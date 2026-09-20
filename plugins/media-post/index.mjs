/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · 点歌台 · 媒体放映机
 *
 * 给模型的工具（依赖「联网访问」提供搜索 / 抖音图文 / Cookie，后端桥负责下载转码发送）：
 *   media_search  搜索 B站 / 抖音视频候选（带匹配分与理由）
 *   media_play    一步点歌：搜索 + 自动选最优 + 发送（默认 QQ 语音）
 *   media_send    把链接内容拉下来发送：语音 / 视频 / 图文 / 文件
 *
 * 发送策略：
 *   NapCat 渠道 → 后端特权段 record / video / file / image；
 *   QQ 官方机器人渠道 → 语音转 SILK 后走官方富媒体接口；
 *   其它渠道   → 降级为「标题 + 时长 + 原链接 + 本地缓存路径」的普通消息（图文会附图片）。
 */
export const name = 'media-post'
export const version = '2.1.0'
export const scope = 'both'
export const displayName = '点歌台 · 媒体放映机'
export const description = '扩展 · B站 / 抖音视频与图文：点歌发 QQ 语音（NapCat / QQ 官方机器人），发视频 / 图文，其它渠道降级为文件或链接。'
export const author = '念风扩展'
export const icon = '🎬'
export const core = false
export const enabled = true
export const depends = {
  'web-access': '>=1.1.0',
  'tool-registry': '^1.0.0',
  'session-service': '>=2.0.0',
  'chat-store': '^1.0.0',
  'event-bus': '*',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'chat-permissions': '^1.0.0',
  'config': '^1.0.0',
  'napcat': '^1.0.0',
  'qqbot': '>=1.5.0',
  'plugin-manager': '>=1.0.0',
  'settings-container': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const inject = [
  'tool-registry',
  'plugin-manager?',
  'session-service',
  'chat-store',
  'event-bus',
  'config',
  'api?',
  'chat-permissions?',
  'toast?',
  'settings-container?',
]
export const provides = [{ name: 'media-post', type: 'singleton' }]
export const permissions = ['network']

import { formatDuration, rankCandidates } from './lib/match.mjs'
import { PANEL_CSS, renderMediaPanel } from './panel.mjs'

function useStyle(ctx, css) {
  if (!css || typeof document === 'undefined') return () => {}
  // 注意：念风的 ctx.effect(fn) 是「注册卸载清理」，不会立即执行；
  // 样式必须现在注入，再把 remove 注册成清理函数（与 web-access/ui.mjs 一致）。
  const style = document.createElement('style')
  style.dataset.plugin = 'media-post'
  style.textContent = css
  document.head.appendChild(style)
  try {
    return ctx.effect(() => style.remove())
  } catch (_) {
    return () => style.remove()
  }
}

const SEARCH_DESCRIPTION =
  '在 B站（默认）或抖音站内搜索视频，返回候选列表：标题 / UP主 / 时长 / 播放量 / 匹配分 score / 命中理由 reasons。' +
  '用户说「放一下 / 来一首 / 点歌 X」时：先搜索 X，再从候选里挑「最像纯放歌」的一条，把它的 url 交给 media_send（mode=voice）；' +
  '如果候选分数接近或有翻唱 / 短剧等歧义，先把候选念给用户选（用 chat_send）。' +
  '挑选参考：标题包含完整歌名、时长 2:30~6:30、播放量高、带「Hi-Res / 无损 / 纯音乐 / 官方 / 完整版」等特征；' +
  '避开：短剧、合集、第X集、教学、翻唱、伴奏、直播回放、预告剪辑（工具已在 score/reasons 里体现）。' +
  '抖音站内搜索需要插件浏览器可用，B站搜索走官方接口。'

const PLAY_DESCRIPTION =
  '一步点歌：搜索 + 自动挑最像原曲的一条 + 按 mode 发到当前渠道（默认 voice=QQ 语音；NapCat 与 QQ 官方机器人渠道均支持，QQ 官方会先转 SILK）。' +
  '适合用户意图明确、歌名唯一的场景（例如「放一下来不及爱你」）。' +
  '如果返回 ambiguous=true，说明有多个相近候选：这时改用 media_search 拿候选，用 chat_send 问用户选哪个。' +
  '返回 title / duration / delivered 表示实际发了什么；NEED_LOGIN 时让用户到「设置 → 点歌台」登录对应平台。'

const SEND_DESCRIPTION =
  '把 B站 / 抖音链接里的内容拉下来发到当前渠道（或 channel 指定的渠道）。' +
  'mode=voice：只提取音频；NapCat 发 record 语音，QQ 官方机器人会转成 SILK 后通过官方富媒体接口发送；' +
  '其它渠道降级发文件 / 链接（用户说「放一下 / 来首 / 点歌」时用这个）。' +
  'mode=video：下载视频直发（用户发链接说「把这个视频发出来 / 发群里」时用这个）。' +
  'mode=images：抖音图文（图片 + 文案），发图片组。' +
  'mode=auto：链接本身是图文就发图文，否则发视频。' +
  'caption 是随媒体一起发的一句话，可省略；不要重复用户原话。' +
  '返回 delivered=fallback 表示目标渠道不支持媒体直发，消息已按「标题 + 原链接 + 本地缓存路径」发出；' +
  'NEED_LOGIN → 提示用户去「设置 → 点歌台」点登录；FFMPEG_UNAVAILABLE → 提示用户点「一键安装缺失工具」。'

const MODE_LABEL = { voice: 'QQ 语音', video: '视频', file: '文件', images: '图文' }

export function apply(ctx) {
  const registry = ctx.inject('tool-registry')
  const manager = ctx.inject('plugin-manager?')
  const sessions = ctx.inject('session-service')
  const store = ctx.inject('chat-store')
  const events = ctx.inject('event-bus')
  const config = ctx.inject('config')
  const permissions = ctx.inject('chat-permissions?')
  const toast = ctx.inject('toast?')
  const pages = ctx.inject('settings-container?') || ctx.registry.get('settings-container')

  useStyle(ctx, PANEL_CSS)

  const api = () => ctx.registry.get('api')
  const notify = (kind, message) => {
    try {
      if (kind === 'error') toast?.warn?.(message)
      else toast?.[kind]?.(message)
    } catch (_) {
      /* ignore */
    }
  }

  const callApi = async (method, path, body, timeoutMs = 120000) => {
    const client = api()
    if (!client) return { ok: false, code: 'BACKEND_OFFLINE', error: '本地后端未连接（backend-client 未启用或后端未启动）。' }
    try {
      if (method === 'get') return await client.get(path, { timeoutMs })
      if (method === 'del') return await client.del(path, { timeoutMs })
      return await client.post(path, body, { timeoutMs })
    } catch (error) {
      return { ok: false, code: error?.status === 404 ? 'BRIDGE_NOT_LOADED' : 'BACKEND_ERROR', error: `后端调用失败：${error?.message || error}` }
    }
  }

  /** 搜索：B站 / 抖音，返回打分排序后的候选。 */
  const searchCandidates = async ({ query, site = 'bilibili', limit = 8 }) => {
    const keyword = String(query || '').trim()
    if (!keyword) return { ok: false, code: 'INVALID_ARGS', error: '缺少搜索关键词 query。' }
    const targetSite = site === 'douyin' ? 'douyin' : 'bilibili'
    const result = await callApi('post', '/web-access/browse', { action: 'search', site: targetSite, query: keyword, limit: Math.max(1, Math.min(20, Number(limit) || 8)) }, 120000)
    if (!result?.ok) {
      return {
        ok: false,
        code: result?.code || 'SEARCH_FAILED',
        error: result?.error || '搜索失败',
        hint: targetSite === 'douyin' ? '抖音站内搜索需要浏览器可用；也可以让用户直接发抖音链接。' : result?.hint || '',
      }
    }
    const ranked = rankCandidates(result.results || [], keyword).slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
    const candidates = ranked.map(item => ({
      title: item.title,
      author: item.author || '',
      duration: item.duration || (item.duration_seconds ? formatDuration(item.duration_seconds) : ''),
      duration_seconds: item.duration_seconds || 0,
      play: item.play || 0,
      url: item.url,
      score: item.score,
      reasons: item.reasons,
    }))
    const ambiguous = !candidates.length || candidates[0].score < 25 || (candidates[1] && candidates[0].score - candidates[1].score < 8 && candidates[0].score < 60)
    return { ok: true, query: keyword, site: targetSite, candidates, ambiguous }
  }

  /** 解析目标会话（当前 / 跨渠道，跨渠道走权限层）。 */
  const resolveTarget = async (args, context) => {
    const requested = args?.channel ? String(args.channel) : ''
    const channelId = requested || String(context.channelId || '')
    if (!channelId) return { ok: false, code: 'NO_CHANNEL', error: '当前没有可用的渠道。' }
    if (requested && requested !== context.channelId && permissions?.authorize) {
      const decision = await permissions.authorize({ conversationId: context.conversationId, action: 'send', channel: requested })
      if (!decision?.ok) return { ok: false, code: decision?.code || 'NO_PERMISSION', error: decision?.error || '没有向该渠道发送的权限。' }
      const conversationId = store.conversationIdFor?.(decision.channelId || requested) || context.conversationId
      return { ok: true, channelId: decision.channelId || requested, conversationId, authorization: decision }
    }
    return { ok: true, channelId, conversationId: context.conversationId }
  }

  const appendMessage = (conversationId, { content = '', images = [], meta = {} }) => {
    const conv = sessions.get(conversationId)
    if (!conv) return null
    return store.append(conversationId, {
      role: 'assistant',
      content,
      content_type: images.length && !content ? 'image' : 'text',
      sender_id: `role_${conv.id}`,
      sender_name: conv.name,
      is_bot: true,
      source: 'nova',
      visibility: 'shareable',
      meta: { via: 'media_post', channel: meta.channel, ...meta, ...(images.length ? { images } : {}) },
    })
  }

  const kindLabel = media => (media?.kind === 'images' ? '图文' : media?.kind === 'audio' ? '音频' : media?.kind === 'video' ? '视频' : '媒体')

  const fallbackText = (sent, media, { reason = '' } = {}) => {
    const items = Array.isArray(sent.media) ? sent.media : media?.items || [media].filter(Boolean)
    const first = items[0] || {}
    const title = first.title || media?.title || sent.title || ''
    const seconds = first.duration || media?.duration || 0
    const lines = []
    if (sent.caption) lines.push(String(sent.caption).slice(0, 200))
    lines.push(`【${kindLabel(first)}】${title || '已下载'}${seconds ? `（${formatDuration(seconds)}）` : ''}`)
    if (reason) lines.push(`（未直发原因：${reason}）`)
    if (sent.sourceUrl || first.sourceUrl) lines.push(`原链接：${sent.sourceUrl || first.sourceUrl}`)
    const filePath = sent.filePaths?.[0]
    if (filePath) lines.push(`已缓存到本机：${filePath}`)
    if (sent.downloadUrl) lines.push(`下载/播放：${sent.downloadUrl}`)
    return lines.join('\n')
  }

  /** 下载（prepare）→ 发送（send）→ 写聊天记录 / 降级消息。 */
  const sendMedia = async (args, context, modeOverride = '') => {
    const url = String(args?.url || '').trim()
    if (!url) return { ok: false, code: 'INVALID_ARGS', error: '缺少媒体链接 url。' }
    const mode = modeOverride || (['voice', 'video', 'file', 'images', 'auto'].includes(args?.mode) ? args.mode : 'auto')
    const target = await resolveTarget(args, context)
    if (!target.ok) return target

    // NapCat 渠道在会话/渠道表里用的是稳定 ID（napcat:<渠道id>）；
    // 会话 meta 里存着后端原始渠道 id，优先带上，避免媒体被降级成链接。
    const targetConversation = sessions.get(target.conversationId)
    const conversationMeta = targetConversation?.meta || {}
    const napcatChannelId = String(conversationMeta.napcatChannelId || '')
    const napcatTargetId = String(conversationMeta.napcatTargetId || '')
    const napcatInstanceId = String(conversationMeta.napcatInstanceId || '')
    // 直接拿会话 meta 里的发送目标：不依赖后端 NapCat 渠道表是否同步。
    const napcatTarget = napcatInstanceId && napcatTargetId
      ? {
          instanceId: napcatInstanceId,
          targetType: conversationMeta.napcatTargetType === 'group' ? 'group' : 'private',
          targetId: napcatTargetId,
        }
      : null
    const qqbotChannelId = String(conversationMeta.qqbotChannelId || '')
    const reasonOf = sent => [sent?.reason || sent?.code, sent?.reasonText].filter(Boolean).join('：')

    const prepareKind = mode === 'voice' ? 'audio' : mode === 'images' ? 'images' : mode === 'video' ? 'video' : 'auto'
    const prepared = await callApi('post', '/media/prepare', { url, kind: prepareKind }, 900000)
    if (!prepared?.ok) return prepared || { ok: false, error: '下载失败' }

    if (prepared.media?.kind === 'images' || Array.isArray(prepared.media?.items)) {
      const media = prepared.media
      const caption = String(args?.caption || '').slice(0, 200)
      const sent = await callApi('post', '/media/send', {
        channelId: target.channelId,
        napcatChannelId,
        napcatTarget,
        qqbotChannelId,
        ids: (media.items || []).map(item => item.id),
        mode: 'images',
        caption,
      }, 300000)
      if (!sent?.ok) return sent
      if (sent.fallback) {
        const reason = reasonOf(sent)
        const message = appendMessage(target.conversationId, {
          content: fallbackText(sent, media, { reason }),
          images: (sent.fileUrls || []).slice(0, 4),
          meta: { mediaMode: 'images', channel: target.channelId, downloaded: true },
        })
        return {
          ok: true,
          delivered: 'fallback',
          mode: 'images',
          channel: target.channelId,
          title: media.title || '',
          image_count: (media.items || []).length,
          message_id: message?.message_id || '',
          note: `目标渠道不支持媒体直发，已按「文案 + 图片 + 链接」发送。${reason ? `（未直发原因：${reason}）` : ''}`,
        }
      }
      const message = appendMessage(target.conversationId, {
        content: `📷 图文：${media.title || ''}`.trim(),
        meta: { direction: 'outbound', mediaMode: 'images', channel: target.channelId, mediaIds: (media.items || []).map(item => item.id), napcatMessageId: sent.messageId || '' },
      })
      return { ok: true, delivered: 'images', mode: 'images', channel: target.channelId, title: media.title || '', image_count: (media.items || []).length, napcat_message_id: sent.messageId || '', message_id: message?.message_id || '' }
    }

    const media = prepared.media
    const finalMode = mode === 'auto' ? (media?.kind === 'audio' ? 'voice' : 'video') : mode
    const caption = String(args?.caption || '').slice(0, 200)
    const sent = await callApi('post', '/media/send', { channelId: target.channelId, napcatChannelId, napcatTarget, qqbotChannelId, id: media.id, mode: finalMode, caption }, 300000)
    if (!sent?.ok) return sent

    if (sent.fallback) {
      const reason = reasonOf(sent)
      const message = appendMessage(target.conversationId, {
        content: fallbackText(sent, media, { reason }),
        images: [],
        meta: { mediaMode: finalMode, channel: target.channelId, downloaded: true },
      })
      return {
        ok: true,
        delivered: 'fallback',
        mode: finalMode,
        channel: target.channelId,
        title: media.title || '',
        duration_seconds: media.duration || 0,
        source_url: media.sourceUrl || url,
        message_id: message?.message_id || '',
        reason: sent.reason || sent.code || '',
        reason_text: sent.reasonText || '',
        note: `目标渠道不支持媒体直发，已发送标题 / 原链接 / 本地缓存路径。${reason ? `（未直发原因：${reason}）` : ''}`,
      }
    }

    const message = appendMessage(target.conversationId, {
      content: `${finalMode === 'voice' ? '🎵 语音' : finalMode === 'video' ? '🎬 视频' : '📎 文件'}：${media.title || media.file || ''}`.trim(),
      meta: {
        direction: 'outbound',
        mediaMode: finalMode,
        channel: target.channelId,
        mediaId: media.id,
        platformMessageId: sent.messageId || '',
        ...(sent.target === 'qqbot'
          ? { qqbotMessageId: sent.messageId || '', qqbotVoiceFormat: sent.voiceFormat || 'silk' }
          : { napcatMessageId: sent.messageId || '' }),
      },
    })
    return {
      ok: true,
      success: true,
      delivered: finalMode,
      mode: finalMode,
      channel: target.channelId,
      target: sent.target || '',
      title: media.title || '',
      author: media.author || '',
      duration_seconds: media.duration || 0,
      source_url: media.sourceUrl || url,
      platform_message_id: sent.messageId || sent.msgId || '',
      napcat_message_id: sent.target === 'qqbot' ? '' : sent.messageId || '',
      voice_format: sent.voiceFormat || '',
      message_id: message?.message_id || '',
      note:
        finalMode === 'voice'
          ? `QQ 语音已成功发出${
              sent.voiceFormat === 'silk' ? '（QQ 官方机器人 SILK）' : sent.voiceFormat === 'amr' ? '（mp3 被拒后已自动转 amr）' : ''
            }。工具结果就是成功，不要向用户声称发送失败。`
          : `${MODE_LABEL[finalMode] || '媒体'}已发出。`,
    }
  }

  const disposers = [
    registry.register(
      'media_search',
      {
        description: SEARCH_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词，一般是歌名 / 视频标题关键词。' },
            site: { type: 'string', enum: ['bilibili', 'douyin'], description: '搜索站点，默认 bilibili。' },
            limit: { type: 'number', description: '返回候选条数，默认 8，最大 20。' },
          },
          required: ['query'],
        },
      },
      async (args, context) => {
        const result = await searchCandidates(args || {})
        if (!result.ok) return result
        return {
          ok: true,
          query: result.query,
          site: result.site,
          ambiguous: result.ambiguous,
          candidates: result.candidates,
          note: result.ambiguous
            ? '候选分数比较接近：把标题 / 时长念给用户确认，或自己按「最像原曲」挑一条后用 media_send。'
            : '已按「像不像纯放歌」排序；挑一条把 url 交给 media_send（点歌默认 mode=voice）。',
        }
      },
    ),
    registry.register(
      'media_play',
      {
        description: PLAY_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '歌名 / 视频关键词。' },
            mode: { type: 'string', enum: ['voice', 'video'], description: '默认 voice（QQ 语音）；想直接发视频用 video。' },
            site: { type: 'string', enum: ['bilibili', 'douyin'], description: '搜索站点，默认 bilibili。' },
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道；跨渠道需要权限。' },
            caption: { type: 'string', description: '随媒体一起发的一句话，可省略。' },
          },
          required: ['query'],
        },
      },
      async (args, context) => {
        const search = await searchCandidates({ query: args?.query, site: args?.site, limit: 8 })
        if (!search.ok) return search
        if (search.ambiguous || !search.candidates.length) {
          return {
            ok: true,
            ambiguous: true,
            query: search.query,
            candidates: search.candidates,
            note: '没有足够有把握的候选：用 chat_send 把候选念给用户，或让用户确认后再用 media_send。',
          }
        }
        const top = search.candidates[0]
        const sent = await sendMedia({ ...args, url: top.url, mode: args?.mode === 'video' ? 'video' : 'voice' }, context, args?.mode === 'video' ? 'video' : 'voice')
        if (sent?.ok) return { ...sent, picked: { title: top.title, author: top.author, duration: top.duration, url: top.url, score: top.score, reasons: top.reasons } }
        return sent
      },
    ),
    registry.register(
      'media_send',
      {
        description: SEND_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'B站 / 抖音链接（b23.tv、bilibili.com、v.douyin.com、抖音分享链接均可）。' },
            mode: { type: 'string', enum: ['auto', 'voice', 'video', 'images', 'file'], description: '默认 auto；点歌用 voice，链接发视频用 video，抖音图文用 images。' },
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道；跨渠道需要权限。' },
            caption: { type: 'string', description: '随媒体一起发的一句话，可省略。' },
          },
          required: ['url'],
        },
      },
      async (args, context) => sendMedia(args || {}, context),
    ),
  ]

  const service = {
    name: 'media-post',
    version,
    search: args => searchCandidates(args || {}),
    send: (args, context) => sendMedia(args || {}, context || {}),
  }
  ctx.provide('media-post', service, { type: 'singleton' })

  const renderPanel = container =>
    renderMediaPanel(container, {
      api: ctx.registry.get('api'),
      toast: ctx.registry.get('toast'),
    })

  if (manager?.registerSettings) {
    try {
      const dispose = manager.registerSettings({
        id: 'media-post',
        title: '点歌台 · 媒体放映机',
        description: 'B站 / 抖音下载、QQ 语音、媒体库与 Cookie 登录。',
        render: container => renderPanel(container),
      })
      ctx.effect(() => () => dispose?.())
    } catch (error) {
      ctx.logger.warn(`[media-post] 注册插件设置面板失败：${error?.message || error}`)
    }
  }

  if (pages?.register) {
    ctx.effect(() =>
      pages.register({
        id: 'media-post',
        group: '功能',
        groupOrder: 52,
        label: '点歌台',
        icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
        order: 77,
        render(container) {
          return renderPanel(container)
        },
      }),
    )
  }

  ctx.effect(() => {
    for (const dispose of disposers) {
      try { dispose() } catch (_) { /* ignore */ }
    }
  })

  events?.emit?.('media-post:ready', { version })
  ctx.logger.info('点歌台已启用：media_search / media_play / media_send（依赖联网访问 + NapCat / QQ 官方机器人语音）')
}
