/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * Statuspage（Atlassian Statuspage v2 API）解析。
 *
 * 适用站点：https://status.deepseek.com、status.openai.com、status.anthropic.com、
 * status.x.ai 等绝大多数模型厂商状态页。
 *   GET <base>/api/v2/summary.json
 * 返回 page / status / components / incidents / scheduled_maintenances。
 */

const __revision = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || ''
  } catch (_) {
    return ''
  }
})()
const libUrl = file => `./${String(file).replace(/^\.\//, '')}${__revision ? `?v=${encodeURIComponent(__revision)}` : ''}`
const { normalizeWhitespace, safeJsonParse, trimSlash, truncateText, uniqueList } = await import(libUrl('util.mjs'))

export const COMPONENT_STATUS_LABELS = {
  operational: '正常',
  degraded_performance: '性能下降',
  partial_outage: '部分故障',
  major_outage: '重大故障',
  under_maintenance: '维护中',
}

export const INCIDENT_STATUS_LABELS = {
  investigating: '调查中',
  identified: '已定位',
  monitoring: '观察中',
  resolved: '已恢复',
  postmortem: '复盘中',
  scheduled: '已计划',
  in_progress: '进行中',
  verifying: '验证中',
  completed: '已完成',
}

export const IMPACT_LABELS = {
  none: '无影响',
  minor: '轻微',
  major: '重大',
  critical: '严重',
  maintenance: '计划维护',
}

export const COMPONENT_STATUS_EMOJI = {
  operational: '🟢',
  degraded_performance: '🟡',
  partial_outage: '🟠',
  major_outage: '🔴',
  under_maintenance: '🔧',
}

export const INCIDENT_STATUS_EMOJI = {
  investigating: '🔴',
  identified: '🟠',
  monitoring: '🟡',
  resolved: '🟢',
  postmortem: '⚪',
  scheduled: '🗓️',
  in_progress: '🔧',
  verifying: '🔎',
  completed: '✅',
}

export function componentStatusLabel(status) {
  return COMPONENT_STATUS_LABELS[String(status || '')] || String(status || '未知')
}

export function incidentStatusLabel(status) {
  return INCIDENT_STATUS_LABELS[String(status || '')] || String(status || '未知')
}

export function impactLabel(impact) {
  return IMPACT_LABELS[String(impact || '')] || String(impact || '')
}

export function componentStatusEmoji(status) {
  return COMPONENT_STATUS_EMOJI[String(status || '')] || '⚪'
}

export function incidentStatusEmoji(status) {
  return INCIDENT_STATUS_EMOJI[String(status || '')] || '⚪'
}

export function statusPageSummaryUrl(sourceUrl) {
  const raw = String(sourceUrl || '').trim()
  if (!raw) return ''
  if (/\/api\/v2\/summary\.json(\?|#|$)/i.test(raw)) return raw
  return `${trimSlash(raw)}/api/v2/summary.json`
}

export function statusPageHistoryFeedUrl(sourceUrl) {
  const raw = String(sourceUrl || '').trim()
  if (!raw) return ''
  if (/\/history\.rss(\?|#|$)/i.test(raw)) return raw
  const base = raw.replace(/\/api\/v2\/summary\.json(\?.*)?$/i, '')
  return `${trimSlash(base)}/history.rss`
}

function parseDate(value) {
  if (!value) return 0
  const at = Date.parse(String(value))
  return Number.isFinite(at) ? at : Number(value) || 0
}

function normalizeComponent(raw, group = '') {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || raw.component_id || '').trim()
  const name = normalizeWhitespace(raw.name || raw.component || '')
  if (!id && !name) return null
  const status = String(raw.status || 'operational')
  return {
    id: id || name,
    name: name || id,
    status,
    statusLabel: componentStatusLabel(status),
    description: normalizeWhitespace(raw.description || ''),
    group: normalizeWhitespace(group || raw.group?.name || ''),
    groupId: String(raw.group_id || raw.group?.id || ''),
    isGroup: raw.group === true || Array.isArray(raw.components),
    createdAt: parseDate(raw.created_at),
    updatedAt: parseDate(raw.updated_at || raw.updatedAt),
  }
}

/** 展开 Statuspage components，包括 group 内的子组件。 */
export function flattenComponents(list, group = '') {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const entry = normalizeComponent(item, group)
    if (!entry) continue
    out.push(entry)
    if (Array.isArray(item.components) && item.components.length) {
      out.push(...flattenComponents(item.components, entry.name))
    }
  }
  const map = new Map()
  for (const item of out) {
    const key = item.id || item.name
    // 同一 id 重复出现时，优先保留子组件（isGroup=false）的实时状态。
    if (!map.has(key) || (!item.isGroup && map.get(key).isGroup)) map.set(key, item)
  }
  return [...map.values()]
}

function mergeAffectedComponents(incident, updates) {
  const list = []
  const push = value => {
    if (!value) return
    const id = String(value.id || value.code || value.component_id || '').trim()
    const name = normalizeWhitespace(value.name || value.component_name || '')
    if (!id && !name) return
    list.push({
      id: id || name,
      name: name || id,
      status: String(value.status || value.new_status || '').trim(),
    })
  }
  for (const item of Array.isArray(incident?.components) ? incident.components : []) push(item)
  for (const update of updates) {
    for (const item of update.affectedComponents || []) push(item)
  }
  const map = new Map()
  for (const item of list) {
    const key = item.id || item.name
    if (!map.has(key)) map.set(key, item)
  }
  return [...map.values()]
}

/** 把 Statuspage incident / scheduled_maintenance 统一成前端友好的结构。 */
export function normalizeIncident(raw, { maintenance = false } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || raw.incident_id || '').trim()
  if (!id) return null
  const updates = (Array.isArray(raw.incident_updates) ? raw.incident_updates : Array.isArray(raw.updates) ? raw.updates : [])
    .map(update => ({
      id: String(update?.id || '').trim(),
      status: String(update?.status || raw.status || ''),
      body: normalizeWhitespace(update?.body || update?.text || ''),
      createdAt: parseDate(update?.created_at || update?.createdAt),
      updatedAt: parseDate(update?.updated_at || update?.updatedAt),
      displayAt: parseDate(update?.display_at || update?.displayAt),
      affectedComponents: (Array.isArray(update?.affected_components) ? update.affected_components : []).map(item => ({
        id: String(item?.code || item?.id || item?.component_id || '').trim(),
        name: normalizeWhitespace(item?.name || item?.component_name || ''),
        oldStatus: String(item?.old_status || ''),
        newStatus: String(item?.new_status || item?.status || ''),
      })),
    }))
    .filter(update => update.status || update.body)
    .sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0))

  const status = String(raw.status || (maintenance ? 'scheduled' : 'investigating'))
  const impact = String(raw.impact || (maintenance ? 'maintenance' : 'minor'))
  const latest = updates[updates.length - 1] || null
  const components = mergeAffectedComponents(raw, updates)
  return {
    id,
    name: normalizeWhitespace(raw.name || raw.title || (maintenance ? '计划维护' : '服务事件')) || (maintenance ? '计划维护' : '服务事件'),
    status,
    statusLabel: incidentStatusLabel(status),
    statusEmoji: incidentStatusEmoji(status),
    impact,
    impactLabel: impactLabel(impact),
    maintenance: !!maintenance,
    createdAt: parseDate(raw.created_at || raw.createdAt || raw.started_at),
    updatedAt: parseDate(raw.updated_at || raw.updatedAt || latest?.updatedAt || latest?.createdAt),
    startedAt: parseDate(raw.started_at || raw.created_at),
    resolvedAt: parseDate(raw.resolved_at),
    scheduledFor: parseDate(raw.scheduled_for),
    scheduledUntil: parseDate(raw.scheduled_until),
    shortlink: String(raw.shortlink || raw.short_url || '').trim(),
    components,
    updates,
    latestBody: latest?.body || '',
    latestStatus: latest?.status || status,
  }
}

export function isStatusPageSummary(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  return Array.isArray(data.components) || Array.isArray(data.incidents) || Array.isArray(data.scheduled_maintenances)
}

/** 解析 /api/v2/summary.json。 */
export function parseStatusPageSummary(data, source = {}) {
  const raw = typeof data === 'string' ? safeJsonParse(data, null) : data
  if (!isStatusPageSummary(raw)) throw new Error('不是合法的 Statuspage summary.json')
  const page = raw.page && typeof raw.page === 'object' ? raw.page : {}
  const overall = raw.status && typeof raw.status === 'object' ? raw.status : {}
  const components = flattenComponents(raw.components)
  const incidents = (Array.isArray(raw.incidents) ? raw.incidents : []).map(item => normalizeIncident(item)).filter(Boolean)
  const maintenances = (Array.isArray(raw.scheduled_maintenances) ? raw.scheduled_maintenances : Array.isArray(raw.maintenances) ? raw.maintenances : [])
    .map(item => normalizeIncident(item, { maintenance: true }))
    .filter(Boolean)
  return {
    adapter: 'statuspage',
    sourceId: source.id || '',
    sourceName: source.name || '',
    page: {
      id: String(page.id || ''),
      name: normalizeWhitespace(page.name || source.name || ''),
      url: String(page.url || source.homepage || source.url || ''),
      timeZone: String(page.time_zone || ''),
      updatedAt: parseDate(page.updated_at),
    },
    overall: {
      indicator: String(overall.indicator || ''),
      description: normalizeWhitespace(overall.description || ''),
      updatedAt: parseDate(page.updated_at),
    },
    components,
    incidents,
    maintenances,
    fetchedAt: Date.now(),
  }
}

export function statusPageOverallLabel(overall) {
  const indicator = String(overall?.indicator || '').toLowerCase()
  if (indicator === 'none' || indicator === 'operational') return overall?.description || '全部正常'
  if (indicator === 'minor') return overall?.description || '部分服务异常'
  if (indicator === 'major') return overall?.description || '重大服务异常'
  if (indicator === 'critical') return overall?.description || '严重服务异常'
  return overall?.description || ''
}

export function compactIncidentText(incident, max = 600) {
  const parts = []
  if (incident?.latestBody) parts.push(incident.latestBody)
  if (!parts.length && incident?.updates?.length) {
    const last = incident.updates[incident.updates.length - 1]
    if (last?.body) parts.push(last.body)
  }
  return truncateText(parts.join('\n'), max)
}

export function componentNames(components, limit = 6) {
  return uniqueList((Array.isArray(components) ? components : []).map(item => item?.name || item?.id || '')).slice(0, limit)
}
