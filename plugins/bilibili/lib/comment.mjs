/*
 * bilibili · 评论模块（扫描收 / 主动发 / 回复）
 *
 * 收：
 *   - 消息中心里「回复我的 / @我的」由 notice.mjs 负责；
 *   - 这里负责按配置监控指定稿件（或自动取 UP 主最近投稿）的最新评论。
 * 发：
 *   - post()  在视频下发一条新评论；
 *   - reply() 回复某条评论（root / parent 自动按 B站楼中楼规则组织）。
 * 发送使用独立串行队列与频率 / 每日上限。
 */
import { libUrl } from './rev.mjs'

const { RateLimitedQueue } = await import(libUrl('queue.mjs'))
const { normalizeComment, parseTarget } = await import(libUrl('normalize.mjs'))
const { sleep } = await import(libUrl('util.mjs'))

const SEEN_LIMIT = 300
const MAX_VIDEOS_PER_POLL = 4
const TARGET_TTL = 6 * 60 * 60 * 1000
// 首次扫描只静默入库最新几条评论，更早的历史仅标记已读，避免一次性灌爆。
const FIRST_SYNC_LIMIT = 3
const FIRST_SYNC_MAX_ITEMS = 10
const BACKLOG_AGE_MS = 10 * 60 * 1000

export class CommentModule {
  constructor({ transport, state, getSettings, getSelfUid, logger = null, emit = () => {} } = {}) {
    this.transport = transport
    this.state = state
    this.getSettings = getSettings
    this.getSelfUid = getSelfUid
    this.logger = logger
    this.emit = emit
    this.polling = false
    this.ownCache = { at: 0, list: [] }
    this.queue = new RateLimitedQueue({ name: 'comment', logger })
  }

  applyLimits() {
    const limits = this.getSettings()?.limits || {}
    this.queue.configure({
      minIntervalMs: limits.commentMinIntervalMs,
      jitterMs: Math.max(3000, Number(limits.commentMinIntervalMs) || 30000),
      perHour: limits.commentPerHour,
      perDay: limits.commentPerDay,
    })
  }

  commentStore() {
    const comments = (this.state.cursors.comments = this.state.cursors.comments || {})
    comments.targets = comments.targets || {}
    comments.seen = comments.seen || {}
    comments.initialized = comments.initialized || {}
    comments.rotateIndex = Number(comments.rotateIndex) || 0
    return comments
  }

  seenOf(key) {
    const store = this.commentStore()
    const current = (store.seen[key] = store.seen[key] || [])
    return current
  }

  async resolveCached(target, { force = false } = {}) {
    const store = this.commentStore()
    const input = target && typeof target === 'object' ? target : parseTarget(target)
    if (!input) return null
    const parsed = {
      bvid: String(input.bvid || ''),
      aid: String(input.aid || (input.oid && (Number(input.type) || 1) === 1 ? input.oid : '')),
      oid: String(input.oid || ''),
      type: Number(input.type) || 1,
      short: String(input.short || ''),
    }
    const key = parsed.bvid || parsed.aid || `${parsed.type}:${parsed.oid}`
    if (!key || key === '1:') return null
    const cached = store.targets[key]
    if (!force && cached && Date.now() - Number(cached.at || 0) < TARGET_TTL) return cached
    try {
      if (parsed.short || parsed.bvid || parsed.aid) {
        const resolved = await this.transport.call('resolveTarget', [parsed.short || parsed.bvid || parsed.aid])
        const next = { ...resolved, key: resolved.bvid || resolved.aid || key, at: Date.now() }
        store.targets[key] = next
        return next
      }
      const next = { bvid: '', aid: '', oid: parsed.oid, type: parsed.type, title: '', key, at: Date.now() }
      store.targets[key] = next
      return next
    } catch (err) {
      this.logger?.warn?.(`[bilibili] 解析目标失败「${parsed.bvid || parsed.aid || parsed.oid}」：${err?.message || err}`)
      return cached || null
    }
  }

  async candidateTargets() {
    const settings = this.getSettings() || {}
    const list = Array.isArray(settings.videos) ? settings.videos.filter(Boolean) : []
    if (settings.autoOwnVideos && this.getSelfUid()) {
      if (Date.now() - this.ownCache.at > 60 * 60 * 1000) {
        try {
          const videos = await this.transport.call('ownVideos', [this.getSelfUid(), { ps: 10 }])
          this.ownCache = { at: Date.now(), list: videos.map(item => item.bvid || item.aid).filter(Boolean) }
        } catch (err) {
          this.logger?.warn?.(`[bilibili] 获取 UP 主投稿失败：${err?.message || err}`)
          this.ownCache.at = Date.now()
        }
      }
      list.push(...this.ownCache.list)
    }
    const unique = [...new Set(list.map(item => String(item || '').trim()).filter(Boolean))]
    if (!unique.length) return []
    const store = this.commentStore()
    const start = store.rotateIndex % unique.length
    const picked = []
    for (let i = 0; i < Math.min(MAX_VIDEOS_PER_POLL, unique.length); i += 1) picked.push(unique[(start + i) % unique.length])
    store.rotateIndex = (start + picked.length) % unique.length
    return picked
  }

  flattenReplies(replies, root = '0') {
    const out = []
    for (const reply of Array.isArray(replies) ? replies : []) {
      out.push({ raw: reply, root })
      if (Array.isArray(reply?.replies) && reply.replies.length) out.push(...this.flattenReplies(reply.replies, String(reply.rpid || root)))
    }
    return out
  }

  async pollOnce() {
    if (this.polling) return { skipped: true }
    this.polling = true
    const items = []
    try {
      const targets = await this.candidateTargets()
      const selfUid = this.getSelfUid()
      let firstSyncBudget = FIRST_SYNC_MAX_ITEMS
      for (const target of targets) {
        const resolved = await this.resolveCached(target)
        if (!resolved?.oid) continue
        const key = resolved.key || resolved.bvid || resolved.aid || resolved.oid
        let data = null
        try {
          data = await this.transport.call('comments', [{ oid: resolved.oid, type: resolved.type || 1, ps: 20, pn: 1, sort: 0 }])
        } catch (err) {
          this.logger?.warn?.(`[bilibili] 拉取评论失败「${resolved.title || key}」：${err?.message || err}`)
          continue
        }
        const seen = this.seenOf(key)
        const known = new Set(seen)
        const store = this.commentStore()
        const firstSync = !store.initialized[key]
        const flat = this.flattenReplies(data?.replies || [])
        let emitted = 0
        let skipped = 0
        for (const { raw, root } of flat) {
          const item = normalizeComment(raw, {
            oid: resolved.oid,
            type: resolved.type || 1,
            bvid: resolved.bvid || '',
            title: resolved.title || '',
            selfUid,
            root,
            parent: root && root !== '0' ? String(raw?.rpid || '') : '',
          })
          if (!item) continue
          if (String(item.sender.uid) === String(selfUid)) continue
          if (known.has(item.target.rpid)) continue
          known.add(item.target.rpid)
          if (firstSync && (emitted >= FIRST_SYNC_LIMIT || firstSyncBudget <= 0)) {
            skipped += 1
            continue
          }
          item.thread.name = `B站评论 · ${item.thread.name || resolved.oid}`
          item.video = {
            bvid: resolved.bvid || '',
            aid: resolved.aid || '',
            title: resolved.title || '',
            desc: resolved.desc || '',
            owner: resolved.owner || '',
            url: resolved.url || (resolved.bvid ? `https://www.bilibili.com/video/${resolved.bvid}` : ''),
          }
          item.backlog = firstSync || Date.now() - item.at > BACKLOG_AGE_MS
          if (firstSync) {
            emitted += 1
            firstSyncBudget -= 1
          }
          items.push(item)
        }
        store.initialized[key] = true
        store.seen[key] = [...known].slice(-SEEN_LIMIT)
        if (firstSync) this.logger?.info?.(`[bilibili] 评论监控「${resolved.title || key}」首次扫描：静默入库 ${emitted} 条，跳过 ${skipped} 条更早评论`)
      }
      for (const item of items) this.emit(item)
      if (items.length) this.logger?.info?.(`[bilibili] 监控稿件收到 ${items.length} 条新评论`)
      return { items: items.length }
    } finally {
      this.polling = false
    }
  }

  commentRpid(result) {
    return String(result?.rpid || result?.rpid_str || result?.data?.rpid || result?.data?.rpid_str || '')
  }

  /**
   * 发完评论后回查公开列表：B站返回 code=0 只说明提交成功，不代表已公开展示。
   * 新评论的列表索引可能延迟，所以默认重试 3 次；同时查楼中楼与最新主评论，
   * 避免因为接口延迟或 fallback 成顶层评论而误报“被折叠”。
   */
  async verifyReply({ oid, type, root, rpid, attempts = 3, retryDelayMs = 2500 }) {
    if (!oid || !rpid) return null
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      if (attempt) await sleep(retryDelayMs)
      try {
        if (root) {
          const data = await this.transport.call('commentReplies', [{ oid, type, root, ps: 20, pn: 1 }])
          const list = data?.replies || data?.data?.replies || []
          if (list.some(item => String(item?.rpid || item?.rpid_str || '') === String(rpid))) return true
        }
        const main = await this.transport.call('comments', [{ oid, type, ps: 20, pn: 1, sort: 0 }])
        const flat = this.flattenReplies(main?.replies || [])
        if (flat.some(({ raw }) => String(raw?.rpid || raw?.rpid_str || '') === String(rpid))) return true
      } catch (err) {
        this.logger?.debug?.(`[bilibili] 回查评论可见性（${attempt + 1}/${attempts}）失败：${err?.message || err}`)
      }
    }
    return false
  }

  async post(target, text) {
    this.applyLimits()
    const resolved = await this.resolveCached(target)
    if (!resolved?.oid) throw new Error(`没有识别出要评论的视频：${typeof target === 'object' ? JSON.stringify(target) : String(target || '')}`)
    const result = await this.queue.push(() => this.transport.call('commentAdd', [{ oid: resolved.oid, type: resolved.type || 1, message: text }]))
    const rpid = this.commentRpid(result)
    if (rpid) this.logger?.info?.(`[bilibili] 评论已提交 rpid=${rpid}（视频 ${resolved.bvid || resolved.oid}）`)
    return { ...(result && typeof result === 'object' ? result : {}), rpid }
  }

  async reply(target, rpid, text, extra = {}) {
    this.applyLimits()
    const resolved = await this.resolveCached(target)
    if (!resolved?.oid) throw new Error(`没有识别出评论目标：${typeof target === 'object' ? JSON.stringify(target) : String(target || '')}`)
    const root = String(extra.root || rpid || '')
    const parent = String(extra.parent || rpid || '')
    const result = await this.queue.push(() => this.transport.call('commentAdd', [{ oid: resolved.oid, type: resolved.type || 1, message: text, root, parent }]))
    const replyRpid = this.commentRpid(result)
    const verified = await this.verifyReply({ oid: resolved.oid, type: resolved.type || 1, root, rpid: replyRpid })
    if (verified === true) {
      this.logger?.info?.(`[bilibili] 评论回复已发布并公开可见 rpid=${replyRpid}（root=${root}）`)
    } else if (verified === false) {
      this.logger?.warn?.(
        `[bilibili] 评论回复 rpid=${replyRpid} 已提交，但未出现在公开回复列表：可能在审核 / 被折叠 / 仅自己可见（root=${root}）`,
      )
    }
    return { ...(result && typeof result === 'object' ? result : {}), rpid: replyRpid, root, verified }
  }

  async list(target, limit = 20) {
    const resolved = await this.resolveCached(target)
    if (!resolved?.oid) throw new Error(`没有识别出视频：${target}`)
    const data = await this.transport.call('comments', [{ oid: resolved.oid, type: resolved.type || 1, ps: limit, pn: 1, sort: 0 }])
    const selfUid = this.getSelfUid()
    return this.flattenReplies(data?.replies || [])
      .map(({ raw, root }) => normalizeComment(raw, { oid: resolved.oid, type: resolved.type || 1, bvid: resolved.bvid || '', title: resolved.title || '', selfUid, root }))
      .filter(Boolean)
  }

  stats() {
    return { ...this.queue.stats(), monitored: Object.keys(this.commentStore().targets || {}).length }
  }
}
