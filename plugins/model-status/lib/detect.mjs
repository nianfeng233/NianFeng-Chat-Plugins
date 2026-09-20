/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 模型状态订阅 · 事件检测与文案格式化（纯函数，可在扩展自测里直接单测）。
 *
 * 设计要点：
 *   - 第一次拿到某个来源时只建立基线（seed），不推送历史事件，避免刚安装就刷屏；
 *   - 后续轮询按 incident.updated_at / component.status / RSS guid 判断变化；
 *   - 同一次故障同时触发“事件更新”和“组件状态变化”时，组件事件会被抑制，
 *     避免一条故障在群里出现两条内容；
 *   - 所有事件都带 at（事件时间），桥在通知阶段按 maxEventAgeMs 丢弃太旧的历史。
 */

import { formatTime, normalizeWhitespace, truncateText, uniqueBy, uniqueList } from './util.mjs'
import {
  componentStatusEmoji,
  componentStatusLabel,
  incidentStatusEmoji,
  incidentStatusLabel,
  impactLabel,
} from './statuspage.mjs'
import { googleImpactEmoji, googleImpactLabel } from './google-cloud.mjs'

export const EVENT_KIND_LABELS = {
  incident: '服务事件',
  recovery: '服务恢复',
  maintenance: '计划维护',
  component: '组件状态变化',
  feed: '新动态',
  test: '测试消息',
}

export function eventKindLabel(kind) {
  return EVENT_KIND_LABELS[String(kind || '')] || '状态更新'
}

function snapshotHasData(previous, adapter) {
  if (!previous || previous.adapter !== adapter) return false
  if (adapter === 'rss') return previous.initialized === true
  if (adapter === 'google-cloud') return previous.initialized === true
  return !!(
    previous.initialized === true ||
    Object.keys(previous.incidents || {}).length ||
    Object.keys(previous.maintenances || {}).length ||
    Object.keys(previous.components || {}).length
  )
}

function componentKeyOf(item) {
  return String(item?.id || item?.name || '').trim()
}

function rememberSuppressed(set, components) {
  for (const item of Array.isArray(components) ? components : []) {
    const id = componentKeyOf(item)
    const name = normalizeWhitespace(item?.name || '')
    if (id) set.add(id)
    if (name) set.add(name)
  }
}

function baseEvent(source, options = {}) {
  return {
    id: String(options.id || ''),
    sourceId: source.id || '',
    sourceName: source.name || '',
    sourceEmoji: source.emoji || '📡',
    adapter: source.adapter || 'auto',
    eventType: options.eventType || 'incident',
    kind: options.kind || options.eventType || 'incident',
    title: String(options.title || ''),
    at: Number(options.at) || Date.now(),
    status: String(options.status || ''),
    statusLabel: String(options.statusLabel || ''),
    statusEmoji: String(options.statusEmoji || '⚪'),
    impact: String(options.impact || ''),
    impactLabel: String(options.impactLabel || ''),
    body: truncateText(String(options.body || ''), 1200),
    components: Array.isArray(options.components) ? options.components : [],
    url: String(options.url || ''),
    maintenance: options.maintenance === true,
    componentId: String(options.componentId || ''),
    componentName: String(options.componentName || ''),
    oldStatus: String(options.oldStatus || ''),
    oldStatusLabel: String(options.oldStatusLabel || ''),
    newStatus: String(options.newStatus || ''),
    newStatusLabel: String(options.newStatusLabel || ''),
  }
}

function incidentEvent(source, incident, kind, at) {
  return baseEvent(source, {
    id: `${source.id}:${incident.maintenance ? 'maintenance' : 'incident'}:${incident.id}:${incident.updatedAt || incident.latestStatus || kind}`,
    eventType: kind,
    kind,
    title: incident.name,
    at: at || incident.updatedAt || incident.createdAt || Date.now(),
    status: incident.status,
    statusLabel: incident.statusLabel || incidentStatusLabel(incident.status),
    statusEmoji: incident.statusEmoji || incidentStatusEmoji(incident.status),
    impact: incident.impact,
    impactLabel: incident.impactLabel || impactLabel(incident.impact),
    body: incident.latestBody,
    components: incident.components,
    url: incident.shortlink || incident.url || '',
    maintenance: !!incident.maintenance,
  })
}

function componentEvent(source, component, previous, at) {
  return baseEvent(source, {
    id: `${source.id}:component:${component.id}:${component.status}:${component.updatedAt || at || Date.now()}`,
    eventType: 'component',
    kind: 'component',
    title: component.name,
    at: at || component.updatedAt || Date.now(),
    status: component.status,
    statusLabel: component.statusLabel || componentStatusLabel(component.status),
    statusEmoji: component.statusEmoji || componentStatusEmoji(component.status),
    body: component.description || '',
    components: [{ id: component.id, name: component.name, status: component.status }],
    url: '',
    componentId: component.id,
    componentName: component.name,
    oldStatus: previous?.status || '',
    oldStatusLabel: previous?.statusLabel || componentStatusLabel(previous?.status),
    newStatus: component.status,
    newStatusLabel: component.statusLabel || componentStatusLabel(component.status),
  })
}

/** Statuspage summary -> 事件 + 新快照。 */
export function collectStatusPageEvents({ source, parsed, previous, endpoint = '' }) {
  const seed = !snapshotHasData(previous, 'statuspage')
  const events = []
  const suppressed = new Set()
  const previousIncidents = previous?.incidents || {}
  const previousMaintenances = previous?.maintenances || {}
  const previousComponents = previous?.components || {}

  const next = {
    adapter: 'statuspage',
    endpoint: String(endpoint || previous?.endpoint || ''),
    initialized: true,
    fetchedAt: parsed.fetchedAt || Date.now(),
    pageName: parsed.page?.name || source.name || '',
    overallStatus: parsed.overall || {},
    incidents: {},
    maintenances: {},
    components: {},
  }

  for (const incident of parsed.incidents) {
    next.incidents[incident.id] = {
      id: incident.id,
      name: incident.name,
      status: incident.status,
      statusLabel: incident.statusLabel,
      impact: incident.impact,
      updatedAt: incident.updatedAt,
    }
    const prev = previousIncidents[incident.id]
    const changed = !prev || Number(prev.updatedAt) !== Number(incident.updatedAt) || prev.status !== incident.status
    if (!seed && changed) {
      const kind = incident.status === 'resolved' ? 'recovery' : 'incident'
      events.push(incidentEvent(source, incident, kind, incident.updatedAt))
      rememberSuppressed(suppressed, incident.components)
    }
  }

  for (const maintenance of parsed.maintenances) {
    next.maintenances[maintenance.id] = {
      id: maintenance.id,
      name: maintenance.name,
      status: maintenance.status,
      statusLabel: maintenance.statusLabel,
      impact: maintenance.impact,
      updatedAt: maintenance.updatedAt,
    }
    const prev = previousMaintenances[maintenance.id]
    const changed = !prev || Number(prev.updatedAt) !== Number(maintenance.updatedAt) || prev.status !== maintenance.status
    if (!seed && changed) {
      events.push(incidentEvent(source, maintenance, 'maintenance', maintenance.updatedAt))
      rememberSuppressed(suppressed, maintenance.components)
    }
  }

  for (const component of parsed.components) {
    next.components[component.id] = {
      id: component.id,
      name: component.name,
      status: component.status,
      statusLabel: component.statusLabel,
      updatedAt: component.updatedAt,
      isGroup: !!component.isGroup,
    }
    if (seed) continue
    const prev = previousComponents[component.id]
    if (!prev || prev.status === component.status) continue
    if (component.isGroup) continue
    const id = componentKeyOf(component)
    const name = normalizeWhitespace(component.name)
    if (suppressed.has(id) || suppressed.has(name)) continue
    events.push(componentEvent(source, component, prev, component.updatedAt))
  }

  return { seed, events, snapshot: next }
}

/** RSS / Atom -> 事件 + 新快照。 */
export function collectFeedEvents({ source, feed, previous, endpoint = '', maxSeen = 500 }) {
  const seed = !snapshotHasData(previous, 'rss')
  const previousSeen = previous?.seen || {}
  const nextSeen = {}
  const events = []

  for (const item of feed.items || []) {
    const key = String(item.id || item.url || item.title || '').trim()
    if (!key) continue
    nextSeen[key] = Number(previousSeen[key]) || Number(item.publishedAt) || Date.now()
    if (seed || previousSeen[key]) continue
    events.push(
      baseEvent(source, {
        id: `${source.id}:feed:${key}`,
        eventType: 'feed',
        kind: 'feed',
        title: item.title || '状态页新动态',
        at: Number(item.publishedAt) || Date.now(),
        statusLabel: item.categories?.[0] || '',
        body: item.body || '',
        url: item.url || '',
        components: [],
      }),
    )
  }

  // 也保留上一次快照中的历史 guid，防止 RSS 源短暂缺失某些条目后重复推送。
  for (const [key, at] of Object.entries(previousSeen)) {
    if (!nextSeen[key]) nextSeen[key] = Number(at) || Date.now()
  }

  const trimmed = Object.entries(nextSeen)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, Math.max(1, Number(maxSeen) || 500))
  const seen = Object.fromEntries(trimmed)

  return {
    seed,
    events,
    snapshot: {
      adapter: 'rss',
      endpoint: String(endpoint || previous?.endpoint || ''),
      initialized: true,
      fetchedAt: feed.fetchedAt || Date.now(),
      pageName: feed.page?.name || source.name || '',
      seen,
    },
  }
}

/** Google Cloud incidents.json -> 事件 + 新快照。 */
export function collectGoogleCloudEvents({ source, parsed, previous, endpoint = '' }) {
  const seed = !snapshotHasData(previous, 'google-cloud')
  const previousIncidents = previous?.incidents || {}
  const events = []
  const next = {
    adapter: 'google-cloud',
    endpoint: String(endpoint || previous?.endpoint || ''),
    initialized: true,
    fetchedAt: parsed.fetchedAt || Date.now(),
    pageName: parsed.page?.name || source.name || '',
    incidents: {},
  }

  for (const incident of parsed.incidents) {
    next.incidents[incident.id] = {
      id: incident.id,
      title: incident.title,
      status: incident.status,
      statusLabel: incident.statusLabel,
      updatedAt: incident.updatedAt,
      resolvedAt: incident.resolvedAt,
    }
    const prev = previousIncidents[incident.id]
    const changed =
      !prev ||
      Number(prev.updatedAt) !== Number(incident.updatedAt) ||
      Number(prev.resolvedAt) !== Number(incident.resolvedAt)
    if (seed || !changed) continue
    const kind = incident.resolvedAt ? 'recovery' : 'incident'
    events.push(
      baseEvent(source, {
        id: `${source.id}:${kind}:${incident.id}:${incident.updatedAt || incident.resolvedAt || kind}`,
        eventType: kind,
        kind,
        title: incident.title,
        at: (kind === 'recovery' ? incident.resolvedAt : incident.updatedAt) || incident.updatedAt || Date.now(),
        status: incident.status,
        statusLabel: incident.statusLabel || googleImpactLabel(incident.status),
        statusEmoji: incident.statusEmoji || googleImpactEmoji(incident.status),
        impact: incident.status,
        impactLabel: incident.statusLabel || googleImpactLabel(incident.status),
        body: incident.body,
        components: incident.components,
        url: incident.url,
      }),
    )
  }

  return { seed, events, snapshot: next }
}

function selectedValues(list) {
  return uniqueList(Array.isArray(list) ? list : []).map(item => String(item).trim()).filter(Boolean)
}

function eventHaystack(event) {
  return [
    event?.title,
    event?.body,
    event?.statusLabel,
    event?.impactLabel,
    ...(Array.isArray(event?.components) ? event.components.flatMap(item => [item?.id, item?.name]) : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** 判断一个事件是否命中某个渠道对某个来源的订阅设置。 */
export function eventMatchesSubscription(event, subscriptionSource) {
  if (!event || !subscriptionSource || subscriptionSource.enabled === false) return false
  const events = subscriptionSource.events || {}
  const kind = String(event.kind || '')
  if (kind === 'component') {
    if (events.component === false) return false
  } else if (kind === 'maintenance') {
    if (events.maintenance === false) return false
  } else if (events.incident === false) {
    return false
  }

  const selected = selectedValues(subscriptionSource.components)
  if (selected.length) {
    if (kind === 'component') {
      const key = String(event.componentId || event.componentName || event.title || '')
      if (!selected.includes(key) && !selected.includes(event.componentName)) return false
    } else {
      const componentMatches = (event.components || []).some(item => {
        const id = String(item?.id || '')
        const name = String(item?.name || '')
        return selected.includes(id) || selected.includes(name)
      })
      if (!componentMatches) {
        const haystack = eventHaystack(event)
        if (!selected.some(value => haystack.includes(value.toLowerCase()))) return false
      }
    }
  }

  const keywords = selectedValues(subscriptionSource.keywords)
  if (keywords.length) {
    const haystack = eventHaystack(event)
    if (!keywords.some(keyword => haystack.includes(keyword.toLowerCase()))) return false
  }
  return true
}

function formatComponents(event, max = 6) {
  const list = (Array.isArray(event?.components) ? event.components : [])
    .map(item => normalizeWhitespace(item?.name || item?.id || ''))
    .filter(Boolean)
  return uniqueBy(list, item => item).slice(0, max).join('、')
}

/** 渠道通知正文（纯文本，兼容 QQ / 微信 / NapCat）。 */
export function formatEventText(event, config = {}) {
  const maxChars = Math.max(200, Math.min(4000, Number(config.maxTextChars) || 1200))
  const timeZone = config.timeZone || 'Asia/Shanghai'
  const time = formatTime(event?.at || Date.now(), timeZone)
  const sourceName = event?.sourceName || '模型状态'
  const lines = []

  const kind = String(event?.kind || 'incident')
  if (kind === 'component') {
    lines.push(`【模型状态 · 组件变化】${sourceName}`)
    lines.push(`${event.statusEmoji || '⚪'} ${event.componentName || event.title || '组件'}`)
    lines.push(`状态：${event.oldStatusLabel || componentStatusLabel(event.oldStatus)} → ${event.newStatusLabel || componentStatusLabel(event.newStatus)}`)
    if (event.body) lines.push(`说明：${truncateText(event.body, 500)}`)
    lines.push(`时间：${time}`)
    if (event.url) lines.push(`详情：${event.url}`)
  } else if (kind === 'recovery' || kind === 'maintenance') {
    const title = kind === 'recovery' ? '服务恢复' : '计划维护'
    lines.push(`【模型状态 · ${title}】${sourceName}`)
    lines.push(`${event.statusEmoji || (kind === 'recovery' ? '✅' : '🔧')} ${event.title || '状态更新'}`)
    lines.push(`状态：${event.statusLabel || (kind === 'recovery' ? '已恢复' : '维护中')}${event.impactLabel ? ` · 影响：${event.impactLabel}` : ''}`)
    const components = formatComponents(event)
    if (components) lines.push(`组件：${components}`)
    if (event.body) lines.push(`进展：${truncateText(event.body, 600)}`)
    lines.push(`时间：${time}`)
    if (event.url) lines.push(`详情：${event.url}`)
  } else if (kind === 'feed') {
    lines.push(`【模型状态 · 新动态】${sourceName}`)
    lines.push(`🔔 ${event.title || '状态页更新'}`)
    if (event.body) lines.push(truncateText(event.body, 700))
    lines.push(`时间：${time}`)
    if (event.url) lines.push(`详情：${event.url}`)
  } else if (kind === 'test') {
    lines.push('【模型状态订阅 · 测试消息】')
    lines.push(event.body || '如果你在群里看到这条消息，说明订阅推送链路已经打通。')
    lines.push(`时间：${time}`)
  } else {
    lines.push(`【模型状态 · 服务事件】${sourceName}`)
    lines.push(`${event.statusEmoji || '🔴'} ${event.title || '服务状态更新'}`)
    lines.push(`状态：${event.statusLabel || '未知'}${event.impactLabel ? ` · 影响：${event.impactLabel}` : ''}`)
    const components = formatComponents(event)
    if (components) lines.push(`组件：${components}`)
    if (event.body) lines.push(`进展：${truncateText(event.body, 700)}`)
    lines.push(`时间：${time}`)
    if (event.url) lines.push(`详情：${event.url}`)
  }

  const text = lines.filter(Boolean).join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

export function compactEvent(event) {
  return {
    id: String(event?.id || ''),
    sourceId: String(event?.sourceId || ''),
    sourceName: String(event?.sourceName || ''),
    sourceEmoji: String(event?.sourceEmoji || '📡'),
    adapter: String(event?.adapter || ''),
    kind: String(event?.kind || ''),
    eventType: String(event?.eventType || event?.kind || ''),
    title: String(event?.title || ''),
    at: Number(event?.at) || 0,
    status: String(event?.status || ''),
    statusLabel: String(event?.statusLabel || ''),
    statusEmoji: String(event?.statusEmoji || ''),
    impact: String(event?.impact || ''),
    impactLabel: String(event?.impactLabel || ''),
    body: truncateText(String(event?.body || ''), 600),
    components: (Array.isArray(event?.components) ? event.components : []).slice(0, 12).map(item => ({
      id: String(item?.id || ''),
      name: String(item?.name || ''),
      status: String(item?.status || ''),
    })),
    url: String(event?.url || ''),
    componentId: String(event?.componentId || ''),
    componentName: String(event?.componentName || ''),
    oldStatus: String(event?.oldStatus || ''),
    newStatus: String(event?.newStatus || ''),
    oldStatusLabel: String(event?.oldStatusLabel || ''),
    newStatusLabel: String(event?.newStatusLabel || ''),
  }
}
