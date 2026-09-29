/*
 * bilibili · 消息中心模块（回复我的 / @我的 / 收到的赞 / 系统消息）
 * 对应 B站主页右上角「消息」下拉与 message.bilibili.com 通知页。
 * 默认只处理「回复我的 / @我的」，点赞与系统消息默认关闭，避免噪音触发回复。
 */
import { libUrl } from './rev.mjs'

const { normalizeNotice } = await import(libUrl('normalize.mjs'))

const SEEN_LIMIT = 200
const KINDS = ['reply', 'at', 'like', 'system']
// 首次同步 / 断线很久后的历史保护：只静默入库最近几条，其余仅标记已读。
const FIRST_SYNC_LIMIT = 3
const FIRST_SYNC_MAX_ITEMS = 10
const BACKLOG_AGE_MS = 10 * 60 * 1000

export class NoticeModule {
  constructor({ transport, state, getSettings, getSelfUid, logger = null, emit = () => {} } = {}) {
    this.transport = transport
    this.state = state
    this.getSettings = getSettings
    this.getSelfUid = getSelfUid
    this.logger = logger
    this.emit = emit
    this.polling = false
    this.unread = {}
    // 通知补全用的缓存：视频信息 30 分钟，评论反查 5 分钟，自己投稿列表 30 分钟。
    this.videoCache = new Map()
    this.commentCache = new Map()
    this.ownVideoCache = { at: 0, list: [] }
  }

  cursor(kind) {
    const notices = (this.state.cursors.notices = this.state.cursors.notices || {})
    const current = (notices[kind] = notices[kind] || { lastId: '', seen: [], initialized: false })
    if (!Array.isArray(current.seen)) current.seen = []
    return current
  }

  itemsOf(kind, data) {
    if (Array.isArray(data?.items)) return data.items
    if (Array.isArray(data?.list)) return data.list
    if (kind === 'like' && data?.latest) return [data.latest]
    if (data?.item) return [data]
    return []
  }

  async videoContext(oid, type, bvid = '') {
    if ((!oid && !bvid) || Number(type) !== 1) return null
    const key = String(bvid || oid)
    const cached = this.videoCache.get(key)
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.data
    try {
      const info = await this.transport.call('resolveTarget', [String(bvid || oid)])
      const data = {
        bvid: info?.bvid || bvid || '',
        aid: info?.aid || String(oid || ''),
        title: info?.title || '',
        desc: info?.desc || '',
        owner: info?.owner || '',
        url: info?.url || (info?.bvid ? `https://www.bilibili.com/video/${info.bvid}` : oid ? `https://www.bilibili.com/video/av${oid}` : ''),
      }
      this.videoCache.set(key, { at: Date.now(), data })
      return data
    } catch (err) {
      this.logger?.debug?.(`[bilibili] 获取视频信息失败 oid=${oid}：${err?.message || err}`)
      return null
    }
  }

  normalizeTitle(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[\s【】\[\]（）()|｜:：,，.。!！?？~～\-—]+/g, '')
  }

  /**
   * 兜底：@ 通知给的 oid 可能是业务编号（例如 1），拿不到真实稿件时，
   * 用通知里的视频标题去自己的最近投稿里找同名/近似视频。适合“在我自己的视频下 @ 我”的场景。
   */
  async findOwnVideoByTitle(title) {
    const wanted = this.normalizeTitle(title)
    if (!wanted) return null
    if (Date.now() - Number(this.ownVideoCache.at || 0) > 30 * 60 * 1000) {
      try {
        const list = await this.transport.call('ownVideos', [this.getSelfUid(), { ps: 30 }])
        this.ownVideoCache = { at: Date.now(), list: Array.isArray(list) ? list : [] }
      } catch (err) {
        this.logger?.debug?.(`[bilibili] 获取自己投稿列表失败：${err?.message || err}`)
        this.ownVideoCache.at = Date.now()
      }
    }
    let fallback = null
    for (const video of this.ownVideoCache.list || []) {
      const candidate = this.normalizeTitle(video?.title)
      if (!candidate) continue
      if (candidate === wanted) return video
      if (!fallback && (candidate.includes(wanted) || wanted.includes(candidate))) fallback = video
    }
    return fallback
  }

  /** @ / 回复通知里没有评论 rpid 时，按发送者 UID 在最新评论里反查一条。 */
  async findComment(oid, uid) {
    if (!oid || !uid) return null
    const key = `${oid}:${uid}`
    const cached = this.commentCache.get(key)
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data
    try {
      const data = await this.transport.call('comments', [{ oid, type: 1, ps: 20, pn: 1, sort: 0 }])
      const flat = []
      const walk = (list, root = '0') => {
        for (const comment of Array.isArray(list) ? list : []) {
          flat.push({ raw: comment, root })
          if (Array.isArray(comment?.replies) && comment.replies.length) walk(comment.replies, String(comment.rpid || root))
        }
      }
      walk(data?.replies || [])
      const picked = flat
        .filter(({ raw }) => String(raw?.mid ?? raw?.member?.mid ?? '') === String(uid))
        .sort((a, b) => Number(b.raw?.ctime || 0) - Number(a.raw?.ctime || 0))[0]
      if (!picked) return null
      const raw = picked.raw
      const result = {
        rpid: String(raw?.rpid || ''),
        root: String(raw?.root && raw.root !== '0' ? raw.root : raw?.rpid || ''),
        parent: String(raw?.rpid || ''),
        text: String(raw?.content?.message || raw?.content?.content || '').trim().slice(0, 1000),
      }
      this.commentCache.set(key, { at: Date.now(), data: result })
      return result
    } catch (err) {
      this.logger?.debug?.(`[bilibili] 反查 @ 评论失败 oid=${oid} uid=${uid}：${err?.message || err}`)
      return null
    }
  }

  /** 给回复 / @ 通知补上视频详情，并在缺 rpid 时反查评论，解决“知道被 @ 但回不出去”。 */
  async enrich(item, raw = null) {
    if (!item?.target || Number(item.target.type) !== 1 || (!item.target.oid && !item.target.bvid)) return item
    let video = await this.videoContext(item.target.oid, item.target.type, item.target.bvid)
    if (!video) {
      // oid 是业务编号（常见是 1）时，按通知里的视频标题去自己的投稿里回查。
      const matched = await this.findOwnVideoByTitle(item.title || item.thread?.name)
      if (matched && (matched.bvid || matched.aid)) {
        video = (await this.videoContext(matched.aid, 1, matched.bvid)) || {
          bvid: matched.bvid || '',
          aid: String(matched.aid || ''),
          title: matched.title || '',
          desc: '',
          owner: '',
          url: matched.bvid ? `https://www.bilibili.com/video/${matched.bvid}` : matched.aid ? `https://www.bilibili.com/video/av${matched.aid}` : '',
        }
        this.logger?.info?.(`[bilibili] ${item.kind} 通知按标题匹配到稿件：${video.title || video.bvid}（${video.url}）`)
      }
    }
    if (video) {
      item.video = video
      if (!item.target.bvid && video.bvid) item.target.bvid = video.bvid
      // 通知里的 subject_id / business_id 都不可靠；解析出真实 aid 后统一覆盖，
      // 并把会话线程 key 归一，避免同一稿件因错误 ID 被拆成多个会话。
      if (video.aid && String(item.target.oid) !== String(video.aid)) {
        item.target.oid = String(video.aid)
        item.thread.oid = String(video.aid)
        item.thread.key = `comment:${video.aid}:${Number(item.target.type) || 1}`
      }
      if (!item.thread.name) item.thread.name = video.title
    } else if (raw) {
      this.logger?.info?.(`[bilibili] ${item.kind} 通知未解析出有效稿件，原始字段：${JSON.stringify(raw).slice(0, 900)}`)
    }
    const textMissing = !String(item.text || '').trim() || (video?.title && String(item.text).trim() === video.title)
    if (!item.target.rpid || textMissing) {
      const found = await this.findComment(item.target.oid, item.sender.uid)
      if (found) {
        // 正文缺失说明 uri 字段不可靠，这时优先用反查到的评论 ID，而不是通知里的编号。
        if (textMissing || !item.target.rpid) {
          item.target.rpid = found.rpid
          this.logger?.info?.(`[bilibili] ${item.kind} 通知反查到评论 rpid=${found.rpid}（oid=${item.target.oid}）`)
        }
        item.target.root = found.root
        item.target.parent = found.parent
        if (textMissing && found.text) item.text = found.text
        item.replyLookup = true
      }
    }
    if (textMissing && !item.text) {
      // 反查失败时不要拿视频标题冒充对方说的话，明确告诉模型“正文没拿到”。
      item.text = '（未能读取到原评论内容，请结合视频信息判断对方意图）'
      item.textMissing = true
    }
    return item
  }

  /**
   * 轻量探针：实时长连接收到帧时只查一次未读数；只有未读增加才真正拉取各分类。
   * 这样可以把 @ / 回复通知的最坏延迟从轮询间隔压到几秒，同时避免频繁拉列表。
   */
  async poke() {
    if (this.polling) return { skipped: true }
    const settings = this.getSettings() || {}
    const enabled = settings.noticeKinds || { reply: true, at: true, like: false, system: false }
    try {
      const before = this.unread || {}
      const unread = (await this.transport.call('msgfeedUnread')) || {}
      this.unread = unread
      const increased = KINDS.some(
        kind => enabled[kind] && Number(unread?.[kind] || 0) > Number(before?.[kind] || 0),
      )
      if (!increased) return { items: 0, skipped: true }
      return this.pollOnce()
    } catch (err) {
      this.logger?.debug?.(`[bilibili] 消息中心探针失败：${err?.message || err}`)
      return { items: 0, error: String(err?.message || err) }
    }
  }

  async pollOnce() {
    if (this.polling) return { skipped: true }
    this.polling = true
    const items = []
    try {
      const settings = this.getSettings() || {}
      const enabled = settings.noticeKinds || { reply: true, at: true, like: false, system: false }
      const selfUid = this.getSelfUid()
      try {
        this.unread = (await this.transport.call('msgfeedUnread')) || {}
      } catch (_) {
        this.unread = {}
      }
      let firstSyncBudget = FIRST_SYNC_MAX_ITEMS
      for (const kind of KINDS) {
        if (!enabled[kind]) continue
        let data = null
        try {
          data = await this.transport.call('msgfeed', [kind])
        } catch (err) {
          this.logger?.warn?.(`[bilibili] 拉取消息中心「${kind}」失败：${err?.message || err}`)
          continue
        }
        const cursor = this.cursor(kind)
        const known = new Set(cursor.seen)
        const list = this.itemsOf(kind, data)
        const firstSync = !cursor.initialized
        let emitted = 0
        let skipped = 0
        for (const raw of list) {
          const item = normalizeNotice(kind, raw, { selfUid })
          if (!item) continue
          if (String(item.sender.uid) === String(selfUid)) continue
          const key = String(item.id)
          if (known.has(key)) continue
          known.add(key)
          // 首次同步只静默入库最新几条；更早的通知标记已读，不触发模型。
          if (firstSync && (emitted >= FIRST_SYNC_LIMIT || firstSyncBudget <= 0)) {
            skipped += 1
            continue
          }
          await this.enrich(item, raw)
          item.backlog = firstSync || Date.now() - item.at > BACKLOG_AGE_MS
          if (firstSync) {
            emitted += 1
            firstSyncBudget -= 1
          }
          items.push(item)
        }
        cursor.initialized = true
        cursor.seen = [...known].slice(-SEEN_LIMIT)
        cursor.lastId = String(list[0]?.id || cursor.lastId || '')
        if (firstSync) this.logger?.info?.(`[bilibili] 消息中心「${kind}」首次同步：静默入库 ${emitted} 条，跳过 ${skipped} 条更早通知`)
      }
      for (const item of items) this.emit(item)
      if (items.length) this.logger?.info?.(`[bilibili] 消息中心收到 ${items.length} 条新通知`)
      return { items: items.length }
    } finally {
      this.polling = false
    }
  }

  async list(kind) {
    const data = await this.transport.call('msgfeed', [kind])
    const selfUid = this.getSelfUid()
    return this.itemsOf(kind, data)
      .map(raw => normalizeNotice(kind, raw, { selfUid }))
      .filter(Boolean)
  }

  stats() {
    return { unread: this.unread }
  }
}
