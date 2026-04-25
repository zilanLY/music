/**
 * Leapcell Server — Combines Express API + Static Files in one process
 * - /* (all paths)           → netease-cloud-music-api-alger (music API)
 * - /* (fallback)            → dist/ (Vite build output, SPA)
 *
 * ⚡ VIP 歌曲解灰修复:
 * 当 /song/enhance/player/url 返回 url=null 时，
 * 使用 @unblockneteasemusic/server 从酷我/酷狗/咪咕/哔哩哔哩获取替代链接。
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

  // ── ⚡ VIP 歌曲解灰路由 ──────────────────────────────────────────────
  // 拦截 /song/enhance/player/url，url=null 时用 @unblockneteasemusic/server 解灰
  // 从酷我/酷狗/咪咕/哔哩哔哩等第三方平台获取替代播放链接
  let unmMatch = null;
  try {
    unmMatch = require('@unblockneteasemusic/server').match;
    console.log('[UNM] @unblockneteasemusic/server loaded successfully');
  } catch (e) {
    console.warn('[UNM] Failed to load @unblockneteasemusic/server:', e.message);
    console.warn('[UNM] VIP song fallback will be disabled');
  }

  // 第三方音源优先级（去掉 pyncmd，需要 ffmpeg 转码太重）
  const UNM_SERVERS = ['kuwo', 'kugou', 'migu', 'bilibili'];

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
      // 1) 主接口 — 网易云官方 API
      const mainRes = await makeRequest('/api/song/enhance/player/url',
        { ids: JSON.stringify(ids), br },
        { crypto: 'eapi', cookie: query.cookie, ua: query.ua || '', realIP: query.realIP, e_r: query.e_r, domain: '', checkToken: false }
      );
      const mainData = mainRes.body?.data || [];
      if (!mainData.length) throw new Error('empty response');

      // 2) 检查哪些歌曲没有有效 URL
      const nullIds = mainData.filter(item => !item.url || item.url === '').map(item => String(item.id));
      if (!nullIds.length) {
        mainData.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
        res.status(200).send({ code: 200, data: mainData });
        return;
      }

      // 3) 用 UNM 从第三方平台获取替代链接
      console.log(`[UNM] ${nullIds.length}/${ids.length} songs need ungray: ${nullIds.join(',')}`);

      const fallbackMap = new Map();
      if (unmMatch) {
        const unmResults = await Promise.allSettled(
          nullIds.map(id => unmMatch(id, UNM_SERVERS))
        );
        for (let i = 0; i < unmResults.length; i++) {
          const result = unmResults[i];
          const id = nullIds[i];
          if (result.status === 'fulfilled' && result.value?.url) {
            fallbackMap.set(id, {
              id: Number(id),
              url: result.value.url,
              source: result.value.source,
              br: result.value.br || br,
              size: 0,
              type: 'mp3',
              md5: '',
              code: 200,
              level: 'standard',
              gain: 0,
              peak: 0,
              mvUrl: null,
            });
            console.log(`[UNM] ✓ id=${id} from ${result.value.source}`);
          } else {
            const reason = result.status === 'fulfilled'
              ? 'no url returned'
              : result.reason.message;
            console.log(`[UNM] ✗ id=${id} failed: ${reason}`);
          }
        }
      } else {
        console.log('[UNM] Skipping fallback (UNM not available)');
      }

      // 4) 合并结果
      const merged = mainData.map(item => {
        if (item.url && item.url !== '') return item; // 官方有链接，保持不变
        const fallback = fallbackMap.get(String(item.id));
        if (fallback) return fallback;
        return item; // 都没拿到，保持原样
      });

      merged.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
      const successCount = merged.filter(i => i.url).length;
      console.log(`[UNM] Final: ${successCount}/${ids.length} songs got URL`);

      res.status(200).send({ code: 200, data: merged });
    } catch (err) {
      console.error('[UNM] Error:', err.message);
      res.status(502).send({ code: 502, msg: 'Song URL failed', detail: err.message });
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
  app.use(express.static(path.join(__dirname, 'dist'), {
    acceptRanges: true,
    cacheControl: false,
    maxAge: '31536000ms',
  }));

  // SPA fallback
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
