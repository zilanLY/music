/**
 * Leapcell Server — Combines Express API + Static Files in one process
 * ⚡ VIP 解灰：官方 url=null 时，直接调第三方平台 check() 获取替代链接
 */
const path = require('path');
const fs = require('fs');
const PORT = process.env.PORT || 8080;

async function buildApp() {
  const express = require('express');
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: false, limit: '50mb' }));
  app.use(require('express-fileupload')());

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

  // ── 加载 UNM 第三方音源 ──────────────────────────────────────────────
  // 直接加载各平台的 check() 函数，绕过有 bug 的 find.js
  const providers = {};
  const providerNames = ['kuwo', 'kugou', 'migu', 'bilibili'];
  for (const name of providerNames) {
    try {
      providers[name] = require(`@unblockneteasemusic/server/src/provider/${name}`);
      console.log(`[UNM] Loaded provider: ${name}`);
    } catch (e) {
      console.warn(`[UNM] Failed to load ${name}: ${e.message}`);
    }
  }

  // ── 辅助函数 ─────────────────────────────────────────────────────────
  function getRealIp(req) {
    let ip = req.ip || '';
    if (ip.substring(0, 7) === '::ffff:') ip = ip.substring(7);
    if (ip === '::1') ip = global.cnIp || '127.0.0.1';
    return ip;
  }

  function parseCookie(raw) {
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string') return cookieToJson(decode(raw));
    return {};
  }

  // 加载所有 netease API 模块
  const files = (await fs.promises.readdir(moduleBase)).reverse().filter(f => f.endsWith('.js'));
  const specialRoutes = { 'daily_signin.js': '/daily_signin', 'fm_trash.js': '/fm_trash', 'personal_fm.js': '/personal_fm' };

  for (const file of files) {
    const route = specialRoutes[file] || `/${file.replace(/\.js$/i, '').replace(/_/g, '/')}`;
    const mod = require(path.join(moduleBase, file));

    // 跳过 song_url 路由（我们自己处理）
    if (/^\/(api\/)?song[\/_]url/i.test(route)) continue;

    app.use(route, async (req, res) => {
      [req.query, req.body].forEach(item => {
        if (item && typeof item.cookie === 'string') item.cookie = parseCookie(item.cookie);
      });
      const query = Object.assign({}, { cookie: req.cookies }, req.query, req.body, req.files || {});
      try {
        const resp = await mod(query, (...args) => {
          const params = [...args];
          let ip = req.ip; if (ip?.substring(0, 7) === '::ffff:') ip = ip.substring(7);
          if (ip === '::1') ip = global.cnIp || '127.0.0.1';
          params[3] = { ...params[3], ip };
          return request(...params);
        });
        if (!query.noCookie && Array.isArray(resp.cookie) && resp.cookie.length > 0) {
          res.append('Set-Cookie', resp.cookie.map(c => req.protocol === 'https' ? `${c}; SameSite=None; Secure` : c));
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
  // 绕过 find.js，自己调 /api/song/detail 获取元数据，直接传给各平台 check()
  const vipPatterns = [
    /^\/(api\/)?song[\/_]url(\/v1)?$/i,
    /^\/(api\/)?song\/enhance\/player\/url$/i,
  ];

  for (const pattern of vipPatterns) {
    app.all(pattern, async (req, res) => {
      [req.query, req.body].forEach(item => {
        if (item && typeof item.cookie === 'string') item.cookie = parseCookie(item.cookie);
      });

      const query = Object.assign({}, { cookie: req.cookies }, req.query, req.body);
      const ids = String(query.id || query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
      const br = parseInt(query.br || 999000);
      if (!ids.length) { res.status(400).send({ code: 400, msg: '缺少 id 参数' }); return; }

      const req_ = (...args) => {
        const params = [...args];
        let ip = req.ip; if (ip?.substring(0, 7) === '::ffff:') ip = ip.substring(7);
        if (ip === '::1') ip = global.cnIp || '127.0.0.1';
        params[3] = { ...params[3], ip };
        return request(...params);
      };

      try {
        // 1) 官方 API
        let mainData = [];
        try {
          const mainRes = await req_('/api/song/enhance/player/url',
            { ids: JSON.stringify(ids), br },
            { crypto: 'eapi', cookie: query.cookie, ua: query.ua || '', realIP: getRealIp(req), e_r: query.e_r, domain: '', checkToken: false }
          );
          mainData = mainRes.body?.data || [];
        } catch (e) { console.warn('[UNM] Official API failed:', e?.message || String(e)); }

        const nullSongs = mainData.filter(item => !item.url || item.url === '');
        if (!nullSongs.length) {
          mainData.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
          res.status(200).send({ code: 200, data: mainData });
          return;
        }

        const nullIds = nullSongs.map(s => s.id);
        console.log(`[UNM] ${nullIds.length}/${ids.length} songs need ungray: ${nullIds.join(',')}`);

        // 2) 获取歌曲元数据（自己调，不用 find.js）
        const songMetaMap = new Map();
        try {
          const detailRes = await req_('/api/v3/song/detail',
            { c: JSON.stringify(nullIds.map(id => ({ id: String(id) }))) },
            { crypto: 'weapi', cookie: query.cookie, ua: query.ua || '', realIP: getRealIp(req), e_r: query.e_r, domain: '', checkToken: false }
          );
          const songs = detailRes.body?.songs || [];
          for (const song of songs) {
            songMetaMap.set(String(song.id), {
              id: song.id,
              name: song.name,
              artists: (song.ar || []).map(a => ({ id: a.id, name: a.name })),
              album: { id: song.al?.id, name: song.al?.name || '' },
              duration: song.dt || 0,
              keyword: song.name + ' - ' + (song.ar || []).map(a => a.name).join(' / '),
            });
          }
        } catch (e) {
          console.warn('[UNM] song_detail failed:', e?.message || String(e));
        }

        // 3) 逐首解灰：依次尝试各平台
        const fallbackMap = new Map();
        const activeProviders = Object.entries(providers);

        for (const id of nullIds) {
          const meta = songMetaMap.get(String(id));
          if (!meta || !meta.keyword) {
            console.log(`[UNM] ✗ id=${id} no metadata, skipping`);
            continue;
          }

          console.log(`[UNM] Searching: ${meta.keyword}`);
          let found = false;

          for (const [name, provider] of activeProviders) {
            if (found) break;
            try {
              const url = await provider.check(meta);
              if (url) {
                fallbackMap.set(String(id), {
                  id: Number(id),
                  url: url,
                  br: br,
                  size: 0,
                  type: 'mp3',
                  md5: '',
                  code: 200,
                  level: 'standard',
                  gain: 0,
                  peak: 0,
                  mvUrl: nullSongs.find(s => String(s.id) === String(id))?.mvUrl || null,
                });
                console.log(`[UNM] ✓ id=${id} from ${name}: ${String(url).substring(0, 80)}`);
                found = true;
              }
            } catch (e) {
              // 当前平台没找到，继续尝试下一个
            }
          }
          if (!found) console.log(`[UNM] ✗ id=${id} not found on any provider`);
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
        console.error('[UNM] Fatal:', err?.message || String(err));
        res.status(502).send({ code: 502, msg: 'Song URL failed', detail: err?.message || String(err) });
      }
    });
  }

  // B站缓存目录
  try {
    const biliCacheDir = path.join(__dirname, 'node_modules', 'netease-cloud-music-api-alger', 'cache');
    if (!fs.existsSync(biliCacheDir)) fs.mkdirSync(biliCacheDir, { recursive: true });
  } catch (e) { console.warn('创建B站缓存目录失败:', e?.message); }

  registerBiliApis(app, biliApiConfigs);

  // 静态文件
  app.use(express.static(path.join(__dirname, 'dist'), { acceptRanges: true, cacheControl: false, maxAge: '31536000ms' }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

  return app;
}

buildApp()
  .then(app => app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}/`)))
  .catch(err => { console.error('Failed to start:', err); process.exit(1); });
