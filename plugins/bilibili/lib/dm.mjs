/*
 * bilibili · 私信模块（收 / 发独立）
 * 收：会话列表 + 增量拉取，去重后交给上层策略判定。
 * 发：独立串行队列 + 频率 / 每日上限，与评论模块互不阻塞。
 */
import { libUrl } from './rev.mjs'

const { RateLimitedQueue } = await import(libUrl('queue.mjs'))
const { normalizeDmSessions, normalizeDmMessage } = await import(libUrl('normalize.mjs'))

const SEEN_LIMIT = 80
// 首次同步 / 断线很久后的历史保护：只静默入库最近几条，其余仅标记已读。
const FIRST_SYNC_LIMIT = 3
const FIRST_SYNC_MAX_ITEMS = 12
const MAX_SESSIONS_PER_POLL = 10
const BACKLOG_AGE_MS = 10 * 60 * 1000

export class DmModule {
  constructor({ transport, state, getSettings, getSelfUid, logger = null, emit = () => {} } = {}) {
    this.transport = transport
    this.state = state
    this.getSettings = getSettings
    this.getSelfUid = getSelfUid
    this.logger = logger
    this.emit = emit
    this.polling = false
    this.queue = new RateLimitedQueue({ name: 'dm', logger })
    // 消息记录接口失败退避：接口不可用时仍用会话列表 last_msg 兜底，避免刷屏警告。
    this.messageBackoffUntil = 0
    this.lastMessageError = ''
    this.lastMessageErrorAt = 0
  }

  applyLimits() {
    const limits = this.getSettings()?.limits || {}
    this.queue.configure({
      minIntervalMs: limits.dmMinIntervalMs,
      jitterMs: Math.max(1000, Number(limits.dmMinIntervalMs) || 4000),
      perHour: limits.dmPerHour,
      perDay: limits.dmPerDay,
    })
  }

  cursor(peerUid) {
    const store = (this.state.cursors.dm = this.state.cursors.dm || { peers: {} })
    const peers = (store.peers = store.peers || {})
    const key = String(peerUid)
    const current = (peers[key] = peers[key] || { lastTs: 0, lastKey: '', name: '', avatar: '', seen: [] })
    if (!Array.isArray(current.seen)) current.seen = []
    return current
  }

  /**
   * 消息记录接口不可用时的兜底：用会话列表返回的 last_msg 交出一条最新消息。
   * 只记 seen、不推进 lastTs，接口恢复后仍能回填更早的遗漏消息。
   */
  synthesizeLatest(session, cursor, items) {
    const raw = session?.last
    if (!raw?.msg_key || !raw?.content) return
    if (cursor.seen.includes(raw.msg_key)) return
    const item = normalizeDmMessage(raw, { selfUid: this.getSelfUid() })
    if (!item) return
    if (!item.sender.name) item.sender.name = session.nickname || cursor.name || ''
    if (!item.sender.avatar) item.sender.avatar = session.avatar || cursor.avatar || ''
    item.thread.name = `B站私信 · ${item.sender.name || item.sender.uid}`
    item.backlog = Date.now() - item.at > BACKLOG_AGE_MS
    cursor.seen = [...new Set([...cursor.seen, raw.msg_key])].slice(-SEEN_LIMIT)
    items.push(item)
  }

  noteMessageError(err) {
    const now = Date.now()
    if (now - this.lastMessageErrorAt < 5 * 60 * 1000) return
    this.lastMessageErrorAt = now
    this.logger?.warn?.(
      `[bilibili] 私信记录接口暂不可用（${String(err?.message || err).slice(0, 160)}）；已改用会话 last_msg 兜底，60 秒后重试，实时镜像不受影响`,
    )
  }

  /** 实时模块已经把某条消息交给上层时，把游标推进，避免下一轮轮询重复推送。 */
  markSeen(peerUid, msgKey, timestamp) {
    const cursor = this.cursor(peerUid)
    const key = String(msgKey || '')
    if (key && !cursor.seen.includes(key)) cursor.seen.push(key)
    cursor.seen = cursor.seen.slice(-SEEN_LIMIT)
    if (key) cursor.lastKey = key
    cursor.lastTs = Math.max(Number(cursor.lastTs) || 0, Number(timestamp) || 0)
  }

  async pollOnce() {
    if (this.polling) return { skipped: true }
    this.polling = true
    const items = []
    try {
      const data = await this.transport.call('dmSessions')
      const allSessions = normalizeDmSessions(data)
      // 未读优先、其次最近活跃；单次最多处理一批，避免几十个会话串行拉取造成“等很久 + 一次性灌入”。
      const ordered = allSessions
        .slice()
        .sort((a, b) => (Number(b.unread) || 0) - (Number(a.unread) || 0) || Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0))
      const dmCursors = (this.state.cursors.dm = this.state.cursors.dm || { peers: {} })
      const rotateStart = Number(dmCursors.rotateIndex) || 0
      const sessions = []
      for (let index = 0; index < Math.min(MAX_SESSIONS_PER_POLL, ordered.length); index += 1) {
        sessions.push(ordered[(rotateStart + index) % ordered.length])
      }
      dmCursors.rotateIndex = ordered.length ? (rotateStart + sessions.length) % ordered.length : 0
      let firstSyncBudget = FIRST_SYNC_MAX_ITEMS
      let firstSyncSessions = 0
      let skippedHistory = 0
      const selfUid = this.getSelfUid()
      for (const session of sessions) {
        const cursor = this.cursor(session.peerUid)
        if (session.nickname) cursor.name = session.nickname
        if (!cursor.name) {
          try {
            const card = await this.transport.call('userCard', [session.peerUid])
            if (card?.nickname) {
              cursor.name = card.nickname
              cursor.avatar = card.avatar
            }
          } catch (_) {
            /* 用户资料失败不影响收信 */
          }
        }
        const known = new Set(cursor.seen)
        const hasNew = Number(session.lastTimestamp) > Number(cursor.lastTs) || (session.lastMsgKey && !known.has(session.lastMsgKey))
        if (!hasNew && session.unread <= 0) continue
        let payload = null
        let fetchError = null
        if (this.messageBackoffUntil > Date.now()) {
          fetchError = new Error(this.lastMessageError || '私信记录接口暂不可用')
        } else {
          try {
            payload = await this.transport.call('dmMessages', [session.peerUid, { size: 20, sessionId: session.sessionId }])
            this.messageBackoffUntil = 0
          } catch (err) {
            fetchError = err
            this.messageBackoffUntil = Date.now() + 60000
            this.lastMessageError = String(err?.message || err).slice(0, 200)
          }
        }
        if (fetchError) {
          this.synthesizeLatest(session, cursor, items)
          this.noteMessageError(fetchError)
          continue
        }
        const messages = (payload?.messages || payload?.msgs || []).slice().sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
        const firstSync = !cursor.lastKey && !cursor.lastTs
        if (firstSync) firstSyncSessions += 1
        // 首次同步只保留最近几条做静默上下文，更早的历史只标记已读，绝不触发模型。
        const emitKeys = new Set(
          (firstSync ? messages.slice(-FIRST_SYNC_LIMIT) : messages).map(raw => String(raw?.msg_key ?? raw?.msgKey ?? '')),
        )
        for (const raw of messages) {
          const msgKey = String(raw?.msg_key ?? raw?.msgKey ?? '')
          if (msgKey && known.has(msgKey)) continue
          if (msgKey) known.add(msgKey)
          if (firstSync && (!emitKeys.has(msgKey) || firstSyncBudget <= 0)) {
            skippedHistory += 1
            continue
          }
          const item = normalizeDmMessage(raw, { selfUid })
          if (!item) continue
          if (!item.sender.name) item.sender.name = session.nickname || cursor.name || ''
          if (!item.sender.avatar) item.sender.avatar = session.avatar || cursor.avatar || ''
          item.thread.name = `B站私信 · ${item.sender.name || item.sender.uid}`
          item.backlog = firstSync || Date.now() - item.at > BACKLOG_AGE_MS
          if (firstSync) firstSyncBudget -= 1
          items.push(item)
        }
        const last = messages[messages.length - 1]
        cursor.seen = [...known].slice(-SEEN_LIMIT)
        cursor.lastTs = Math.max(Number(cursor.lastTs) || 0, Number(last?.timestamp) || 0, Number(session.lastTimestamp) || 0)
        cursor.lastKey = String(last?.msg_key || session.lastMsgKey || cursor.lastKey || '')
      }
      if (firstSyncSessions) {
        this.logger?.info?.(
          `[bilibili] 首次同步 ${firstSyncSessions} 个会话：历史消息只静默入库，跳过 ${skippedHistory} 条更早记录`,
        )
      }
      for (const item of items) this.emit(item)
      if (items.length) this.logger?.info?.(`[bilibili] 收到 ${items.length} 条私信`)
      return { items: items.length }
    } finally {
      this.polling = false
    }
  }

  send(peerUid, text) {
    this.applyLimits()
    return this.queue.push(() => this.transport.call('dmSend', [peerUid, text]))
  }

  async listSessions() {
    const data = await this.transport.call('dmSessions')
    return normalizeDmSessions(data)
  }

  async messages(peerUid, limit = 20) {
    const data = await this.transport.call('dmMessages', [peerUid, { size: limit }])
    return (data?.messages || data?.msgs || [])
      .slice()
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
      .map(raw => normalizeDmMessage(raw, { selfUid: this.getSelfUid() }))
      .filter(Boolean)
  }

  stats() {
    return this.queue.stats()
  }
}
