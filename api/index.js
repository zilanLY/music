/**
 * Vercel Serverless Function — NeteaseCloudMusicApi
 *
 * 直接实现 constructServer 逻辑，从 node_modules 加载全部 API 模块。
 * Vercel 会自动 npm install 根目录的 package.json 依赖。
 *
 * 模块路径: 项目根/node_modules/netease-cloud-music-api-alger/module/
 *
 * ⚡ VIP 歌曲多源解析修复:
 * 当 /song/enhance/player/url 返回 url=null 时，
 * 自动尝试 /api/song/enhance/download/url 兜底获取有效链接。
 */

const path = require('path')
const fs = require('fs')

// 从 netease-cloud-music-api-alger 加载必要模块
const { middleware: cacheMiddleware } = require('netease-cloud-music-api-alger/util/apicache')
const { cookieToJson } = require('netease-cloud-music-api-alger/util/index')
const request = require('netease-cloud-music-api-alger/util/request')
const fileUpload = require('express-fileupload')
const { biliRequest } = require('netease-cloud-music-api-alger/util/biliRequest')
const { registerBiliApis } = require('netease-cloud-music-api-alger/util/biliApiHandler')
const biliApiConfigs = require('netease-cloud-music-api-alger/bili/biliApiConfigs')
const decode = require('safe-decode-uri-component')

// 特殊路由映射（与原版一致）
const specialRoutes = {
  'daily_signin.js': '/daily_signin',
  'fm_trash.js': '/fm_trash',
  'personal_fm.js': '/personal_fm',
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔧 VIP 歌曲多源解析（修复 url=null 问题）
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 对单个歌曲 ID 尝试多个音质级别，从高到低，直到拿到有效 URL
 * @param {string} id - 歌曲 ID
 * @param {Function} makeRequest - request 工厂
 * @param {Object} cookie - Cookie 对象
 * @param {Object} baseOptions - 基础请求选项（ua, realIP 等）
 */
async function trySongUrlWithFallback(id, makeRequest, cookie, baseOptions) {
  // 音质优先级： hires > lossless > high > standard
  const bitrates = [
    999000, // hires (flac)
    320000, // high (mp3 320k)
    192000, // standard-hi
    128000, // standard
    96000,  // low
    64000,  // very low
  ]

  // 构建 request 工厂（复用主逻辑的 request 闭包）
  const reqOptions = (br) => ({
    crypto: 'eapi',
    cookie,
    ua: baseOptions.ua || '',
    proxy: baseOptions.proxy,
    realIP: baseOptions.realIP,
    e_r: baseOptions.e_r,
    domain: '',
    checkToken: false,
  })

  // 第一步：尝试标准播放链接（多音质兜底）
  for (const br of bitrates) {
    try {
      const res = await makeRequest(
        '/api/song/enhance/player/url',
        { ids: JSON.stringify([id]), br },
        reqOptions(br),
      )
      const item = res.body?.data?.[0]
      if (item?.url) {
        return { ...item, fetchedVia: `player_url_br${br}` }
      }
    } catch (_) { /* 继续尝试下一个音质 */ }
  }

  // 第二步：尝试下载链接（VIP 专属，比播放链接权限更高）
  for (const br of bitrates) {
    try {
      const res = await makeRequest(
        '/api/song/enhance/download/url',
        { id, br },
        reqOptions(br),
      )
      const url = res.body?.url
      if (url) {
        return {
          id: Number(id),
          url,
          br: res.body?.br || br,
          size: res.body?.size || 0,
          type: res.body?.type || 'flac',
          md5: res.body?.md5 || '',
          code: 200,
          level: res.body?.level || 'standard',
          gain: res.body?.gain || 0,
          peak: res.body?.peak || 0,
          mvUrl: null,
          fetchedVia: `download_url_br${br}`,
        }
      }
    } catch (_) { /* 继续 */ }
  }

  // 第三步：全部失败，返回 null
  return {
    id: Number(id),
    url: null,
    br: 999000,
    size: 0,
    type: 'mp3',
    md5: '',
    code: 200,
    level: 'standard',
    gain: 0,
    peak: 0,
    mvUrl: null,
    fetchedVia: 'none',
  }
}

/**
 * VIP 多源解析主入口
 * 覆盖 /api/song/enhance/player/url 路由
 */
async function handleSongUrlVipFallback(req, res, makeRequest) {
  const query = { ...req.query, ...req.body }
  const cookie = req.cookies || {}
  const ids = String(query.id || query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (!ids.length) {
    res.status(400).send({ code: 400, msg: '缺少 id 参数' })
    return
  }

  const br = parseInt(query.br || 999000)

  // 先走官方主接口
  try {
    const mainRes = await makeRequest(
      '/api/song/enhance/player/url',
      { ids: JSON.stringify(ids), br },
      { crypto: 'eapi', cookie, ua: query.ua || '', proxy: query.proxy, realIP: query.realIP, e_r: query.e_r, domain: '', checkToken: false },
    )

    const mainData = mainRes.body?.data || []
    if (!mainData.length) throw new Error('empty response')

    // 检查是否有歌曲需要 fallback
    const nullUrls = mainData.filter((item) => !item.url || item.url === '')
    const validUrls = mainData.filter((item) => item.url && item.url !== '')

    if (!nullUrls.length) {
      // 全部歌曲都有有效 URL，直接返回
      mainData.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)))
      res.status(200).send({ code: 200, data: mainData })
      return
    }

    // 有歌曲 url=null，并行请求 fallback
    console.log(`[VIP-Fix] ${nullUrls.length}/${ids.length} 歌曲需要 fallback，尝试多源解析...`)

    const fallbackResults = await Promise.all(
      nullUrls.map((item) =>
        trySongUrlWithFallback(
          String(item.id),
          makeRequest,
          cookie,
          { ua: query.ua || '', proxy: query.proxy, realIP: query.realIP, e_r: query.e_r },
        ),
      ),
    )

    // 合并结果
    const fallbackMap = new Map(fallbackResults.map((r) => [String(r.id), r]))
    const merged = mainData.map((item) => {
      if (!item.url && fallbackMap.has(String(item.id))) {
        return fallbackMap.get(String(item.id))
      }
      return item
    })

    merged.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)))

    const successCount = merged.filter((i) => i.url).length
    console.log(`[VIP-Fix] 完成: ${successCount}/${ids.length} 歌曲获得有效 URL`)

    res.status(200).send({ code: 200, data: merged })
  } catch (err) {
    console.error('[VIP-Fix] 主接口异常:', err.message)
    res.status(502).send({ code: 502, msg: '歌曲链接获取失败', detail: err.message })
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function buildExpressApp() {
  const express = require('express')
  const app = express()

  // ── 基础中间件 ─────────────────────────────────────────────────────────
  app.set('trust proxy', true)
  app.use(express.static(path.join(__dirname, 'public'))) // 静态文件
  app.use(express.json({ limit: '50mb' }))
  app.use(express.urlencoded({ extended: false, limit: '50mb' }))
  app.use(fileUpload())
  app.use(cacheMiddleware('2 minutes', (_, res) => res.statusCode === 200))

  // ── CORS ──────────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type,Cookie',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      })
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  })

  // ── Cookie 解析 ──────────────────────────────────────────────────────
  app.use((req, _, next) => {
    req.cookies = {}
    ;(req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 1 || eq === pair.length - 1) return
      const key = decode(pair.slice(0, eq)).trim()
      const val = decode(pair.slice(eq + 1)).trim()
      req.cookies[key] = val
    })
    next()
  })

  // ── ⚡ VIP 歌曲多源解析路由（优先于动态模块加载）────────────────────
  // 匹配: /api/song/enhance/player/url 和 /song/enhance/player/url
  const vipSongUrlPattern = /^\/(api\/)?song\/enhance\/player\/url$/i
  app.all(vipSongUrlPattern, async (req, res) => {
    // 解析 query/body 中的 cookie
    ;[req.query, req.body].forEach((item) => {
      if (item && typeof item.cookie === 'string') {
        item.cookie = cookieToJson(decode(item.cookie))
      }
    })

    // 构建 request 工厂（复用标准闭包逻辑）
    const makeRequest = (...args) => {
      let ip = req.ip || ''
      if (ip.substring(0, 7) === '::ffff:') ip = ip.substring(7)
      if (ip === '::1') ip = global.cnIp || '127.0.0.1'
      const params = [...args]
      params[3] = { ...params[3], ip }
      return request(...params)
    }

    await handleSongUrlVipFallback(req, res, makeRequest)
  })

  // ── 动态加载所有 API 模块 ─────────────────────────────────────────────
  // node_modules 相对于 api/ 目录（即项目根目录）
  const moduleBase = path.join(__dirname, '..', 'node_modules', 'netease-cloud-music-api-alger', 'module')

  const files = (await fs.promises.readdir(moduleBase))
    .reverse()
    .filter((f) => f.endsWith('.js'))

  const modules = files.map((file) => {
    const id = file.split('.')[0]
    const route = specialRoutes[file] || `/${file.replace(/\.js$/i, '').replace(/_/g, '/')}`
    const mod = require(path.join(moduleBase, file))
    return { id, route, mod }
  })

  // ── 注册路由 ──────────────────────────────────────────────────────────
  for (const { route, mod } of modules) {
    // 跳过 song/enhance/player/url（已被上面的 VIP 路由处理）
    if (vipSongUrlPattern.test(route)) continue

    app.use(route, async (req, res) => {
      // 解析 cookie 到 query/body
      ;[req.query, req.body].forEach((item) => {
        if (item && typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie))
        }
      })

      const query = Object.assign(
        {},
        { cookie: req.cookies },
        req.query,
        req.body,
        req.files || {},
      )

      try {
        const resp = await mod(query, (...args) => {
          const params = [...args]
          let ip = req.ip
          if (ip && ip.substring(0, 7) === '::ffff:') ip = ip.substring(7)
          if (ip === '::1') ip = global.cnIp || '127.0.0.1'
          params[3] = { ...params[3], ip }
          return request(...params)
        })

        const cookies = resp.cookie
        if (!query.noCookie && Array.isArray(cookies) && cookies.length > 0) {
          if (req.protocol === 'https') {
            res.append('Set-Cookie', cookies.map((c) => `${c}; SameSite=None; Secure`))
          } else {
            res.append('Set-Cookie', cookies)
          }
        }
        res.status(resp.status).send(resp.body)
      } catch (err) {
        const resp = err
        if (!resp.body) { res.status(404).send({ code: 404, msg: 'Not Found' }); return }
        if (resp.body.code == 301) resp.body.msg = '需要登录'
        if (!query.noCookie && resp.cookie) res.append('Set-Cookie', resp.cookie)
        res.status(resp.status).send(resp.body)
      }
    })
  }

  // ── B站 API ──────────────────────────────────────────────────────────
  registerBiliApis(app, biliApiConfigs)

  return app
}

// ── Vercel 导出（缓存 app 避免重复构建）────────────────────────────────
let _app = null

module.exports = async (req, res) => {
  if (!_app) _app = await buildExpressApp()
  _app(req, res)
}
