/*
 * bilibili · B站渠道插件（外部插件，独立目录，不进入本体）
 *
 * 一个渠道 = 一个 B站账号。渠道内再按「私信对端 / 稿件评论线程」拆独立会话：
 *   - 私信：每个对端 UID 一个会话（private 页签）；
 *   - 消息中心（回复我 / @我）与评论扫描：每个稿件 / 动态一个会话（group 页签）。
 *
 * 入站先过黑白名单与名单外策略（drop / ingest / process），再决定是否触发模型。
 * 外发不依赖 channel-base 的单会话映射：每个会话按自己的 thread meta 独立路由，
 * 私信与评论使用后端各自的发送队列。
 */
import { BILIBILI_CSS } from './style.mjs'
import { renderQrSvg } from './qrcode.mjs'
import { DEFAULT_POLICY, normalizePolicy, decide, describeDecision } from './lib/policy.mjs'
import { KIND_LABEL, previewText } from './lib/normalize.mjs'

export const name = 'bilibili'
export const version = '1.6.0'
export const scope = 'both'
export const displayName = '哔哩哔哩'
export const description = 'B站渠道：扫码 / Edge 托管登录，私信与消息中心（回复我 / @我 / 点赞 / 系统）收发，评论扫描与主动评论；UID 黑白名单与名单外处理策略。'
export const author = '念风扩展'
export const icon = '📺'
export const core = false
export const enabled = true
export const depends = {
  'channel-base': '^1.0.0',
  'channel-detail-host': '>=3.0.0',
  'channel-list': '>=1.0.0',
  'channel-registry': '>=1.0.0',
  'config': '>=1.1.0',
  'event-bus': '*',
  'session-service': '^2.0.0',
  'toast-host': '>=1.0.0',
  'tool-registry': '^1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'chat-store': '>=1.0.0',
  'message-service': '>=1.0.0',
  'chat-permissions': '>=1.0.0',
  'plugin-manager': '>=1.0.0',
}
export const inject = [
  'channel-base',
  'channel-registry',
  'session-service',
  'event-bus',
  'toast',
  'config',
  'tool-registry',
  'api?',
  'message-service?',
  'chat-store?',
  'chat-permissions?',
  'plugin-manager?',
]
export const provides = [{ name: 'bilibili-channel', type: 'singleton' }]
export const permissions = ['network']

const TYPE_ID = 'bilibili'
const TYPE_COLOR = '#fb7299'
const TYPE_ICON = '📺'
const TAB_LABELS = { private: '私聊', group: '群聊', privacy: '隐私' }
const STATUS_LABEL = { online: '已接入', connecting: '连接中', offline: '未登录', error: '异常' }
const STATUS_COLOR = { online: '#70a15a', connecting: '#c9a227', offline: '#b3b9c2', error: '#c65b5b' }
const SCOPE_TABS = [
  ['dm', '私信'],
  ['comment', '评论'],
  ['at', '@我'],
  ['like', '点赞'],
  ['system', '系统'],
]
const DEFAULT_PERMISSIONS = {
  read: true,
  reply: true,
  context: true,
  crossRead: false,
  crossSend: false,
  confirm: true,
}
const PERMISSION_META = [
  ['read', '接收消息', '把 B站消息写入角色上下文'],
  ['reply', '自动回复', '模型生成后自动发回 B站'],
  ['context', '参与工作记忆', '该渠道消息参与角色级工作记忆'],
  ['crossRead', '跨渠道读取', '允许该角色读取其它渠道记录'],
  ['crossSend', '跨渠道发送', '允许向其它渠道发送消息'],
  ['confirm', '敏感操作确认', '跨渠道等敏感操作需要二次确认'],
]
const DEFAULT_SETTINGS = {
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
  sendVia: 'auto',
  realtime: { enabled: true },
  videos: [],
  autoOwnVideos: false,
  policy: DEFAULT_POLICY,
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function useStyle(ctx, css) {
  if (typeof document === 'undefined' || !css) return
  const style = document.createElement('style')
  style.dataset.plugin = 'bilibili'
  style.textContent = css
  document.head.appendChild(style)
  ctx.effect(() => style.remove())
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTime(value) {
  const at = Number(value) || 0
  if (!at) return ''
  const date = new Date(at)
  const pad = number => String(number).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseLines(value, limit = 50) {
  return [...new Set(String(value ?? '').split(/[\r\n,，;；]+/).map(item => item.trim()).filter(Boolean))].slice(0, limit)
}

export function apply(ctx) {
  const base = ctx.inject('channel-base')
  const channels = ctx.inject('channel-registry')
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')
  const config = ctx.inject('config')
  const tools = ctx.inject('tool-registry')
  const api = ctx.inject('api?')
  const messages = ctx.inject('message-service?')
  const store = ctx.inject('chat-store?')

  useStyle(ctx, BILIBILI_CSS)

  /** conversationId -> finish，等待 chat-flow 整轮结束 */
  const pendingTurns = new Map()
  /** conversationId -> 本轮入站（外发时用于解析私信对端 / 评论回复目标） */
  const activeTurns = new Map()
  /** conversationId -> 串行处理链 */
  const busyChains = new Map()
  /** channelId -> Set(itemId)，页面内去重（SSE 与收件箱可能同时到达） */
  const handledInbound = new Map()
  /** conversationId:messageId -> true，避免 added / done 重复外发 */
  const outboundSeen = new Set()
  /** conversationId -> 串行外发链 */
  const outboundChains = new Map()
  /** conversationId -> 抑制到期时间：模型已调用主动发送工具后，避免把回合总结再自动发一遍 */
  const suppressOutbound = new Map()
  /** conversationId -> 评论外发合并缓冲（多条助手消息用换行合成一条评论） */
  const commentBatches = new Map()
  /** channelId -> 已消费的收件箱 seq，用于 SSE 断开后的补收 */
  const lastInboxSeq = new Map()
  /** 详情页重绘回调（挂载时注册） */
  const detailRefreshers = new Set()
  /**
   * 渠道详情草稿：宿主在 conversation:update / channel:updated 等事件时会整块重绘详情，
   * 这里按 channelId 保存未保存的表单内容，重新挂载后原样恢复。
   */
  const detailDrafts = new Map()
  let backendEvents = null
  let fallbackTimer = null
  let syncTimer = null

  /* ---------------- 渠道基础 ---------------- */

  const findChannel = channelId => {
    for (const tab of channels.tabs()) {
      const channel = channels.findChannel(tab, channelId)
      if (channel) return channel
    }
    return null
  }
  const findTab = channelId => channels.tabs().find(tab => channels.findChannel(tab, channelId)) || 'private'
  const isBiliChannel = channel => channel?.type === TYPE_ID
  const permissionsOf = channel => ({ ...DEFAULT_PERMISSIONS, ...(channel?.meta?.permissions || {}) })
  const roleOf = channel => sessions.get(channel?.meta?.roleId) || null
  const isRoleConversation = conv => {
    const meta = conv?.meta || {}
    if (meta.channelConversation === true || meta.hiddenFromSessionList === true) return false
    const channelType = String(meta.channelType || '')
    const channelId = String(meta.channelId || '')
    if (!channelType && !channelId) return true
    if (channelType && channelType !== 'nova') return false
    if (channelId && !channelId.startsWith('nova:web:')) return false
    return true
  }
  const roleOptions = (selectedId = '') => {
    const list = sessions.list().filter(isRoleConversation)
    if (selectedId && !list.some(conv => conv.id === selectedId)) {
      const selected = sessions.get(selectedId)
      if (selected) list.unshift(selected)
    }
    return list
      .map(conv => `<option value="${escapeHtml(conv.id)}" ${conv.id === selectedId ? 'selected' : ''}>${escapeHtml(conv.name || conv.id)}</option>`)
      .join('')
  }
  const channelIdentity = channel => {
    const shared = ctx.registry.get('user-identity')?.get?.() || {}
    const fallbackUserId = String(shared.userId || config.get('chat.userId', 'web-user') || 'web-user').trim() || 'web-user'
    const fallbackUserName = String(shared.userName || config.get('chat.userName', '用户') || '用户').trim() || '用户'
    return {
      userId: String(channel?.meta?.identity?.userId || fallbackUserId).trim() || fallbackUserId,
      userName: String(channel?.meta?.identity?.userName || fallbackUserName).trim() || fallbackUserName,
    }
  }
  const biliMeta = channel => {
    const raw = channel?.meta?.bilibili || {}
    return {
      ...clone(DEFAULT_SETTINGS),
      ...raw,
      capabilities: { ...DEFAULT_SETTINGS.capabilities, ...(raw.capabilities || {}) },
      noticeKinds: { ...DEFAULT_SETTINGS.noticeKinds, ...(raw.noticeKinds || {}) },
      poll: { ...DEFAULT_SETTINGS.poll, ...(raw.poll || {}) },
      // 目前没有开放 limits 编辑；忽略历史渠道 meta 里遗留的旧默认值，统一用当前版本默认，避免旧间隔继续生效。
      limits: { ...DEFAULT_SETTINGS.limits },
      sendVia: raw.sendVia === 'browser' ? 'browser' : 'auto',
      realtime: { ...DEFAULT_SETTINGS.realtime, ...(raw.realtime || {}) },
      videos: Array.isArray(raw.videos) ? raw.videos : [],
      policy: normalizePolicy(raw.policy),
    }
  }
  const channelKey = channelId => `${TYPE_ID}:${channelId}`

  /* ---------------- 渠道配置同步 / 状态 ---------------- */

  function updateChannelFromStatus(data) {
    if (!data?.channelId) return
    const channel = findChannel(data.channelId)
    if (!channel || !isBiliChannel(channel)) return
    const mapped = data.status === 'online' ? 'online' : data.status === 'offline' ? 'offline' : data.status === 'error' ? 'error' : 'connecting'
    const nextMeta = {
      ...(channel.meta || {}),
      bilibiliStatus: data.status || mapped,
      accountUid: data.profile?.uid || '',
      accountName: data.profile?.nickname || '',
      accountAvatar: data.profile?.avatar || '',
      riskActive: data.risk?.active === true,
      riskUntil: Number(data.risk?.until) || 0,
      browserRunning: data.browser?.running === true,
      lastError: data.error || '',
    }
    const unchanged =
      channel.status === mapped &&
      String(channel.meta?.bilibiliStatus || '') === String(nextMeta.bilibiliStatus) &&
      String(channel.meta?.accountUid || '') === String(nextMeta.accountUid) &&
      String(channel.meta?.accountName || '') === String(nextMeta.accountName) &&
      (channel.meta?.lastError || '') === nextMeta.lastError
    if (unchanged) return
    channels.updateChannel(findTab(channel.id), channel.id, { status: mapped, meta: nextMeta })
  }

  async function syncChannelConfig(channel, { quiet = true } = {}) {
    if (!api || !isBiliChannel(channel)) return null
    const meta = biliMeta(channel)
    try {
      const data = await api.post('/bilibili/channels/config', {
        channelId: channel.id,
        name: channel.name,
        settings: {
          capabilities: meta.capabilities,
          noticeKinds: meta.noticeKinds,
          poll: meta.poll,
          limits: meta.limits,
          browserFallback: meta.browserFallback,
          browserHeadless: meta.browserHeadless,
          sendVia: meta.sendVia,
          realtime: meta.realtime,
          videos: meta.videos,
          autoOwnVideos: meta.autoOwnVideos,
        },
      })
      if (data) updateChannelFromStatus({ ...data, channelId: channel.id })
      return data
    } catch (err) {
      if (!quiet) toast.warn?.(`同步 B站渠道失败：${err?.message || err}`)
      return null
    }
  }

  async function syncAllChannels() {
    if (!api) return
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (isBiliChannel(channel)) await syncChannelConfig(channel)
      }
    }
  }

  function scheduleSync(delay = 400) {
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = null
      syncAllChannels().catch(() => {})
    }, delay)
  }

  /* ---------------- 会话：一个对端 / 一个稿件线程一个容器 ---------------- */

  function threadChannelId(channel, item) {
    const key = String(item?.thread?.key || `${item?.kind || 'msg'}:${item?.sender?.uid || item?.id || 'unknown'}`)
    return `${TYPE_ID}:${channel.id}:${key}`
  }

  async function ensureConversation(channel, item) {
    if (!isBiliChannel(channel)) return null
    const role = roleOf(channel)
    const roleId = channel.meta?.roleId || role?.meta?.roleId || role?.id || channel.id
    const permissions = permissionsOf(channel)
    const identity = channelIdentity(channel)
    const stableChannelId = threadChannelId(channel, item)
    const thread = item?.thread || {}
    const isDm = item?.kind === 'dm'
    const findByKey = () => {
      let found = typeof sessions.findByChannelId === 'function' ? sessions.findByChannelId(stableChannelId) : null
      if (!found && channel.meta?.conversationId) {
        const candidate = sessions.get(channel.meta.conversationId)
        if (
          candidate &&
          String(candidate.meta?.bilibiliChannelId || '') === String(channel.id) &&
          String(candidate.meta?.bilibiliThreadKey || '') === String(thread.key || '')
        ) {
          found = candidate
        }
      }
      return found
    }
    let conv = findByKey()
    // 首次后端同步完成前先等 ready，避免同一个线程在两次启动里被创建成多个空会话。
    if (
      !conv &&
      typeof sessions.ready === 'function' &&
      typeof sessions.isInitialSyncSettled === 'function' &&
      sessions.isInitialSyncSettled() === false
    ) {
      try {
        await sessions.ready()
      } catch (_) {
        /* 离线 / 后端不可用时继续用本地会话 */
      }
      conv = findByKey()
    }
    const label = isDm
      ? `私信 · ${item?.sender?.name || item?.sender?.uid || '未知用户'}`
      : `${KIND_LABEL[item?.kind] || '评论'} · ${thread.name || thread.bvid || thread.oid || '未命名'}`
    const metaPatch = {
      channelId: stableChannelId,
      channelType: TYPE_ID,
      channelGroup: isDm ? 'private' : 'group',
      source: TYPE_ID,
      roleId,
      bilibiliChannelId: channel.id,
      bilibiliThreadKey: String(thread.key || ''),
      bilibiliThread: {
        kind: item?.kind || 'comment',
        peerUid: isDm ? thread.peerUid || item?.target?.peerUid || '' : '',
        oid: thread.oid || item?.target?.oid || '',
        type: Number(thread.type || item?.target?.type) || 0,
        bvid: thread.bvid || item?.target?.bvid || '',
        name: thread.name || '',
        // 评论合并外发是延迟进行的，这里持久化回复目标，避免 activeTurns 清空后丢失 rpid。
        rpid: String(item?.target?.rpid || ''),
        root: String(item?.target?.root || ''),
        parent: String(item?.target?.parent || ''),
      },
      hiddenFromSessionList: true,
      channelConversation: true,
      identityUserId: identity.userId,
      identityUserName: identity.userName,
      participatesWorkingMemory: permissions.context !== false,
      crossReadable: permissions.crossRead === true,
      crossSendable: permissions.crossSend === true,
      sensitiveConfirm: permissions.confirm !== false,
      contextMode: isDm ? '' : 'channel-only',
      contextMessages: isDm ? 0 : 40,
      contextRounds: 0,
      persona: role?.meta?.persona ?? conv?.meta?.persona ?? '',
      model: role?.meta?.model ?? conv?.meta?.model ?? '',
      backupMode: role?.meta?.backupMode ?? conv?.meta?.backupMode ?? 'global',
      backupModels: role?.meta?.backupModels ?? conv?.meta?.backupModels ?? [],
      backupModel: role?.meta?.backupModel ?? conv?.meta?.backupModel ?? 'global',
      avatarImage: role?.meta?.avatarImage ?? conv?.meta?.avatarImage ?? '',
    }
    if (!conv) {
      conv = sessions.create({
        name: `${role?.name || '角色'} · B站${label}`,
        avatar: role?.avatar || (role?.name || 'B').slice(0, 1),
        c1: role?.c1,
        c2: role?.c2,
        preview: `${role?.name || '角色'} 的 B站渠道 · ${label}`,
        meta: metaPatch,
      })
    } else {
      sessions.update(conv.id, { meta: { ...(conv.meta || {}), ...metaPatch } })
    }
    if (String(channel.meta?.conversationId || '') !== String(conv.id)) {
      channels.updateChannel(findTab(channel.id), channel.id, {
        meta: { ...(channel.meta || {}), conversationId: conv.id },
      })
    }
    try {
      store?.channelForConversation?.(conv.id)
    } catch (_) {
      /* chat-store 未就绪时忽略 */
    }
    return conv
  }

  function threadConversations(channelId) {
    return sessions
      .list()
      .filter(conv => conv?.meta?.channelType === TYPE_ID && String(conv.meta.bilibiliChannelId || '') === String(channelId))
      .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
  }

  /* ---------------- 入站：策略判定 / 落库 / 触发模型 ---------------- */

  function dedupeInbound(channelId, item) {
    let seen = handledInbound.get(channelId)
    if (!seen) {
      seen = new Set()
      handledInbound.set(channelId, seen)
    }
    if (seen.has(item.id)) return false
    seen.add(item.id)
    if (seen.size > 800) seen.delete(seen.values().next().value)
    return true
  }

  async function handleInbound(raw) {
    // 服务端代聊已接管时，WebUI 只负责展示；避免两个实例同时触发模型。
    if (api?.supports?.('server-agent') && globalThis.__NIANFENG_SERVER_AGENT__ !== true) return
    const channelId = raw?.channelId || raw?.bilibiliChannelId
    const item = raw?.item || raw
    if (!channelId || !item?.id) return
    const channel = findChannel(channelId)
    if (!isBiliChannel(channel) || !dedupeInbound(channel.id, item)) return

    const policy = biliMeta(channel).policy
    // 全局历史闸门：处理时已经超过 10 分钟的消息一律按积压处理（静默入库、不触发模型），
    // 覆盖 inbox 重放、实时断线补收、首次同步等各种“晚到”路径。
    const stale = Number(item.at) > 0 && Date.now() - Number(item.at) > 10 * 60 * 1000
    const isBacklog = item.backlog === true || stale
    let decision = decide(
      { kind: item.kind, id: item.id, senderUid: item.sender?.uid, senderName: item.sender?.name, text: item.text, backlog: isBacklog },
      policy,
    )
    // 扩展插件可监听 bilibili:trigger-decision 接管 / 修改判定（与 NapCat 习惯一致）。
    try {
      const payload = { channel, item, ...decision }
      const intercepted = events.emit('bilibili:trigger-decision', payload, { interceptor: true }) || payload
      if (intercepted && typeof intercepted === 'object') {
        const explicitOutcome = ['drop', 'ingest', 'process'].includes(intercepted.outcome) ? intercepted.outcome : ''
        const explicitTrigger = typeof intercepted.trigger === 'boolean' ? intercepted.trigger : null
        if (explicitOutcome || explicitTrigger !== null) {
          decision = {
            scope: decision.scope,
            outcome: explicitOutcome || (explicitTrigger ? 'process' : 'drop'),
            reason: intercepted.reason || decision.reason,
          }
        }
      }
    } catch (_) {
      /* 扩展失败时继续默认规则 */
    }
    ctx.logger.info(
      `[bilibili] 收到${KIND_LABEL[item.kind] || item.kind}：${previewText(item)}（${item.sender?.name || item.sender?.uid || '未知'}）→ ${describeDecision(decision)}`,
    )
    if (decision.outcome === 'drop') return

    const conv = await ensureConversation(channel, item)
    if (!conv) return
    const permissions = permissionsOf(channel)
    const senderUid = String(item.sender?.uid || '')
    const text = String(item.text || '').trim() || (Array.isArray(item.images) && item.images.length ? '[图片]' : '') || previewText(item)
    // 稿件基本信息单独作为一条顶层 user 消息，真正的 @ 评论只放原评论内容，
    // 避免模型把“视频标题”当成对方说的话。
    const video = item.video || null
    const videoUrl = video?.url
      || (item.target?.bvid ? `https://www.bilibili.com/video/${item.target.bvid}` : '')
      || (Number(item.target?.type) === 1 && item.target?.oid ? `https://www.bilibili.com/video/av${item.target.oid}` : '')
    const contextParts = []
    if (video?.title) contextParts.push(`标题：${video.title}`)
    if (videoUrl) contextParts.push(`链接：${videoUrl}`)
    if (video?.owner) contextParts.push(`UP：${video.owner}`)
    if (video?.desc) contextParts.push(`简介：${String(video.desc).replace(/\s+/g, ' ').slice(0, 300)}`)
    const contextText = contextParts.length ? `【B站视频信息】${contextParts.join('；')}` : ''
    const messageMeta = {
      via: TYPE_ID,
      direction: 'inbound',
      bilibiliChannelId: channel.id,
      bilibiliKind: item.kind,
      bilibiliThreadKey: String(item.thread?.key || ''),
      peerUid: String(item.target?.peerUid || item.thread?.peerUid || ''),
      senderId: `bili:${senderUid}`,
      senderUid,
      senderNickname: item.sender?.name || '',
      commentId: String(item.target?.rpid || ''),
      oid: String(item.target?.oid || ''),
      commentType: Number(item.target?.type) || 0,
      root: String(item.target?.root || ''),
      parent: String(item.target?.parent || ''),
      bvid: String(item.target?.bvid || ''),
      video: video ? { bvid: video.bvid || '', title: video.title || '', url: videoUrl, owner: video.owner || '' } : undefined,
      replyLookup: item.replyLookup === true || undefined,
      textMissing: item.textMissing === true || undefined,
      triggered: decision.outcome === 'process',
      triggerReason: decision.reason,
      backlog: isBacklog || undefined,
    }
    const appendUser = payload => {
      if (store?.append) store.append(conv.id, { role: 'user', ...payload })
      else messages?.add?.(conv.id, { role: 'user', status: 'sent', ...payload })
    }

    // 1) 每个会话首次收到该稿件内容时，先单独写入一条「视频信息」顶层消息。
    if (contextText) {
      const contextKey = `${video?.bvid || item.target?.bvid || item.target?.oid || ''}:${Number(item.target?.type) || 1}`
      if (String(conv.meta?.bilibiliVideoContextKey || '') !== contextKey) {
        appendUser({
          content: contextText,
          sender_id: 'bili:video-context',
          sender_name: 'B站视频信息',
          source: TYPE_ID,
          meta: {
            via: TYPE_ID,
            direction: 'inbound',
            bilibiliVideoContext: true,
            bilibiliChannelId: channel.id,
            video: video ? { bvid: video.bvid || '', title: video.title || '', url: videoUrl, owner: video.owner || '' } : undefined,
          },
        })
        try {
          sessions.update(conv.id, { meta: { ...(conv.meta || {}), bilibiliVideoContextKey: contextKey } })
        } catch (_) {
          /* ignore */
        }
      }
    }

    // 2) 对方 @ 我的原评论 / 私信正文本身，保持干净，不混入视频标题。
    appendUser({
      content: text,
      sender_id: `bili:${senderUid}`,
      sender_name: item.sender?.name || senderUid,
      source: TYPE_ID,
      meta: messageMeta,
    })

    if (decision.outcome !== 'process') return
    if (permissions.read === false || permissions.reply === false) return
    if (!ctx.registry.get('chat-flow')) return
    activeTurns.set(conv.id, { channel, item, decision, content: text })
    const previous = busyChains.get(conv.id) || Promise.resolve()
    const task = previous
      .catch(() => {})
      .then(() => runInboundTurn(channel, conv, item, text))
      .catch(err => ctx.logger?.warn?.(`[bilibili] 处理 ${item.id} 失败：${err?.message || err}`))
    busyChains.set(conv.id, task)
    task.finally(() => {
      if (busyChains.get(conv.id) === task) busyChains.delete(conv.id)
    })
  }

  async function runInboundTurn(channel, conv, item, content = '') {
    try {
      await new Promise(resolve => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (pendingTurns.get(conv.id) === finish) pendingTurns.delete(conv.id)
          resolve()
        }
        const timer = setTimeout(finish, 10 * 60 * 1000)
        pendingTurns.set(conv.id, finish)
        try {
          events.emit('message:send', {
            conversationId: conv.id,
            text: content || String(item.text || '').trim() || (item.images?.length ? '[图片]' : '') || previewText(item),
            images: [],
            skipUserAppend: true,
          })
        } catch (_) {
          finish()
        }
      })
      await outboundIdle(conv.id)
    } finally {
      const current = activeTurns.get(conv.id)
      if (current?.item?.id === item.id) activeTurns.delete(conv.id)
    }
  }

  /* ---------------- 外发：按会话独立路由 ---------------- */

  const outboundIdle = conversationId => outboundChains.get(conversationId) || Promise.resolve()

  function enqueueOutbound(conversationId, task) {
    const previous = outboundChains.get(conversationId) || Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    outboundChains.set(conversationId, next)
    Promise.resolve(next)
      .catch(() => {})
      .finally(() => {
        if (outboundChains.get(conversationId) === next) outboundChains.delete(conversationId)
      })
    return next
  }

  function deliverable(message) {
    if (!message || message.role !== 'assistant') return false
    if (message.streaming || message.error) return false
    if (message.meta?.direction === 'outbound') return false
    if (!String(message.content || '').trim() && !(Array.isArray(message.meta?.images) && message.meta.images.length)) return false
    return true
  }

  function commentTargetOf(thread, active) {
    const target = active?.item?.target || thread || {}
    const oid = String(target.oid || thread?.oid || '')
    const type = Number(target.type || thread?.type) || 1
    const bvid = String(target.bvid || thread?.bvid || '')
    const rpid = String(target.rpid || '')
    if (!oid) throw new Error('当前评论会话缺少稿件 oid，无法回复')
    return { target, oid, type, bvid, rpid }
  }

  async function sendCommentMessage({ channel, thread, active, text }) {
    const { target, oid, type, bvid, rpid } = commentTargetOf(thread, active)
    if (rpid) {
      return api.post('/bilibili/comment/reply', {
        channelId: channel.id,
        oid,
        type,
        bvid,
        rpid,
        root: String(target.root || rpid),
        parent: String(target.parent || rpid),
        text,
      }, { timeoutMs: 120000 })
    }
    // @ 通知可能不带评论 rpid：降级为在稿件下发一条新评论，并带上 @昵称。
    const mention = active?.item?.sender?.name ? `@${active.item.sender.name} ` : ''
    ctx.logger.info(`[bilibili] 缺少评论 ID，已降级为在稿件 ${oid} 下发新评论`)
    return api.post('/bilibili/comment/post', { channelId: channel.id, oid, type, bvid, text: `${mention}${text}` }, { timeoutMs: 120000 })
  }

  function patchOutboundMeta(entry, { rpid = '', verified, error = '', mergedInto = '' } = {}) {
    try {
      const current = sessions.message(entry.conversationId, entry.messageId)
      if (!current) return
      messages?.update?.(entry.conversationId, entry.messageId, {
        meta: {
          ...(current.meta || {}),
          via: TYPE_ID,
          direction: 'outbound',
          bilibiliSent: !error,
          bilibiliRpid: rpid || undefined,
          bilibiliVerified: verified,
          bilibiliMergedInto: mergedInto || undefined,
          outboundError: error || '',
        },
      })
    } catch (_) {
      /* ignore */
    }
  }

  /** B站评论单条上限 1000 字；合并超长时按行拆段，正常情况只有一条。 */
  function splitCommentText(text, max = 900) {
    const source = String(text || '')
    const lines = source.split('\n')
    const chunks = []
    let current = ''
    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line
      if (next.length <= max) {
        current = next
        continue
      }
      if (current) chunks.push(current)
      if (line.length <= max) {
        current = line
      } else {
        for (let index = 0; index < line.length; index += max) chunks.push(line.slice(index, index + max))
        current = ''
      }
    }
    if (current) chunks.push(current)
    return chunks.length ? chunks : [source.slice(0, max)]
  }

  /** 评论外发合并：2.2 秒窗口内的多条助手消息用换行拼成一条评论，避免连续刷屏。 */
  function flushCommentBatch(conversationId) {
    const batch = commentBatches.get(conversationId)
    if (!batch) return
    commentBatches.delete(conversationId)
    if (batch.timer) clearTimeout(batch.timer)
    const merged = batch.messages.map(item => item.text).join('\n').trim()
    if (!merged) {
      for (const entry of batch.messages) outboundSeen.delete(entry.seenKey)
      return
    }
    enqueueOutbound(conversationId, async () => {
      try {
        const chunks = splitCommentText(merged, 900)
        let rpid = ''
        let verified
        for (const chunk of chunks) {
          const result = await sendCommentMessage({ channel: batch.channel, thread: batch.thread, active: batch.active, text: chunk })
          const sent = result?.data && typeof result.data === 'object' ? result.data : result || {}
          rpid = rpid || String(sent.rpid || '')
          verified = typeof sent.verified === 'boolean' ? sent.verified : verified
        }
        const firstId = batch.messages[0]?.messageId || ''
        for (const entry of batch.messages) {
          patchOutboundMeta(entry, { rpid, verified, mergedInto: entry.messageId === firstId ? '' : firstId })
        }
        if (verified === false) {
          toast?.warn?.('评论已提交，但 B站 暂未公开显示：可能在审核 / 被折叠 / 仅自己可见')
          ctx.logger.warn(`[bilibili] 评论已提交但未公开可见 rpid=${rpid}（合并 ${batch.messages.length} 条消息）`)
        } else {
          ctx.logger.info(`[bilibili] 评论外发成功${rpid ? ` rpid=${rpid}` : ''}：合并 ${batch.messages.length} 条消息`)
        }
      } catch (err) {
        const error = String(err?.message || err).slice(0, 300)
        ctx.logger.warn(`[bilibili] 评论外发失败：${error}`)
        toast?.warn?.(`「${batch.channel.name}」外发失败：${error}`)
        for (const entry of batch.messages) patchOutboundMeta(entry, { error })
        try {
          messages?.add?.(conversationId, {
            role: 'assistant',
            content: `【外发失败】${batch.channel.name}：${error}`,
            meta: { via: TYPE_ID, direction: 'outbound', outboundError: error, errorNotice: true },
          })
        } catch (_) {
          /* ignore */
        }
      } finally {
        for (const entry of batch.messages) outboundSeen.delete(entry.seenKey)
      }
    })
  }

  function dispatchOutbound(conversationId, message) {
    if (!deliverable(message) || !api) return false
    const suppressUntil = Number(suppressOutbound.get(conversationId)) || 0
    if (Date.now() < suppressUntil) {
      ctx.logger.debug?.(`[bilibili] 本轮已通过工具主动发送，跳过自动外发：${String(message.content || '').slice(0, 40)}`)
      return false
    }
    const conv = sessions.get(conversationId)
    if (conv?.meta?.channelType !== TYPE_ID) return false
    const channel = findChannel(conv.meta.bilibiliChannelId)
    if (!channel) return false
    const messageId = String(message.id || message.message_id || '')
    const seenKey = `${conversationId}:${messageId}`
    if (outboundSeen.has(seenKey)) return false
    const text = String(message.content || '').trim()
    if (!text) return false
    outboundSeen.add(seenKey)
    const active = activeTurns.get(conversationId)
    const thread = conv.meta?.bilibiliThread || {}
    if (thread.kind === 'dm') {
      enqueueOutbound(conversationId, async () => {
        try {
          const peerUid = String(thread.peerUid || active?.item?.target?.peerUid || '')
          if (!peerUid) throw new Error('当前私信会话缺少对端 UID')
          const result = await api.post('/bilibili/dm/send', { channelId: channel.id, peerUid, text }, { timeoutMs: 120000 })
          patchOutboundMeta({ conversationId, messageId }, {})
          ctx.logger.info(`[bilibili] 私信外发成功：${text.slice(0, 40)}`)
          return result
        } catch (err) {
          const error = String(err?.message || err).slice(0, 300)
          ctx.logger.warn(`[bilibili] 私信外发失败：${error}`)
          toast?.warn?.(`「${channel.name}」外发失败：${error}`)
          patchOutboundMeta({ conversationId, messageId }, { error })
          try {
            messages?.add?.(conversationId, {
              role: 'assistant',
              content: `【外发失败】${channel.name}：${error}`,
              meta: { via: TYPE_ID, direction: 'outbound', outboundError: error, errorNotice: true },
            })
          } catch (_) {
            /* ignore */
          }
          return { ok: false, error }
        } finally {
          outboundSeen.delete(seenKey)
        }
      })
      return true
    }
    let batch = commentBatches.get(conversationId)
    if (!batch) {
      batch = { channel, thread: { ...thread }, active, timer: null, messages: [] }
      commentBatches.set(conversationId, batch)
    }
    batch.messages.push({ conversationId, messageId, seenKey, text })
    if (batch.timer) clearTimeout(batch.timer)
    batch.timer = setTimeout(() => flushCommentBatch(conversationId), 2200)
    batch.timer.unref?.()
    return true
  }

  const onOutboundMessage = payload => {
    if (payload?.conversationId && payload?.message) dispatchOutbound(payload.conversationId, payload.message)
  }

  /* ---------------- SSE / 收件箱补收 ---------------- */

  function parseEvent(event) {
    try {
      return event?.data ? JSON.parse(event.data) : null
    } catch (_) {
      return null
    }
  }

  const isAgentProcessor = () => !(api?.supports?.('server-agent') && globalThis.__NIANFENG_SERVER_AGENT__ !== true)

  async function ackInbox(channelId, seq) {
    const value = Number(seq) || 0
    if (!api || !value || !isAgentProcessor()) return false
    lastInboxSeq.set(String(channelId), Math.max(Number(lastInboxSeq.get(String(channelId))) || 0, value))
    try {
      await api.post('/bilibili/inbox/ack', { channelId, seq: value })
      return true
    } catch (_) {
      return false
    }
  }

  function ensureBackendEvents() {
    if (backendEvents || !api || typeof EventSource === 'undefined') return
    try {
      const source = new EventSource(`${api.baseUrl()}/events`)
      source.addEventListener('bilibili:message', event => {
        const data = parseEvent(event)
        if (data?.item) {
          handleInbound({ channelId: data.channelId, item: data.item })
            .then(() => ackInbox(data.channelId, data.item.seq))
            .catch(() => {})
        }
      })
      source.addEventListener('bilibili:status', event => {
        const data = parseEvent(event)
        if (data) updateChannelFromStatus(data)
      })
      source.addEventListener('bilibili:notice', event => {
        const data = parseEvent(event)
        if (data?.message) (data.level === 'warn' ? toast.warn : toast.info)?.call(toast, data.message)
      })
      source.addEventListener('open', () => {
        drainAllInboxes().catch(() => {})
      })
      backendEvents = source
    } catch (_) {
      backendEvents = null
    }
  }

  async function drainInbox(channel) {
    if (!api || !isBiliChannel(channel)) return
    const processor = isAgentProcessor()
    const after = Number(lastInboxSeq.get(channel.id)) || 0
    const data = await api.get(`/bilibili/inbox?channelId=${encodeURIComponent(channel.id)}&after=${after}`)
    const items = (data?.items || []).slice().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
    let maxSeq = after
    for (const item of items) {
      maxSeq = Math.max(maxSeq, Number(item.seq) || 0)
      if (processor) await handleInbound({ channelId: channel.id, item })
    }
    lastInboxSeq.set(channel.id, maxSeq)
    if (processor && maxSeq > after) await api.post('/bilibili/inbox/ack', { channelId: channel.id, seq: maxSeq }).catch(() => {})
  }

  async function drainAllInboxes() {
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (!isBiliChannel(channel)) continue
        try {
          await drainInbox(channel)
        } catch (_) {
          /* 后端未启动时忽略 */
        }
      }
    }
  }

  /* ---------------- 对外服务（其它插件 / 测试可直接调用） ---------------- */

  ctx.provide('bilibili-channel', {
    name: 'bilibili-channel',
    version,
    type: TYPE_ID,
    channels: () => {
      const list = []
      for (const tab of channels.tabs()) for (const channel of channels.channels(tab)) if (isBiliChannel(channel)) list.push(channel)
      return list
    },
    decide: (channelOrId, item) => {
      const channel = typeof channelOrId === 'string' ? findChannel(channelOrId) : channelOrId
      if (!isBiliChannel(channel)) throw new Error('不是 B站渠道')
      return decide(
        { kind: item?.kind, id: item?.id, senderUid: item?.sender?.uid, senderName: item?.sender?.name, text: item?.text, backlog: item?.backlog === true },
        biliMeta(channel).policy,
      )
    },
    handleInbound: item => handleInbound(item),
    threads: channelId => threadConversations(channelId),
    syncConfig: channelOrId => {
      const channel = typeof channelOrId === 'string' ? findChannel(channelOrId) : channelOrId
      if (!isBiliChannel(channel)) return Promise.resolve(null)
      return syncChannelConfig(channel, { quiet: false })
    },
  })

  /* ---------------- 渠道注册 ---------------- */

  const registration = base.defineChannel({
    type: TYPE_ID,
    name: '哔哩哔哩',
    color: TYPE_COLOR,
    icon: TYPE_ICON,
    description: 'B站账号渠道：私信 / 消息中心（回复我·@我）/ 评论，应用内扫码或 Edge 托管登录。',
    create: options => openCreateDialog(options),
    detail: options => mountDetailPanel(options),
    connect: async channel => {
      await syncChannelConfig(channel, { quiet: false })
      const meta = biliMeta(channel)
      return { ...channel, ...meta }
    },
    disconnect: async channel => {
      if (api) await api.post('/bilibili/browser/close', { channelId: channel.id }).catch(() => {})
      return channel
    },
  })
  ctx.effect(() => registration?.dispose?.())

  /* ---------------- 模型工具（收发独立） ---------------- */

  const resolveToolChannel = args => {
    const explicit = String(args?.channel_id || args?.channelId || '').trim()
    if (explicit) {
      const channel = findChannel(explicit)
      if (!isBiliChannel(channel)) throw new Error(`找不到 B站渠道：${explicit}`)
      return channel
    }
    const list = []
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (isBiliChannel(channel) && channel.status === 'online') list.push(channel)
      }
    }
    if (list.length === 1) return list[0]
    if (!list.length) throw new Error('没有已登录的 B站渠道，请先在渠道列表里添加并登录')
    throw new Error('有多个已登录的 B站渠道，请用 channel_id 指定')
  }
  const resolveVideoTarget = (args, context) => {
    const explicit = String(args?.target || args?.video || args?.url || args?.bvid || '').trim()
    if (explicit) return explicit
    const active = context?.conversationId ? activeTurns.get(String(context.conversationId)) : null
    const target = active?.item?.target || {}
    if (target.bvid) return String(target.bvid)
    if (Number(target.type) === 1 && target.oid) return `av${target.oid}`
    return ''
  }
  const markToolSent = context => {
    const id = String(context?.conversationId || '')
    if (!id) return
    if (suppressOutbound.size > 200) {
      for (const [key, until] of suppressOutbound) if (Number(until) < Date.now()) suppressOutbound.delete(key)
    }
    suppressOutbound.set(id, Date.now() + 15000)
  }
  const toolDisposers = []
  if (tools?.register) {
    const channelParam = { type: 'string', description: 'B站渠道 ID；只有一个在线渠道时可省略' }
    toolDisposers.push(
      tools.register(
        'bilibili_dm_send',
        {
          description: '给指定 B站 UID 发送一条私信（默认发给主动来消息的对端）。注意 B站对陌生人私信有限制。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              peer_uid: { type: 'string', description: '接收者 B站 UID' },
              text: { type: 'string', description: '私信正文' },
            },
            required: ['peer_uid', 'text'],
          },
        },
        async (args, context) => {
          markToolSent(context)
          const channel = resolveToolChannel(args)
          const data = await api.post('/bilibili/dm/send', { channelId: channel.id, peerUid: String(args.peer_uid || ''), text: String(args.text || '') }, { timeoutMs: 120000 })
          return { ok: true, channel: channel.name, ...data }
        },
      ),
    )
    toolDisposers.push(
      tools.register(
        'bilibili_dm_read',
        {
          description: '读取 B站私信：填 peer_uid 读某个对端的最近消息，不填则返回最近会话列表。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              peer_uid: { type: 'string', description: '可选，对端 UID' },
              limit: { type: 'number', description: '最多返回多少条，默认 20，最大 50' },
            },
          },
        },
        async args => {
          const channel = resolveToolChannel(args)
          const limit = Math.max(1, Math.min(50, Number(args.limit) || 20))
          if (args.peer_uid) {
            const data = await api.get(`/bilibili/dm/messages?channelId=${encodeURIComponent(channel.id)}&peerUid=${encodeURIComponent(String(args.peer_uid))}&limit=${limit}`)
            return { ok: true, channel: channel.name, ...data }
          }
          const data = await api.get(`/bilibili/dm/sessions?channelId=${encodeURIComponent(channel.id)}`)
          return { ok: true, channel: channel.name, sessions: (data.sessions || []).slice(0, limit) }
        },
      ),
    )
    toolDisposers.push(
      tools.register(
        'bilibili_notice_read',
        {
          description: '读取 B站主页「消息」：回复我的 / @我的 / 收到的赞 / 系统消息。kind 默认 reply。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              kind: { type: 'string', enum: ['reply', 'at', 'like', 'system'], description: '消息中心分类' },
              limit: { type: 'number', description: '最多返回多少条，默认 20' },
            },
          },
        },
        async args => {
          const channel = resolveToolChannel(args)
          const kind = String(args.kind || 'reply')
          const limit = Math.max(1, Math.min(50, Number(args.limit) || 20))
          const data = await api.get(`/bilibili/notice/list?channelId=${encodeURIComponent(channel.id)}&kind=${encodeURIComponent(kind)}`)
          return { ok: true, channel: channel.name, kind, items: (data.items || []).slice(0, limit) }
        },
      ),
    )
    toolDisposers.push(
      tools.register(
        'bilibili_comment_read',
        {
          description: '读取指定 B站视频的评论（支持 BV 号 / av 号 / 视频链接 / 短链）。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              target: { type: 'string', description: '视频 BV 号 / av 号 / 链接' },
              limit: { type: 'number', description: '最多返回多少条，默认 20' },
            },
            required: ['target'],
          },
        },
        async args => {
          const channel = resolveToolChannel(args)
          const limit = Math.max(1, Math.min(50, Number(args.limit) || 20))
          const data = await api.get(`/bilibili/comment/list?channelId=${encodeURIComponent(channel.id)}&target=${encodeURIComponent(String(args.target || ''))}&limit=${limit}`)
          return { ok: true, channel: channel.name, items: data.items || [] }
        },
      ),
    )
    toolDisposers.push(
      tools.register(
        'bilibili_comment_post',
        {
          description: '在指定 B站视频下主动发一条新评论。请控制频率，避免触发风控。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              target: { type: 'string', description: '视频 BV 号 / av 号 / 链接' },
              text: { type: 'string', description: '评论正文（最多 1000 字）' },
            },
            required: ['target', 'text'],
          },
        },
        async (args, context) => {
          markToolSent(context)
          const channel = resolveToolChannel(args)
          const active = context?.conversationId ? activeTurns.get(String(context.conversationId)) : null
          const activeTarget = active?.item?.target || {}
          // 兼容模型常见的参数别名：video / url / bvid / content / message。
          const explicitTarget = String(args.target || args.video || args.url || args.bvid || '').trim()
          const text = String(args.text || args.content || args.message || '').trim()
          if (!text) throw new Error('缺少评论正文（text）')
          const body = { channelId: channel.id, text }
          if (explicitTarget) body.target = explicitTarget
          else {
            body.oid = String(activeTarget.oid || '')
            body.type = Number(activeTarget.type) || 1
            body.bvid = String(activeTarget.bvid || '')
          }
          if (!body.target && !body.oid) throw new Error('缺少评论目标：请提供视频 BV 号 / 链接，或在本渠道的评论会话里调用')
          const data = await api.post('/bilibili/comment/post', body, { timeoutMs: 120000 })
          return { ok: true, channel: channel.name, ...data }
        },
      ),
    )
    toolDisposers.push(
      tools.register(
        'bilibili_comment_reply',
        {
          description: '回复 B站某条评论（评论通知里回复我的 / @我的，或评论列表里的 rpid）。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              target: { type: 'string', description: '评论所在视频的 BV 号 / av 号 / 链接；动态评论可改用 oid + type' },
              oid: { type: 'string', description: '可选，评论业务 ID（视频 aid 或动态 id）' },
              type: { type: 'number', description: '可选，评论区类型，视频为 1，动态为 17' },
              rpid: { type: 'string', description: '要回复的评论 ID' },
              root: { type: 'string', description: '可选，楼中楼根评论 ID；默认与 rpid 相同' },
              parent: { type: 'string', description: '可选，直接父评论 ID；默认与 rpid 相同' },
              text: { type: 'string', description: '回复正文' },
            },
            required: ['rpid', 'text'],
          },
        },
        async (args, context) => {
          markToolSent(context)
          const channel = resolveToolChannel(args)
          const active = context?.conversationId ? activeTurns.get(String(context.conversationId)) : null
          const activeTarget = active?.item?.target || {}
          const explicitTarget = String(args.target || args.video || args.url || args.bvid || '').trim()
          const rpid = String(args.rpid || args.comment_id || args.reply_id || activeTarget.rpid || '')
          const text = String(args.text || args.content || args.message || '').trim()
          if (!rpid) throw new Error('缺少 rpid：可直接回复当前评论会话，或先用 bilibili_comment_read 查评论 ID')
          if (!text) throw new Error('缺少回复正文（text）')
          const body = {
            channelId: channel.id,
            rpid,
            text,
            root: args.root ? String(args.root) : String(activeTarget.root || rpid),
            parent: args.parent ? String(args.parent) : String(activeTarget.parent || rpid),
          }
          if (explicitTarget) body.target = explicitTarget
          else {
            body.oid = String(args.oid || activeTarget.oid || '')
            body.type = Number(args.type || activeTarget.type) || 1
            body.bvid = String(activeTarget.bvid || '')
          }
          const data = await api.post('/bilibili/comment/reply', body, { timeoutMs: 120000 })
          return { ok: true, channel: channel.name, ...data }
        },
      ),
    )
    toolDisposers.push(
      tools.register(
        'bilibili_video_like',
        {
          description: '给指定 B站视频点赞（支持 BV 号 / av 号 / 链接）。高频点赞有风控风险，已内置独立队列与频率限制。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              target: { type: 'string', description: '视频 BV 号 / av 号 / 链接' },
              like: { type: 'boolean', description: 'true 点赞（默认），false 取消点赞' },
            },
            required: ['target'],
          },
        },
        async (args, context) => {
          const channel = resolveToolChannel(args)
          const target = resolveVideoTarget(args, context)
          if (!target) throw new Error('缺少视频目标：请提供 BV 号 / av 号 / 链接')
          const data = await api.post('/bilibili/video/like', { channelId: channel.id, target, like: args.like !== false }, { timeoutMs: 120000 })
          return { ok: true, channel: channel.name, ...data }
        },
      ),
    )
    toolDisposers.push(
      tools.register(
        'bilibili_video_coin',
        {
          description: '给指定 B站视频投币（1 或 2 枚），可选同时点赞。注意硬币余额与每日上限。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              target: { type: 'string', description: '视频 BV 号 / av 号 / 链接' },
              count: { type: 'number', description: '投币数量：1（默认）或 2' },
              also_like: { type: 'boolean', description: '是否同时点赞' },
            },
            required: ['target'],
          },
        },
        async (args, context) => {
          const channel = resolveToolChannel(args)
          const target = resolveVideoTarget(args, context)
          if (!target) throw new Error('缺少视频目标：请提供 BV 号 / av 号 / 链接')
          const data = await api.post('/bilibili/video/coin', {
            channelId: channel.id,
            target,
            count: Number(args.count) >= 2 ? 2 : 1,
            alsoLike: args.also_like === true,
          }, { timeoutMs: 120000 })
          return { ok: true, channel: channel.name, ...data }
        },
      ),
    )
    toolDisposers.push(
      tools.register(
        'bilibili_video_favorite',
        {
          description: '把指定 B站视频收藏到账号的收藏夹；未指定 folder_id 时自动用第一个收藏夹（没有则创建「念风收藏」）。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              target: { type: 'string', description: '视频 BV 号 / av 号 / 链接' },
              folder_id: { type: 'string', description: '可选，收藏夹 ID' },
            },
            required: ['target'],
          },
        },
        async (args, context) => {
          const channel = resolveToolChannel(args)
          const target = resolveVideoTarget(args, context)
          if (!target) throw new Error('缺少视频目标：请提供 BV 号 / av 号 / 链接')
          const data = await api.post('/bilibili/video/favorite', {
            channelId: channel.id,
            target,
            folderId: args.folder_id ? String(args.folder_id) : '',
          }, { timeoutMs: 120000 })
          return { ok: true, channel: channel.name, ...data }
        },
      ),
    )
    toolDisposers.push(
      tools.register(
        'bilibili_video_triple',
        {
          description: '一键三连：给指定 B站视频点赞 + 投 2 币 + 收藏。三个动作走同一独立队列，任一步失败会返回在 data 里。',
          parameters: {
            type: 'object',
            properties: {
              channel_id: channelParam,
              target: { type: 'string', description: '视频 BV 号 / av 号 / 链接' },
            },
            required: ['target'],
          },
        },
        async (args, context) => {
          const channel = resolveToolChannel(args)
          const target = resolveVideoTarget(args, context)
          if (!target) throw new Error('缺少视频目标：请提供 BV 号 / av 号 / 链接')
          const data = await api.post('/bilibili/video/triple', { channelId: channel.id, target }, { timeoutMs: 180000 })
          return { ok: true, channel: channel.name, ...data }
        },
      ),
    )
  }
  ctx.effect(() => {
    while (toolDisposers.length) {
      const dispose = toolDisposers.pop()
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
  })

  /* ---------------- 事件接线 / 生命周期 ---------------- */

  const offs = [
    events.on('message:added', onOutboundMessage),
    events.on('message:done', onOutboundMessage),
    events.on('chat:request-done', payload => {
      const finish = pendingTurns.get(payload?.conversationId)
      if (typeof finish === 'function') finish()
    }),
    events.on('channel:add', ({ channel }) => {
      if (!isBiliChannel(channel)) return
      ensureBackendEvents()
      syncChannelConfig(channel).catch(() => {})
    }),
    events.on('channel:updated', ({ channel }) => {
      if (isBiliChannel(channel)) scheduleSync()
    }),
    events.on('channel:sync', () => {
      ensureBackendEvents()
      scheduleSync(600)
    }),
    events.on('channel:activated', ({ tab, id }) => {
      const channel = id ? channels.findChannel(tab, id) : null
      if (isBiliChannel(channel)) syncChannelConfig(channel).catch(() => {})
    }),
    events.on('channel:removed', ({ channel }) => {
      if (!isBiliChannel(channel)) return
      lastInboxSeq.delete(channel.id)
      handledInbound.delete(channel.id)
      detailDrafts.delete(channel.id)
      for (const [conversationId, batch] of commentBatches) {
        if (String(batch.channel?.id || '') !== String(channel.id)) continue
        if (batch.timer) clearTimeout(batch.timer)
        for (const entry of batch.messages) outboundSeen.delete(entry.seenKey)
        commentBatches.delete(conversationId)
      }
      if (api) api.del(`/bilibili/channels/${encodeURIComponent(channel.id)}`).catch(() => {})
    }),
  ]
  ctx.effect(() => offs.forEach(off => off?.()))

  ctx.effect(() => {
    const bootTimer = setTimeout(() => {
      ensureBackendEvents()
      syncAllChannels().catch(() => {})
      drainAllInboxes().catch(() => {})
    }, 1200)
    const fallback = setInterval(() => {
      ensureBackendEvents()
      drainAllInboxes().catch(() => {})
    }, 90000)
    fallback.unref?.()
    return () => {
      clearTimeout(bootTimer)
      clearInterval(fallback)
      try {
        backendEvents?.close?.()
      } catch (_) {
        /* ignore */
      }
      backendEvents = null
      if (syncTimer) clearTimeout(syncTimer)
      for (const task of busyChains.values()) task.catch?.(() => {})
      for (const task of outboundChains.values()) task.catch?.(() => {})
      for (const batch of commentBatches.values()) if (batch.timer) clearTimeout(batch.timer)
      commentBatches.clear()
      pendingTurns.clear()
      activeTurns.clear()
      handledInbound.clear()
    }
  })

  ctx.logger.info('B站渠道插件就绪（外部插件 · 协议 + Edge 兜底）')

  /* ---------------- UI：添加渠道 ---------------- */

  function openCreateDialog({ tab = 'private', typeDef } = {}) {
    const overlay = document.createElement('div')
    overlay.className = 'bil-mask'
    overlay.innerHTML = `
      <div class="bil-dialog" role="dialog" aria-modal="true">
        <h3>添加${escapeHtml(typeDef?.name || '哔哩哔哩')}渠道</h3>
        <div class="bil-sub">一个渠道对应一个 B站账号。保存后可选择应用内扫码、Edge 托管或手动 Cookie 登录。</div>
        <label class="bil-field"><span>渠道名称</span><input data-bil-name maxlength="30" value="哔哩哔哩" /></label>
        <div class="bil-grid">
          <label class="bil-field"><span>使用角色</span><select data-bil-role><option value="">请选择角色</option>${roleOptions()}</select></label>
          <label class="bil-field"><span>渠道分类</span><select data-bil-category>${['private', 'group', 'privacy']
            .map(value => `<option value="${value}" ${value === tab ? 'selected' : ''}>${TAB_LABELS[value]}</option>`)
            .join('')}</select></label>
        </div>
        <div class="bil-grid">
          <label class="bil-field"><span>登录方式</span><select data-bil-login>
            <option value="qr">应用内扫码（推荐）</option>
            <option value="browser">Edge 托管登录</option>
            <option value="cookie">手动 Cookie</option>
          </select></label>
          <label class="bil-field"><span>默认名单外策略</span><select data-bil-fallback>
            <option value="inbox" selected>静默入库（推荐）</option>
            <option value="all">照单全收</option>
            <option value="probability">概率处理</option>
            <option value="rules">规则处理</option>
          </select></label>
        </div>
        <div class="bil-field"><span>接入能力</span>
          <div class="bil-checks">
            <label class="bil-check"><input type="checkbox" data-bil-cap="dm" checked />私信收发</label>
            <label class="bil-check"><input type="checkbox" data-bil-cap="notice" checked />消息中心（回复我 / @我）</label>
            <label class="bil-check"><input type="checkbox" data-bil-cap="commentScan" />视频评论监控</label>
          </div>
        </div>
        <div class="bil-note">黑白名单按目标 UID 判断，与显示昵称无关；名单外的私信 / 评论默认只静默入库，不自动回复，可在渠道详情里改成概率或规则处理。</div>
        <div class="bil-error" data-bil-error hidden></div>
        <div class="bil-actions"><button class="bil-btn" data-bil-cancel>取消</button><button class="bil-btn primary" data-bil-save>添加渠道</button></div>
      </div>`
    document.body.appendChild(overlay)
    const close = () => overlay.remove()
    const errorEl = overlay.querySelector('[data-bil-error]')
    const fail = message => {
      errorEl.textContent = message
      errorEl.hidden = false
    }
    overlay.querySelector('[data-bil-cancel]').addEventListener('click', close)
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    overlay.querySelector('[data-bil-save]').addEventListener('click', async () => {
      const name = overlay.querySelector('[data-bil-name]').value.trim() || '哔哩哔哩'
      const roleId = overlay.querySelector('[data-bil-role]').value
      const category = overlay.querySelector('[data-bil-category]').value
      const loginMode = overlay.querySelector('[data-bil-login]').value
      const fallbackMode = overlay.querySelector('[data-bil-fallback]').value
      if (!roleId) return fail('请选择使用角色')
      const capabilities = {
        dm: overlay.querySelector('[data-bil-cap="dm"]').checked,
        notice: overlay.querySelector('[data-bil-cap="notice"]').checked,
        commentScan: overlay.querySelector('[data-bil-cap="commentScan"]').checked,
      }
      const settings = clone(DEFAULT_SETTINGS)
      settings.capabilities = capabilities
      settings.policy = normalizePolicy({})
      for (const scope of ['dm', 'comment', 'at']) settings.policy[scope].fallback.mode = fallbackMode
      const group = channels.groups(category)[0] || channels.addGroup(category, '我的渠道')
      const saved = channels.addChannel(category, group.id, {
        type: TYPE_ID,
        name,
        color: TYPE_COLOR,
        status: 'offline',
        meta: { roleId, category, permissions: { ...DEFAULT_PERMISSIONS }, bilibili: settings },
      })
      if (!saved) return fail('添加渠道失败')
      close()
      toast.success(`「${name}」已添加，请完成 B站登录`)
      channels.activate(category, saved.id)
      await syncChannelConfig(saved)
      setTimeout(() => openLoginDialog(findChannel(saved.id) || saved, loginMode), 150)
    })
  }

  /* ---------------- UI：登录弹窗 ---------------- */

  function openLoginDialog(channel, initialMode = 'qr') {
    let mode = ['qr', 'browser', 'cookie'].includes(initialMode) ? initialMode : 'qr'
    let closed = false
    let pollTimer = null
    let currentKey = ''
    const overlay = document.createElement('div')
    overlay.className = 'bil-mask'
    overlay.innerHTML = `
      <div class="bil-dialog" role="dialog" aria-modal="true" style="width:min(480px,94vw)">
        <h3>登录 B站账号</h3>
        <div class="bil-sub">登录态只保存在当前渠道独立的凭据文件与 Edge profile 里；应用内扫码不依赖浏览器。</div>
        <div class="bil-tabs">
          <button class="bil-tab" data-bil-mode="qr">应用内扫码</button>
          <button class="bil-tab" data-bil-mode="browser">Edge 托管</button>
          <button class="bil-tab" data-bil-mode="cookie">手动 Cookie</button>
        </div>
        <div data-bil-body></div>
        <div class="bil-status"><span class="dot" data-bil-dot></span><span data-bil-login-status>准备中…</span></div>
        <div class="bil-error" data-bil-error hidden></div>
        <div class="bil-actions"><button class="bil-btn" data-bil-close>关闭</button></div>
      </div>`
    document.body.appendChild(overlay)
    const bodyEl = overlay.querySelector('[data-bil-body]')
    const dotEl = overlay.querySelector('[data-bil-dot]')
    const statusEl = overlay.querySelector('[data-bil-login-status]')
    const errorEl = overlay.querySelector('[data-bil-error]')
    const setStatus = (text, color = '#c9a227') => {
      statusEl.textContent = text
      dotEl.style.background = color
    }
    const setError = message => {
      errorEl.textContent = message || ''
      errorEl.hidden = !message
    }
    const stopPoll = () => {
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
    }
    const close = () => {
      if (closed) return
      closed = true
      stopPoll()
      overlay.remove()
      for (const refresh of detailRefreshers) {
        try {
          refresh()
        } catch (_) {
          /* ignore */
        }
      }
    }
    const done = () => {
      stopPoll()
      setStatus('登录成功', '#70a15a')
      toast.success('B站账号已登录')
      setTimeout(close, 900)
    }
    const pollQr = async () => {
      if (closed || !currentKey) return
      const data = await api.get(`/bilibili/login/qrcode?channelId=${encodeURIComponent(channel.id)}&key=${encodeURIComponent(currentKey)}`)
      if (data.status === 'success') return done()
      setStatus(data.message || '等待扫码')
      if (data.status === 'expired') {
        stopPoll()
        setError('二维码已过期，请关闭后重新登录')
      }
    }
    const startQr = async () => {
      stopPoll()
      setError('')
      bodyEl.innerHTML = '<div class="bil-qr">正在获取二维码…</div>'
      setStatus('正在获取二维码…')
      try {
        const qr = await api.post('/bilibili/login/qrcode', { channelId: channel.id })
        currentKey = qr.qrcodeKey
        bodyEl.innerHTML = `<div class="bil-qr">${renderQrSvg(qr.url, { size: 224 })}</div>`
        setStatus('请用 B站手机客户端扫码')
        pollTimer = setInterval(() => pollQr().catch(err => setError(err?.message || String(err))), 2500)
      } catch (err) {
        bodyEl.innerHTML = '<div class="bil-qr">二维码获取失败</div>'
        setError(err?.message || String(err))
      }
    }
    const pollBrowser = async () => {
      if (closed) return
      const data = await api.get(`/bilibili/login/browser?channelId=${encodeURIComponent(channel.id)}`)
      if (data.status === 'success') return done()
      setStatus(data.message || '等待在浏览器里完成登录')
    }
    const startBrowser = async () => {
      stopPoll()
      setError('')
      bodyEl.innerHTML = '<div class="bil-note">已打开独立的 Edge 登录窗口。请在里面扫码或登录，插件会自动读取登录态；完成后可保持窗口开启作为风控兜底。</div>'
      setStatus('正在打开浏览器…')
      try {
        await api.post('/bilibili/login/browser', { channelId: channel.id, headless: false })
        setStatus('等待在浏览器里完成登录')
        pollTimer = setInterval(() => pollBrowser().catch(err => setError(err?.message || String(err))), 2500)
      } catch (err) {
        setError(err?.message || String(err))
      }
    }
    const renderCookie = () => {
      stopPoll()
      setError('')
      bodyEl.innerHTML = `
        <label class="bil-field"><span>登录 Cookie（至少包含 SESSDATA，建议同时包含 bili_jct / DedeUserID / buvid3）</span>
          <textarea data-bil-cookie placeholder="SESSDATA=...; bili_jct=...; DedeUserID=..."></textarea>
        </label>
        <button class="bil-btn primary" data-bil-cookie-save>保存并登录</button>`
      bodyEl.querySelector('[data-bil-cookie-save]').addEventListener('click', async () => {
        setError('')
        try {
          await api.post('/bilibili/login/cookie', { channelId: channel.id, cookie: bodyEl.querySelector('[data-bil-cookie]').value })
          done()
        } catch (err) {
          setError(err?.message || String(err))
        }
      })
    }
    const render = () => {
      overlay.querySelectorAll('[data-bil-mode]').forEach(button => button.classList.toggle('active', button.dataset.bilMode === mode))
      setError('')
      if (mode === 'qr') startQr()
      else if (mode === 'browser') startBrowser()
      else renderCookie()
    }
    overlay.querySelectorAll('[data-bil-mode]').forEach(button => {
      button.addEventListener('click', () => {
        mode = button.dataset.bilMode
        render()
      })
    })
    overlay.querySelector('[data-bil-close]').addEventListener('click', close)
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    render()
  }

  /* ---------------- UI：渠道详情 ---------------- */

  function mountDetailPanel({ container, channel }) {
    let currentId = channel.id
    let destroyed = false
    let statusTimer = null
    let inboxPreview = []

    // 宿主会在新消息等事件时整块重绘详情；未保存的编辑放在草稿里，重挂载后继续显示。
    let draft = detailDrafts.get(currentId) || null
    let scope = draft?.scope && SCOPE_TABS.some(([id]) => id === draft.scope) ? draft.scope : 'dm'
    const isDirty = () => !!draft?.dirty?.caps || !!draft?.dirty?.policy

    const getChannel = () => findChannel(currentId) || channel

    const snapshot = () => {
      const bili = biliMeta(getChannel())
      const policy = {}
      for (const [id] of SCOPE_TABS) {
        const source = bili.policy[id] || bili.policy.dm || {}
        policy[id] = {
          blacklist: (source.blacklist || []).join(','),
          whitelist: (source.whitelist || []).join(','),
          mode: source.fallback?.mode || 'inbox',
          probability: Number(source.fallback?.probability) || 0,
          defaultOutcome: source.fallback?.defaultOutcome || 'ingest',
          enabled: source.enabled !== false,
          rules: (source.fallback?.rules || []).map(rule => `${rule.type}:${rule.value} -> ${rule.outcome}`).join('\n'),
        }
      }
      return {
        capabilities: { ...bili.capabilities },
        noticeKinds: { ...bili.noticeKinds },
        realtime: { enabled: bili.realtime?.enabled !== false },
        autoOwnVideos: bili.autoOwnVideos === true,
        videos: (bili.videos || []).join('\n'),
        poll: {
          dmSec: Number(bili.poll?.dmSec) || 20,
          noticeSec: Number(bili.poll?.noticeSec) || 60,
          commentSec: Number(bili.poll?.commentSec) || 300,
        },
        browserFallback: bili.browserFallback !== false,
        sendVia: bili.sendVia === 'browser' ? 'browser' : 'auto',
        policy,
      }
    }

    const ensureDraft = () => {
      if (!draft) {
        draft = { scope, dirty: { caps: false, policy: false }, ...snapshot() }
        detailDrafts.set(currentId, draft)
      }
      draft.scope = scope
      return draft
    }

    const paintDirty = () => {
      const dirty = isDirty()
      for (const badge of container.querySelectorAll('[data-bil-dirty]')) badge.hidden = !dirty
    }

    const readDraft = (section, { mark = true } = {}) => {
      const d = ensureDraft()
      const value = selector => container.querySelector(selector)?.value
      const checked = selector => !!container.querySelector(selector)?.checked
      d.capabilities = {
        dm: checked('[data-bil-cap="dm"]'),
        notice: checked('[data-bil-cap="notice"]'),
        commentScan: checked('[data-bil-cap="commentScan"]'),
      }
      d.noticeKinds = {
        reply: checked('[data-bil-kind="reply"]'),
        at: checked('[data-bil-kind="at"]'),
        like: checked('[data-bil-kind="like"]'),
        system: checked('[data-bil-kind="system"]'),
      }
      d.realtime = { enabled: checked('[data-bil-realtime]') }
      d.autoOwnVideos = checked('[data-bil-auto-videos]')
      if (value('[data-bil-videos]') !== undefined) d.videos = value('[data-bil-videos]')
      d.poll = {
        dmSec: Math.max(10, Number(value('[data-bil-poll-dm]')) || 20),
        noticeSec: Math.max(20, Number(value('[data-bil-poll-notice]')) || 60),
        commentSec: Math.max(60, Number(value('[data-bil-poll-comment]')) || 300),
      }
      d.browserFallback = value('[data-bil-fallback]') !== 'off'
      d.sendVia = value('[data-bil-sendvia]') === 'browser' ? 'browser' : 'auto'
      const current = (d.policy[scope] = d.policy[scope] || {})
      current.blacklist = value('[data-bil-blacklist]') ?? current.blacklist ?? ''
      current.whitelist = value('[data-bil-whitelist]') ?? current.whitelist ?? ''
      current.mode = value('[data-bil-mode]') || current.mode || 'inbox'
      current.probability = Math.max(0, Math.min(100, Number(value('[data-bil-probability]')) || 0))
      current.defaultOutcome = value('[data-bil-default]') || current.defaultOutcome || 'ingest'
      current.enabled = checked('[data-bil-enabled]')
      current.rules = value('[data-bil-rules]') ?? current.rules ?? ''
      if (mark) {
        d.dirty[section] = true
        paintDirty()
      }
      d.scope = scope
      return d
    }

    const paint = data => {
      const c = getChannel()
      const meta = c.meta || {}
      const status = data?.status || c.status || 'offline'
      const pill = container.querySelector('[data-bil-status]')
      if (pill) {
        pill.textContent = STATUS_LABEL[status] || status
        pill.style.color = STATUS_COLOR[status] || STATUS_COLOR.offline
      }
      const nameEl = container.querySelector('[data-bil-name]')
      if (nameEl) nameEl.textContent = meta.accountName || '未登录'
      const uidEl = container.querySelector('[data-bil-uid]')
      if (uidEl) uidEl.textContent = meta.accountUid ? `UID ${meta.accountUid}` : '扫码 / 浏览器登录后自动读取账号信息'
      const avatarEl = container.querySelector('[data-bil-avatar]')
      if (avatarEl) {
        avatarEl.src = meta.accountAvatar || ''
        avatarEl.style.visibility = meta.accountAvatar ? 'visible' : 'hidden'
      }
      const riskEl = container.querySelector('[data-bil-risk]')
      if (riskEl) {
        const riskActive = Number(data?.risk?.until || meta.riskUntil || 0) > Date.now()
        riskEl.textContent = riskActive
          ? `风控冷却中（${data?.risk?.message || '请求被拦截'}），后续自动走浏览器兜底；冷却结束前减少操作。`
          : meta.lastError
            ? `最近错误：${meta.lastError}`
            : '协议优先，命中风控 / 登录失效时自动切到该渠道独立的 Edge 浏览器执行；私信与评论各有一条独立发送队列。'
      }
    }

    const refreshStatus = async () => {
      if (destroyed || !api) return
      try {
        const data = await api.get(`/bilibili/status?channelId=${encodeURIComponent(currentId)}`)
        updateChannelFromStatus({ ...data, channelId: currentId })
        paint(data)
      } catch (_) {
        /* 后端未启动 */
      }
    }

    const loadInbox = async () => {
      if (!api) return
      try {
        const data = await api.get(`/bilibili/inbox?channelId=${encodeURIComponent(currentId)}&after=0`)
        inboxPreview = (data?.items || []).slice(-12).reverse()
        render()
      } catch (_) {
        inboxPreview = []
      }
    }

    const saveCapabilities = async () => {
      const d = readDraft('caps')
      const c = getChannel()
      const meta = biliMeta(c)
      meta.capabilities = { ...d.capabilities }
      meta.noticeKinds = { ...d.noticeKinds }
      meta.autoOwnVideos = d.autoOwnVideos === true
      meta.realtime = { ...d.realtime }
      meta.videos = parseLines(d.videos, 50)
      meta.poll = { ...d.poll }
      meta.browserFallback = d.browserFallback !== false
      meta.sendVia = d.sendVia === 'browser' ? 'browser' : 'auto'
      // 先清 dirty 再更新渠道：updateChannel 会同步触发宿主重绘，重绘时就能渲染出“已保存”状态。
      d.dirty.caps = false
      channels.updateChannel(findTab(c.id), c.id, { meta: { ...(c.meta || {}), bilibili: meta } })
      await syncChannelConfig(findChannel(c.id) || c, { quiet: false })
      paintDirty()
      toast.success('接入能力已保存')
    }

    const savePolicy = async () => {
      const d = readDraft('policy')
      const c = getChannel()
      const meta = biliMeta(c)
      const policy = normalizePolicy(meta.policy)
      const current = d.policy[scope] || {}
      policy[scope] = {
        enabled: current.enabled !== false,
        blacklist: parseLines(current.blacklist, 200),
        whitelist: parseLines(current.whitelist, 200),
        whitelistOutcome: 'process',
        fallback: {
          mode: current.mode || 'inbox',
          probability: Math.max(0, Math.min(100, Number(current.probability) || 0)),
          defaultOutcome: current.defaultOutcome || 'ingest',
          rules: current.rules || '',
        },
      }
      meta.policy = normalizePolicy(policy)
      d.dirty.policy = false
      channels.updateChannel(findTab(c.id), c.id, { meta: { ...(c.meta || {}), bilibili: meta } })
      await syncChannelConfig(findChannel(c.id) || c)
      paintDirty()
      toast.success(`已保存「${SCOPE_TABS.find(([id]) => id === scope)?.[1] || scope}」策略`)
    }

    const render = () => {
      const c = getChannel()
      const meta = c.meta || {}
      const draftView = ensureDraft()
      const current = draftView.policy[scope] || {}
      container.innerHTML = `
        <div class="bil-section">
          <div class="bil-section-title">
            <span>B站账号</span>
            <span class="bil-pill" data-bil-status style="color:${STATUS_COLOR[c.status] || STATUS_COLOR.offline}">${STATUS_LABEL[c.status] || c.status}</span>
          </div>
          <div class="bil-account">
            <img data-bil-avatar alt="" src="${escapeHtml(meta.accountAvatar || '')}" style="visibility:${meta.accountAvatar ? 'visible' : 'hidden'}" />
            <div style="flex:1">
              <div class="name" data-bil-name>${escapeHtml(meta.accountName || '未登录')}</div>
              <div class="uid" data-bil-uid>${meta.accountUid ? `UID ${escapeHtml(meta.accountUid)}` : '扫码 / 浏览器登录后自动读取账号信息'}</div>
            </div>
          </div>
          <div class="bil-actions" style="justify-content:flex-start;margin-top:0">
            <button class="bil-btn primary" data-action="login">${meta.accountUid ? '重新登录' : '登录 B站'}</button>
            <button class="bil-btn" data-action="logout">退出登录</button>
            <button class="bil-btn" data-action="browser-open">打开托管浏览器</button>
            <button class="bil-btn" data-action="browser-close">关闭浏览器</button>
          </div>
          <div class="bil-note" data-bil-risk></div>
        </div>

        <div class="bil-section">
          <div class="bil-section-title"><span>接入能力</span><span style="display:flex;gap:8px;align-items:center"><span class="bil-pill" data-bil-dirty ${isDirty() ? '' : 'hidden'}>有未保存修改</span><button class="bil-btn" data-action="save-caps">保存能力</button></span></div>
          <div class="bil-checks">
            <label class="bil-check"><input type="checkbox" data-bil-cap="dm" ${draftView.capabilities.dm ? 'checked' : ''} />私信收发</label>
            <label class="bil-check"><input type="checkbox" data-bil-cap="notice" ${draftView.capabilities.notice ? 'checked' : ''} />消息中心</label>
            <label class="bil-check"><input type="checkbox" data-bil-cap="commentScan" ${draftView.capabilities.commentScan ? 'checked' : ''} />视频评论监控</label>
          </div>
          <div class="bil-checks" style="margin-top:8px">
            ${[['reply', '回复我的'], ['at', '@我的'], ['like', '收到的赞'], ['system', '系统消息']]
              .map(([id, label]) => `<label class="bil-check"><input type="checkbox" data-bil-kind="${id}" ${draftView.noticeKinds[id] ? 'checked' : ''} />${label}</label>`)
              .join('')}
          </div>
          <div class="bil-checks" style="margin-top:8px">
            <label class="bil-check"><input type="checkbox" data-bil-auto-videos ${draftView.autoOwnVideos ? 'checked' : ''} />自动监控我最近投稿</label>
            <label class="bil-check"><input type="checkbox" data-bil-realtime ${draftView.realtime.enabled ? 'checked' : ''} />私信实时推送（镜像官方 WebSocket）</label>
          </div>
          <div class="bil-note">开启实时推送后，该渠道会保留一个无头 Edge 标签页在 message.bilibili.com，消息到达即刻推送；私信轮询自动降频为断线补收。浏览器不可用时自动回退纯轮询。宿主因新消息重绘详情时，未保存的修改会保留在草稿里。</div>
          <label class="bil-field" style="margin-top:10px"><span>额外监控稿件（BV 号 / av 号 / 链接，一行一个）</span>
            <textarea data-bil-videos placeholder="BV1xx411c7mD">${escapeHtml(String(draftView.videos || ''))}</textarea>
          </label>
          <div class="bil-grid">
            <label class="bil-field"><span>私信轮询秒数</span><input type="number" min="10" data-bil-poll-dm value="${Number(draftView.poll.dmSec) || 20}" /></label>
            <label class="bil-field"><span>消息中心轮询秒数</span><input type="number" min="20" data-bil-poll-notice value="${Number(draftView.poll.noticeSec) || 60}" /></label>
            <label class="bil-field"><span>评论轮询秒数</span><input type="number" min="60" data-bil-poll-comment value="${Number(draftView.poll.commentSec) || 300}" /></label>
            <label class="bil-field"><span>风控时浏览器兜底</span><select data-bil-fallback>
              <option value="on" ${draftView.browserFallback !== false ? 'selected' : ''}>开启（推荐）</option>
              <option value="off" ${draftView.browserFallback === false ? 'selected' : ''}>关闭</option>
            </select></label>
            <label class="bil-field"><span>发送方式</span><select data-bil-sendvia>
              <option value="auto" ${draftView.sendVia !== 'browser' ? 'selected' : ''}>协议优先（风控时浏览器兜底）</option>
              <option value="browser" ${draftView.sendVia === 'browser' ? 'selected' : ''}>浏览器优先（评论/互动更接近真人）</option>
            </select></label>
          </div>
          <div class="bil-note">如果评论经常「已提交但未公开可见」，把发送方式改为「浏览器优先」：评论、点赞、投币、收藏会通过该渠道独立 Edge 的页面上下文发出，请求特征与真人操作一致，被风控/折叠的概率更低。</div>
        </div>

        <div class="bil-section">
          <div class="bil-section-title"><span>黑白名单与名单外策略</span><span style="display:flex;gap:8px;align-items:center"><span class="bil-pill" data-bil-dirty ${isDirty() ? '' : 'hidden'}>有未保存修改</span><button class="bil-btn" data-action="save-policy">保存策略</button></span></div>
          <div class="bil-tabs">
            ${SCOPE_TABS.map(([id, label]) => `<button class="bil-tab ${id === scope ? 'active' : ''}" data-scope="${id}">${label}</button>`).join('')}
          </div>
          <div class="bil-grid">
            <label class="bil-field"><span>黑名单 UID（最高优先级，命中即丢弃）</span><textarea data-bil-blacklist placeholder="123456,789012">${escapeHtml(String(current.blacklist || ''))}</textarea></label>
            <label class="bil-field"><span>白名单 UID（优先处理）</span><textarea data-bil-whitelist placeholder="123456">${escapeHtml(String(current.whitelist || ''))}</textarea></label>
          </div>
          <div class="bil-grid">
            <label class="bil-field"><span>名单外处理</span><select data-bil-mode>
              ${[['all', '照单全收'], ['inbox', '静默入库'], ['probability', '概率处理'], ['rules', '规则处理']]
                .map(([id, label]) => `<option value="${id}" ${current.mode === id ? 'selected' : ''}>${label}</option>`)
                .join('')}
            </select></label>
            <label class="bil-field"><span>概率（%）</span><input type="number" min="0" max="100" data-bil-probability value="${Number(current.probability) || 0}" /></label>
            <label class="bil-field"><span>规则未命中时</span><select data-bil-default>
              ${[['ingest', '静默入库'], ['process', '触发回复'], ['drop', '丢弃']]
                .map(([id, label]) => `<option value="${id}" ${current.defaultOutcome === id ? 'selected' : ''}>${label}</option>`)
                .join('')}
            </select></label>
            <label class="bil-field"><span>该分类启用</span>
              <label class="bil-check" style="margin-top:8px"><input type="checkbox" data-bil-enabled ${current.enabled !== false ? 'checked' : ''} />参与收发与判定</label>
            </label>
          </div>
          <label class="bil-field"><span>规则（每行一条：keyword:加群 -> process ／ regex:优惠|福利 -> ingest ／ uid:123 -> drop）</span>
            <textarea data-bil-rules placeholder="keyword:你好 -> process">${escapeHtml(String(current.rules || ''))}</textarea>
          </label>
          <div class="bil-note">判定顺序：黑名单 → 白名单 → 名单外策略。档位：drop 丢弃 / ingest 静默入库（不触发模型）/ process 触发模型回复；启动积压消息即使命中 process 也只入库。</div>
        </div>

        <div class="bil-section">
          <div class="bil-section-title"><span>最近入站</span><button class="bil-btn" data-action="refresh-inbox">刷新</button></div>
          <div class="bil-log">${inboxPreview.length
            ? inboxPreview.map(item => `<div class="bil-log-line"><span class="t">${formatTime(item.at)}</span>[${escapeHtml(KIND_LABEL[item.kind] || item.kind)}] ${escapeHtml(item.sender?.name || item.sender?.uid || '未知')}：${escapeHtml(previewText(item))}</div>`).join('')
            : '<div class="bil-log-line">暂无入站消息；收到后会按策略写入对应会话。</div>'}</div>
        </div>`
      container.querySelectorAll('[data-scope]').forEach(button => {
        button.addEventListener('click', () => {
          // 切 tab 前先把当前分类的编辑存进草稿，但不因此标记为“未保存”。
          readDraft('policy', { mark: false })
          scope = button.dataset.scope
          ensureDraft().scope = scope
          render()
        })
      })
      container.querySelector('[data-action="login"]')?.addEventListener('click', () => openLoginDialog(getChannel()))
      container.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
        try {
          await api.post('/bilibili/logout', { channelId: currentId })
          toast.info('已退出 B站登录')
          await refreshStatus()
        } catch (err) {
          toast.warn(`退出失败：${err?.message || err}`)
        }
      })
      container.querySelector('[data-action="browser-open"]')?.addEventListener('click', async () => {
        try {
          await api.post('/bilibili/login/browser', { channelId: currentId, headless: false })
          toast.info('已打开该渠道独立的 Edge 窗口')
          await refreshStatus()
        } catch (err) {
          toast.warn(`打开浏览器失败：${err?.message || err}`)
        }
      })
      container.querySelector('[data-action="browser-close"]')?.addEventListener('click', async () => {
        try {
          await api.post('/bilibili/browser/close', { channelId: currentId })
          toast.info('已关闭托管浏览器')
          await refreshStatus()
        } catch (err) {
          toast.warn(`关闭失败：${err?.message || err}`)
        }
      })
      container.querySelector('[data-action="save-caps"]')?.addEventListener('click', () => saveCapabilities().catch(err => toast.warn(err?.message || String(err))))
      container.querySelector('[data-action="save-policy"]')?.addEventListener('click', () => savePolicy().catch(err => toast.warn(err?.message || String(err))))
      container.querySelector('[data-action="refresh-inbox"]')?.addEventListener('click', () => loadInbox().catch(() => {}))
      paint({ status: c.status })
    }

    const refresher = () => {
      if (!destroyed) render()
    }
    detailRefreshers.add(refresher)
    // 编辑即入草稿：宿主因新消息等事件重绘详情时，未保存内容会在重新挂载后恢复。
    const policyFieldSelector = '[data-bil-blacklist],[data-bil-whitelist],[data-bil-mode],[data-bil-probability],[data-bil-default],[data-bil-enabled],[data-bil-rules]'
    const onFieldChange = event => {
      const target = event.target
      if (!target?.closest?.('input, textarea, select')) return
      readDraft(target.closest(policyFieldSelector) ? 'policy' : 'caps')
    }
    container.addEventListener('input', onFieldChange)
    container.addEventListener('change', onFieldChange)
    render()
    loadInbox().catch(() => {})
    refreshStatus()
    statusTimer = setInterval(refreshStatus, 8000)
    statusTimer.unref?.()
    const offStatus = events.on('bilibili:status', payload => {
      if (String(payload?.channelId || '') !== String(currentId) || destroyed) return
      paint(payload)
    })

    return () => {
      destroyed = true
      detailRefreshers.delete(refresher)
      offStatus?.()
      container.removeEventListener('input', onFieldChange)
      container.removeEventListener('change', onFieldChange)
      if (statusTimer) clearInterval(statusTimer)
      statusTimer = null
      // 草稿刻意保留：宿主马上会重新挂载详情，未保存内容需要原样恢复。
      container.innerHTML = ''
    }
  }
}
