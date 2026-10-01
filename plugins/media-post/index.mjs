/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · 点歌台 · 媒体放映机
 *
 * 给模型的工具（依赖「联网访问」提供搜索 / 抖音图文 / Cookie，后端桥负责下载转码发送）：
 *   media_search  搜索 B站 / 抖音视频候选（带匹配分与理由）
 *   media_play    一步点歌：搜索 + 自动选最优 + 发送（默认 QQ 语音，支持一次多首）
 *   media_send    把链接内容拉下来发送：语音 / 视频 / 图文 / 文件，支持一次多条链接
 *
 * 下载策略（v2.3.0）：
 *   B站 → 直接请求网页播放器同款 DASH（fnval=4048，原画质），选最高清晰度；
 *   抖音 → 只取详情接口 play_addr 系列（网页播放器在播的「无水印」流），绝不碰 download_addr（带水印）；
 *   两者都做编码探测：非 H.264 + AAC 时由 ffmpeg 按需转码，避免「视频发出去打开 0:00 / 黑屏」。
 *
 * 发送策略：
 *   NapCat 渠道 → 后端特权段 record / video / file / image；
 *   QQ 官方机器人渠道 → 语音转 SILK 后走官方富媒体接口；
 *   其它渠道   → 降级为「标题 + 时长 + 原链接 + 本地缓存路径」的普通消息（图文会附图片）。
 */
export const name = 'media-post'
export const version = '2.3.0'
export const scope = 'both'
export const displayName = '点歌台 · 媒体放映机'
export const description = '扩展 · B站 / 抖音视频与图文：点歌发 QQ 语音（NapCat / QQ 官方机器人），视频 / 文件 / 图文直发 NapCat 与 QQ 官方机器人，其它渠道降级为文件或链接。'
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
import { normalizeLinkList } from './lib/links.mjs'
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
  '用户一次点好几首时，把歌名放进 queries 数组（最多 5 首）：会先全部搜索、挑最像的一条，再按顺序一条条发出。' +
  '如果返回 ambiguous=true，说明有多个相近候选：这时改用 media_search 拿候选，用 chat_send 问用户选哪个。' +
  '返回 title / duration / delivered 表示实际发了什么；NEED_LOGIN 时让用户到「设置 → 点歌台」登录对应平台。'

const SEND_DESCRIPTION =
  '把 B站 / 抖音链接里的内容拉下来发到当前渠道（或 channel 指定的渠道）。' +
  '一次可以发多条：url 支持直接塞多条链接，urls 支持字符串数组（最多 5 条，按顺序逐条发出；用户给了一串链接时就一次填进来，不要拆成多次调用）。' +
  'mode=voice：只提取音频；NapCat 发 record 语音，QQ 官方机器人会转成 SILK 后通过官方富媒体接口发送；' +
  'mode=video：下载视频直发（默认下载浏览器同款原画质无水印流，必要时自动转码成 H.264）；NapCat 发 video 段，QQ 官方机器人上传 file_type=2 后发送；' +
  'mode=file：下载后按文件直发；NapCat 发 file 段，QQ 官方机器人上传 file_type=4 后发送。' +
  'mode=images：抖音图文（图片 + 文案），发图片组。' +
  'mode=auto：链接本身是图文就发图文，否则发视频。' +
  'caption 是随媒体一起发的一句话（多条时只跟第一条走），可省略；不要重复用户原话。' +
  '当用户让你把视频 / 文件发到某个 QQ 渠道时，直接用本工具并指定 channel；不要回答不会发，也不要把视频链接当作已发送。' +
  '返回 delivered=fallback 表示目标渠道确实不支持媒体直发，消息已按「标题 + 原链接 + 本地缓存路径」发出；' +
  '返回 delivered=batch 时看 count / items / failed 汇报，不要把失败的那几条说成成功；' +
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

  /** 一次调用最多发送多少条链接（多条会先并发下载、再按顺序发送）。 */
  const MAX_BATCH = 5
  const PREPARE_CONCURRENCY = 2

  /** 并发受限的 map（保持返回顺序）。 */
  const mapLimit = async (items, limit, worker) => {
    const list = Array.isArray(items) ? items : []
    const results = new Array(list.length)
    let cursor = 0
    const size = Math.max(1, Math.min(Number(limit) || 1, list.length))
    await Promise.all(
      Array.from({ length: size }, async () => {
        while (cursor < list.length) {
          const index = cursor
          cursor += 1
          results[index] = await worker(list[index], index)
        }
      }),
    )
    return results
  }

  /** 收集要发送的链接：url / urls 都支持，字段里塞多条链接或说明文字也能认出来。 */
  const collectUrls = args => {
    const raw = []
    if (args?.url !== undefined && args?.url !== null) raw.push(args.url)
    if (Array.isArray(args?.urls)) raw.push(...args.urls)
    else if (args?.urls !== undefined && args?.urls !== null) raw.push(args.urls)
    const all = normalizeLinkList(raw)
    return { urls: all.slice(0, MAX_BATCH), total: all.length }
  }

  /** 解析会话 meta 里的 NapCat / QQ 官方发送目标（批量发送只需解析一次）。 */
  const resolveChannelEnv = target => {
    // NapCat 渠道在会话/渠道表里用的是稳定 ID（napcat:<渠道id>）；
    // 会话 meta 里存着后端原始渠道 id，优先带上，避免媒体被降级成链接。
    const conversationMeta = sessions.get(target.conversationId)?.meta || {}
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
    return {
      napcatChannelId: String(conversationMeta.napcatChannelId || ''),
      napcatTarget,
      qqbotChannelId: String(conversationMeta.qqbotChannelId || ''),
    }
  }

  const prepareKindOf = mode => (mode === 'voice' ? 'audio' : mode === 'images' ? 'images' : mode === 'video' ? 'video' : 'auto')

  const prepareOne = async (url, mode) => {
    const prepared = await callApi('post', '/media/prepare', { url, kind: prepareKindOf(mode) }, 900000)
    if (prepared?.ok) return prepared
    return { ...(prepared || {}), ok: false, url, code: prepared?.code || 'DOWNLOAD_FAILED', error: prepared?.error || '下载失败' }
  }

  const reasonOf = sent => [sent?.reason || sent?.code, sent?.reasonText].filter(Boolean).join('：')

  /** 发送一条已下载好的媒体，并写聊天记录 / 降级消息。 */
  const deliverOne = async ({ prepared, url, target, env, mode, caption = '' }) => {
    const { napcatChannelId, napcatTarget, qqbotChannelId } = env
    const qualityOf = media => ({
      quality: media?.meta?.quality || prepared.quality || '',
      watermark_free: media?.meta?.watermarkFree ?? prepared.watermarkFree ?? null,
      transcoded: prepared.transcoded || media?.meta?.transcoded || '',
    })

    if (prepared.media?.kind === 'images' || Array.isArray(prepared.media?.items)) {
      const media = prepared.media
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
      ...qualityOf(media),
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

  /** 下载（prepare）→ 发送（send）→ 写聊天记录 / 降级消息；url / urls 支持一次多条。 */
  const sendMedia = async (args, context, modeOverride = '') => {
    const { urls, total } = collectUrls(args)
    if (!urls.length) {
      const raw = String(args?.url ?? (Array.isArray(args?.urls) ? args.urls.join(' ') : args?.urls ?? '')).trim()
      return {
        ok: false,
        code: 'INVALID_ARGS',
        error: raw ? `没有识别到受支持的链接（目前只支持 B站 / 抖音）：${raw.slice(0, 120)}` : '缺少媒体链接 url / urls。',
      }
    }
    const truncated = total > urls.length
    const mode = modeOverride || (['voice', 'video', 'file', 'images', 'auto'].includes(args?.mode) ? args.mode : 'auto')
    const target = await resolveTarget(args, context)
    if (!target.ok) return target
    const env = resolveChannelEnv(target)
    const caption = String(args?.caption || '').slice(0, 200)

    if (urls.length === 1) {
      const prepared = await prepareOne(urls[0], mode)
      if (!prepared.ok) return prepared
      return deliverOne({ prepared, url: urls[0], target, env, mode, caption })
    }

    // 多条链接：先并发下载（2 条并发），再按给出的顺序逐条发送，避免群里顺序错乱。
    const preparedList = await mapLimit(urls, PREPARE_CONCURRENCY, url => prepareOne(url, mode))
    const sent = []
    const failed = []
    for (let index = 0; index < preparedList.length; index += 1) {
      const url = urls[index]
      const prepared = preparedList[index]
      if (!prepared?.ok) {
        failed.push({ url, code: prepared?.code || 'DOWNLOAD_FAILED', error: prepared?.error || '下载失败' })
        continue
      }
      // caption 只跟第一条走，避免同一句话重复刷屏。
      const result = await deliverOne({ prepared, url, target, env, mode, caption: index === 0 ? caption : '' })
      if (result?.ok) sent.push({ url, ...result })
      else failed.push({ url, code: result?.code || 'SEND_FAILED', error: result?.error || '发送失败' })
    }

    if (!sent.length) {
      return {
        ok: false,
        code: failed[0]?.code || 'SEND_FAILED',
        error: `${urls.length} 条都没发出去：${failed.map(item => `${item.url}：${item.error}`).join('；').slice(0, 300)}`,
        failed,
      }
    }
    return {
      ok: true,
      success: true,
      delivered: 'batch',
      mode,
      channel: target.channelId,
      count: sent.length,
      requested: urls.length,
      truncated,
      items: sent.map(item => ({
        url: item.url,
        mode: item.mode || mode,
        delivered: item.delivered,
        title: item.title || '',
        duration_seconds: item.duration_seconds || 0,
        quality: item.quality || '',
        watermark_free: item.watermark_free ?? null,
        transcoded: item.transcoded || '',
        platform_message_id: item.platform_message_id || '',
        message_id: item.message_id || '',
      })),
      failed,
      note: `已按顺序发出 ${sent.length}/${urls.length} 条${failed.length ? `，${failed.length} 条失败（见 failed）` : ''}${
        truncated ? `；本次只处理前 ${urls.length} 条（一共给了 ${total} 条），剩下的让用户再发一次` : ''
      }。成功的就是已经发出去了，不要向用户声称发送失败。`,
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
            query: { type: 'string', description: '歌名 / 视频关键词（单首）。' },
            queries: {
              type: 'array',
              items: { type: 'string' },
              description: '一次点好几首时用：歌名 / 关键词数组，最多 5 首，会按顺序逐条搜索并发送。',
            },
            mode: { type: 'string', enum: ['voice', 'video'], description: '默认 voice（QQ 语音）；想直接发视频用 video。' },
            site: { type: 'string', enum: ['bilibili', 'douyin'], description: '搜索站点，默认 bilibili。' },
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道；跨渠道需要权限。' },
            caption: { type: 'string', description: '随媒体一起发的一句话（多条时只跟第一条走），可省略。' },
          },
        },
      },
      async (args, context) => {
        const mode = args?.mode === 'video' ? 'video' : 'voice'
        const rawQueries = []
        if (typeof args?.queries === 'string') rawQueries.push(...args.queries.split(/[\n,，、;；]+/))
        else if (Array.isArray(args?.queries)) rawQueries.push(...args.queries)
        const single = String(args?.query || '')
        if (single) rawQueries.unshift(...single.split(/[\n,，、;；]+/))
        const queries = []
        for (const item of rawQueries) {
          const keyword = String(item || '').trim()
          if (keyword && !queries.includes(keyword)) queries.push(keyword)
        }
        if (!queries.length) return { ok: false, code: 'INVALID_ARGS', error: '缺少点歌关键词 query / queries。' }

        // 先全部搜索：能确定的一条条攒起来，不确定的交给模型问用户。
        const picked = []
        const skipped = []
        for (const keyword of queries.slice(0, 5)) {
          const search = await searchCandidates({ query: keyword, site: args?.site, limit: 8 })
          if (!search.ok) {
            skipped.push({ query: keyword, code: search.code || 'SEARCH_FAILED', reason: search.error || '搜索失败' })
            continue
          }
          if (search.ambiguous || !search.candidates.length) {
            skipped.push({ query: keyword, reason: '候选不确定', candidates: search.candidates.slice(0, 3) })
            continue
          }
          const top = search.candidates[0]
          picked.push({ query: keyword, url: top.url, title: top.title, author: top.author, duration: top.duration, score: top.score, reasons: top.reasons })
        }

        if (!picked.length) {
          return {
            ok: true,
            ambiguous: true,
            queries,
            skipped,
            note: '没有足够有把握的候选：用 chat_send 把候选念给用户，或让用户确认后再用 media_send。',
          }
        }

        const sent = await sendMedia({ ...args, query: '', queries: [], urls: picked.map(item => item.url), mode }, context, mode)
        const pickedMap = new Map(picked.map(item => [item.url, item]))
        if (sent?.delivered === 'batch') {
          return {
            ...sent,
            picked: (sent.items || []).map(item => ({
              query: pickedMap.get(item.url)?.query || '',
              title: pickedMap.get(item.url)?.title || item.title,
              url: item.url,
              score: pickedMap.get(item.url)?.score,
              reasons: pickedMap.get(item.url)?.reasons,
            })),
            skipped,
          }
        }
        if (sent?.ok) return { ...sent, picked: [{ ...picked[0], url: picked[0].url }], skipped }
        return { ...sent, skipped }
      },
    ),
    registry.register(
      'media_send',
      {
        description: SEND_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'B站 / 抖音链接（b23.tv、bilibili.com、v.douyin.com、抖音分享链接均可）；也可以一次塞多条链接，用空格 / 换行分隔。' },
            urls: {
              type: 'array',
              items: { type: 'string' },
              description: '一次发多条链接：字符串数组，按顺序逐条发送，最多 5 条（和 url 二选一或同时用）。',
            },
            mode: { type: 'string', enum: ['auto', 'voice', 'video', 'images', 'file'], description: '默认 auto；点歌用 voice，链接发视频用 video，抖音图文用 images。多条链接共用同一个 mode。' },
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道；跨渠道需要权限。' },
            caption: { type: 'string', description: '随媒体一起发的一句话（多条时只跟第一条走），可省略。' },
          },
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
