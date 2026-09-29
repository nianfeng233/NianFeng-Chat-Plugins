/*
 * bilibili · 渠道状态持久化
 * 文件：<数据目录>/bilibili.json
 * Cookie 值使用 AES-256-GCM 加密，密钥复用念风数据目录的 .secret-key。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'

const ENC_PREFIX = 'enc:v1:'
export const MAX_INBOX = 300

export function defaultAccountState() {
  return {
    createdAt: 0,
    updatedAt: 0,
    cookies: [],
    profile: { uid: '', nickname: '', avatar: '', loggedAt: 0 },
    settings: {
      capabilities: { dm: true, notice: true, commentScan: false },
      noticeKinds: { reply: true, at: true, like: false, system: false },
      poll: { dmSec: 20, noticeSec: 30, commentSec: 300 },
      limits: {
        dmPerHour: 20,
        dmPerDay: 80,
        dmMinIntervalMs: 4000,
        commentPerHour: 5,
        commentPerDay: 20,
        commentMinIntervalMs: 15000,
        videoPerHour: 20,
        videoPerDay: 60,
        videoMinIntervalMs: 4000,
      },
      browserFallback: true,
      browserHeadless: true,
      // auto：协议优先、风控时浏览器兜底；browser：评论/互动写操作优先走浏览器页面请求（更接近真人）。
      sendVia: 'auto',
      // 实时私信：常驻 message.bilibili.com 标签页镜像官方长连接；失败自动回退轮询。
      realtime: { enabled: true },
      videos: [],
      autoOwnVideos: false,
    },
    cursors: { dm: { peers: {} }, notices: { reply: {}, at: {}, like: {}, system: {} }, comments: {} },
    inbox: [],
    inboxSeq: 0,
    daily: { date: '', dm: 0, comment: 0 },
    risk: { until: 0, code: 0, message: '', at: 0 },
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

export function createStateStore({ dataDir, logger = null }) {
  const statePath = () => join(dataDir, 'bilibili.json')
  const keyPath = () => join(dataDir, '.secret-key')
  let secretKey = null
  let state = { version: 1, updatedAt: 0, accounts: {} }
  let persistTimer = null
  let persistChain = Promise.resolve()
  let closed = false

  const encrypt = plain => {
    const value = String(plain ?? '')
    if (!value || !secretKey) return value
    if (value.startsWith(ENC_PREFIX)) return value
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secretKey, iv)
    const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `${ENC_PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${payload.toString('base64')}`
  }

  const decrypt = stored => {
    const value = String(stored ?? '')
    if (!value || !value.startsWith(ENC_PREFIX)) return value
    if (!secretKey) return ''
    try {
      const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split(':')
      const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
    } catch (_) {
      logger?.warn?.('[bilibili] 登录凭据解密失败，请重新登录')
      return ''
    }
  }

  const ensureSecret = async () => {
    try {
      const raw = (await readFile(keyPath(), 'utf8')).trim()
      const key = Buffer.from(raw, 'base64')
      if (key.length === 32) return key
    } catch (_) {
      /* 不存在 / 损坏：重建 */
    }
    const key = randomBytes(32)
    await mkdir(dataDir, { recursive: true })
    await writeFile(keyPath(), key.toString('base64'), 'utf8')
    await chmod(keyPath(), 0o600).catch(() => {})
    return key
  }

  const persistNow = async () => {
    await mkdir(dataDir, { recursive: true })
    const accounts = {}
    for (const [id, account] of Object.entries(state.accounts)) accounts[id] = clone(account)
    for (const account of Object.values(accounts)) {
      account.cookies = (account.cookies || []).map(cookie => ({ ...cookie, value: encrypt(cookie.value) }))
    }
    const payload = { version: 1, updatedAt: Date.now(), accounts }
    const tmp = `${statePath()}.${process.pid}.${Date.now().toString(36)}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, statePath())
    await chmod(statePath(), 0o600).catch(() => {})
    state.updatedAt = payload.updatedAt
  }

  const schedulePersist = () => {
    if (closed) return
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistChain = persistChain.then(persistNow, persistNow).catch(err => logger?.warn?.(`[bilibili] 状态写入失败：${err?.message || err}`))
    }, 600)
    persistTimer.unref?.()
  }

  const load = async () => {
    await mkdir(dataDir, { recursive: true })
    secretKey = await ensureSecret()
    let raw = null
    try {
      raw = JSON.parse(await readFile(statePath(), 'utf8'))
    } catch (_) {
      raw = null
    }
    const accounts = raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {}
    for (const [id, stored] of Object.entries(accounts)) {
      const account = { ...defaultAccountState(), ...(stored || {}) }
      account.cookies = (Array.isArray(account.cookies) ? account.cookies : [])
        .map(cookie => ({ ...cookie, value: decrypt(cookie?.value) }))
        .filter(cookie => cookie?.name && cookie?.value)
      account.inbox = Array.isArray(account.inbox) ? account.inbox.slice(-MAX_INBOX) : []
      accounts[id] = account
    }
    state = { version: 1, updatedAt: Number(raw?.updatedAt) || 0, accounts }
    logger?.info?.(`[bilibili] 已加载 ${Object.keys(accounts).length} 个渠道状态`)
  }

  const account = (channelId, { create = true } = {}) => {
    const id = String(channelId || '').trim()
    if (!id) return null
    let current = state.accounts[id]
    if (!current && create) {
      current = defaultAccountState()
      current.createdAt = Date.now()
      state.accounts[id] = current
    }
    return current || null
  }

  const patchAccount = (channelId, patch) => {
    const current = account(channelId)
    if (!current || !patch) return current
    Object.assign(current, patch)
    current.updatedAt = Date.now()
    schedulePersist()
    return current
  }

  const mergeSettings = (channelId, settings) => {
    const current = account(channelId)
    if (!current) return null
    const base = defaultAccountState().settings
    const next = settings && typeof settings === 'object' ? settings : {}
    current.settings = {
      ...base,
      ...current.settings,
      ...next,
      capabilities: { ...base.capabilities, ...(current.settings?.capabilities || {}), ...(next.capabilities || {}) },
      noticeKinds: { ...base.noticeKinds, ...(current.settings?.noticeKinds || {}), ...(next.noticeKinds || {}) },
      poll: { ...base.poll, ...(current.settings?.poll || {}), ...(next.poll || {}) },
      limits: { ...base.limits, ...(current.settings?.limits || {}), ...(next.limits || {}) },
      realtime: { ...base.realtime, ...(current.settings?.realtime || {}), ...(next.realtime || {}) },
      videos: Array.isArray(next.videos) ? next.videos.map(item => String(item || '').trim()).filter(Boolean).slice(0, 50) : current.settings?.videos || [],
    }
    current.updatedAt = Date.now()
    schedulePersist()
    return current.settings
  }

  const pushInbox = (channelId, item) => {
    const current = account(channelId)
    if (!current || !item) return 0
    current.inboxSeq = (Number(current.inboxSeq) || 0) + 1
    item.seq = current.inboxSeq
    current.inbox.push(item)
    if (current.inbox.length > MAX_INBOX) current.inbox = current.inbox.slice(-MAX_INBOX)
    schedulePersist()
    return current.inboxSeq
  }

  const removeAccount = channelId => {
    const id = String(channelId || '')
    if (!id || !state.accounts[id]) return false
    delete state.accounts[id]
    schedulePersist()
    return true
  }

  const flush = async () => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    await persistChain.catch(() => {})
    await persistNow()
  }

  const dispose = () => {
    closed = true
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = null
  }

  return {
    ready: load(),
    state: () => state,
    account,
    patchAccount,
    mergeSettings,
    pushInbox,
    removeAccount,
    schedulePersist,
    flush,
    dispose,
    paths: { statePath, keyPath },
  }
}
