/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * agnes-media · Agnes API 请求构造与响应解析。
 *
 * 官方接口（2026-09-24 核对）：
 *   - 图像：POST {base}/images/generations
 *   - 视频：POST {base}/videos
 *   - 视频查询：GET {origin}/agnesapi?video_id=...（2.5 系列带 &model_name=...）
 *   - 模型列表：GET {base}/models
 */

const DEFAULT_IMAGE_SIZE = '2K'
const DEFAULT_IMAGE_RATIO = '1:1'
const DEFAULT_VIDEO_SIZE_V25 = '720P'
const DEFAULT_VIDEO_ASPECT = '16:9'
const DEFAULT_VIDEO_SECONDS = '5'

const ASPECT_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']
const IMAGE_SIZES = ['1K', '2K', '3K', '4K']
const VIDEO_SIZES_V25 = ['720P', '1080P', '1K', '2K']
const VIDEO_SIZES_V25_FLASH = ['720P']
const VIDEO_MODES = ['text', 'keyframe', 'reference']

export function normalizeBaseUrl(input) {
  let value = String(input || '').trim().replace(/\/+$/, '')
  if (!value) value = 'https://apihub.agnes-ai.com/v1'
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  try {
    const url = new URL(value)
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1'
    return url.href.replace(/\/+$/, '')
  } catch (_) {
    throw Object.assign(new Error(`Base URL 不合法：${input || '(空)'}`), { code: 'INVALID_BASE_URL' })
  }
}

/** 去掉 /v1 得到网关 origin，Agnes Video 的 /agnesapi 查询接口挂在网关根上。 */
export function originFromBase(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl))
  return `${url.protocol}//${url.host}`
}

export function imageSizeOptions() {
  return [...IMAGE_SIZES]
}

export function videoSizeOptions(model) {
  return isV25Flash(model) ? [...VIDEO_SIZES_V25_FLASH] : [...VIDEO_SIZES_V25]
}

export function aspectRatioOptions() {
  return [...ASPECT_RATIOS]
}

export function videoModeOptions() {
  return [...VIDEO_MODES]
}

export function isV25VideoModel(model) {
  const id = String(model || '').toLowerCase()
  return id.includes('video-2.5') || id.includes('video-25') || id.includes('video2.5')
}

export function isV25Flash(model) {
  return isV25VideoModel(model) && String(model || '').toLowerCase().includes('flash')
}

export function isV2VideoModel(model) {
  return !isV25VideoModel(model) && /video-v?2\.0|video-v2|video_2_0/i.test(String(model || ''))
}

function clean(value, fallback = '') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function normalizeReferences(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const url = clean(typeof raw === 'string' ? raw : raw?.url || raw?.dataUrl || '')
    if (url) out.push(url)
  }
  return [...new Set(out)]
}

function normalizeAudios(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const url = clean(typeof raw === 'string' ? raw : raw?.url || '')
    if (url) out.push(url)
  }
  return [...new Set(out)]
}

function normalizeVideos(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw) continue
    if (typeof raw === 'string') {
      if (raw.trim()) out.push({ url: raw.trim() })
      continue
    }
    const url = clean(raw.url || raw.video_url || '')
    if (!url) continue
    out.push({
      url,
      ...(Number.isFinite(Number(raw.start_seconds)) ? { start_seconds: Number(raw.start_seconds) } : {}),
      ...(raw.require_audio === true ? { require_audio: true } : {}),
    })
  }
  return out
}

/**
 * 构建图像请求体。
 * 参考图既支持 Data URI，也支持公网 URL；官方要求 image 必须放在 extra_body。
 */
export function buildImagePayload(args = {}) {
  const model = clean(args.model, 'agnes-image-2.5-flash')
  const prompt = clean(args.prompt)
  if (!prompt) throw Object.assign(new Error('缺少 prompt（图片描述）'), { code: 'INVALID_ARGS' })

  const dimensions = clean(args.dimensions || args.width_height || args.exact_size)
  let size = clean(args.size, DEFAULT_IMAGE_SIZE)
  let ratio = clean(args.ratio, DEFAULT_IMAGE_RATIO)
  if (dimensions) {
    if (!/^\d{2,5}x\d{2,5}$/i.test(dimensions)) {
      throw Object.assign(new Error(`精确尺寸应形如 1024x768，收到：${dimensions}`), { code: 'INVALID_SIZE' })
    }
    const [width, height] = dimensions.toLowerCase().split('x').map(Number)
    if (width % 16 !== 0 || height % 16 !== 0) {
      throw Object.assign(new Error('Agnes 的精确尺寸宽高必须能被 16 整除；推荐直接用 1K/2K/3K/4K + ratio。'), { code: 'INVALID_SIZE' })
    }
    size = `${width}x${height}`
    ratio = ''
  }

  const references = normalizeReferences(args.references || args.reference_images)
  const responseFormat = clean(args.response_format || args.responseFormat, 'url') === 'b64_json' ? 'b64_json' : 'url'
  const body = {
    model,
    prompt,
    size,
    ...(ratio ? { ratio } : {}),
    extra_body: {
      response_format: responseFormat,
      ...(references.length ? { image: references } : {}),
    },
  }
  // 官方文档：文生图需要 Base64 输出时用 return_base64；图生图用 extra_body.response_format。
  if (responseFormat === 'b64_json' && !references.length) body.return_base64 = true
  return body
}

function inferVideoMode(args = {}, v25 = true) {
  const requested = clean(args.mode).toLowerCase()
  if (VIDEO_MODES.includes(requested)) return requested
  const refs = normalizeReferences(args.reference_images)
  const first = clean(args.first_frame)
  const last = clean(args.last_frame)
  if (first || last) return 'keyframe'
  if (refs.length >= 2) return v25 ? 'keyframe' : 'keyframes'
  if (refs.length === 1) return v25 ? 'reference' : 'image'
  return 'text'
}

export function buildVideoPayload(args = {}) {
  const model = clean(args.model, 'agnes-video-2.5-flash')
  const prompt = clean(args.prompt)
  if (!prompt) throw Object.assign(new Error('缺少 prompt（视频描述）'), { code: 'INVALID_ARGS' })

  const references = normalizeReferences(args.reference_images)
  const audios = normalizeAudios(args.reference_audios)
  const videos = normalizeVideos(args.reference_videos)
  const firstFrame = clean(args.first_frame)
  const lastFrame = clean(args.last_frame)
  const seed = Number.isFinite(Number(args.seed)) ? Math.round(Number(args.seed)) : null
  const negativePrompt = clean(args.negative_prompt)

  if (isV25VideoModel(model)) {
    const flash = isV25Flash(model)
    const mode = inferVideoMode(args, true)
    const size = clean(args.size, DEFAULT_VIDEO_SIZE_V25)
    if (flash && size !== '720P') {
      throw Object.assign(new Error('agnes-video-2.5-flash 的 size 只支持 720P。'), { code: 'INVALID_VIDEO_SIZE' })
    }
    if (!VIDEO_SIZES_V25.includes(size)) {
      throw Object.assign(new Error(`视频 size 只支持：${VIDEO_SIZES_V25.join(' / ')}。`), { code: 'INVALID_VIDEO_SIZE' })
    }
    if (!flash && size === '720P' && String(model).toLowerCase() === 'agnes-video-2.5-flash') {
      throw Object.assign(new Error('agnes-video-2.5-flash 的 size 只支持 720P。'), { code: 'INVALID_VIDEO_SIZE' })
    }
    if (flash && references.length > 5) {
      throw Object.assign(new Error('agnes-video-2.5-flash 的 reference 图片最多 5 张。'), { code: 'INVALID_REFERENCE_COUNT' })
    }
    if (!flash && references.length > 8) {
      throw Object.assign(new Error('agnes-video-2.5 的 reference 图片最多 8 张。'), { code: 'INVALID_REFERENCE_COUNT' })
    }
    if (audios.length > 3) {
      throw Object.assign(new Error('reference 音频最多 3 段。'), { code: 'INVALID_REFERENCE_COUNT' })
    }
    if (flash && videos.length) {
      throw Object.assign(new Error('agnes-video-2.5-flash 不支持 videos 参考视频。'), { code: 'INVALID_REFERENCE_VIDEO' })
    }

    const body = {
      model,
      prompt,
      mode,
      seconds: clean(args.seconds, DEFAULT_VIDEO_SECONDS),
      size,
      aspect_ratio: clean(args.aspect_ratio, DEFAULT_VIDEO_ASPECT),
      n: 1,
      ...(seed !== null ? { seed } : {}),
    }
    if (!['4', '5', '6', '7', '8', '9', '10', '11', '12'].includes(body.seconds)) {
      throw Object.assign(new Error('视频 seconds 支持字符串 "4" 到 "12"。'), { code: 'INVALID_SECONDS' })
    }

    if (mode === 'keyframe') {
      if (!firstFrame && !lastFrame) {
        throw Object.assign(new Error('keyframe 模式至少需要 first_frame 或 last_frame。'), { code: 'MISSING_KEYFRAME' })
      }
      if (firstFrame) body.first_frame = firstFrame
      if (lastFrame) body.last_frame = lastFrame
    } else if (mode === 'reference') {
      if (!references.length && !audios.length && !videos.length) {
        throw Object.assign(new Error('reference 模式至少需要图片 / 音频 / 视频参考中的一类。'), { code: 'MISSING_REFERENCE' })
      }
      if (references.length) body.images = references
      if (audios.length) body.audios = audios
      if (videos.length) body.videos = videos
    } else {
      if (firstFrame || lastFrame || references.length || audios.length || videos.length) {
        throw Object.assign(new Error('text 模式不能携带 first_frame / last_frame / images / audios / videos。'), { code: 'INVALID_VIDEO_MODE' })
      }
    }
    return body
  }

  // Agnes Video V2.0（旧版参数完全不同：width / height / num_frames / frame_rate）
  const mode = inferVideoMode(args, false)
  const width = Number(args.width) || 1152
  const height = Number(args.height) || 768
  const numFrames = Number(args.num_frames) || 121
  const frameRate = Number(args.frame_rate) || 24
  if (numFrames > 441 || numFrames < 9 || (numFrames - 1) % 8 !== 0) {
    throw Object.assign(new Error('num_frames 必须满足 8n+1 且 ≤ 441，例如 81 / 121 / 241 / 441。'), { code: 'INVALID_FRAMES' })
  }
  if (frameRate < 1 || frameRate > 60) {
    throw Object.assign(new Error('frame_rate 支持 1–60。'), { code: 'INVALID_FRAME_RATE' })
  }

  const body = {
    model,
    prompt,
    width,
    height,
    num_frames: numFrames,
    frame_rate: frameRate,
    ...(seed !== null ? { seed } : {}),
    ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    ...(Number.isFinite(Number(args.num_inference_steps)) ? { num_inference_steps: Math.max(1, Math.round(Number(args.num_inference_steps))) } : {}),
  }
  if (mode === 'keyframes' || references.length >= 2) {
    body.extra_body = { image: references, mode: 'keyframes' }
  } else if (references.length === 1) {
    body.image = references[0]
  } else if (references.length > 1) {
    body.extra_body = { image: references }
  }
  return body
}

export function buildVideoQueryUrl(baseUrl, model, videoId) {
  const origin = originFromBase(baseUrl)
  const params = new URLSearchParams({ video_id: String(videoId || '') })
  if (isV25VideoModel(model)) params.set('model_name', String(model))
  return `${origin}/agnesapi?${params.toString()}`
}

function firstUrl(...values) {
  for (const value of values) {
    const text = clean(value)
    if (/^https?:\/\//i.test(text)) return text
  }
  return ''
}

/** 把创建 / 查询视频任务的响应统一成状态对象。 */
export function normalizeVideoState(payload = {}) {
  const status = clean(payload.status || payload.state).toLowerCase()
  const progress = Number.isFinite(Number(payload.progress)) ? Math.max(0, Math.min(100, Number(payload.progress))) : null
  const url = firstUrl(payload.url, payload.video_url, payload.download_url, payload.remixed_from_video_id, payload.video?.url, payload.result?.url)
  const errorMessage = clean(payload.error?.message || payload.error?.error || (typeof payload.error === 'string' ? payload.error : ''))
  return {
    status,
    progress,
    url,
    error: errorMessage,
    videoId: clean(payload.video_id || payload.videoId),
    taskId: clean(payload.task_id || payload.id || payload.taskId),
    seconds: clean(payload.seconds),
    size: clean(payload.size),
    raw: payload,
  }
}

export function isCompletedStatus(status) {
  const value = String(status || '').toLowerCase()
  return value === 'completed' || value === 'succeeded' || value === 'success' || value === 'done'
}

export function isFailedStatus(status) {
  const value = String(status || '').toLowerCase()
  return value === 'failed' || value === 'error' || value === 'canceled' || value === 'cancelled'
}

export function isPendingStatus(status) {
  return !isCompletedStatus(status) && !isFailedStatus(status)
}

export { DEFAULT_IMAGE_SIZE, DEFAULT_VIDEO_SIZE_V25, DEFAULT_VIDEO_ASPECT, DEFAULT_VIDEO_SECONDS }
