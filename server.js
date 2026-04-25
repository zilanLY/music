/**
 * Leapcell Server — Combines Express API + Static Files in one process
 * - /* (all paths)           → netease-cloud-music-api-alger (music API)
 * - /* (fallback)            → dist/ (Vite build output, SPA)
 *
 * ⚡ VIP 歌曲解灰修复:
 * 官方 API 返回 url=null 时，通过 @unblockneteasemusic/server 从第三方平台解灰。
 */
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 8080;

async function buildApp() {
  const express = require('express');
  const app = express();

  // ── 基础中间件 ────────────────────────────────────────────────────────
  app.set('trust proxy', true);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: false, limit: '50mb' }));
  app.use(require('express-fileupload')());

  // ── 加载 netease-cloud-music-api-alger ──────────────────────────────
  const moduleBase = path.join(__dirname, 'node_modules', 'netease-cloud-music-api-alger', 'module');

  const { middleware: cacheMiddleware } = require('netease-cloud-music-api-alger/util/apicache');
  const { cookieToJson } = require('netease-cloud-music-api-alger/util/index');
  const request = require('netease-cloud-music-api-alger/util/request');
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

  // ── 加载 UNM ─────────────────────────────────────────────────────────
  let unmMatch = null;
  try {
    unmMatch = require('@unblockneteasemusic/server');
    console.log('[UNM] @unblockneteasemusic/server loaded, version:', require('@unblockneteasemusic/server/package.json').version);
  } catch (e) {
    console.warn('[UNM] Failed to load @unblockneteasemusic/server:', e.message);
  }

  // 第三方音源优先级
  const UNM_SERVERS = ['kuwo', 'kugou', 'migu', 'bilibili'];

  // ── 辅助函数 ─────────────────────────────────────────────────────────
  function getRealIp(req) {
    let ip = req.ip || '';
    if (ip.substring(0, 7) === '::ffff:') ip = ip.substring(7);
    if (ip === '::1') ip = global.cnIp || '127.0.0.1';
    return ip;
  }

  function makeRequest(req, cookieObj, extraOptions = {}) {
    return (...args) => {
      const params = [...args];
      params[3] = { ...params[3], ip: getRealIp(req), ...extraOptions };
      return request(...params);
    };
  }

  // 解析 cookie 字符串
  function parseCookie(raw) {
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string') return cookieToJson(decode(raw));
    return {};
  }

  // 加载所有 netease API 模块
  const files = (await fs.promises.readdir(moduleBase)).reverse().filter((f) => f.endsWith('.js'));

  const specialRoutes = {
    'daily_signin.js': '/daily_signin',
    'fm_trash.js': '/fm_trash',
    'personal_fm.js': '/personal_fm',
  };

  for (const file of files) {
    const route = specialRoutes[file] || `/${file.replace(/\.js$/i, '').replace(/_/g, '/')}`;
    const mod = require(path.join(moduleBase, file));

    // 跳过 song_url 路由（我们自己处理）
    if (/^\/(api\/)?song[\/_]url/i.test(route)) continue;

    app.use(route, async (req, res) => {
      [req.query, req.body].forEach((item) => {
        if (item && typeof item.cookie === 'string') {
          item.cookie = parseCookie(item.cookie);
        }
      });

      const query = Object.assign({}, { cookie: req.cookies }, req.query, req.body, req.files || {});

      try {
        const resp = await mod(query, makeRequest(req, query.cookie));
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

  // ── ⚡ VIP 解灰路由 ─────────────────────────────────────────────────
  // 拦截所有 /song/url 和 /song/enhance/player/url 请求
  const vipPatterns = [
    /^\/(api\/)?song[\/_]url(\/v1)?$/i,
    /^\/(api\/)?song\/enhance\/player\/url$/i,
  ];

  for (const pattern of vipPatterns) {
    app.all(pattern, async (req, res) => {
      [req.query, req.body].forEach((item) => {
        if (item && typeof item.cookie === 'string') {
          item.cookie = parseCookie(item.cookie);
        }
      });

      const query = Object.assign({}, { cookie: req.cookies }, req.query, req.body);
      const ids = String(query.id || query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
      const br = parseInt(query.br || 999000);
      const level = query.level || 'exhigh';

      if (!ids.length) { res.status(400).send({ code: 400, msg: '缺少 id 参数' }); return; }

      const req_ = makeRequest(req, query.cookie);

      try {
        // 1) 先调官方 API 拿 URL 和歌曲元数据
        let mainData = [];
        try {
          const mainRes = await req_(
            '/api/song/enhance/player/url',
            { ids: JSON.stringify(ids), br },
            { crypto: 'eapi', cookie: query.cookie, ua: query.ua || '', realIP: getRealIp(req), e_r: query.e_r, domain: '', checkToken: false }
          );
          mainData = mainRes.body?.data || [];
        } catch (e) {
          console.warn('[UNM] Official API failed:', e.message);
        }

        // 找出 url=null 的歌曲
        const nullSongs = mainData.filter(item => !item.url || item.url === '');
        if (nullSongs.length === 0) {
          mainData.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
          res.status(200).send({ code: 200, data: mainData });
          return;
        }

        console.log(`[UNM] ${nullSongs.length}/${ids.length} songs need ungray: ${nullSongs.map(s => s.id).join(',')}`);

        // 3) 用 UNM 解灰（不传 metadata，让 UNM 自己调 /api/song/detail 获取）
        const fallbackMap = new Map();

        if (unmMatch) {
          for (const id of nullIds) {
            console.log(`[UNM] Searching id: ${id}`);

            try {
              // match(id, servers) — 不传第三个参数
              // UNM 会自动调用 /api/song/detail?ids=[id] 获取元数据
              const result = await unmMatch(String(id), UNM_SERVERS);

              if (result?.url) {
                fallbackMap.set(String(id), {
                  id: Number(id),
                  url: result.url,
                  br: result.br || br,
                  size: result.size || 0,
                  type: result.type || 'mp3',
                  md5: result.md5 || '',
                  code: 200,
                  level: 'standard',
                  gain: 0,
                  peak: 0,
                  mvUrl: nullSongs.find(s => String(s.id) === String(id))?.mvUrl || null,
                });
                console.log(`[UNM] ✓ id=${id} got URL from ${result.source}: ${String(result.url).substring(0, 80)}`);
              } else {
                console.log(`[UNM] ✗ id=${id} no URL returned`);
              }
            } catch (e) {
              console.log(`[UNM] ✗ id=${id} error: ${e?.message || String(e)}`);
            }
          }
        } else {
          console.log('[UNM] UNM not available, skipping fallback');
        }

        // 4) 合并结果
        const merged = mainData.map(item => {
          if (item.url && item.url !== '') return item;
          return fallbackMap.get(String(item.id)) || item;
        });

        merged.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
        const successCount = merged.filter(i => i.url).length;
        console.log(`[UNM] Final: ${successCount}/${ids.length} songs have URL`);

        res.status(200).send({ code: 200, data: merged });
      } catch (err) {
        console.error('[UNM] Fatal error:', err?.message || String(err));
        res.status(502).send({ code: 502, msg: 'Song URL failed', detail: err.message });
      }
    });
  }

  // 确保 B站缓存目录存在
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
