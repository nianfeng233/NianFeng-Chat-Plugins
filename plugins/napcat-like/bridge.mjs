/*
 * 念风chat · 扩展插件后端桥 · napcat-like
 *
 * 点赞助手同时可能运行在 WebUI 页面和 headless 代聊 worker 里。
 * NapCat 消息 / 定时器会同时到达多个实例；如果每个实例都执行一次，
 * 就会出现重复点赞、重复回复。这里提供一个进程内租约路由：
 *   POST /api/napcat-like/claim          领取租约
 *   POST /api/napcat-like/claim/release  释放租约
 *   GET  /api/napcat-like/claim?key=     查询租约
 *
 * 后端桥没有加载时，前端会回退到实例内去重，功能不受影响。
 */

export const name = 'napcat-like-bridge'
export const version = '2.0.0'
export const description = 'NapCat 点赞助手后端桥：多实例自动赞 / 「赞我」处理租约仲裁。'
export const core = false
export const inject = ['httpApi']

const MIN_CLAIM_TTL_MS = 1000
const MAX_CLAIM_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000
const MAX_CLAIMS = 5000

const claimStore = new Map()

function pruneClaims(now = Date.now()) {
  if (claimStore.size < 128) return
  if (claimStore.size < MAX_CLAIMS) {
    for (const [key, expiresAt] of claimStore) {
      if (Number(expiresAt) <= now) claimStore.delete(key)
    }
    return
  }
  const doomed = [...claimStore.entries()]
    .sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0))
    .slice(0, Math.ceil(MAX_CLAIMS / 4))
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
  return { released: claimStore.delete(key) }
}

function claimActive(key) {
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
  const disposers = []

  disposers.push(
    httpApi.route('POST', '/api/napcat-like/claim', async (req, res) => {
      try {
        const body = (await httpApi.readBody(req, 256 * 1024)) || {}
        const key = normalizeClaimKey(body.key)
        if (!key) return httpApi.sendError(res, 400, 'claim key 不合法')
        const ttlMs = Number(body.ttlMs) || DEFAULT_CLAIM_TTL_MS
        const result = claimOnce(key, ttlMs)
        httpApi.sendJson(res, 200, { ok: true, key, ...result })
      } catch (err) {
        httpApi.sendError(res, 500, `点赞助手租约领取失败：${err?.message || err}`)
      }
    }),
  )

  disposers.push(
    httpApi.route('POST', '/api/napcat-like/claim/release', async (req, res) => {
      try {
        const body = (await httpApi.readBody(req, 256 * 1024)) || {}
        const key = normalizeClaimKey(body.key)
        if (!key) return httpApi.sendError(res, 400, 'claim key 不合法')
        httpApi.sendJson(res, 200, { ok: true, key, ...releaseClaim(key) })
      } catch (err) {
        httpApi.sendError(res, 500, `点赞助手租约释放失败：${err?.message || err}`)
      }
    }),
  )

  disposers.push(
    httpApi.route('GET', '/api/napcat-like/claim', async (req, res, _params, url) => {
      const key = normalizeClaimKey(url?.searchParams?.get('key'))
      if (!key) return httpApi.sendError(res, 400, 'claim key 不合法')
      httpApi.sendJson(res, 200, { ok: true, key, ...claimActive(key) })
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
  })

  ctx.logger.debug?.('[napcat-like] 后端桥已注册：多实例租约仲裁')
}
