/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 模型状态订阅 · 内置站点目录 + 自定义站点。
 *
 * 目录里的 URL 都是各厂商公开服务状态页 / 状态 JSON / RSS 地址。绝大多数厂商使用
 * Atlassian Statuspage（有 /api/v2/summary.json 与 RSS），少部分（Google Cloud）
 * 提供 incidents.json。适配器默认 auto：先按已知格式探测，失败后再尝试
 * Statuspage API 与 RSS，因此某个站点换实现时不用改插件。
 */

export const ADAPTERS = ['auto', 'statuspage', 'rss', 'google-cloud']

export const ADAPTER_LABELS = {
  auto: '自动识别',
  statuspage: 'Statuspage API',
  rss: 'RSS / Atom',
  'google-cloud': 'Google Cloud 状态',
}

export const CATEGORY_LABELS = {
  llm: '大模型',
  coding: '编程助手',
  image: '图像 / 视频',
  audio: '语音 / 音频',
  infra: 'AI 基础设施',
  custom: '自定义',
}

export const CONFIDENCE_LABELS = {
  official: '官方页面',
  community: '未完全验证',
}

const source = (id, name, options = {}) => ({
  id,
  name,
  vendor: options.vendor || name,
  emoji: options.emoji || '📡',
  color: options.color || '#64748b',
  category: options.category || 'llm',
  adapter: options.adapter || 'auto',
  url: options.url,
  homepage: options.homepage || options.url,
  description: options.description || '',
  keywords: Array.isArray(options.keywords) ? options.keywords.map(String).filter(Boolean) : [],
  confidence: options.confidence || 'official',
})

export const BUILTIN_SOURCES = [
  source('deepseek', 'DeepSeek', {
    vendor: 'DeepSeek',
    emoji: '🐋',
    color: '#4d6bfe',
    adapter: 'rss',
    url: 'https://status.deepseek.com/history.rss',
    homepage: 'https://status.deepseek.com',
    description: 'DeepSeek API / 网页版服务状态（官方 RSS 动态）',
  }),
  source('anthropic', 'Claude（Anthropic）', {
    vendor: 'Anthropic',
    emoji: '🧠',
    color: '#d97757',
    url: 'https://status.anthropic.com',
    description: 'Claude API / Claude.ai 服务状态',
  }),
  source('openai', 'GPT（OpenAI）', {
    vendor: 'OpenAI',
    emoji: '🤖',
    color: '#10a37f',
    url: 'https://status.openai.com',
    description: 'OpenAI API / ChatGPT / Sora 服务状态',
  }),
  source('xai', 'Grok（xAI）', {
    vendor: 'xAI',
    emoji: '🚀',
    color: '#111827',
    adapter: 'rss',
    url: 'https://status.x.ai/feed.xml',
    homepage: 'https://status.x.ai',
    description: 'Grok / xAI API 服务状态（官方 RSS 动态）',
  }),
  source('gemini', 'Gemini（Google）', {
    vendor: 'Google',
    emoji: '✨',
    color: '#4285f4',
    url: 'https://status.cloud.google.com/incidents.json',
    homepage: 'https://status.cloud.google.com',
    description: 'Google Cloud 状态中的 Gemini / Generative Language 产品事件',
    // Google Cloud 的 incidents.json 包含全部产品，默认只筛 Gemini 相关产品；
    // 用户可以在渠道订阅里改关键词，或选择具体产品。
    keywords: ['gemini'],
  }),
  source('mistral', 'Mistral AI', {
    emoji: '🌬️',
    color: '#ff7000',
    url: 'https://status.mistral.ai',
    description: 'Mistral 模型 / API 服务状态',
  }),
  source('perplexity', 'Perplexity', {
    emoji: '🔎',
    color: '#20808d',
    adapter: 'rss',
    url: 'https://status.perplexity.com/feed.rss',
    homepage: 'https://status.perplexity.ai',
    description: 'Perplexity 搜索 / 模型服务状态（官方 RSS 动态）',
    confidence: 'official',
  }),
  source('groq', 'Groq', {
    emoji: '⚡',
    color: '#f55036',
    adapter: 'rss',
    url: 'https://groqstatus.com/feed.rss',
    homepage: 'https://status.groq.com',
    description: 'Groq Cloud / LPU 推理服务状态（官方 RSS 动态）',
    confidence: 'official',
  }),
  source('together', 'Together AI', {
    emoji: '🧩',
    color: '#0f6fff',
    adapter: 'rss',
    url: 'https://status.together.ai/feed',
    homepage: 'https://status.together.ai',
    description: 'Together AI 推理 / 微调服务状态（官方 RSS 动态）',
    confidence: 'official',
  }),
  source('fireworks', 'Fireworks AI', {
    emoji: '🎆',
    color: '#6d28d9',
    url: 'https://status.fireworks.ai',
    description: 'Fireworks AI 推理服务状态',
    confidence: 'community',
  }),
  source('cohere', 'Cohere', {
    emoji: '🧱',
    color: '#39594d',
    url: 'https://status.cohere.com',
    description: 'Cohere API / 模型服务状态',
    confidence: 'community',
  }),
  source('huggingface', 'Hugging Face', {
    emoji: '🤗',
    color: '#ffd21e',
    url: 'https://status.huggingface.co',
    description: 'Hugging Face Hub / Inference 服务状态（自动识别官方 RSS）',
    confidence: 'official',
  }),
  source('openrouter', 'OpenRouter', {
    emoji: '🔀',
    color: '#8b5cf6',
    url: 'https://status.openrouter.ai',
    description: 'OpenRouter 聚合模型服务状态',
    confidence: 'community',
  }),
  source('llama', 'Llama API（Meta）', {
    vendor: 'Meta',
    emoji: '🦙',
    color: '#0866ff',
    url: 'https://status.llama.com',
    description: 'Meta Llama API 服务状态',
    confidence: 'community',
  }),
  source('moonshot', 'Kimi（Moonshot）', {
    vendor: 'Moonshot AI',
    emoji: '🌙',
    color: '#111827',
    url: 'https://status.moonshot.cn',
    description: 'Kimi / Moonshot API 服务状态',
    confidence: 'official',
  }),
  source('minimax', 'MiniMax', {
    emoji: '🔺',
    color: '#ef4444',
    url: 'https://status.minimax.io',
    description: 'MiniMax 模型 / API 服务状态',
    confidence: 'official',
  }),
  source('zai', 'Z.ai / 智谱', {
    vendor: 'Z.ai',
    emoji: '🧿',
    color: '#2563eb',
    url: 'https://status.z.ai',
    description: 'Z.ai / GLM 服务状态；地址未在全部网络环境验证',
    confidence: 'community',
  }),
  source('siliconflow', '硅基流动 SiliconFlow', {
    vendor: 'SiliconFlow',
    emoji: '🌊',
    color: '#7c3aed',
    url: 'https://status.siliconflow.cn',
    description: '硅基流动模型 API 服务状态；地址未在全部网络环境验证',
    confidence: 'community',
  }),
  source('cursor', 'Cursor', {
    emoji: '🖱️',
    color: '#0f172a',
    category: 'coding',
    url: 'https://status.cursor.com',
    description: 'Cursor 编辑器 / 模型服务状态',
    confidence: 'community',
  }),
  source('stability', 'Stability AI', {
    emoji: '🎨',
    color: '#8b5cf6',
    category: 'image',
    url: 'https://status.stability.ai',
    description: 'Stable Diffusion / Stability API 服务状态',
    confidence: 'community',
  }),
  source('fal', 'Fal.ai', {
    emoji: '🖌️',
    color: '#ec4899',
    category: 'image',
    adapter: 'rss',
    url: 'https://status.fal.ai/history.rss',
    homepage: 'https://status.fal.ai',
    description: 'Fal.ai 图像 / 视频模型推理状态（官方 RSS 动态）',
    confidence: 'official',
  }),
  source('runway', 'Runway', {
    emoji: '🎬',
    color: '#111827',
    category: 'image',
    url: 'https://status.runwayml.com',
    description: 'Runway 视频生成服务状态',
    confidence: 'official',
  }),
  source('elevenlabs', 'ElevenLabs', {
    emoji: '🔊',
    color: '#111827',
    category: 'audio',
    url: 'https://status.elevenlabs.io',
    description: 'ElevenLabs 语音合成 / 克隆服务状态',
    confidence: 'community',
  }),
  source('deepgram', 'Deepgram', {
    emoji: '🎙️',
    color: '#13ef93',
    category: 'audio',
    url: 'https://status.deepgram.com',
    description: 'Deepgram 语音识别服务状态',
    confidence: 'community',
  }),
  source('assemblyai', 'AssemblyAI', {
    emoji: '📝',
    color: '#2545d3',
    category: 'audio',
    url: 'https://status.assemblyai.com',
    description: 'AssemblyAI 语音识别服务状态',
    confidence: 'community',
  }),
  source('pinecone', 'Pinecone', {
    emoji: '🌲',
    color: '#16a34a',
    category: 'infra',
    url: 'https://status.pinecone.io',
    description: 'Pinecone 向量数据库服务状态',
    confidence: 'community',
  }),
  source('modal', 'Modal', {
    emoji: '☁️',
    color: '#22c55e',
    category: 'infra',
    url: 'https://status.modal.com',
    description: 'Modal 无服务器 GPU / 推理平台状态（自动识别官方 RSS）',
    confidence: 'official',
  }),
]

const SOURCE_MAP = new Map(BUILTIN_SOURCES.map(item => [item.id, item]))

export function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch (_) {
    return false
  }
}

export function normalizeSourceUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return isValidHttpUrl(withProtocol) ? withProtocol : ''
}

export function listBuiltinSources() {
  return BUILTIN_SOURCES.map(item => ({ ...item, builtin: true }))
}

export function findBuiltinSource(id) {
  return SOURCE_MAP.get(String(id || '')) || null
}

/** 合并内置目录与用户自定义来源；同 id 时自定义优先（用于覆盖内置地址）。 */
export function listAllSources(customSources = {}) {
  const map = new Map()
  for (const item of BUILTIN_SOURCES) map.set(item.id, { ...item, builtin: true })
  for (const item of Object.values(customSources || {})) {
    if (!item?.id) continue
    map.set(item.id, { ...item, builtin: false })
  }
  return [...map.values()]
}

export function findSourceById(id, customSources = {}) {
  const key = String(id || '')
  if (!key) return null
  const custom = customSources?.[key]
  if (custom?.id) return { ...custom, builtin: false }
  return findBuiltinSource(key)
}

/** 生成自定义来源对象；existingIds 用于避免 id 冲突。 */
export function buildCustomSource(input = {}, existingIds = []) {
  const name = String(input.name || '').trim().slice(0, 80)
  const url = normalizeSourceUrl(input.url)
  if (!name) throw Object.assign(new Error('请填写来源名称'), { status: 400 })
  if (!url) throw Object.assign(new Error('请填写合法的 http(s) 状态页地址'), { status: 400 })
  const adapter = ADAPTERS.includes(input.adapter) ? input.adapter : 'auto'
  const emoji = String(input.emoji || '📡').trim().slice(0, 8) || '📡'
  const keywords = Array.isArray(input.keywords) ? input.keywords.map(String).map(item => item.trim()).filter(Boolean).slice(0, 20) : []
  const idBase = `custom-${String(input.id || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'source'}`
  const taken = new Set([...SOURCE_MAP.keys(), ...existingIds.map(String)])
  let id = idBase
  let index = 2
  while (taken.has(id)) {
    id = `${idBase}-${index}`
    index += 1
  }
  return {
    id,
    name,
    vendor: String(input.vendor || name).trim().slice(0, 80),
    emoji,
    color: /^#[0-9a-f]{3,8}$/i.test(String(input.color || '')) ? input.color : '#64748b',
    category: CATEGORY_LABELS[input.category] ? input.category : 'custom',
    adapter,
    url,
    homepage: url,
    description: String(input.description || '自定义状态来源').trim().slice(0, 200),
    keywords,
    confidence: 'community',
    custom: true,
    createdAt: Date.now(),
  }
}

/**
 * auto 适配器的候选地址：
 *   1. 用户已经验证成功的 endpoint（来自快照）；
 *   2. URL 自身（可能是 .json / .rss）；
 *   3. 常见的 Statuspage summary.json / history.rss 派生地址。
 */
export function sourceUrlCandidates(source, previous = null) {
  const out = []
  const push = value => {
    const url = String(value || '').trim()
    if (url && !out.includes(url)) out.push(url)
  }
  if (previous?.endpoint) push(previous.endpoint)
  const raw = String(source?.url || '').trim()
  if (!raw) return out
  const looksLikeFile = /\.(json|rss|atom|xml)(\?|#|$)/i.test(raw)
  if (looksLikeFile) {
    push(raw)
    return out
  }
  const base = raw.replace(/\/+$/, '')
  // Statuspage 站点：优先 API；自定义 / 下一代状态页常见 RSS 路径依次兜底。
  push(`${base}/api/v2/summary.json`)
  push(`${base}/history.rss`)
  push(`${base}/feed`)
  push(`${base}/feed.rss`)
  push(`${base}/feed.xml`)
  push(raw)
  return out
}

export function adapterLabel(adapter) {
  return ADAPTER_LABELS[adapter] || adapter || '未知'
}

export function categoryLabel(category) {
  return CATEGORY_LABELS[category] || category || '自定义'
}
