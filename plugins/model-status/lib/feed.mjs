/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * RSS 2.0 / Atom 订阅源解析（零依赖）。
 *
 * Statuspage 站点通常同时提供 /history.rss；如果某个厂商只提供 RSS，
 * auto 适配器会回退到这里。解析只取标题 / 链接 / 时间 / 正文摘要 / guid。
 */

const __revision = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || ''
  } catch (_) {
    return ''
  }
})()
const libUrl = file => `./${String(file).replace(/^\.\//, '')}${__revision ? `?v=${encodeURIComponent(__revision)}` : ''}`
const { decodeHtmlEntities, normalizeWhitespace, stripHtml, truncateText } = await import(libUrl('util.mjs'))

export function looksLikeFeed(text) {
  const raw = String(text || '').slice(0, 2000)
  return /<rss\b/i.test(raw) || /<feed\b/i.test(raw) || /<rdf:RDF\b/i.test(raw)
}

function cdata(value) {
  const text = String(value ?? '')
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text)
  return match ? match[1] : text
}

function tagPattern(tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<(?:[a-zA-Z0-9_.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_.-]+:)?${escaped}>`, 'i')
}

function firstTag(block, tags) {
  for (const tag of tags) {
    const match = tagPattern(tag).exec(String(block || ''))
    if (match) return match[1]
  }
  return ''
}

function firstAttribute(block, tag, attribute) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const attr = String(attribute).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`<(?:[a-zA-Z0-9_.-]+:)?${escaped}\\b[^>]*\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = regex.exec(String(block || ''))
  if (!match) return ''
  return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '')
}

function tagText(block, tags, { html = true } = {}) {
  const raw = cdata(firstTag(block, tags))
  if (!raw) return ''
  if (!html) return normalizeWhitespace(decodeHtmlEntities(raw))
  return normalizeWhitespace(stripHtml(raw))
}

function parseDate(value) {
  const text = String(value || '').trim()
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : 0
}

function entryLink(block, atom) {
  if (atom) {
    const links = [...String(block || '').matchAll(/<link\b[^>]*>/gi)].map(match => match[0])
    let fallback = ''
    for (const link of links) {
      const href = firstAttribute(link, 'link', 'href')
      if (!href) continue
      const rel = firstAttribute(link, 'link', 'rel').toLowerCase()
      if (!fallback) fallback = href
      if (!rel || rel === 'alternate') return href
    }
    if (fallback) return fallback
  }
  return tagText(block, ['link'], { html: false }) || firstAttribute(block, 'link', 'href')
}

function feedItem(block, atom, index) {
  const title = tagText(block, ['title']) || '(无标题更新)'
  const link = entryLink(block, atom)
  const guid = tagText(block, ['guid', 'id'], { html: false }) || link || `${title}#${index}`
  const publishedAt = parseDate(tagText(block, ['pubDate', 'published', 'updated', 'dc:date', 'date'], { html: false }))
  const bodyRaw = firstTag(block, ['content:encoded', 'content', 'description', 'summary', 'subtitle'])
  const body = normalizeWhitespace(stripHtml(cdata(bodyRaw)))
  const categories = [...String(block || '').matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)]
    .map(match => normalizeWhitespace(stripHtml(cdata(match[1]))))
    .filter(Boolean)
  return {
    id: String(guid).trim(),
    title: truncateText(title, 200),
    url: String(link || '').trim(),
    publishedAt: publishedAt || Date.now(),
    body: truncateText(body, 1200),
    categories: [...new Set(categories)].slice(0, 8),
  }
}

export function parseFeed(text, source = {}) {
  const xml = String(text || '').replace(/^\uFEFF/, '')
  if (!looksLikeFeed(xml)) throw new Error('不是合法的 RSS / Atom 订阅源')
  const atom = /<feed\b/i.test(xml)
  const rootName = atom ? 'feed' : 'channel'
  const rootPattern = tagPattern(rootName)
  const rootMatch = rootPattern.exec(xml)
  const root = rootMatch ? rootMatch[1] : xml
  const pageTitle = tagText(root, ['title']) || source.name || ''
  const pageUrl = entryLink(root, atom) || source.homepage || source.url || ''

  const blocks = []
  const patterns = atom ? [tagPattern('entry')] : [tagPattern('item')]
  for (const pattern of patterns) {
    for (const match of xml.matchAll(new RegExp(pattern.source, 'gi'))) blocks.push(match[1])
  }
  const items = blocks.map((block, index) => feedItem(block, atom, index)).filter(item => item.id || item.title)

  return {
    adapter: 'rss',
    sourceId: source.id || '',
    sourceName: source.name || '',
    feedType: atom ? 'atom' : 'rss',
    page: { name: pageTitle, url: pageUrl },
    items,
    fetchedAt: Date.now(),
  }
}

export function feedItemText(item, max = 500) {
  const parts = [item?.title]
  if (item?.body && item.body !== item.title) parts.push(item.body)
  return truncateText(parts.filter(Boolean).join('\n'), max)
}
