/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * agnes-media · Agnes 生图 / 生视频（独立扩展）
 *
 * 给模型的工具（后端桥见同目录 bridge.mjs）：
 *   agnes_generate_image  挂载图片生成任务（异步，后台完成）
 *   agnes_generate_video  挂载视频生成任务（异步轮询 Agnes）
 *   agnes_task_status     手动查询生成状态
 *   agnes_models          查看图片 / 视频模型、分类与免费状态
 *
 * 任务生成完成后由前端插件（或服务端代聊 Worker）自动发到会话：
 *   - 图片：下载 / 保存成 imageId 后作为图片消息发送；
 *   - 视频：自动发送可播放 / 下载的本地链接（结果文件已落本机数据目录）。
 *
 * 参考图支持三种来源：
 *   - reference_urls：网络上直接给出的图片 URL；
 *   - reference_message_ids：按 message_id 取聊天记录里我 / 角色发过的图片；
 *   - reference_image_ids：念风图片服务里已经存在的 imageId。
 */
export const name = 'agnes-media'
export const version = '1.0.0'
export const scope = 'both'
export const displayName = 'Agnes 生图 / 生视频'
export const description = '工具 · Agnes 图像 / 视频模型接入：下拉选择 + 手动填写、免费状态标注、插件专属代理、异步任务与自动回发；支持 message_id / 网络图源参考图。'
export const author = '念风扩展'
export const icon = '🎨'
export const core = false
export const enabled = true
export const depends = {
  'event-bus': '*',
  'tool-registry': '^1.0.0',
  'session-service': '>=2.0.0',
  'chat-store': '^1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'chat-permissions': '^1.0.0',
  'config': '^1.0.0',
  'image-service': '>=1.0.0',
  'plugin-manager': '>=1.0.0',
  'settings-container': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const inject = [
  'tool-registry',
  'session-service',
  'chat-store',
  'event-bus',
  'api?',
  'chat-permissions?',
  'config?',
  'image-service?',
  'plugin-manager?',
  'settings-container?',
  'toast?',
]
export const provides = []

import { PANEL_CSS, renderAgnesPanel } from './panel.mjs'
import { IMAGE_ICON, SPARKLE_ICON, useStyle } from './ui.mjs'

const TASK_POLL_MS = 4000
const MAX_REFERENCE_IMAGES = 8

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function clean(value, fallback = '') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function uniqueStrings(values) {
  const out = []
  const seen = new Set()
  for (const raw of values) {
    const value = clean(raw)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function imageRefsFromMessage(message) {
  const out = []
  if (Array.isArray(message?.meta?.images)) out.push(...message.meta.images.filter(Boolean))
  if (Array.isArray(message?.meta?.quote?.images)) out.push(...message.meta.quote.images.filter(Boolean))
  const preview = Array.isArray(message?.meta?.forward?.preview) ? message.meta.forward.preview : []
  for (const item of preview) {
    if (Array.isArray(item?.preview_images)) out.push(...item.preview_images.filter(Boolean))
    if (Array.isArray(item?.images)) out.push(...item.images.filter(Boolean))
  }
  return out
}

function blobToDataUrl(blob, fallbackMime = '') {
  return new Promise((resolve, reject) => {
    const fallback = async () => {
      try {
        const buffer = await blob.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ''
        const chunk = 0x8000
        for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
        const base64 = typeof Buffer !== 'undefined' && Buffer.from ? Buffer.from(bytes).toString('base64') : btoa(binary)
        resolve(`data:${String(blob.type || fallbackMime || 'image/png').split(';')[0]};base64,${base64}`)
      } catch (error) {
        reject(error)
      }
    }
    if (typeof FileReader === 'function') {
      try {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => fallback().catch(reject)
        reader.readAsDataURL(blob)
        return
      } catch (_) {
        /* 继续走 Node 垫片分支 */
      }
    }
    fallback().catch(reject)
  })
}

export function apply(ctx) {
  const registry = ctx.inject('tool-registry')
  const sessions = ctx.inject('session-service')
  const store = ctx.inject('chat-store')
  const manager = ctx.inject('plugin-manager?')
  const pages = ctx.inject('settings-container?') || ctx.registry.get('settings-container')
  const resolveImageService = () => ctx.registry.get('image-service')
  const toast = ctx.registry.get('toast')
  const clientId = `agnes_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

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

  const callBackend = async (method, path, body, timeoutMs = 60000) => {
    const client = api()
    if (!client) return { ok: false, code: 'BACKEND_OFFLINE', error: '本地后端未就绪（backend-client 插件未启用或后端未启动）。' }
    try {
      if (method === 'get') return await client.get(path, { timeoutMs })
      if (method === 'put') return await client.put(path, body, { timeoutMs })
      if (method === 'del') return await client.del(path, { timeoutMs })
      return await client.post(path, body, { timeoutMs })
    } catch (error) {
      const status = Number(error?.status) || 0
      return {
        ok: false,
        code: status === 404 ? 'BRIDGE_NOT_LOADED' : status === 401 ? 'BACKEND_AUTH' : 'BACKEND_ERROR',
        status,
        error:
          status === 404
            ? 'Agnes 后端桥尚未加载：请到 设置 → 插件 点「重新扫描」热加载；如果当前内核不支持热加载，再重启念风后端。'
            : `后端调用失败：${error?.message || error}`,
      }
    }
  }

  const backendUrl = path => {
    const value = String(path || '')
    if (!value) return ''
    if (/^https?:\/\//i.test(value)) return value
    const base = String(api()?.baseUrl?.() || '/api').replace(/\/+$/, '')
    if (/^https?:\/\//i.test(base)) {
      const origin = base.replace(/\/api$/i, '')
      return `${origin}${value.startsWith('/') ? value : `/${value}`}`
    }
    return value.startsWith('/') ? value : `/${value}`
  }

  const fetchAsDataUrl = async url => {
    const response = await fetch(url, { credentials: 'include' })
    if (!response.ok) throw new Error(`下载结果失败：HTTP ${response.status}`)
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (contentType && !contentType.startsWith('image/')) throw new Error(`结果不是图片（${contentType}）`)
    const blob = await response.blob()
    return blobToDataUrl(blob, contentType || 'image/png')
  }

  const imageToReference = async (image, { preferRemote = false } = {}) => {
    if (!image) return ''
    const remote = typeof image.url === 'string' && /^https?:\/\//i.test(image.url) && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/i.test(image.url)
      ? image.url
      : ''
    if (preferRemote && remote) return remote
    if (image.dataUrl) return image.dataUrl
    const dataUrl = resolveImageService()?.dataUrlOf?.(image)
    if (dataUrl) return dataUrl
    if (remote) return remote
    if (image.id) {
      await resolveImageService()?.hydrateImages?.([image])
      return resolveImageService()?.dataUrlOf?.(image) || resolveImageService()?.urlOf?.(image) || ''
    }
    return ''
  }

  const resolveReferences = async (args, context, options = {}) => {
    const preferRemote = options.preferRemote === true
    const values = []
    const urls = Array.isArray(args?.reference_urls) ? args.reference_urls : []
    values.push(...urls)
    if (args?.reference_url) values.push(args.reference_url)

    const imageIds = uniqueStrings([
      ...(Array.isArray(args?.reference_image_ids) ? args.reference_image_ids : []),
      ...(args?.reference_image_id ? [args.reference_image_id] : []),
    ])
    if (imageIds.length) {
      const records = imageIds.map(id => ({ id }))
      try {
        await resolveImageService()?.hydrateImages?.(records)
      } catch (_) {
        /* 单张失败继续 */
      }
      for (const record of records) values.push(await imageToReference(record, { preferRemote }))
    }

    const messageIds = uniqueStrings([
      ...(Array.isArray(args?.reference_message_ids) ? args.reference_message_ids : []),
      ...(args?.reference_message_id ? [args.reference_message_id] : []),
    ])
    const conversation = sessions.get(context?.conversationId)
    if (messageIds.length && conversation) {
      const wanted = new Set(messageIds.map(String))
      const selected = (conversation.messages || []).filter(message => wanted.has(String(message.message_id || message.id || '')))
      const refs = []
      for (const message of selected) refs.push(...imageRefsFromMessage(message))
      try {
        await resolveImageService()?.hydrateImages?.(refs)
      } catch (_) {
        /* 单张失败继续 */
      }
      for (const image of refs) values.push(await imageToReference(image, { preferRemote }))
    }

    return uniqueStrings(values.map(value => String(value || ''))).slice(0, MAX_REFERENCE_IMAGES)
  }

  const resolveSingleFrame = async (args, context, field, { preferRemote = false } = {}) => {
    const explicit = clean(args?.[field])
    if (explicit) return explicit
    const messageField = `${field}_message_id`
    const ids = uniqueStrings([args?.[messageField]])
    if (!ids.length || !context?.conversationId) return ''
    const refs = await resolveReferences({ reference_message_ids: ids }, context, { preferRemote })
    return refs[0] || ''
  }

  const targetContext = context => ({
    conversationId: context?.conversationId || '',
    channelId: context?.channelId || '',
    roleId: context?.roleId || '',
    userId: context?.userId || '',
    userName: context?.userName || '',
  })

  const afterCreate = () => {
    setTimeout(() => pollOnce().catch(() => {}), 800)
  }

  /* ---------------- 工具实现 ---------------- */

  const generateImage = async (args, context) => {
    const prompt = clean(args?.prompt)
    if (!prompt) return { ok: false, code: 'INVALID_ARGS', error: '缺少 prompt（图片描述）。' }
    if (!context?.conversationId) return { ok: false, code: 'NO_CONVERSATION', error: '当前没有可用会话，无法挂载生成任务。' }
    const references = await resolveReferences(args, context)
    const result = await callBackend(
      'post',
      '/agnes-media/tasks/image',
      {
        prompt,
        model: clean(args?.model) || undefined,
        size: clean(args?.size) || undefined,
        ratio: clean(args?.ratio) || undefined,
        dimensions: clean(args?.dimensions) || undefined,
        response_format: clean(args?.response_format || args?.responseFormat) || undefined,
        references,
        caption: clean(args?.caption).slice(0, 300),
        auto_send: args?.auto_send !== false,
        context: targetContext(context),
      },
      60000,
    )
    if (!result?.ok) return result
    afterCreate()
    return {
      ok: true,
      task_id: result.task?.id || '',
      kind: 'image',
      status: 'queued',
      model: result.task?.model || clean(args?.model) || '',
      reference_count: references.length,
      reference_warnings: result.task?.reference_warnings || [],
      auto_send: result.task?.auto_send !== false,
      note:
        '图片任务已经在后台生成，不需要等待，也不要在回复里声称图片已经发好。' +
        '完成后插件会自动把图片发到当前会话；用户追问进度时可调用 agnes_task_status。' +
        '如果用户明确要求先看结果再决定，请用 agnes_task_status 查询。',
    }
  }

  const generateVideo = async (args, context) => {
    const prompt = clean(args?.prompt)
    if (!prompt) return { ok: false, code: 'INVALID_ARGS', error: '缺少 prompt（视频描述）。' }
    if (!context?.conversationId) return { ok: false, code: 'NO_CONVERSATION', error: '当前没有可用会话，无法挂载生成任务。' }
    const references = await resolveReferences(args, context, { preferRemote: true })
    const firstFrame = await resolveSingleFrame(args, context, 'first_frame', { preferRemote: true })
    const lastFrame = await resolveSingleFrame(args, context, 'last_frame', { preferRemote: true })
    const result = await callBackend(
      'post',
      '/agnes-media/tasks/video',
      {
        prompt,
        model: clean(args?.model) || undefined,
        mode: clean(args?.mode) || undefined,
        seconds: clean(args?.seconds) || undefined,
        size: clean(args?.size) || undefined,
        aspect_ratio: clean(args?.aspect_ratio || args?.aspectRatio) || undefined,
        seed: Number.isFinite(Number(args?.seed)) ? Number(args.seed) : undefined,
        negative_prompt: clean(args?.negative_prompt) || undefined,
        first_frame: firstFrame || undefined,
        last_frame: lastFrame || undefined,
        reference_audios: Array.isArray(args?.reference_audios) ? args.reference_audios.slice(0, 3) : [],
        reference_videos: Array.isArray(args?.reference_videos) ? args.reference_videos.slice(0, 1) : [],
        width: Number(args?.width) || undefined,
        height: Number(args?.height) || undefined,
        num_frames: Number(args?.num_frames) || undefined,
        frame_rate: Number(args?.frame_rate) || undefined,
        num_inference_steps: Number(args?.num_inference_steps) || undefined,
        references,
        caption: clean(args?.caption).slice(0, 300),
        auto_send: args?.auto_send !== false,
        context: targetContext(context),
      },
      60000,
    )
    if (!result?.ok) return result
    afterCreate()
    return {
      ok: true,
      task_id: result.task?.id || '',
      kind: 'video',
      status: 'queued',
      model: result.task?.model || clean(args?.model) || '',
      reference_count: references.length,
      reference_warnings: result.task?.reference_warnings || [],
      auto_send: result.task?.auto_send !== false,
      note:
        '视频任务已经在后台挂载，不需要等待，也不要在回复里声称视频已经发好。' +
        'Agnes 视频是异步任务，完成后插件会自动把播放 / 下载链接发到当前会话；' +
        '用户追问进度时调用 agnes_task_status（视频通常需要数分钟，不要反复查）。',
    }
  }

  const taskStatus = async (args, context) => {
    const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 30)
    if (args?.task_id) {
      const result = await callBackend('get', `/agnes-media/tasks/${encodeURIComponent(String(args.task_id))}?refresh=1`, undefined, 60000)
      if (!result?.ok) return result
      const task = result.task
      return {
        ok: true,
        task: {
          id: task.id,
          kind: task.kind,
          status: task.status,
          progress: task.progress,
          model: task.model,
          prompt: String(task.prompt || '').slice(0, 160),
          result_url: task.result?.local_url || task.result?.remote_url || '',
          result_kind: task.kind,
          auto_send: task.auto_send,
          sent: !!task.send?.sent_at,
          error: task.error || '',
        },
        note:
          task.status === 'completed'
            ? task.send?.sent_at
              ? '任务已完成并且已经自动发送。'
              : '任务已完成，插件正在 / 即将自动发送。'
            : task.status === 'failed'
              ? '任务失败；可以把 error 如实告诉用户，并建议调整提示词或参数后重试。'
              : '任务仍在生成；图片通常几十秒，视频通常数分钟，不要高频轮询。',
      }
    }
    const result = await callBackend('get', `/agnes-media/tasks?limit=${encodeURIComponent(String(limit))}`, undefined, 30000)
    if (!result?.ok) return result
    const all = args?.all === true
    const list = (result.tasks || [])
      .filter(task => all || !context?.conversationId || task.target?.conversation_id === context.conversationId)
      .slice(0, limit)
      .map(task => ({
        id: task.id,
        kind: task.kind,
        status: task.status,
        progress: task.progress,
        model: task.model,
        result_url: task.result?.local_url || task.result?.remote_url || '',
        auto_send: task.auto_send,
        sent: !!task.send?.sent_at,
        error: task.error || '',
        created_at: task.created_at,
      }))
    return {
      ok: true,
      total: list.length,
      tasks: list,
      note: list.length ? '按 id 传 agnes_task_status 可看单任务详情。' : '当前会话还没有生成任务。',
    }
  }

  const modelsTool = async args => {
    const force = args?.refresh === true || args?.force === true
    const result = await callBackend('get', `/agnes-media/models${force ? '?force=1' : ''}`, undefined, 45000)
    if (!result) return { ok: false, error: '模型列表获取失败' }
    if (result.ok === false && !Array.isArray(result.imageFallback)) return result
    const simplify = item => ({
      id: item.id,
      free: item.free === true ? true : item.free === false ? false : null,
      free_label: item.freeLabel || (item.free === true ? '免费' : item.free === false ? '付费' : '免费情况未知'),
      label: item.label || '',
      price: item.price || '',
      note: item.note || '',
      recommended: item.recommended === true,
      legacy: item.legacy === true,
    })
    return {
      ok: true,
      fetched: result.fetched === true,
      source: result.source || '内置目录',
      verified_at: result.verifiedAt || '',
      classification_note: result.ambiguous
        ? '有部分模型无法确定图片 / 视频分类，已同时放进图片和视频候选，请结合模型名自行判断。'
        : '图片 / 视频模型已按 Agnes 命名自动分类。',
      image_options: (result.imageOptions || result.imageFallback || []).map(simplify),
      video_options: (result.videoOptions || result.videoFallback || []).map(simplify),
      text_options: (result.text || []).map(simplify),
      error: result.error || '',
    }
  }

  /* ---------------- 任务轮询 / 自动发送 ---------------- */

  const processedTaskIds = new Set()
  const processingTaskIds = new Set()

  const releaseTask = async (task, errorMessage) => {
    await callBackend('post', `/agnes-media/tasks/${encodeURIComponent(task.id)}/sent`, { clientId, error: errorMessage }, 30000)
  }

  const finishTask = async (task, messageIds) => {
    await callBackend('post', `/agnes-media/tasks/${encodeURIComponent(task.id)}/sent`, { clientId, messageIds }, 30000)
  }

  const sendCompletedTask = async task => {
    const conversationId = task.target?.conversation_id || ''
    const conversation = sessions.get(conversationId)
    if (!conversation) throw new Error(`目标会话不存在：${conversationId || '(空)'}`)
    const caption = clean(task.caption).slice(0, 300)
    const result = task.result || {}

    if (task.kind === 'image') {
      const localUrl = backendUrl(result.local_url)
      const remoteUrl = result.remote_url || ''
      let record = null
      if (localUrl) {
        try {
          const dataUrl = await fetchAsDataUrl(localUrl)
          const imageSvc = resolveImageService()
          record = imageSvc?.saveDataUrl
            ? await imageSvc.saveDataUrl(dataUrl, { mime: result.mime || 'image/png', name: `agnes_${task.id}.png` })
            : { url: localUrl, mime: result.mime || 'image/png', name: `agnes_${task.id}.png` }
        } catch (error) {
          ctx.logger?.warn?.(`[agnes-media] 本地图片转存失败，退回 URL：${error?.message || error}`)
          record = { url: localUrl, mime: result.mime || 'image/png', name: `agnes_${task.id}.png` }
        }
      } else if (remoteUrl) {
        record = { url: remoteUrl, mime: result.mime || 'image/png', name: `agnes_${task.id}.png` }
      }
      if (!record) throw new Error('任务已完成，但没有可发送的图片结果。')
      const message = store.append(conversationId, {
        role: 'assistant',
        content: caption,
        content_type: 'image',
        sender_id: `role_${conversation.id}`,
        sender_name: conversation.name,
        is_bot: true,
        source: 'nova',
        visibility: 'shareable',
        meta: {
          via: 'agnes_media',
          task_id: task.id,
          channel: task.target?.channel_id || '',
          model: task.model,
          agnes_result: { remote_url: remoteUrl, local_url: result.local_url || '', mime: result.mime || '', bytes: result.bytes || 0 },
          images: [record],
        },
      })
      return message ? [message.message_id || message.id] : []
    }

    if (task.kind === 'video') {
      const localUrl = backendUrl(result.local_url)
      const remoteUrl = result.remote_url || ''
      const videoUrl = localUrl || remoteUrl
      if (!videoUrl) throw new Error('任务已完成，但没有可发送的视频结果。')
      const lines = []
      if (caption) lines.push(caption)
      const sizeText = Number(result.bytes) > 0 ? `，${(Number(result.bytes) / 1024 / 1024).toFixed(1)}MB` : ''
      lines.push(`🎬 视频已生成${sizeText}：${videoUrl}`)
      const message = store.append(conversationId, {
        role: 'assistant',
        content: lines.join('\n'),
        content_type: 'text',
        sender_id: `role_${conversation.id}`,
        sender_name: conversation.name,
        is_bot: true,
        source: 'nova',
        visibility: 'shareable',
        meta: {
          via: 'agnes_media',
          task_id: task.id,
          channel: task.target?.channel_id || '',
          model: task.model,
          video: { url: videoUrl, remote_url: remoteUrl, mime: result.mime || 'video/mp4', bytes: result.bytes || 0 },
        },
      })
      return message ? [message.message_id || message.id] : []
    }

    throw new Error(`未知任务类型：${task.kind}`)
  }

  const sendFailedTask = async task => {
    const conversationId = task.target?.conversation_id || ''
    const conversation = sessions.get(conversationId)
    if (!conversation) return []
    const kindLabel = task.kind === 'video' ? '视频' : '图片'
    const message = store.append(conversationId, {
      role: 'assistant',
      content: `⚠️ ${kindLabel}生成失败：${task.error || '未知错误'}\n任务 ID：${task.id}`,
      content_type: 'text',
      sender_id: `role_${conversation.id}`,
      sender_name: conversation.name,
      is_bot: true,
      source: 'nova',
      visibility: 'shareable',
      meta: { via: 'agnes_media', task_id: task.id, channel: task.target?.channel_id || '', model: task.model, error: true },
    })
    return message ? [message.message_id || message.id] : []
  }

  const handleTerminalTask = async task => {
    if (processingTaskIds.has(task.id)) return
    processingTaskIds.add(task.id)
    try {
      const claim = await callBackend('post', `/agnes-media/tasks/${encodeURIComponent(task.id)}/claim`, { clientId }, 30000)
      if (!claim) return
      if (claim.already_sent) {
        processedTaskIds.add(task.id)
        return
      }
      if (!claim.ok || !claim.claimed) return
      const claimedTask = claim.task || task
      try {
        let messageIds = []
        if (claimedTask.status === 'completed') {
          messageIds = await sendCompletedTask(claimedTask)
        } else if (claimedTask.status === 'failed') {
          messageIds = await sendFailedTask(claimedTask)
        } else {
          // 已取消：不刷屏，只释放占用。
          messageIds = []
        }
        await finishTask(claimedTask, messageIds)
        processedTaskIds.add(task.id)
      } catch (error) {
        await releaseTask(claimedTask, error?.message || String(error))
        ctx.logger?.warn?.(`[agnes-media] 自动发送失败：${error?.message || error}`)
      }
    } finally {
      processingTaskIds.delete(task.id)
    }
  }

  const pollOnce = async () => {
    const result = await callBackend('get', '/agnes-media/tasks?limit=120', undefined, 30000)
    if (!result?.ok) return
    const tasks = Array.isArray(result.tasks) ? result.tasks : []
    const terminal = ['completed', 'failed', 'cancelled']
    for (const task of tasks) {
      if (!task?.id) continue
      if (processedTaskIds.has(task.id)) continue
      if (task.send?.sent_at) {
        processedTaskIds.add(task.id)
        continue
      }
      if (!task.auto_send) {
        processedTaskIds.add(task.id)
        continue
      }
      if ((Number(task.send?.attempts) || 0) >= 3) {
        // 连续三次自动发送失败（例如目标会话被删除）：停止重试，避免每 4 秒刷一次错误。
        processedTaskIds.add(task.id)
        continue
      }
      if (!terminal.includes(task.status)) continue
      if (processingTaskIds.has(task.id)) continue
      if (task.send?.claimed && task.send.claimed_by && task.send.claimed_by !== clientId) continue
      await handleTerminalTask(task)
    }
  }

  let pollTimer = null
  const startPolling = () => {
    const run = () => pollOnce().catch(error => ctx.logger?.warn?.(`[agnes-media] 任务轮询失败：${error?.message || error}`))
    setTimeout(run, 1200)
    pollTimer = setInterval(run, TASK_POLL_MS)
    try {
      ctx.effect(() => () => {
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = null
      })
    } catch (_) {
      /* ignore */
    }
  }

  /* ---------------- 工具注册 ---------------- */

  const REFERENCE_IMAGE_PROPS = {
    reference_urls: {
      type: 'array',
      items: { type: 'string' },
      description:
        '网络图片 URL 列表（最多 8 张）。可以先用 web_search / browser 找图源，再用 web_image 确认；适合“把这张网图当参考”的场景。',
    },
    reference_message_ids: {
      type: 'array',
      items: { type: 'string' },
      description: '聊天记录的 message_id 列表；插件会自动取出这些消息里的图片作为参考图，也支持我或角色发过的图。',
    },
    reference_image_ids: {
      type: 'array',
      items: { type: 'string' },
      description:
        '念风图片服务里的 imageId 列表，例如 web_image 返回的 image_ids（最稳，不受原站防盗链影响），也可以引用之前生成的图片 / 用户上传的图片。',
    },
    reference_message_id: { type: 'string', description: '只取一张参考图时可直接传单个 message_id。' },
    reference_url: { type: 'string', description: '只取一张网络参考图时可直接传 URL。' },
  }

  const IMAGE_PARAMETERS = {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '图片描述 / 编辑指令。建议写清主体、场景、风格、光照、构图、质量。' },
      model: {
        type: 'string',
        description:
          '图片模型 ID，可省略使用插件默认值。可用 agnes_models 查询免费状态；默认为 agnes-image-2.5-flash（当前免费）。',
      },
      size: { type: 'string', enum: ['1K', '2K', '3K', '4K'], description: '输出档位，推荐配合 ratio；默认 2K。' },
      ratio: {
        type: 'string',
        enum: ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'],
        description: '画幅比例，默认 1:1。',
      },
      dimensions: { type: 'string', description: '精确尺寸（如 1024x768）；宽高必须能被 16 整除，一般不推荐。' },
      response_format: { type: 'string', enum: ['url', 'b64_json'], description: '输出格式，默认 url。' },
      caption: { type: 'string', description: '随图片一起发到聊天里的说明文字，可省略。' },
      auto_send: { type: 'boolean', description: '是否完成后自动发送，默认 true。' },
      ...REFERENCE_IMAGE_PROPS,
    },
    required: ['prompt'],
  }

  const VIDEO_PARAMETERS = {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '视频描述。建议包含主体 / 动作 / 场景 / 镜头运动 / 光照 / 风格。' },
      model: {
        type: 'string',
        description:
          '视频模型 ID，可省略使用插件默认值。agnes-video-2.5-flash 限时免费（仅 720P）；agnes-video-2.5 为付费高清；agnes-video-v2.0 为免费旧版。',
      },
      mode: { type: 'string', enum: ['text', 'keyframe', 'reference'], description: '2.5 系列模式；text=文生视频，keyframe=首尾帧，reference=参考图 / 音频 / 视频。' },
      seconds: { type: 'string', enum: ['4', '5', '6', '7', '8', '9', '10', '11', '12'], description: '2.5 系列视频时长（字符串），默认 "5"。' },
      size: { type: 'string', enum: ['720P', '1080P', '1K', '2K'], description: '2.5 系列输出档位；2.5 Flash 只支持 720P。' },
      aspect_ratio: {
        type: 'string',
        enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        description: '2.5 系列画幅，默认 16:9。',
      },
      seed: { type: 'number', description: '随机种子，可复现结果。' },
      negative_prompt: { type: 'string', description: '负向提示词，用于描述不希望出现的内容。' },
      first_frame: { type: 'string', description: '2.5 keyframe 首帧图片 URL。' },
      last_frame: { type: 'string', description: '2.5 keyframe 尾帧图片 URL。' },
      first_frame_message_id: { type: 'string', description: '从聊天记录的 message_id 里取一张图作为首帧。' },
      last_frame_message_id: { type: 'string', description: '从聊天记录的 message_id 里取一张图作为尾帧。' },
      reference_audios: { type: 'array', items: { type: 'string' }, description: '2.5 reference 参考音频 URL 列表（最多 3 段）。' },
      reference_videos: {
        type: 'array',
        items: { type: 'object' },
        description: '2.5 reference 参考视频，元素形如 {url, start_seconds?, require_audio?}（Flash 不支持）。',
      },
      caption: { type: 'string', description: '随视频一起发出的说明文字，可省略。' },
      auto_send: { type: 'boolean', description: '是否完成后自动发送，默认 true。' },
      width: { type: 'number', description: '旧版 agnes-video-v2.0 宽度，默认 1152。' },
      height: { type: 'number', description: '旧版 agnes-video-v2.0 高度，默认 768。' },
      num_frames: { type: 'number', description: '旧版 agnes-video-v2.0 帧数：必须 8n+1 且 ≤441。' },
      frame_rate: { type: 'number', description: '旧版 agnes-video-v2.0 FPS：1–60。' },
      num_inference_steps: { type: 'number', description: '旧版 agnes-video-v2.0 推理步数。' },
      ...REFERENCE_IMAGE_PROPS,
    },
    required: ['prompt'],
  }

  const disposers = []
  const registerTool = (name, definition, handler) => {
    try {
      const dispose = registry.register(name, definition, handler, { owner: 'agnes-media' })
      disposers.push(dispose)
    } catch (error) {
      ctx.logger.warn(`[agnes-media] 注册工具 ${name} 失败：${error?.message || error}`)
    }
  }

  registerTool(
    'agnes_generate_image',
    {
      description:
        'Agnes 生图 / 图生图，异步挂载任务。给出 prompt 后立刻返回 task_id，前台聊天不阻塞；完成后插件会自动把图片发到当前会话。' +
        'model 可省略（默认 agnes-image-2.5-flash，当前免费）；可用 agnes_models 查看图片模型与免费状态。' +
        '参考图三种来源：reference_urls（网络图源）、reference_message_ids（聊天消息 message_id）、reference_image_ids（图片服务 imageId）。' +
        '如果用户要求“网上找一张图再改成 xx 风格”：先用 web_search 找图源，再用 web_image 查看确认，最后把 web_image 返回的 image_ids 传到这里（reference_image_ids 最稳），或把 image_urls 传给 reference_urls。' +
        '不要在工具成功后说图片已经发好了；自动发送可能还要一小会儿。若用户追问进度，用 agnes_task_status。',
      parameters: IMAGE_PARAMETERS,
    },
    generateImage,
  )

  registerTool(
    'agnes_generate_video',
    {
      description:
        'Agnes 生视频 / 图生视频 / 首尾帧 / 参考视频，异步挂载任务。给出 prompt 后立刻返回 task_id，前台聊天不阻塞；' +
        'Agnes 出片后插件自动把视频的播放 / 下载链接发到当前会话。' +
        '2.5 系列：model 默认 agnes-video-2.5-flash（限时免费，仅 720P），也可选付费 agnes-video-2.5；mode=text / keyframe / reference。' +
        '旧版 agnes-video-v2.0 免费，用 num_frames(8n+1,≤441) / frame_rate 控制时长。' +
        '参考图可来自 reference_urls / reference_message_ids / reference_image_ids；首尾帧可用 first_frame / last_frame 或对应 message_id。' +
        '不要等待，也不要在工具成功后声称视频已经发好；用户追问进度用 agnes_task_status，不要高频轮询。',
      parameters: VIDEO_PARAMETERS,
    },
    generateVideo,
  )

  registerTool(
    'agnes_task_status',
    {
      description:
        '查询 Agnes 生图 / 生视频任务的进度与结果。传 task_id 看单个任务；不传就返回当前会话最近任务。' +
        '不要把 status=queued/running 说成已完成；completed 且 sent=true 才代表已经发到聊天。' +
        '图片通常几十秒，视频通常数分钟；模型不要高频轮询。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'agnes_generate_image / agnes_generate_video 返回的 task_id。' },
          all: { type: 'boolean', description: '不传 task_id 时，true=查看所有会话的最近任务，默认只看当前会话。' },
          limit: { type: 'number', description: '最多返回多少条，默认 8，最大 30。' },
        },
      },
    },
    taskStatus,
  )

  registerTool(
    'agnes_models',
    {
      description:
        '查看 Agnes 当前可用的图片 / 视频模型列表，并附带免费状态（优先自动读取 /v1/models，失败时回退内置目录并提示）。' +
        '模型下拉无法自动分类时会同时放进图片和视频候选，需要结合模型名判断。' +
        '当用户问“哪个模型免费 / 用哪个模型”或需要确认手动填写的模型名时使用。',
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'true=强制重新从 Agnes /v1/models 获取，默认使用 5 分钟缓存。' },
        },
      },
    },
    modelsTool,
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
  })

  /* ---------------- 设置面板 ---------------- */

  const renderPanel = container =>
    renderAgnesPanel(container, {
      api: ctx.registry.get('api'),
      toast: ctx.registry.get('toast'),
    })

  if (manager?.registerSettings) {
    try {
      const dispose = manager.registerSettings({
        id: 'agnes-media',
        title: 'Agnes 生图 / 生视频',
        description: 'Agnes API Key、模型、代理与自动发送设置。',
        render: container => renderPanel(container),
      })
      ctx.effect(() => () => dispose?.())
    } catch (error) {
      ctx.logger.warn(`[agnes-media] 注册插件设置面板失败：${error?.message || error}`)
    }
  }

  if (pages?.register) {
    try {
      const dispose = pages.register({
        id: 'agnes-media',
        group: '功能',
        groupOrder: 60,
        label: 'Agnes 生图 / 生视频',
        icon: IMAGE_ICON,
        order: 78,
        render(container) {
          return renderPanel(container)
        },
      })
      ctx.effect(() => () => dispose?.())
    } catch (error) {
      ctx.logger.warn(`[agnes-media] 注册设置页失败：${error?.message || error}`)
    }
  }

  startPolling()
  ctx.logger.info('Agnes 生图 / 生视频已启用：agnes_generate_image / agnes_generate_video / agnes_task_status / agnes_models')
}
