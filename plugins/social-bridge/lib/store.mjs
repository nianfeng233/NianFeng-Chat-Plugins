/*
 * social-bridge · 状态存储
 *
 * 只用一个 JSON 文件保存：
 *   accounts       渠道绑定（B站 / 抖音）
 *   cursors        每个渠道的轮询游标 / 已读 key
 *   inbox          待前端收取的归一化消息
 *   guests         QQ 访客库 + 每个访客的独立消息/记忆
 *   mail           邮箱配置（授权码 AES-256-GCM 加密）
 *   seen           轻量去重记录
 *
 * 桥接进程崩溃最多丢最近 300ms 的状态，消息本体不会丢：
 * 前端收到 inbox 时会 ack。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

const VERSION = 1
const MAX_INBOX = 2000
const MAX_GUEST_MESSAGES = 600
const MAX_ACCOUNT_EVENTS = 800

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function defaultState() {
  return {
    version: VERSION,
    updatedAt: 0,
    accounts: {},
    cursors: {},
    inbox: {},
    history: {},
    guests: {},
    guestIndex: {},
    mail: {
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
      user: '',
      fromName: '',
      authSecret: '',
      secure: true,
    },
    config: {
      pollMs: 60000,
      // 抖音走浏览器自动化，轮询间隔要比普通 API 渠道宽松，避免多会话读取把 CPU 拖死。
      dmPollMs: 120000,
      notifyPollMs: 90000,
      autoReply: { dm: true, mention: true, reply: true, comment: false },
      maxCatchUp: 20,
      mailPageSize: 10,
    },
    seen: {},
  }
}

function ensureList(value) {
  return Array.isArray(value) ? value : []
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

export class SocialStore {
  constructor(dataDir, logger = null) {
    this.dataDir = dataDir
    this.logger = logger
    this.filePath = join(dataDir, 'social-bridge.json')
    this.state = defaultState()
    this.secretKey = null
    this.persistTimer = null
    this.persistChain = Promise.resolve()
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true })
    this.loadSecretKey()
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'))
      const base = defaultState()
      this.state = {
        ...base,
        ...(raw && typeof raw === 'object' ? raw : {}),
        accounts: raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {},
        cursors: raw?.cursors && typeof raw.cursors === 'object' ? raw.cursors : {},
        inbox: raw?.inbox && typeof raw.inbox === 'object' ? raw.inbox : {},
        history: raw?.history && typeof raw.history === 'object' ? raw.history : {},
        guests: raw?.guests && typeof raw.guests === 'object' ? raw.guests : {},
        guestIndex: raw?.guestIndex && typeof raw.guestIndex === 'object' ? raw.guestIndex : {},
        config: { ...base.config, ...(raw?.config || {}), autoReply: { ...base.config.autoReply, ...(raw?.config?.autoReply || {}) } },
        mail: { ...base.mail, ...(raw?.mail || {}) },
        seen: raw?.seen && typeof raw.seen === 'object' ? raw.seen : {},
      }
      const encrypted = this.state.mail?.authSecret || ''
      if (encrypted) {
        try {
          this.state.mail.authCode = this.decrypt(encrypted)
          delete this.state.mail.authSecret
        } catch (error) {
          this.logger?.warn?.(`[social-bridge] 邮箱授权码解密失败：${error.message}`)
        }
      }
      this.logger?.info?.(`[social-bridge] 状态已加载：渠道 ${Object.keys(this.state.accounts).length} 个，访客 ${Object.keys(this.state.guests).length} 个`)
    } catch (_) {
      this.state = defaultState()
    }
    return this
  }

  loadSecretKey() {
    try {
      const keyPath = join(this.dataDir, '.secret-key')
      if (!existsSync(keyPath)) return
      const raw = String(readFileSync(keyPath, 'utf8')).trim()
      if (!raw) return
      this.secretKey = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw).digest()
    } catch (_) {
      this.secretKey = null
    }
  }

  encrypt(value) {
    const text = String(value || '')
    if (!text || !this.secretKey) return text
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.secretKey, iv)
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`
  }

  decrypt(value) {
    const text = String(value || '')
    if (!text) return ''
    if (!text.startsWith('v1:') || !this.secretKey) return text
    const [, ivB64, tagB64, dataB64] = text.split(':')
    const decipher = createDecipheriv('aes-256-gcm', this.secretKey, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  }

  snapshot() {
    return clone(this.state)
  }

  schedulePersist() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persist().catch(error => this.logger?.warn?.(`[social-bridge] 状态写入失败：${error.message}`))
    }, 300)
    this.persistTimer.unref?.()
  }

  async persist() {
    const task = async () => {
      const payload = clone(this.state)
      payload.updatedAt = Date.now()
      if (payload.mail?.authCode) {
        payload.mail.authSecret = this.encrypt(payload.mail.authCode)
        delete payload.mail.authCode
      }
      const tmp = `${this.filePath}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tmp, this.filePath)
    }
    this.persistChain = this.persistChain.then(task, task)
    return this.persistChain
  }

  /* ---------------- 配置 ---------------- */
  config() {
    return this.state.config
  }

  patchConfig(patch = {}) {
    this.state.config = { ...this.state.config, ...(patch || {}), autoReply: { ...this.state.config.autoReply, ...(patch?.autoReply || {}) } }
    this.schedulePersist()
    return this.state.config
  }

  account(channelId) {
    return this.state.accounts[String(channelId || '')] || null
  }

  accounts() {
    return Object.values(this.state.accounts)
  }

  upsertAccount(channelId, patch = {}) {
    const id = String(channelId || '')
    if (!id) return null
    const current = this.state.accounts[id] || { channelId: id, platform: patch.platform || '', createdAt: Date.now() }
    this.state.accounts[id] = {
      ...current,
      ...patch,
      channelId: id,
      updatedAt: Date.now(),
      cursor: { ...(current.cursor || {}), ...(patch.cursor || {}) },
      settings: { ...(current.settings || {}), ...(patch.settings || {}) },
    }
    this.schedulePersist()
    return this.state.accounts[id]
  }

  patchAccount(channelId, patch = {}) {
    const current = this.account(channelId)
    if (!current) return this.upsertAccount(channelId, patch)
    return this.upsertAccount(channelId, patch)
  }

  removeAccount(channelId) {
    const id = String(channelId || '')
    if (!id) return false
    delete this.state.accounts[id]
    this.schedulePersist()
    return true
  }

  /** 邮箱桥模式：清掉旧版社媒 / 访客相关状态，只保留邮箱配置与配置项。 */
  pruneSocialState() {
    const emptyBuckets = ['accounts', 'cursors', 'inbox', 'history', 'guests', 'guestIndex', 'seen']
    let changed = false
    for (const key of emptyBuckets) {
      const value = this.state[key]
      if (value && typeof value === 'object' && Object.keys(value).length) {
        this.state[key] = {}
        changed = true
      }
    }
    if (changed) this.schedulePersist()
    return changed
  }

  /** 渠道被用户删除时清掉它在插件库里的账号、收件箱、历史与去重游标。 */
  removeChannelData(channelId) {
    const id = String(channelId || '')
    if (!id) return false
    let changed = false
    for (const bucket of ['accounts', 'inbox', 'history', 'cursors']) {
      if (!this.state[bucket] || !(id in this.state[bucket])) continue
      delete this.state[bucket][id]
      changed = true
    }
    if (changed) this.schedulePersist()
    return changed
  }

  cursorOf(channelId) {
    const id = String(channelId || '')
    if (!this.state.cursors[id]) this.state.cursors[id] = { seenKeys: [], threads: {}, updatedAt: 0 }
    return this.state.cursors[id]
  }

  markSeen(channelId, key, limit = 800) {
    const id = String(channelId || '')
    const value = String(key || '')
    if (!id || !value) return false
    const cursor = this.cursorOf(id)
    if (!Array.isArray(cursor.seenKeys)) cursor.seenKeys = []
    if (cursor.seenKeys.includes(value)) return false
    cursor.seenKeys.push(value)
    if (cursor.seenKeys.length > limit) cursor.seenKeys.splice(0, cursor.seenKeys.length - limit)
    cursor.updatedAt = Date.now()
    this.schedulePersist()
    return true
  }

  hasSeen(channelId, key) {
    const cursor = this.cursorOf(channelId)
    return Array.isArray(cursor.seenKeys) && cursor.seenKeys.includes(String(key || ''))
  }

  patchThreadCursor(channelId, threadKey, patch = {}) {
    const cursor = this.cursorOf(channelId)
    const key = String(threadKey || '')
    if (!key) return null
    cursor.threads[key] = { ...(cursor.threads[key] || {}), ...patch, updatedAt: Date.now() }
    this.schedulePersist()
    return cursor.threads[key]
  }

  threadCursor(channelId, threadKey) {
    const key = String(threadKey || '')
    return key ? this.cursorOf(channelId).threads[key] || null : null
  }

  /* ---------------- inbox ---------------- */
  pushInbox(channelId, event) {
    const id = String(channelId || '')
    if (!id || !event?.id) return false
    if (!this.state.inbox[id]) this.state.inbox[id] = []
    const list = this.state.inbox[id]
    if (list.some(item => String(item.id) === String(event.id))) return false
    list.push({ ...event, channelId: id, queuedAt: Date.now() })
    if (list.length > MAX_INBOX) list.splice(0, list.length - MAX_INBOX)
    this.schedulePersist()
    return true
  }

  inbox(channelId, { limit = 100, after = 0, kind = '' } = {}) {
    const id = String(channelId || '')
    const list = ensureList(this.state.inbox[id])
    return list
      .filter(item => (!after || Number(item.queuedAt) > Number(after)) && (!kind || item.kind === kind))
      .slice(-Math.max(1, Math.min(500, Number(limit) || 100)))
      .map(clone)
  }

  ackInbox(channelId, ids = []) {
    const id = String(channelId || '')
    const list = ensureList(this.state.inbox[id])
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(value => String(value || '')))
    const kept = list.filter(item => !wanted.has(String(item.id)))
    const removed = list.length - kept.length
    this.state.inbox[id] = kept
    if (removed) this.schedulePersist()
    return removed
  }

  clearInbox(channelId) {
    const id = String(channelId || '')
    const removed = ensureList(this.state.inbox[id]).length
    this.state.inbox[id] = []
    if (removed) this.schedulePersist()
    return removed
  }

  /* ---------------- 历史记录 ---------------- */
  pushHistory(channelId, event) {
    const id = String(channelId || '')
    if (!id || !event?.id) return false
    if (!this.state.history[id]) this.state.history[id] = []
    const list = this.state.history[id]
    if (list.some(item => String(item.id) === String(event.id))) return false
    list.push({ ...event, channelId: id, storedAt: Date.now() })
    if (list.length > MAX_ACCOUNT_EVENTS) list.splice(0, list.length - MAX_ACCOUNT_EVENTS)
    this.schedulePersist()
    return true
  }

  findHistoryEvent(channelId, eventId) {
    const list = ensureList(this.state.history[String(channelId || '')])
    return list.find(item => String(item.id) === String(eventId || '')) || null
  }

  history(channelId, { limit = 50, kind = '', senderId = '', threadKey = '', before = 0, after = 0, keyword = '' } = {}) {
    const id = String(channelId || '')
    const needle = String(keyword || '').toLowerCase()
    return ensureList(this.state.history[id])
      .filter(item => {
        if (kind && item.kind !== kind) return false
        if (senderId && String(item.sender?.id || '') !== String(senderId)) return false
        if (threadKey && String(item.threadKey || item.conversationKey || '') !== String(threadKey)) return false
        if (before && Number(item.timestamp || 0) >= Number(before)) return false
        if (after && Number(item.timestamp || 0) <= Number(after)) return false
        if (needle && !`${item.content || ''} ${item.sender?.name || ''}`.toLowerCase().includes(needle)) return false
        return true
      })
      .slice(-Math.max(1, Math.min(500, Number(limit) || 50)))
      .map(clone)
  }

  /* ---------------- 访客 ---------------- */
  guestKey(platform, accountId, userId) {
    return sha256(`${platform}:${accountId}:${userId}`).slice(0, 24)
  }

  guestIndex(platform, userId) {
    return this.state.guestIndex[`${platform}:${userId}`] || this.state.guestIndex[`${platform}:${String(userId || '')}`] || null
  }

  upsertGuest({ platform = 'qq', accountId = '', userId = '', name = '', remark = '', metadata = {} } = {}) {
    const uid = String(userId || '').trim()
    if (!uid) return null
    const key = this.guestKey(platform, accountId, uid)
    const current = this.state.guests[key] || {
      key,
      platform,
      accountId,
      userId: uid,
      name,
      remark,
      firstSeenAt: Date.now(),
      messages: [],
      notes: [],
      permission: { dialog: false, dialogUntil: 0, reason: '' },
    }
    const next = {
      ...current,
      platform,
      accountId,
      userId: uid,
      name: name || current.name || uid,
      remark: remark || current.remark || '',
      metadata: { ...(current.metadata || {}), ...(metadata || {}) },
      updatedAt: Date.now(),
    }
    this.state.guests[key] = next
    this.state.guestIndex[`${platform}:${uid}`] = key
    this.schedulePersist()
    return next
  }

  guests() {
    return Object.values(this.state.guests)
  }

  guest(key) {
    return this.state.guests[String(key || '')] || null
  }

  addGuestMessage(key, message = {}) {
    const guest = this.guest(key)
    if (!guest) return null
    const normalized = {
      id: String(message.id || `${Date.now()}-${randomBytes(3).toString('hex')}`),
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content ?? message.text ?? '').slice(0, 20000),
      senderId: String(message.senderId || ''),
      senderName: String(message.senderName || ''),
      at: Number(message.at) || Date.now(),
      kind: String(message.kind || 'dm'),
      direction: message.direction || (message.role === 'assistant' ? 'outbound' : 'inbound'),
      metadata: message.metadata || {},
    }
    if (!normalized.content.trim()) return null
    if (guest.messages.some(item => String(item.id) === normalized.id)) return null
    guest.messages.push(normalized)
    if (guest.messages.length > MAX_GUEST_MESSAGES) guest.messages.splice(0, guest.messages.length - MAX_GUEST_MESSAGES)
    guest.updatedAt = Date.now()
    this.schedulePersist()
    return normalized
  }

  readGuestMessages(key, { limit = 30, before = 0 } = {}) {
    const guest = this.guest(key)
    if (!guest) return []
    return guest.messages
      .filter(item => !before || item.at < before)
      .slice(-Math.max(1, Math.min(200, Number(limit) || 30)))
      .map(clone)
  }

  grantGuest(key, { until = Date.now() + 30 * 60 * 1000, reason = '' } = {}) {
    const guest = this.guest(key)
    if (!guest) return null
    guest.permission = { dialog: true, dialogUntil: Number(until) || Date.now(), reason: String(reason || '') }
    guest.updatedAt = Date.now()
    this.schedulePersist()
    return guest.permission
  }

  revokeGuest(key) {
    const guest = this.guest(key)
    if (!guest) return null
    guest.permission = { dialog: false, dialogUntil: 0, reason: '' }
    guest.updatedAt = Date.now()
    this.schedulePersist()
    return guest.permission
  }

  guestPermission(key) {
    const guest = this.guest(key)
    if (!guest?.permission) return { dialog: false, dialogUntil: 0 }
    const permission = { ...guest.permission }
    if (permission.dialog && permission.dialogUntil && Number(permission.dialogUntil) < Date.now()) {
      permission.dialog = false
    }
    return permission
  }

  addGuestNote(key, note = {}, source = 'model') {
    const guest = this.guest(key)
    if (!guest) return null
    const content = String(note.content ?? note.text ?? '').trim()
    if (!content) return null
    const item = {
      id: randomBytes(6).toString('hex'),
      content: content.slice(0, 4000),
      tags: Array.isArray(note.tags) ? note.tags.slice(0, 10) : [],
      source,
      at: Date.now(),
    }
    guest.notes.push(item)
    if (guest.notes.length > 200) guest.notes.splice(0, guest.notes.length - 200)
    guest.updatedAt = Date.now()
    this.schedulePersist()
    return item
  }

  /* ---------------- 邮箱 ---------------- */
  mailConfig() {
    return clone(this.state.mail)
  }

  patchMailConfig(patch = {}) {
    const next = { ...this.state.mail }
    for (const [key, value] of Object.entries(patch || {})) {
      if (value === undefined) continue
      if (key === 'authCode' || key === 'authSecret') continue
      next[key] = value
    }
    if (typeof patch.authCode === 'string') next.authCode = patch.authCode
    this.state.mail = next
    this.schedulePersist()
    return clone(next)
  }
}

export function createStore(dataDir, logger) {
  return new SocialStore(dataDir, logger)
}
