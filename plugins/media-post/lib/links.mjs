/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · 链接解析（零依赖纯函数，方便单测）
 *
 * 模型经常把「多条链接 + 说明文字」塞进同一个参数，或者一次想发好几条：
 * 这里负责从任意文本里抽出受支持的 B站 / 抖音链接，去重并保持顺序，
 * 顺便把裸 BV 号 / av 号补成完整链接（模型有时只给号码）。
 *
 * 安全边界不变：只认白名单平台，别的 URL 一律忽略（不下载任意直链）。
 */

const SUPPORTED_HOSTS = ['b23.tv', 'bilibili.com', 'douyin.com', 'iesdouyin.com']

// 链接里常见的中文标点 / 引号 / 括号都不会出现在 URL 里，直接当分隔符。
const URL_PATTERN = /https?:\/\/[^\s"'<>`，。、；：！？【】（）()[\]{}]+/gi
const BV_PATTERN = /(BV[0-9A-Za-z]{10})/g
const AV_PATTERN = /(?:^|[^\dA-Za-z])(av\d{4,12})(?![\dA-Za-z])/gi

const TAIL_NOISE = /[.,;:!?，。；：！？"'’”」』）)】》>\]]+$/

function trimTail(url) {
  return String(url || '').replace(TAIL_NOISE, '')
}

export function isSupportedMediaUrl(raw) {
  try {
    const host = new URL(String(raw)).hostname.toLowerCase()
    return SUPPORTED_HOSTS.some(item => host === item || host.endsWith(`.${item}`))
  } catch (_) {
    return false
  }
}

/**
 * 从一段文本里抽取受支持的媒体链接（去重、保持出现顺序）。
 * @param {string} text
 * @param {{limit?:number}} [options] limit=0 表示不限制
 * @returns {string[]}
 */
export function extractMediaLinks(text, { limit = 0 } = {}) {
  const source = String(text || '')
  const out = []
  const push = url => {
    const clean = trimTail(url)
    if (!clean || !isSupportedMediaUrl(clean)) return
    if (out.includes(clean)) return
    out.push(clean)
  }

  for (const match of source.matchAll(URL_PATTERN)) push(match[0])

  // 已经有完整链接的 BV 号不再重复补（例如 https://www.bilibili.com/video/BVxxx）。
  const seenBv = new Set(
    out.map(url => (/(BV[0-9A-Za-z]{10})/.exec(url) || [])[1]).filter(Boolean).map(item => item.toLowerCase()),
  )
  for (const match of source.matchAll(BV_PATTERN)) {
    if (seenBv.has(match[1].toLowerCase())) continue
    push(`https://www.bilibili.com/video/${match[1]}`)
    seenBv.add(match[1].toLowerCase())
  }
  for (const match of source.matchAll(AV_PATTERN)) push(`https://www.bilibili.com/video/${match[1]}`)

  const max = Number(limit) > 0 ? Number(limit) : 0
  return max ? out.slice(0, max) : out
}

/**
 * 把模型的 url / urls 参数统一成链接数组：
 *   - string：允许里面塞多条链接或说明文字；
 *   - array：允许数组元素本身也是「一条链接或多条链接的文本」。
 * @param {string|string[]|undefined|null} value
 * @param {{limit?:number}} [options]
 * @returns {string[]}
 */
export function normalizeLinkList(value, { limit = 0 } = {}) {
  const out = []
  const push = url => {
    if (!url || out.includes(url)) return
    out.push(url)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined || item === null) continue
      for (const url of extractMediaLinks(item)) push(url)
    }
  } else if (value !== undefined && value !== null) {
    for (const url of extractMediaLinks(value)) push(url)
  }
  const max = Number(limit) > 0 ? Number(limit) : 0
  return max ? out.slice(0, max) : out
}
