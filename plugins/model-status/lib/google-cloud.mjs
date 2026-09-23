/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * Google Cloud Service Health（status.cloud.google.com/incidents.json）解析。
 *
 * Google Cloud 的状态接口返回全部产品事件；Gemini / Generative Language 只是其中
 * 若干产品，因此这里用 source.keywords（默认 ["gemini"]）做初筛，用户也可以在
 * 渠道订阅里选择具体产品，或修改关键词。
 */

const __revision = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || ''
  } catch (_) {
    return ''
  }
})()
const libUrl = file => `./${String(file).replace(/^\.\//, '')}${__revision ? `?v=${encodeURIComponent(__revision)}` : ''}`
const { normalizeWhitespace, truncateText, uniqueBy, uniqueList } = await import(libUrl('util.mjs'))

export const GOOGLE_IMPACT_LABELS = {
  SERVICE_OUTAGE: '服务中断',
  SERVICE_DISRUPTION: '服务受阻',
  SERVICE_INFORMATION: '信息公告',
  SERVICE_MAINTENANCE: '计划维护',
  SERVICE_AVAILABLE: '服务正常',
}

export const GOOGLE_IMPACT_EMOJI = {
  SERVICE_OUTAGE: '🔴',
  SERVICE_DISRUPTION: '🟠',
  SERVICE_INFORMATION: '🔵',
  SERVICE_MAINTENANCE: '🔧',
  SERVICE_AVAILABLE: '🟢',
}

export function googleImpactLabel(status) {
  return GOOGLE_IMPACT_LABELS[String(status || '')] || String(status || '未知')
}

export function googleImpactEmoji(status) {
  return GOOGLE_IMPACT_EMOJI[String(status || '')] || '⚪'
}

export function isGoogleCloudIncidents(data) {
  if (!Array.isArray(data)) return false
  return data.some(item => item && (Array.isArray(item.affected_products) || item.status_impact))
}

function parseDate(value) {
  if (!value) return 0
  const at = Date.parse(String(value))
  return Number.isFinite(at) ? at : 0
}

function productKey(product) {
  return String(product?.id || product?.title || '').trim()
}

function productMatches(product, keywords) {
  if (!keywords.length) return true
  const haystack = `${product?.title || product?.name || ''} ${product?.id || ''}`.toLowerCase()
  return keywords.some(keyword => haystack.includes(String(keyword).toLowerCase()))
}

function firstProduct(products, keywords) {
  const matched = products.filter(product => productMatches(product, keywords))
  return matched.length ? matched : products
}

function normalizeProduct(product) {
  return {
    id: String(product?.id || product?.title || '').trim(),
    name: normalizeWhitespace(product?.title || product?.id || ''),
  }
}

function normalizeIncident(raw, keywords) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!id) return null
  const updates = (Array.isArray(raw.updates) ? raw.updates : [])
    .map(update => ({
      createdAt: parseDate(update?.created),
      status: String(update?.status || ''),
      body: normalizeWhitespace(update?.text || ''),
    }))
    .filter(update => update.createdAt || update.body)
    .sort((a, b) => a.createdAt - b.createdAt)
  const latest = updates[updates.length - 1] || null
  const end = parseDate(raw.end)
  const begin = parseDate(raw.begin)
  const impact = String(raw.status_impact || latest?.status || '')
  const products = uniqueBy(
    (Array.isArray(raw.affected_products) ? raw.affected_products : []).map(normalizeProduct).filter(item => item.id || item.name),
    item => item.id || item.name,
  )
  const matched = firstProduct(products, keywords)
  const components = matched
    .map(item => ({ id: item.id || item.name, name: item.name || item.id, status: impact }))
    .filter(item => item.id || item.name)
  const productNames = uniqueList(components.map(item => item.name)).slice(0, 4)
  const title = productNames.length ? productNames.join('、') : normalizeWhitespace(raw.affected_products?.[0]?.title || raw.service_name || 'Google Cloud 事件')
  const body = truncateText(String(latest?.body || raw.external_desc || '').trim(), 1200)
  return {
    id,
    title: title || 'Google Cloud 事件',
    body,
    status: impact,
    statusLabel: googleImpactLabel(impact),
    statusEmoji: googleImpactEmoji(impact),
    createdAt: begin || updates[0]?.createdAt || 0,
    updatedAt: latest?.createdAt || parseDate(raw.modified) || begin || 0,
    resolvedAt: end,
    components,
    updates,
    url: `https://status.cloud.google.com/incidents/${encodeURIComponent(id)}`,
    raw: {
      serviceName: normalizeWhitespace(raw.service_name || ''),
      externalDesc: normalizeWhitespace(raw.external_desc || ''),
    },
  }
}

export function parseGoogleCloudIncidents(data, source = {}) {
  if (!isGoogleCloudIncidents(data)) throw new Error('不是合法的 Google Cloud incidents.json')
  const keywords = uniqueList(Array.isArray(source.keywords) ? source.keywords : [])
  const incidents = data.map(item => normalizeIncident(item, keywords)).filter(Boolean)
  // 默认只保留与 source.keywords 命中的事件（比如 Gemini）；如果关键词为空则保留全部。
  const filtered = keywords.length
    ? incidents.filter(incident => {
        const haystack = [
          incident.title,
          incident.body,
          incident.raw.serviceName,
          incident.raw.externalDesc,
          ...incident.components.flatMap(item => [item.id, item.name]),
        ]
          .join(' ')
          .toLowerCase()
        return keywords.some(keyword => haystack.includes(String(keyword).toLowerCase()))
      })
    : incidents
  return {
    adapter: 'google-cloud',
    sourceId: source.id || '',
    sourceName: source.name || '',
    page: {
      name: source.name || 'Google Cloud',
      url: source.homepage || 'https://status.cloud.google.com',
    },
    incidents: filtered.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)),
    allProducts: uniqueBy(
      data
        .flatMap(item => (Array.isArray(item?.affected_products) ? item.affected_products : []))
        .map(normalizeProduct)
        .filter(item => item.id || item.name),
      item => item.id || item.name,
    ),
    fetchedAt: Date.now(),
  }
}

/** 给设置页的「组件 / 产品筛选」用：只列出与当前来源关键词相关的产品。 */
export function googleCloudProducts(parsed, source = {}) {
  const keywords = uniqueList(Array.isArray(source.keywords) ? source.keywords : [])
  const all = Array.isArray(parsed?.allProducts) ? parsed.allProducts : []
  if (!keywords.length) return all.slice(0, 200)
  return all.filter(item => productMatches(item, keywords)).slice(0, 200)
}
