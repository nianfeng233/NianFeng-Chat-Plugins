/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * web-access · Tavily 联网搜索 / 网页提取客户端。
 * API Key 只保存在本机后端（AES-256-GCM 加密），不会进入模型上下文。
 */
/*
 * 热更新缓存穿透：bridge.mjs 热重载时带 ?v= revision，lib 依赖链继续复用同一
 * revision，避免更新插件后仍命中旧 ESM 模块缓存导致新导出缺失、后端桥 404。
 */
const __revision = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || ''
  } catch (_) {
    return ''
  }
})()
const libUrl = file => `./${String(file).replace(/^\.\//, '')}${__revision ? `?v=${encodeURIComponent(__revision)}` : ''}`

const { requestText } = await import(libUrl('http.mjs'))
const { clampNumber, truncateText } = await import(libUrl('util.mjs'))

const SEARCH_URL = 'https://api.tavily.com/search'
const EXTRACT_URL = 'https://api.tavily.com/extract'

function errorResult(code, error, hint = '') {
  return { ok: false, code, error, ...(hint ? { hint } : {}) }
}

function mapHttpError(status, text) {
  const detail = truncateText(String(text || '').replace(/\s+/g, ' ').trim(), 300)
  if (status === 401 || status === 403) {
    return errorResult('TAVILY_AUTH', 'Tavily API Key 无效或没有权限，请在 设置 → 联网访问 中检查密钥。', detail)
  }
  if (status === 429) return errorResult('TAVILY_RATE_LIMIT', 'Tavily 请求过于频繁或额度不足，请稍后重试。', detail)
  if (status >= 500) return errorResult('TAVILY_UPSTREAM', `Tavily 服务暂时不可用（HTTP ${status}）。`, detail)
  return errorResult('TAVILY_ERROR', `Tavily 接口返回 HTTP ${status}。`, detail)
}

function normalizeResults(results, maxContent = 1500) {
  return (Array.isArray(results) ? results : []).map(item => ({
    title: String(item.title || '').slice(0, 300),
    url: String(item.url || ''),
    content: truncateText(String(item.content || item.raw_content || '').replace(/\s+/g, ' ').trim(), maxContent),
    score: Number(item.score) || 0,
  }))
}

/**
 * @param {{apiKey:string, query:string, maxResults?:number, searchDepth?:string, topic?:string,
 *   timeRange?:string, includeDomains?:string[], excludeDomains?:string[], includeAnswer?:boolean,
 *   timeoutMs?:number, proxy?:string}} options
 */
export async function tavilySearch(options = {}) {
  const apiKey = String(options.apiKey || '').trim()
  const query = String(options.query || '').trim()
  if (!apiKey) {
    return errorResult('NO_TAVILY_KEY', '尚未配置 Tavily API Key。', '请提示用户打开 设置 → 联网访问，填写 Tavily API Key；或改用 browser 工具直接访问网站。')
  }
  if (!query) return errorResult('INVALID_ARGS', '缺少搜索关键词 query。')

  const payload = {
    query,
    search_depth: ['basic', 'advanced'].includes(options.searchDepth) ? options.searchDepth : 'basic',
    max_results: clampNumber(options.maxResults, 1, 20, 8),
    include_answer: options.includeAnswer !== false,
    include_raw_content: false,
    include_images: false,
  }
  if (options.topic && ['general', 'news', 'finance'].includes(options.topic)) payload.topic = options.topic
  if (options.timeRange && ['day', 'week', 'month', 'year'].includes(options.timeRange)) payload.time_range = options.timeRange
  if (Array.isArray(options.includeDomains) && options.includeDomains.length) payload.include_domains = options.includeDomains.map(String).slice(0, 10)
  if (Array.isArray(options.excludeDomains) && options.excludeDomains.length) payload.exclude_domains = options.excludeDomains.map(String).slice(0, 10)

  let response
  try {
    response = await requestText(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      timeoutMs: clampNumber(options.timeoutMs, 3000, 120000, 20000),
      proxy: options.proxy || '',
      maxBytes: 2 * 1024 * 1024,
    })
  } catch (err) {
    return errorResult('TAVILY_REQUEST_FAILED', `Tavily 请求失败：${err?.message || err}`, '若本机需要代理，请在 设置 → 网络 里配置全局代理。')
  }
  if (response.status < 200 || response.status >= 300) return mapHttpError(response.status, response.text)

  let data = null
  try {
    data = JSON.parse(response.text)
  } catch (_) {
    return errorResult('TAVILY_BAD_RESPONSE', 'Tavily 返回了无法解析的内容。', truncateText(response.text, 200))
  }

  return {
    ok: true,
    provider: 'tavily',
    query,
    answer: truncateText(String(data.answer || ''), 4000),
    results: normalizeResults(data.results),
    response_time: Number(data.response_time) || undefined,
  }
}

/**
 * Tavily 网页提取：用于浏览器 / 直连都拿不到正文，但用户配置了 Tavily 的场景。
 * @returns {Promise<{ok:boolean, results?:object[], failed?:object[], code?:string, error?:string}>}
 */
export async function tavilyExtract(options = {}) {
  const apiKey = String(options.apiKey || '').trim()
  const urls = (Array.isArray(options.urls) ? options.urls : [options.urls]).map(String).map(item => item.trim()).filter(Boolean).slice(0, 5)
  if (!apiKey) return errorResult('NO_TAVILY_KEY', '尚未配置 Tavily API Key。')
  if (!urls.length) return errorResult('INVALID_ARGS', '缺少要提取的网页 urls。')

  let response
  try {
    response = await requestText(EXTRACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ urls, extract_depth: options.extractDepth === 'advanced' ? 'advanced' : 'basic', format: 'markdown' }),
      timeoutMs: clampNumber(options.timeoutMs, 3000, 120000, 30000),
      proxy: options.proxy || '',
      maxBytes: 3 * 1024 * 1024,
    })
  } catch (err) {
    return errorResult('TAVILY_REQUEST_FAILED', `Tavily 提取请求失败：${err?.message || err}`)
  }
  if (response.status < 200 || response.status >= 300) return mapHttpError(response.status, response.text)
  let data = null
  try {
    data = JSON.parse(response.text)
  } catch (_) {
    return errorResult('TAVILY_BAD_RESPONSE', 'Tavily 提取接口返回了无法解析的内容。')
  }
  const limit = clampNumber(options.maxChars, 2000, 60000, 12000)
  return {
    ok: true,
    provider: 'tavily',
    results: (Array.isArray(data.results) ? data.results : []).map(item => ({
      url: String(item.url || ''),
      raw_content: truncateText(String(item.raw_content || ''), limit),
      truncated: String(item.raw_content || '').length > limit,
    })),
    failed: (Array.isArray(data.failed_results) ? data.failed_results : []).map(item => ({
      url: String(item.url || ''),
      error: String(item.error || ''),
    })),
  }
}
