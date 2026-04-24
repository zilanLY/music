/**
 * Leapcell Server — Combines Express API + Static Files in one process
 * - /* (all paths)           → netease-cloud-music-api-alger (music API)
 * - /* (fallback)            → dist/ (Vite build output, SPA)
 *
 * ⚡ VIP 歌曲多源解析修复:
 * 当 /song/enhance/player/url 返回 url=null 时，
 * 自动尝试 /api/song/enhance/download/url 兜底获取有效链接。
 */
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;

async function buildApp() {
  const express = require('express');
  const app = express();

  // ── 基础中间件 ────────────────────────────────────────────────────────
  app.set('trust proxy', true);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: false, limit: '50mb' }));
  app.use(require('express-fileupload')());

  // ── 动态加载 netease-cloud-music-api-alger 路由 ───────────────────────
  const moduleBase = path.join(__dirname, 'node_modules', 'netease-cloud-music-api-alger', 'module');

  const { middleware: cacheMiddleware } = require('netease-cloud-music-api-alger/util/apicache');
  const { cookieToJson } = require('netease-cloud-music-api-alger/util/index');
  const request = require('netease-cloud-music-api-alger/util/request');
  const { biliRequest } = require('netease-cloud-music-api-alger/util/biliRequest');
  const { registerBiliApis } = require('netease-cloud-music-api-alger/util/biliApiHandler');
  const biliApiConfigs = require('netease-cloud-music-api-alger/bili/biliApiConfigs');
  const decode = require('safe-decode-uri-component');

  app.use(cacheMiddleware('2 minutes', (_, res) => res.statusCode === 200));

  // CORS
  app.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type,Cookie',
      'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
    });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Cookie 解析
  app.use((req, _, next) => {
    req.cookies = {};
    (req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 1 || eq === pair.length - 1) return;
      req.cookies[decode(pair.slice(0, eq)).trim()] = decode(pair.slice(eq + 1)).trim();
    });
    next();
  });

  // 加载所有 API 模块
  const files = (await fs.promises.readdir(moduleBase)).reverse().filter((f) => f.endsWith('.js'));

  const specialRoutes = {
    'daily_signin.js': '/daily_signin',
    'fm_trash.js': '/fm_trash',
    'personal_fm.js': '/personal_fm',
  };

  for (const file of files) {
    const route = specialRoutes[file] || `/${file.replace(/\.js$/i, '').replace(/_/g, '/')}`;
    const mod = require(path.join(moduleBase, file));

    app.use(route, async (req, res) => {
      [req.query, req.body].forEach((item) => {
        if (item && typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie));
        }
      });

      const query = Object.assign({}, { cookie: req.cookies }, req.query, req.body, req.files || {});

      try {
        const resp = await mod(query, (...args) => {
          const params = [...args];
          let ip = req.ip;
          if (ip && ip.substring(0, 7) === '::ffff:') ip = ip.substring(7);
          if (ip === '::1') ip = global.cnIp || '127.0.0.1';
          params[3] = { ...params[3], ip };
          return request(...params);
        });

        if (!query.noCookie && Array.isArray(resp.cookie) && resp.cookie.length > 0) {
          res.append('Set-Cookie', resp.cookie.map((c) =>
            req.protocol === 'https' ? `${c}; SameSite=None; Secure` : c
          ));
        }
        res.status(resp.status).send(resp.body);
      } catch (err) {
        if (!err.body) { res.status(404).send({ code: 404, msg: 'Not Found' }); return; }
        if (!query.noCookie && err.cookie) res.append('Set-Cookie', err.cookie);
        res.status(err.status).send(err.body);
      }
    });
  }

  // ── ⚡ VIP 歌曲多源解析路由 ──────────────────────────────────────────
  // 拦截 /song/enhance/player/url，当 url=null 时自动 fallback 到 download/url
  const vipUrlPattern = /^\/(api\/)?song\/enhance\/player\/url$/i;
  app.all(vipUrlPattern, async (req, res) => {
    [req.query, req.body].forEach((item) => {
      if (item && typeof item.cookie === 'string') {
        item.cookie = cookieToJson(decode(item.cookie));
      }
    });

    const query = Object.assign({}, { cookie: req.cookies }, req.query, req.body);
    const ids = String(query.id || query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const br = parseInt(query.br || 999000);

    if (!ids.length) { res.status(400).send({ code: 400, msg: '缺少 id 参数' }); return; }

    const makeRequest = (...args) => {
      const params = [...args];
      let ip = req.ip;
      if (ip && ip.substring(0, 7) === '::ffff:') ip = ip.substring(7);
      if (ip === '::1') ip = global.cnIp || '127.0.0.1';
      params[3] = { ...params[3], ip };
      return request(...params);
    };

    try {
      // 主接口
      const mainRes = await makeRequest('/api/song/enhance/player/url',
        { ids: JSON.stringify(ids), br },
        { crypto: 'eapi', cookie: query.cookie, ua: query.ua || '', realIP: query.realIP, e_r: query.e_r, domain: '', checkToken: false }
      );
      const mainData = mainRes.body?.data || [];

      if (!mainData.length) throw new Error('empty response');

      const nullUrls = mainData.filter(item => !item.url || item.url === '');
      const validUrls = mainData.filter(item => item.url && item.url !== '');

      if (!nullUrls.length) {
        mainData.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
        res.status(200).send({ code: 200, data: mainData });
        return;
      }

      // 有 url=null 的歌曲，尝试 download/url 兜底
      console.log(`[VIP-Fix] ${nullUrls.length}/${ids.length} songs need fallback`);

      const bitrates = [999000, 320000, 192000, 128000, 96000, 64000];
      const fallbackResults = await Promise.all(nullUrls.map(async (item) => {
        for (const b of bitrates) {
          try {
            const r = await makeRequest('/api/song/enhance/download/url',
              { id: item.id, br: b },
              { crypto: 'eapi', cookie: query.cookie, ua: query.ua || '', realIP: query.realIP, e_r: query.e_r, domain: '', checkToken: false }
            );
            if (r.body?.url) {
              return { id: item.id, url: r.body.url, br: r.body.br || b, size: r.body.size || 0,
                type: r.body.type || 'mp3', md5: r.body.md5 || '', code: 200, level: r.body.level || 'standard',
                gain: r.body.gain || 0, peak: r.body.peak || 0, mvUrl: item.mvUrl || null };
            }
          } catch (_) { /* continue */ }
        }
        return { id: item.id, url: null, br: 999000, size: 0, type: 'mp3', md5: '',
          code: 200, level: 'standard', gain: 0, peak: 0, mvUrl: item.mvUrl || null };
      }));

      const fallbackMap = new Map(fallbackResults.map(r => [String(r.id), r]));
      const merged = mainData.map(item => (!item.url && fallbackMap.has(String(item.id))) ? fallbackMap.get(String(item.id)) : item);
      merged.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));

      const successCount = merged.filter(i => i.url).length;
      console.log(`[VIP-Fix] Result: ${successCount}/${ids.length} songs got URL`);

      res.status(200).send({ code: 200, data: merged });
    } catch (err) {
      console.error('[VIP-Fix] Error:', err.message);
      res.status(502).send({ code: 502, msg: 'VIP fallback failed', detail: err.message });
    }
  });

  // 确保 B站缓存目录存在（Leapcell 容器中 node_modules 可能是只读的，
  // biliApiHandler.js 的 saveCookies 会尝试 mkdir，提前创建避免 ENOENT）
  try {
    const biliCacheDir = path.join(__dirname, 'node_modules', 'netease-cloud-music-api-alger', 'cache');
    if (!fs.existsSync(biliCacheDir)) {
      fs.mkdirSync(biliCacheDir, { recursive: true });
    }
  } catch (e) {
    console.warn('创建B站缓存目录失败（不影响核心功能）:', e.message);
  }

  registerBiliApis(app, biliApiConfigs);

  // ── 静态文件 (dist/) ─────────────────────────────────────────────────
  // 直接让 Express 处理静态文件，不需要手动路由
  app.use(express.static(path.join(__dirname, 'dist'), {
    // 启用 gzip/brotli 压缩
    acceptRanges: true,
    cacheControl: false,
    // 设置合适的 maxAge
    maxAge: '31536000ms',
  }));

  // SPA fallback — 所有未匹配的 GET 请求返回 index.html
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });

  return app;
}

buildApp()
  .then((app) => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}/`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
