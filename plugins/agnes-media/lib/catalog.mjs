/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * agnes-media · 模型目录与免费状态。
 *
 * 免费 / 付费状态来自 Agnes AI 官方文档与官方定价页（2026-09-24 核对）：
 *   - 国际站文档：https://www.agnes-ai.com/zh-Hans/docs/pricing
 *   - 国内站域名：https://www.agnes-ai.cn
 *
 * 说明：官方可能调整优惠活动，这里只作为“给用户看”的参考标注；
 * 真正的扣费永远以 Agnes 账户账单为准。未知模型会明确标注“免费情况未知”。
 */

export const CATALOG_VERIFIED_AT = '2026-09-24'
export const CATALOG_SOURCE = 'Agnes AI 官方定价页 / API 文档（2026-09-24 核对）'

/**
 * kind：image / video / text / other
 * free：true 免费、false 付费、null 未知
 * api：video 专用，v2 = Agnes Video V2.0，v25 = Agnes Video 2.5 系列
 */
export const KNOWN_MODELS = {
  'agnes-3.0-flash': {
    kind: 'text',
    free: true,
    label: '文本 Agent',
    price: '输入缓存 $0.005/M、输入 $0.05/M、输出 $0.15/M；现价全部 $0',
    note: '512K 上下文 / 65,536 输出，面向 Agent 与工具调用，当前免费。',
  },
  'agnes-2.5-flash': {
    kind: 'text',
    free: true,
    label: '文本',
    price: '输入 $0.03/M、输出 $0.15/M；现价全部 $0',
    note: '512K 上下文，日常对话与工具调用均可，当前免费。',
  },
  'agnes-2.0-flash': {
    kind: 'text',
    free: true,
    legacy: true,
    label: '文本（旧版）',
    price: '输入 $0.03/M、输出 $0.15/M；现价全部 $0',
    note: '旧版文本模型，官方建议迁移到 agnes-2.5-flash。',
  },
  'agnes-2.5-pro': {
    kind: 'text',
    free: false,
    label: '文本推理 Pro',
    price: '输入 $0.45/M、输出 $0.90/M、缓存命中 $0.045/M',
    note: '付费推理模型，需要账户开通权限。',
  },
  'agnes-2.5-pro-beta': {
    kind: 'text',
    free: false,
    label: '文本推理 Beta',
    price: '输入 $0.10/M、输出 $0.30/M、缓存命中 $0.01/M',
    note: '付费 Beta 推理模型。',
  },
  'agnes-2.5-pro-alpha': {
    kind: 'text',
    free: false,
    label: '文本推理 Alpha',
    price: '输入 $0.45/M、输出 $0.90/M、缓存命中 $0.045/M',
    note: '已转为付费模型，权重 Apache 2.0 开源。',
  },
  'agnes-image-2.5-flash': {
    kind: 'image',
    free: true,
    recommended: true,
    label: '图像（最新）',
    price: '1K/2K/3K/4K 现价 $0/张，输入参考图现价 $0',
    note: '最新一代图像模型，能力和提示词遵循最好；参数与 2.1 Flash 完全兼容。',
  },
  'agnes-image-2.1-flash': {
    kind: 'image',
    free: true,
    label: '图像',
    price: '1K/2K/3K/4K 现价 $0/张，输入参考图现价 $0',
    note: '上一代图像模型，当前免费。',
  },
  'agnes-image-2.0-flash': {
    kind: 'image',
    free: true,
    legacy: true,
    label: '图像（旧版）',
    price: '1K/2K/3K/4K 现价 $0/张，输入参考图现价 $0',
    note: '旧版图像模型，建议优先使用 2.5 Flash。',
  },
  'agnes-video-2.5-flash': {
    kind: 'video',
    free: true,
    recommended: true,
    api: 'v25',
    label: '视频（限时免费）',
    price: '原价 $0.025/秒，现价 $0/秒（限时免费）',
    note: '支持 text / keyframe / reference；size 固定 720P，reference 图片最多 5 张、音频最多 3 段。',
  },
  'agnes-video-v2.0': {
    kind: 'video',
    free: true,
    legacy: true,
    api: 'v2',
    label: '视频 V2.0',
    price: '$0.005/秒；现价 $0/秒',
    note: '旧版异步视频 API：num_frames 必须 8n+1 且 ≤441，frame_rate 1–60。',
  },
  'agnes-video-2.5': {
    kind: 'video',
    free: false,
    api: 'v25',
    label: '视频 2.5 高清',
    price: '720P $0.025/秒；1080P / 1K $0.040/秒；2K $0.055/秒',
    note: '付费高清视频模型，支持首尾帧、图片/音频/视频参考与音画协同。',
  },
}

export const IMAGE_FALLBACK_MODELS = Object.keys(KNOWN_MODELS).filter(id => KNOWN_MODELS[id].kind === 'image')
export const VIDEO_FALLBACK_MODELS = Object.keys(KNOWN_MODELS).filter(id => KNOWN_MODELS[id].kind === 'video')

const IMAGE_HINT = /(^|[-_.])(image|imagegen|image-generation|draw|dalle|flux|sd|seedream|midjourney|mj)([-_.]|$)/i
const VIDEO_HINT = /(^|[-_.])(video|movie|motion|veo|kling|sora|wan|seedance|pika|runway)([-_.]|$)/i
const TEXT_HINT = /(^|[-_.])(chat|text|llm|reason|thinking|pro|flash|turbo|instruct|max|mini|air|nano)([-_.]|$)/i

export function normalizeModelId(value) {
  return String(value || '').trim()
}

/**
 * 尽量把 Agnes /models 返回的模型 ID 分类。
 * 只有明确命中图像 / 视频特征时才归到对应类型；否则归到 other，
 * 由前端在“分类不确定”时把 other 同时展示到图片和视频下拉框里。
 */
export function classifyModel(id) {
  const model = normalizeModelId(id)
  if (!model) return 'other'
  if (KNOWN_MODELS[model]) return KNOWN_MODELS[model].kind
  if (IMAGE_HINT.test(model)) return 'image'
  if (VIDEO_HINT.test(model)) return 'video'
  if (TEXT_HINT.test(model)) return 'text'
  return 'other'
}

/** 给一个模型 ID 附加免费状态、价格说明和分类，未知模型明确返回 free:null。 */
export function annotateModel(id, extra = {}) {
  const model = normalizeModelId(id)
  const known = KNOWN_MODELS[model] || null
  const kind = known?.kind || classifyModel(model)
  const free = known ? known.free === true : null
  return {
    id: model,
    kind,
    category: kind === 'other' ? 'unknown' : kind,
    known: !!known,
    free,
    freeLabel: free === true ? '免费' : free === false ? '付费' : '免费情况未知',
    price: known?.price || '',
    note: known?.note || '',
    label: known?.label || '',
    recommended: known?.recommended === true,
    legacy: known?.legacy === true,
    api: known?.api || '',
    ...extra,
  }
}

/** 把模型列表按用途分类，并保留原始未识别项。 */
export function classifyModelList(ids = []) {
  const seen = new Set()
  const list = []
  for (const raw of ids) {
    const id = normalizeModelId(typeof raw === 'string' ? raw : raw?.id || raw?.name)
    if (!id || seen.has(id)) continue
    seen.add(id)
    list.push(annotateModel(id))
  }
  const byKind = kind => list.filter(item => item.kind === kind)
  const text = byKind('text')
  const image = byKind('image')
  const video = byKind('video')
  const other = byKind('other')
  return {
    all: list,
    text,
    image,
    video,
    other,
    // 分类不出来的模型同时放进图片 / 视频候选，避免“型号都在但用户选不到”。
    imageOptions: [...image, ...other],
    videoOptions: [...video, ...other],
    ambiguous: other.length > 0,
  }
}

export function modelLabel(id, { withFree = true } = {}) {
  const item = annotateModel(id)
  const prefix = item.label ? `${item.label} · ` : ''
  const free = withFree ? `（${item.freeLabel}）` : ''
  return `${prefix}${item.id}${free}`
}

export function catalogPayload() {
  return {
    verifiedAt: CATALOG_VERIFIED_AT,
    source: CATALOG_SOURCE,
    models: Object.keys(KNOWN_MODELS).map(id => annotateModel(id)),
    imageFallback: IMAGE_FALLBACK_MODELS.map(id => annotateModel(id)),
    videoFallback: VIDEO_FALLBACK_MODELS.map(id => annotateModel(id)),
  }
}
