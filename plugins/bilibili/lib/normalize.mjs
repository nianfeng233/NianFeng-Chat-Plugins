/*
 * bilibili · 原始接口数据 → 统一入站消息（纯函数，后端桥与测试脚本共用）
 *
 * item 统一结构：
 *   {
 *     id, kind: 'dm'|'reply'|'at'|'like'|'system'|'comment',
 *     at, sender: { uid, name, avatar }, text, title, images,
 *     thread: { key, name, peerUid?, oid?, type?, bvid? },
 *     target: { peerUid?, oid?, type?, rpid?, root?, parent?, bvid?, uri? },
 *     backlog
 *   }
 */
import { libUrl } from './rev.mjs'

const { safeJsonParse, stripHtml, truncateText, normalizeWhitespace } = await import(libUrl('util.mjs'))

export const KIND_LABEL = {
  dm: '私信',
  reply: '回复我的',
  at: '@我的',
  like: '收到的赞',
  system: '系统消息',
  comment: '视频评论',
}

export function textFromDmContent(content, msgType) {
  const parsed = safeJsonParse(content, null)
  const type = Number(msgType) || 1
  if (parsed && typeof parsed === 'object') {
    const direct = parsed.content ?? parsed.text ?? parsed.msg ?? ''
    if (typeof direct === 'string' && direct.trim()) return normalizeWhitespace(direct, { keepNewlines: true }).slice(0, 4000)
    if (parsed.url && type === 2) return '[图片]'
    const nested = parsed.content
    if (nested && typeof nested === 'object' && typeof nested.text === 'string') return normalizeWhitespace(nested.text).slice(0, 4000)
  }
  if (typeof parsed === 'string' && parsed.trim()) return normalizeWhitespace(parsed).slice(0, 4000)
  const raw = String(content ?? '').trim()
  if (raw && !raw.startsWith('{')) return truncateText(raw, 4000)
  if (type === 2) return '[图片]'
  if (type === 7) return '[视频/卡片消息]'
  if (type === 10) return '[系统提示]'
  return `[消息类型 ${type}]`
}

function dmImages(content, msgType) {
  if (Number(msgType) !== 2) return []
  const parsed = safeJsonParse(content, null)
  if (parsed?.url) return [{ url: String(parsed.url), width: Number(parsed.width) || 0, height: Number(parsed.height) || 0 }]
  return []
}

export function normalizeDmMessage(raw, { selfUid = 0 } = {}) {
  const msg = raw && typeof raw === 'object' ? raw : {}
  const senderUid = String(msg.sender_uid ?? msg.senderUid ?? '')
  const receiverUid = String(msg.receiver_uid ?? msg.receiverUid ?? '')
  const peerUid = senderUid && String(selfUid) !== senderUid ? senderUid : receiverUid
  if (!peerUid || (senderUid && String(selfUid) === senderUid)) return null
  const msgKey = String(msg.msg_key ?? msg.msgKey ?? msg.msg_id ?? '')
  const timestamp = Number(msg.timestamp ?? msg.time ?? 0) || Math.floor(Date.now() / 1000)
  const id = msgKey ? `dm:${peerUid}:${msgKey}` : `dm:${peerUid}:${timestamp}:${String(msg.content || '').slice(0, 32)}`
  return {
    id,
    kind: 'dm',
    at: timestamp * 1000,
    sender: {
      uid: peerUid,
      name: String(msg.sender_name || msg.senderName || '').trim(),
      avatar: String(msg.sender_avatar || '').trim(),
    },
    text: textFromDmContent(msg.content, msg.msg_type ?? msg.msgType),
    images: dmImages(msg.content, msg.msg_type ?? msg.msgType),
    thread: { key: `dm:${peerUid}`, name: '', peerUid },
    target: { peerUid },
    raw: { msgKey, msgType: Number(msg.msg_type ?? msg.msgType) || 1 },
  }
}

export function normalizeDmSessions(payload) {
  const list = payload?.session_list || payload?.sessions || []
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const peerUid = String(raw?.talker_id ?? raw?.talkerId ?? raw?.peer_uid ?? '')
    if (!peerUid) continue
    const last = raw?.last_msg || raw?.lastMsg || {}
    out.push({
      peerUid,
      nickname: String(last?.sender_name || raw?.nickname || '').trim(),
      avatar: String(raw?.avatar || '').trim(),
      sessionId: String(raw?.session_id ?? raw?.sessionId ?? ''),
      unread: Number(raw?.unread_count ?? raw?.unreadCount ?? 0) || 0,
      lastMsgKey: String(last?.msg_key ?? last?.msgKey ?? ''),
      lastTimestamp: Number(last?.timestamp ?? raw?.last_msg_time ?? 0) || 0,
      // 保留原始 last_msg 作为消息记录接口失败时的兜底来源。
      last,
    })
  }
  return out
}

/** 解析消息中心 / 评论通知里的 bilibili:// uri。 */
export function parseBilibiliUri(uri) {
  const text = String(uri || '').trim()
  if (!text) return {}
  // 消息中心现在常给 https 视频链接（例如 https://www.bilibili.com/video/BV...）。
  if (/^https?:\/\//i.test(text)) {
    const target = parseTarget(text)
    if (target && (target.bvid || target.aid)) {
      return { bvid: target.bvid || '', aid: target.aid || '', oid: target.aid || '', type: target.type || 1 }
    }
  }
  let match = text.match(/bilibili:\/\/comment\/detail\/(\d+)\/(\d+)\/(\d+)/i)
  if (match) return { oid: match[1], type: Number(match[2]) || 1, rpid: match[3] }
  match = text.match(/bilibili:\/\/comment\/(\d+)\/(\d+)\/(\d+)/i)
  if (match) return { oid: match[1], type: Number(match[2]) || 1, rpid: match[3] }
  match = text.match(/bilibili:\/\/(?:video|bangumi)\/(BV[0-9A-Za-z]+|av\d+|\d+)/i)
  if (match) return { bvid: /^BV/i.test(match[1]) ? match[1] : '', aid: /^av/i.test(match[1]) ? match[1].slice(2) : /^\d+$/.test(match[1]) ? match[1] : '' }
  match = text.match(/bilibili:\/\/(?:dynamic|opus)\/(\d+)/i)
  if (match) return { oid: match[1], type: 17 }
  const nums = text.match(/\d+/g) || []
  if (/comment/i.test(text) && nums.length >= 3) return { oid: nums[0], type: Number(nums[1]) || 1, rpid: nums[2] }
  if (/video/i.test(text) && nums.length >= 1) return { aid: nums[0] }
  return {}
}

function pickFirst(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

/** 消息中心（回复我 / @我 / 点赞 / 系统）单条通知 → item。 */
export function normalizeNotice(kind, raw, { selfUid = 0 } = {}) {
  const notice = raw && typeof raw === 'object' ? raw : {}
  const user = notice.user || notice.users?.[0] || {}
  const item = notice.item || notice.content || {}
  const uri = pickFirst(item.uri, item.native_uri, notice.uri, item.link)
  const parsed = parseBilibiliUri(uri)
  const httpTarget = /^https?:\/\//i.test(uri) ? parseTarget(uri) : null
  const senderUid = String(user.mid ?? notice.mid ?? notice.uid ?? '')
  // 原评论正文优先取 source_content；item.title 在这类通知里通常是视频标题。
  const sourceContent = stripHtml(pickFirst(item.source_content, notice.source_content)).slice(0, 4000)
  const fallbackText = stripHtml(
    pickFirst(
      notice.reply?.content?.message,
      item.reply?.content?.message,
      item.content?.message,
      item.summary,
      item.title,
      notice.title,
      notice.content,
    ),
  ).slice(0, 4000)
  const text = sourceContent || fallbackText
  const title = stripHtml(
    pickFirst(item.subject, item.title && item.title !== text ? item.title : '', notice.subject),
  ).slice(0, 300)
  // 重要：business_id 在通知里只是业务编号（常见就是 1），真实稿件在 uri / subject_id。
  const parsedBvid = String(parsed.bvid || httpTarget?.bvid || '')
  const parsedAid = String(parsed.aid || httpTarget?.aid || '')
  const parsedType = Number(parsed.type || httpTarget?.type) || 0
  const parsedOid = String(parsed.oid || (parsedAid && (parsedType || 1) === 1 ? parsedAid : '') || '')
  const oid = parsedOid || String(item.subject_id ?? item.oid ?? item.business_id ?? '')
  const type = parsedType || Number(item.type) || (parsedBvid || parsedAid || oid ? 1 : 0) || 1
  // 评论 ID：@ / 回复通知里 source_id 才是被 @ / 被回复的那条评论；target_id 常为 0。
  const rpid = String(item.source_id || notice.reply?.rpid || item.rpid || item.target_id || parsed.rpid || '')
  const bvid = String(item.bvid ?? parsedBvid ?? '')
  const aid = String(parsedAid || (type === 1 && oid ? oid : ''))
  const nativeUri = pickFirst(item.native_uri, notice.native_uri) || uri
  const nativeRoot = String(nativeUri).match(/comment_root_id=(\d+)/i)?.[1] || ''
  const root = String(Number(item.root_id) > 0 ? item.root_id : nativeRoot || rpid || '')
  const parent = String(Number(item.target_id) > 0 ? item.target_id : rpid || '')
  const at = (Number(notice.reply_time ?? notice.time ?? notice.ctime ?? 0) || Math.floor(Date.now() / 1000)) * 1000
  const baseId = pickFirst(notice.id, notice.notify_id, rpid, `${senderUid}:${oid}:${type}:${at}`)
  if (!senderUid && !text && !oid) return null
  const threadKey = oid ? `comment:${oid}:${type}` : `notice:${kind}:${senderUid}`
  return {
    id: `notice:${kind}:${baseId}`,
    kind,
    at,
    sender: {
      uid: senderUid,
      name: stripHtml(pickFirst(user.nickname, notice.nickname)).slice(0, 80),
      avatar: pickFirst(user.avatar, notice.avatar),
    },
    text,
    title,
    images: [],
    thread: { key: threadKey, name: title, oid, type, bvid },
    target: { oid, type, rpid, root, parent, bvid: bvid || undefined, aid: aid || undefined, uri },
    raw: { notifyId: String(notice.id || ''), itemType: Number(item.type) || 0 },
  }
}

/** 视频评论接口的单条评论 → item（含楼中楼，root / parent 用于精准回复）。 */
export function normalizeComment(raw, { oid = '', type = 1, bvid = '', title = '', selfUid = 0, root = '0', parent = '0' } = {}) {
  const comment = raw && typeof raw === 'object' ? raw : {}
  const rpid = String(comment.rpid ?? comment.rpid_str ?? '')
  const mid = String(comment.mid ?? comment.member?.mid ?? '')
  if (!rpid) return null
  const commentOid = String(comment.oid ?? oid ?? '')
  const commentType = Number(comment.type ?? type) || 1
  const text = stripHtml(pickFirst(comment.content?.message, comment.content?.content, comment.message)).slice(0, 4000)
  const at = (Number(comment.ctime ?? comment.time ?? 0) || Math.floor(Date.now() / 1000)) * 1000
  return {
    id: `comment:${commentOid}:${commentType}:${rpid}`,
    kind: 'comment',
    at,
    sender: {
      uid: mid,
      name: stripHtml(pickFirst(comment.member?.uname, comment.member?.name, comment.uname)).slice(0, 80),
      avatar: pickFirst(comment.member?.avatar, comment.avatar),
    },
    text,
    title: String(title || '').slice(0, 300),
    images: [],
    thread: { key: `comment:${commentOid}:${commentType}`, name: String(title || `视频 ${bvid || commentOid}`).slice(0, 120), oid: commentOid, type: commentType, bvid },
    target: {
      oid: commentOid,
      type: commentType,
      rpid,
      root: String(comment.root && comment.root !== '0' ? comment.root : root || rpid),
      parent: String(parent && parent !== '0' ? parent : rpid),
      bvid: bvid || undefined,
    },
    raw: { mid, isUp: comment.member?.mid === selfUid },
  }
}

/** 支持 BV 号 / av 号 / aid / 视频 URL / 动态 URL。 */
export function parseTarget(target) {
  const raw = String(target ?? '').trim()
  if (!raw) return null
  const url = raw.match(/https?:\/\/[^\s]+/i)?.[0] || raw
  let match = url.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i) || url.match(/^(BV[0-9A-Za-z]+|av\d+)$/i)
  if (match) {
    const token = match[1]
    if (/^BV/i.test(token)) return { bvid: token, aid: '', oid: '', type: 1, raw }
    return { bvid: '', aid: token.slice(2), oid: token.slice(2), type: 1, raw }
  }
  match = url.match(/b23\.tv\/([0-9A-Za-z]+)/i)
  if (match) return { bvid: '', aid: '', oid: '', type: 1, short: `https://b23.tv/${match[1]}`, raw }
  match = url.match(/(?:t\.bilibili\.com|bilibili\.com\/opus|bilibili\.com\/dynamic)\/(\d+)/i)
  if (match) return { bvid: '', aid: '', oid: match[1], type: 17, raw }
  match = raw.match(/^(?:oid|aid|av)[:：]?\s*(\d+)$/i)
  if (match) return { bvid: '', aid: match[1], oid: match[1], type: 1, raw }
  match = raw.match(/^\d+$/)
  if (match) return { bvid: '', aid: raw, oid: raw, type: 1, raw }
  return { bvid: '', aid: '', oid: '', type: 1, raw }
}

export function previewText(item) {
  const text = String(item?.text || '').trim()
  if (text) return text.replace(/\s+/g, ' ').slice(0, 120)
  if (Array.isArray(item?.images) && item.images.length) return '[图片]'
  if (item?.title) return String(item.title).replace(/\s+/g, ' ').slice(0, 120)
  return `[${KIND_LABEL[item?.kind] || item?.kind || '消息'}]`
}

export function dedupeKey(item) {
  return String(item?.id || `${item?.kind}:${item?.sender?.uid}:${item?.at}`)
}
