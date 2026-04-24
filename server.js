/**
 * Leapcell Server — Combines Express API + Static Files in one process
 * - /* (all paths)           → netease-cloud-music-api-alger (music API)
 * - /* (fallback)            → dist/ (Vite build output, SPA)
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
