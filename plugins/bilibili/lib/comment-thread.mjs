/*
 * bilibili · 评论树（纯函数 + 可选网络拉取）
 *
 * 评论 / @ 通知的上下文不能只靠我们自己的聊天记录：B站楼中楼里用户可能是
 * 先在别人的评论下回复、再 @ 机器人，只有把当前评论的父级链按 rpid 从 B站
 * 拉回来，模型才能看到“她到底在回复谁、前因后果是什么”。
 *
 * 这里只保留当前评论所属的父级链：
 *   root（主楼） -> ... -> parent -> current rpid
 * 同一楼层里其它无关用户的评论不会进入上下文，避免污染。
 */

export function flattenCommentReplies(list, root = '0') {
  const out = []
  const walk = (items, rootId) => {
    for (const raw of Array.isArray(items) ? items : []) {
      if (!raw || typeof raw !== 'object') continue
      const rpid = String(raw.rpid ?? raw.rpid_str ?? '')
      if (!rpid) continue
      const nextRoot = String(raw.root && raw.root !== '0' ? raw.root : rootId || rpid)
      out.push({ raw, root: nextRoot })
      if (Array.isArray(raw.replies) && raw.replies.length) walk(raw.replies, nextRoot)
    }
  }
  walk(list, root)
  return out
}

/** 从扁平评论列表里取 currentRpid 到主楼的完整父级链（不展开同层其它回复）。 */
export function commentBranch(flat, currentRpid, { limit = 20 } = {}) {
  const target = String(currentRpid || '')
  if (!target) return []
  const byId = new Map()
  for (const entry of Array.isArray(flat) ? flat : []) {
    const id = String(entry?.raw?.rpid ?? entry?.raw?.rpid_str ?? '')
    if (id && !byId.has(id)) byId.set(id, entry)
  }
  let node = byId.get(target)
  if (!node) return []
  const chain = []
  const seen = new Set()
  while (node) {
    const id = String(node.raw?.rpid ?? node.raw?.rpid_str ?? '')
    if (!id || seen.has(id)) break
    seen.add(id)
    chain.unshift(node)
    const parent = String(node.raw?.parent ?? node.raw?.parent_str ?? '')
    const root = String(node.raw?.root ?? '')
    const next =
      parent && parent !== '0' && parent !== id
        ? parent
        : root && root !== '0' && root !== id
          ? root
          : ''
    if (!next) break
    node = byId.get(next)
  }
  const max = Math.max(1, Number(limit) || 20)
  return chain.slice(-max)
}

const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)

/** 评论树 -> 模型可读文本。selfUid 用于区分“机器人自己发的评论”和对方评论。 */
export function formatCommentTree(items, { selfUid = 0, maxChars = 4000 } = {}) {
  const list = Array.isArray(items) ? items : []
  const lines = list.map((entry, index) => {
    const raw = entry?.raw || {}
    const rpid = String(raw.rpid ?? raw.rpid_str ?? '')
    const uid = String(raw.mid ?? raw.member?.mid ?? '')
    const name = cleanText(raw.member?.uname || raw.member?.name || raw.uname || `UID ${uid}`) || `UID ${uid}`
    const text = cleanText(raw.content?.message ?? raw.content?.content ?? raw.message ?? '')
    const mine = selfUid && uid === String(selfUid)
    const role = mine ? '我（机器人）' : index === list.length - 1 ? '当前相关评论' : '对方'
    const depth = index === 0 ? '主楼' : `第${index + 1}层`
    return `${index + 1}. [${depth}] ${role} · ${name}${uid ? `（UID ${uid}）` : ''}：${text || '[空评论]'}${rpid ? `（rpid=${rpid}）` : ''}`
  })
  const output = lines.join('\n')
  return output.length > maxChars ? `${output.slice(0, Math.max(0, maxChars - 1))}…` : output
}

/** 兼容旧命名；新代码统一用 formatCommentTree。 */
export const formatCommentThread = formatCommentTree

/**
 * 通过 transport 拉取当前评论的父级链。网络失败不抛错，只返回空数组。
 * @param {{call: Function}} transport
 */
export async function fetchCommentThread(transport, { oid = '', type = 1, bvid = '', root = '', rpid = '', limit = 12 } = {}) {
  if (!transport?.call) return []
  const oidText = String(oid || bvid || '')
  if (!oidText) return []
  const currentRpid = String(rpid || '')
  const rootId = String(root || '') && String(root) !== '0' ? String(root) : currentRpid
  const flat = []
  const collect = data => {
    const replies = data?.replies || data?.data?.replies || []
    flat.push(...flattenCommentReplies(replies, rootId))
  }
  if (rootId) {
    try {
      collect(await transport.call('commentReplies', [{ oid: oidText, type: Number(type) || 1, root: rootId, ps: 20, pn: 1 }]))
    } catch (_) {
      /* 楼中楼接口不可用时用主评论接口兜底 */
    }
  }
  const hasCurrent = () => flat.some(entry => String(entry.raw?.rpid ?? entry.raw?.rpid_str ?? '') === currentRpid)
  const hasRoot = () => flat.some(entry => String(entry.raw?.rpid ?? entry.raw?.rpid_str ?? '') === rootId)
  // 楼中楼接口常只返回回复，不返回主楼；缺主楼 / 当前评论时再用主评论接口补齐。
  if (!flat.length || !hasCurrent() || !hasRoot()) {
    try {
      collect(await transport.call('comments', [{ oid: oidText, type: Number(type) || 1, ps: 20, pn: 1, sort: 0 }]))
    } catch (_) {
      /* 网络失败时保持已拿到的部分 */
    }
  }
  return commentBranch(flat, currentRpid || rootId, { limit })
}
