/*
 * 念风chat · 扩展插件后端桥 · napcat-group-guard
 *
 * 前端插件运行在浏览器环境里，直接 fetch QQ 头像 CDN 会受 CORS 限制，
 * 画像卡就只剩占位文字。这里按参考项目“服务端下载头像 bytes”的思路，
 * 注册一个本机后端路由：/api/group-guard/avatar?qq=xxx
 * 前端把返回的图片字节画进 Canvas，不涉及 canvas 跨域污染。
 *
 * 另外提供一组进程内“事件/周期租约”路由。群管助手同时运行在 WebUI 页面
 * 和 headless 代聊 worker 里，同一个 NapCat 事件会广播给所有实例。租约让
 * 服务端原子仲裁“谁处理这个事件 / 这一轮清理”，避免同一请求被多个实例
 * 重复同意、重复发送欢迎或重复踢人。
 *
 * 服务端档案图渲染：POST /api/group-guard/render。headless / 无 Canvas
 * 实例通过它生成档案图；PowerShell + System.Drawing 不可用时自动降级到
 * 纯 Node PNG，保证不依赖 WebUI 页面常驻。
 *
 * 还提供 /api/group-guard/image 图片落盘路由：前端 Canvas 生成档案图后，
 * 如果 base64 / data URL 发送都被 NapCat 拒绝，可以把图片存到本机文件，
 * 再用 file:/// 路径发送，避免大图在 WebSocket / HTTP JSON 上被截断。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renderDossierCard } from './render-server.mjs'

export const name = 'napcat-group-guard-bridge'
export const version = '2.0.0'
export const description = '群管助手后端桥：QQ 头像代理、服务端档案图渲染（PowerShell + 纯 Node 兜底）、图片落盘发送 + 多实例事件 / 清理租约仲裁。'
export const core = false
// 注意：后端桥真实加载时 ctx.settings 必须先声明，不能用 settings? 可选写法，
// 否则 Cordis 会抛 “cannot get property settings without inject”，整个桥注册失败。
export const inject = ['httpApi', 'settings']

const MAX_AVATAR_BYTES = 4 * 1024 * 1024
const AVATAR_TIMEOUT_MS = 10000
const MAX_DOSSIER_BYTES = 8 * 1024 * 1024
const MAX_DOSSIER_FILES = 240
const MAX_CLAIMS = 5000
const MIN_CLAIM_TTL_MS = 1000
const MAX_CLAIM_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000

const avatarCandidates = qq => [
  `https://q4.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=640`,
  `https://q.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=640&img_type=jpg`,
  `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`,
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

async function fetchAvatarBytes(qq) {
  for (const url of avatarCandidates(qq)) {
    for (const headers of [
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NapCat/OneBot' },
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: 'https://qzone.qq.com/' },
    ]) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('avatar timeout')), AVATAR_TIMEOUT_MS)
      try {
        const response = await fetch(url, { headers, signal: controller.signal })
        clearTimeout(timer)
        if (!response.ok) continue
        const contentType = String(response.headers.get('content-type') || 'image/jpeg').toLowerCase()
        if (!contentType.startsWith('image/')) continue
        const buffer = Buffer.from(await response.arrayBuffer())
        if (!buffer.length || buffer.length > MAX_AVATAR_BYTES) continue
        return { buffer, contentType }
      } catch (_) {
        clearTimeout(timer)
        await sleep(120)
      }
    }
  }
  return null
}

const avatarCache = new Map()
const AVATAR_CACHE_MS = 30 * 60 * 1000
const AVATAR_CACHE_LIMIT = 2000

async function fetchAvatarBytesCached(qq) {
  const key = String(qq || '')
  if (!key) return null
  const cached = avatarCache.get(key)
  if (cached && Date.now() - cached.at < AVATAR_CACHE_MS) return cached.value
  const value = await fetchAvatarBytes(key)
  if (value) {
    if (avatarCache.size >= AVATAR_CACHE_LIMIT) {
      const oldest = [...avatarCache.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0]
      if (oldest) avatarCache.delete(oldest[0])
    }
    avatarCache.set(key, { at: Date.now(), value })
  }
  return value
}

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function imageDirOf(settings) {
  const dataDir = String(settings?.dataDir || process.env.NIANFENG_DATA_DIR || join(tmpdir(), 'nianfeng-group-guard')).trim()
  return join(dataDir, 'group-guard', 'images')
}

function parseImageBody(body = {}) {
  let mime = 'image/jpeg'
  let base64 = ''
  const dataUrl = String(body?.dataUrl || '').trim()
  const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/i)
  if (match) {
    mime = String(match[1] || 'image/jpeg').toLowerCase()
    base64 = match[2].replace(/\s+/g, '')
  } else {
    base64 = String(body?.base64 || '').replace(/\s+/g, '')
    mime = String(body?.mime || 'image/jpeg').toLowerCase()
  }
  if (!base64) return { ok: false, error: '缺少图片 base64 数据' }
  const buffer = Buffer.from(base64, 'base64')
  if (!buffer.length) return { ok: false, error: '图片数据为空' }
  if (buffer.length > MAX_DOSSIER_BYTES) return { ok: false, error: `图片过大（${buffer.length} 字节，上限 ${MAX_DOSSIER_BYTES}）` }
  const ext = MIME_EXT[mime] || 'jpg'
  return { ok: true, mime: EXT_MIME[`.${ext}`] || 'image/jpeg', ext, buffer }
}

function pruneImageDir(dir) {
  try {
    if (!existsSync(dir)) return
    const files = readdirSync(dir)
      .map(name => {
        const path = join(dir, name)
        try {
          return { path, at: statSync(path).mtimeMs }
        } catch (_) {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at)
    for (const item of files.slice(0, Math.max(0, files.length - MAX_DOSSIER_FILES))) {
      try {
        unlinkSync(item.path)
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    /* ignore */
  }
}

function saveDossierImage(settings, body = {}) {
  const parsed = parseImageBody(body)
  if (!parsed.ok) return parsed
  const dir = imageDirOf(settings)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, error: `图片目录创建失败：${err?.message || err}` }
  }
  const id = `${randomUUID().replace(/-/g, '')}.${parsed.ext}`
  const filePath = join(dir, id)
  try {
    writeFileSync(filePath, parsed.buffer)
  } catch (err) {
    return { ok: false, error: `图片写入失败：${err?.message || err}` }
  }
  pruneImageDir(dir)
  const normalized = filePath.replace(/\\/g, '/')
  return {
    ok: true,
    id,
    file: id,
    path: filePath,
    fileUrl: `file:///${normalized.replace(/^\/+/, '')}`,
    mime: parsed.mime,
    bytes: parsed.buffer.length,
  }
}

/**
 * 进程内租约表：key -> expiresAt。
 * 同一后端进程里 Node 单线程，检查与写入之间没有 await，天然原子。
 */
const claimStore = new Map()

function pruneClaims(now = Date.now()) {
  if (claimStore.size < MAX_CLAIMS) {
    if (claimStore.size < 128) return
    for (const [key, expiresAt] of claimStore) {
      if (Number(expiresAt) <= now) claimStore.delete(key)
    }
    return
  }
  // 超出容量时优先淘汰最早到期的一批，避免长期运行的进程无限占用内存。
  const doomed = [...claimStore.entries()].sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0)).slice(0, Math.ceil(MAX_CLAIMS / 4))
  for (const [key] of doomed) claimStore.delete(key)
}

function normalizeClaimKey(value) {
  const key = String(value ?? '').trim()
  if (!key || key.length > 240 || /[\r\n]/.test(key)) return ''
  return key
}

function claimOnce(key, ttlMs) {
  const now = Date.now()
  pruneClaims(now)
  const current = Number(claimStore.get(key)) || 0
  if (current > now) return { claimed: false, expiresAt: current, remainingMs: current - now }
  const ttl = Math.max(MIN_CLAIM_TTL_MS, Math.min(MAX_CLAIM_TTL_MS, Number(ttlMs) || DEFAULT_CLAIM_TTL_MS))
  const expiresAt = now + ttl
  claimStore.set(key, expiresAt)
  return { claimed: true, expiresAt, remainingMs: ttl }
}

function releaseClaim(key) {
  const existed = claimStore.delete(key)
  return { released: existed }
}

function isClaimActive(key) {
  const now = Date.now()
  const expiresAt = Number(claimStore.get(key)) || 0
  if (expiresAt <= now) {
    if (expiresAt) claimStore.delete(key)
    return { active: false, expiresAt: 0 }
  }
  return { active: true, expiresAt }
}

export function apply(ctx) {
  const httpApi = ctx.httpApi
  const settings = ctx.settings || (typeof ctx.inject === 'function' ? ctx.inject('settings?') : null) || null
  const disposers = []

  // 档案图落盘：前端 Canvas 图发送失败时，先存到本机文件，再用 file:/// 发送。
  disposers.push(
    httpApi.route('POST', '/api/group-guard/image', async (req, res) => {
      try {
        const body = (await httpApi.readBody(req, 12 * 1024 * 1024)) || {}
        const result = saveDossierImage(settings, body)
        if (!result.ok) return httpApi.sendError(res, 400, result.error)
        httpApi.sendJson(res, 200, result)
      } catch (err) {
        httpApi.sendError(res, 500, `档案图落盘失败：${err?.message || err}`)
      }
    }),
  )

  // 服务端档案图渲染：给没有浏览器 Canvas 的 headless / 服务端代聊实例用。
  disposers.push(
    httpApi.route('POST', '/api/group-guard/render', async (req, res) => {
      try {
        const body = (await httpApi.readBody(req, 2 * 1024 * 1024)) || {}
        const result = await renderDossierCard(body, { fetchAvatar: fetchAvatarBytesCached })
        if (!result.ok) return httpApi.sendError(res, 500, result.error)
        httpApi.sendJson(res, 200, result)
      } catch (err) {
        httpApi.sendError(res, 500, `服务端档案图渲染失败：${err?.message || err}`)
      }
    }),
  )

  // 只读预览 / 兜底 URL 访问；文件名是随机 ID，不含用户数据。
  disposers.push(
    httpApi.route('GET', '/api/group-guard/image/:id', async (req, res, params) => {
      const id = String(params?.id || '')
      if (!/^[a-f0-9]{32}\.(jpg|png|webp|gif)$/i.test(id)) return httpApi.sendError(res, 400, '图片 ID 不合法')
      const filePath = join(imageDirOf(settings), id)
      try {
        const buffer = readFileSync(filePath)
        const contentType = EXT_MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': buffer.length,
          'Cache-Control': 'public, max-age=600',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(buffer)
      } catch (_) {
        httpApi.sendError(res, 404, '图片不存在或已清理')
      }
    }),
  )

  disposers.push(httpApi.route('GET', '/api/group-guard/avatar', async (req, res, _params, url) => {
    const qq = String(url?.searchParams?.get('qq') || '').trim()
    if (!/^\d{5,12}$/.test(qq)) {
      return httpApi.sendError(res, 400, 'QQ 号不合法')
    }
      const avatar = await fetchAvatarBytesCached(qq)
      if (!avatar) {
        return httpApi.sendError(res, 404, '头像获取失败')
      }
      const format = String(url?.searchParams?.get('format') || url?.searchParams?.get('data') || '').trim().toLowerCase()
      if (['1', 'true', 'json', 'data', 'dataurl'].includes(format)) {
        const base64 = avatar.buffer.toString('base64')
        return httpApi.sendJson(res, 200, {
          ok: true,
          qq,
          mime: avatar.contentType,
          base64,
          dataUrl: `data:${avatar.contentType};base64,${base64}`,
        })
      }
      res.writeHead(200, {
        'Content-Type': avatar.contentType,
        'Content-Length': avatar.buffer.length,
        'Cache-Control': 'public, max-age=600',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(avatar.buffer)
  }))

  // 尝试占领一个事件 / 一轮清理。第一个调用者拿到 claimed:true，其余调用者拿到 false。
  disposers.push(httpApi.route('POST', '/api/group-guard/claim', async (req, res) => {
    const body = (await httpApi.readBody(req)) || {}
    const key = normalizeClaimKey(body.key)
    if (!key) return httpApi.sendError(res, 400, 'claim key 不合法')
    const ttlMs = Number(body.ttlMs) || DEFAULT_CLAIM_TTL_MS
    const result = claimOnce(key, ttlMs)
    httpApi.sendJson(res, 200, { ok: true, key, ...result })
  }))

  // 处理失败时释放租约，让补偿轮询 / 其它页面可以立即重试。
  disposers.push(httpApi.route('POST', '/api/group-guard/claim/release', async (req, res) => {
    const body = (await httpApi.readBody(req)) || {}
    const key = normalizeClaimKey(body.key)
    if (!key) return httpApi.sendError(res, 400, 'claim key 不合法')
    httpApi.sendJson(res, 200, { ok: true, key, ...releaseClaim(key) })
  }))

  // 查询租约是否仍被占用（不续期、不抢占）。
  disposers.push(httpApi.route('GET', '/api/group-guard/claim', async (req, res, _params, url) => {
    const key = normalizeClaimKey(url?.searchParams?.get('key'))
    if (!key) return httpApi.sendError(res, 400, 'claim key 不合法')
    httpApi.sendJson(res, 200, { ok: true, key, ...isClaimActive(key) })
  }))

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
  })
  ctx.logger.debug?.('[napcat-group-guard] 后端桥已注册：头像代理 + 多页面租约')
}
