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
 *   - 每个事件带 important 标记：true 代表“服务异常 / 质量下降 / 恢复”这类
 *     重要节点，false 代表调查中、观察中等过程更新或普通公告。默认通知模式
 *     只投递 important=true 的事件；
 *   - 所有事件都带 at（事件时间），桥在通知阶段按 maxEventAgeMs 丢弃太旧的历史。
 */

const __revision = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || ''
  } catch (_) {
    return ''
  }
})()
const libUrl = file => `./${String(file).replace(/^\.\//, '')}${__revision ? `?v=${encodeURIComponent(__revision)}` : ''}`

/*
 * 后端桥热重载时内核只会给 bridge.mjs 加 ?v=，静态依赖仍会命中 Node 的
 * ESM 模块缓存。这里让整棵 lib 依赖链复用同一个 revision query，更新插件后
 * 不需要重启后端也能加载到新的模块图。
 */
const { formatTime, normalizeWhitespace, truncateText, uniqueBy, uniqueList } = await import(libUrl('util.mjs'))
const {
  componentStatusEmoji,
  componentStatusLabel,
  incidentStatusEmoji,
  incidentStatusLabel,
  impactLabel,
} = await import(libUrl('statuspage.mjs'))
const { googleImpactEmoji, googleImpactLabel } = await import(libUrl('google-cloud.mjs'))
const {
  classifyStatusText,
  extractAffectedComponents,
  localizeStatusTitle,
  summarizeStatusBody,
} = await import(libUrl('text.mjs'))

export { EVENT_KIND_LABELS, eventKindLabel } from './kind.mjs'

const COMPONENT_SEVERITY = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
}

export function componentSeverity(status) {
  return COMPONENT_SEVERITY[String(status || '')] || 0
}

function incidentResolved(status) {
  return /^(resolved|postmortem|completed|done)$/i.test(String(status || '').trim())
}

function incidentSeverityLevel(incident) {
  let level = 0
  for (const item of Array.isArray(incident?.components) ? incident.components : []) {
    level = Math.max(level, componentSeverity(item?.status))
  }
  const impact = String(incident?.impact || '').toLowerCase()
  if (impact === 'critical') level = Math.max(level, 4)
  else if (impact === 'major') level = Math.max(level, 3)
  else if (impact === 'minor') level = Math.max(level, 2)
  const status = String(incident?.status || '').toLowerCase()
  if (!level && /^(investigating|identified|monitoring|verifying|in_progress)$/.test(status)) level = 2
  return level
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

function componentListOf(eventOrIncident) {
  return (Array.isArray(eventOrIncident?.components) ? eventOrIncident.components : [])
    .map(item => ({
      id: String(item?.id || item?.name || '').trim(),
      name: normalizeWhitespace(item?.name || item?.id || ''),
      status: String(item?.status || ''),
    }))
    .filter(item => item.id || item.name)
}

function baseEvent(source, options = {}) {
  return {
    id: String(options.id || ''),
    sourceId: String(source?.id || ''),
    sourceName: String(source?.name || ''),
    sourceEmoji: String(source?.emoji || '📡'),
    adapter: String(source?.adapter || 'auto'),
    eventType: String(options.eventType || 'incident'),
    kind: String(options.kind || options.eventType || 'incident'),
    title: localizeStatusTitle(options.title || ''),
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
    important: options.important === undefined ? true : options.important === true,
    severityLevel: Number(options.severityLevel) || 0,
  }
}

function incidentEvent(source, incident, kind, at, options = {}) {
  const components = componentListOf(incident)
  const statusLabel = String(options.statusLabel || incident.statusLabel || incidentStatusLabel(incident.status))
  return baseEvent(source, {
    id: options.id || `${source.id}:${incident.maintenance ? 'maintenance' : 'incident'}:${incident.id}:${incident.updatedAt || incident.latestStatus || kind}`,
    eventType: options.eventType || kind,
    kind,
    title: incident.name,
    at: at || incident.updatedAt || incident.createdAt || Date.now(),
    status: incident.status,
    statusLabel,
    statusEmoji: options.statusEmoji || incident.statusEmoji || incidentStatusEmoji(incident.status),
    impact: incident.impact,
    impactLabel: kind === 'recovery' ? '' : incident.impactLabel || impactLabel(incident.impact),
    body: summarizeStatusBody(incident.latestBody, { label: statusLabel, components }),
    components,
    url: incident.shortlink || incident.url || '',
    maintenance: !!incident.maintenance,
    important: options.important,
    severityLevel: options.severityLevel === undefined ? incidentSeverityLevel(incident) : options.severityLevel,
  })
}

function componentEvent(source, component, previous, at, options = {}) {
  return baseEvent(source, {
    id: options.id || `${source.id}:component:${component.id}:${component.status}:${component.updatedAt || at || Date.now()}`,
    eventType: 'component',
    kind: options.kind || 'component',
    title: component.name,
    at: at || component.updatedAt || Date.now(),
    status: component.status,
    statusLabel: component.statusLabel || componentStatusLabel(component.status),
    statusEmoji: component.statusEmoji || componentStatusEmoji(component.status),
    body: summarizeStatusBody(component.description || '', {
      label: component.statusLabel || componentStatusLabel(component.status),
    }),
    components: componentListOf([component]),
    url: '',
    componentId: component.id,
    componentName: component.name,
    oldStatus: previous?.status || '',
    oldStatusLabel: previous?.statusLabel || (previous?.status ? componentStatusLabel(previous.status) : '未知'),
    newStatus: component.status,
    newStatusLabel: component.statusLabel || componentStatusLabel(component.status),
    important: options.important,
    severityLevel: options.severityLevel === undefined ? componentSeverity(component.status) : options.severityLevel,
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
  // v2.1.x 快照没有 baselineActive 字段；升级后的第一轮把当时仍在异常中的
  // incident 视作基线，避免旧故障因一次过程更新被当成新故障推送。
  const legacySnapshot =
    previous?.adapter === 'statuspage' &&
    previous?.initialized === true &&
    Object.values(previousIncidents).some(item => item && item.importantActive === undefined)

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
    const prev = previousIncidents[incident.id]
    const resolved = incidentResolved(incident.status)
    const level = incidentSeverityLevel(incident)
    const changed = !prev || Number(prev.updatedAt) !== Number(incident.updatedAt) || prev.status !== incident.status
    const prevActive = !!prev && !incidentResolved(prev.status)
    let important = false
    let importantActive = prev?.importantActive === true
    let importantResolved = prev?.importantResolved === true
    let baselineActive = prev?.baselineActive === true

    if (seed) {
      importantActive = false
      importantResolved = false
      baselineActive = !resolved
    } else if (changed) {
      if (resolved) {
        important = importantActive && !importantResolved
        if (important) importantResolved = true
        baselineActive = false
      } else if (!prev) {
        if (level >= 2) {
          important = true
          importantActive = true
        }
        baselineActive = false
      } else if (prevActive) {
        // 已经处于异常中的同一条 incident：只有首次异常 / 质量下降值得推送，
        // 调查中 → 已定位 → 观察中这类过程更新默认不再逐条刷屏。
        if (prev.baselineActive === true || legacySnapshot) {
          important = false
          baselineActive = true
        } else if (importantActive) {
          important = false
        } else if (level >= 2) {
          important = true
          importantActive = true
          baselineActive = false
        }
      } else if (level >= 2) {
        // 之前已恢复的 incident 再次进入异常（例如重新打开）。
        important = true
        importantActive = true
        importantResolved = false
        baselineActive = false
      }
    }

    // 处于异常中的 incident 所影响的组件，由 incident 通知统一说明；
    // 没有实际影响的公告类 incident 不要误伤组件变化。恢复时也抑制同轮
    // 组件状态变化，避免一件事推两条。
    if (!resolved && level >= 2) rememberSuppressed(suppressed, incident.components)
    if (changed && (resolved || level >= 2 || important)) rememberSuppressed(suppressed, incident.components)

    if (!seed && changed) {
      events.push(
        incidentEvent(source, incident, resolved ? 'recovery' : 'incident', incident.updatedAt, {
          important,
          severityLevel: resolved ? 0 : level,
        }),
      )
    }

    next.incidents[incident.id] = {
      id: incident.id,
      name: incident.name,
      status: incident.status,
      statusLabel: incident.statusLabel,
      impact: incident.impact,
      updatedAt: incident.updatedAt,
      importantActive,
      importantResolved,
      baselineActive,
    }
  }

  for (const maintenance of parsed.maintenances) {
    const prev = previousMaintenances[maintenance.id]
    const done = incidentResolved(maintenance.status)
    const changed = !prev || Number(prev.updatedAt) !== Number(maintenance.updatedAt) || prev.status !== maintenance.status
    let important = false
    let importantActive = prev?.importantActive === true
    let importantResolved = prev?.importantResolved === true
    let baselineActive = prev?.baselineActive === true

    if (seed) {
      importantActive = false
      importantResolved = false
      baselineActive = !done
    } else if (changed) {
      if (done) {
        important = importantActive && !importantResolved
        if (important) importantResolved = true
        baselineActive = false
      } else if (!prev) {
        important = true
        importantActive = true
        baselineActive = false
      } else if (!incidentResolved(prev.status)) {
        important = false
        baselineActive = prev.baselineActive === true
      } else {
        important = true
        importantActive = true
        importantResolved = false
        baselineActive = false
      }
    }

    if (!done || changed) rememberSuppressed(suppressed, maintenance.components)

    if (!seed && changed) {
      events.push(
        incidentEvent(source, maintenance, 'maintenance', maintenance.updatedAt, {
          important,
          severityLevel: done ? 0 : 1,
        }),
      )
    }

    next.maintenances[maintenance.id] = {
      id: maintenance.id,
      name: maintenance.name,
      status: maintenance.status,
      statusLabel: maintenance.statusLabel,
      impact: maintenance.impact,
      updatedAt: maintenance.updatedAt,
      importantActive,
      importantResolved,
      baselineActive,
    }
  }

  for (const component of parsed.components) {
    const prev = previousComponents[component.id]
    const name = normalizeWhitespace(component.name)
    const id = componentKeyOf(component)
    let importantActive = prev?.importantActive === true

    if (seed || component.isGroup || !prev || prev.status === component.status) {
      next.components[component.id] = {
        id: component.id,
        name: component.name,
        status: component.status,
        statusLabel: component.statusLabel,
        updatedAt: component.updatedAt,
        isGroup: !!component.isGroup,
        importantActive,
      }
      continue
    }

    const oldRank = componentSeverity(prev.status)
    const newRank = componentSeverity(component.status)
    let important = false

    if (newRank > oldRank) {
      // 0 → 非正常：这就是用户要的“服务出错 / 质量下降”。
      // 性能下降 → 部分 / 重大故障的升级也值得跟一条。
      if (oldRank === 0 && newRank >= 2) {
        important = true
        importantActive = true
      } else if (importantActive && oldRank < 3 && newRank >= 3) {
        important = true
        importantActive = true
      }
    } else if (newRank === 0 && oldRank > 0) {
      // 只有此前确实推送过异常，才补一条恢复，避免“莫名其妙报恢复”。
      important = prev.importantActive === true
      importantActive = false
    }

    next.components[component.id] = {
      id: component.id,
      name: component.name,
      status: component.status,
      statusLabel: component.statusLabel,
      updatedAt: component.updatedAt,
      isGroup: !!component.isGroup,
      importantActive,
    }

    if (suppressed.has(id) || suppressed.has(name)) continue
    if (newRank === oldRank && !important) continue
    events.push(
      componentEvent(source, component, prev, component.updatedAt, {
        important,
        severityLevel: newRank,
      }),
    )
  }

  return { seed, events, snapshot: next }
}

function feedContentHash(item) {
  const text = `${item?.title || ''}\n${item?.body || ''}\n${item?.url || ''}`
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function normalizeIncidentIdentifier(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const direct = raw.match(/\/incidents?\/([^/?#\s]+)/i)
  if (direct) return direct[1]
  try {
    const url = new URL(raw)
    const match = url.pathname.match(/\/incidents?\/([^/?#]+)/i)
    if (match) return match[1]
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch (_) {
    return raw.replace(/[?#].*$/, '').replace(/\/+$/, '')
  }
}

function feedIncidentKey(item) {
  const url = String(item?.url || '')
  const id = String(item?.id || '')
  if (/incidents?/i.test(url)) {
    const key = normalizeIncidentIdentifier(url)
    if (key) return key
  }
  if (/incidents?/i.test(id)) {
    const key = normalizeIncidentIdentifier(id)
    if (key) return key
  }
  // 没有 /incidents/<id> 时，优先用“去掉状态前缀的标题”聚合同一条动态的
  // 多次更新；不少 RSS 源每次更新都会换 guid，但标题和链接是稳定的。
  const titleKey = normalizeWhitespace(item?.title || '')
    .replace(/^(resolved|recovered|restored|investigating|identified|monitoring|completed|scheduled)\s*[:\-–—]\s*/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
  if (titleKey) return titleKey
  const fromUrl = normalizeIncidentIdentifier(url)
  if (fromUrl) return fromUrl
  const fromId = normalizeIncidentIdentifier(id)
  if (fromId) return fromId
  return ''
}

function classifyFeedItem(item) {
  const classification = classifyStatusText({ title: item?.title || '', body: item?.body || '' })
  const components = extractAffectedComponents(item?.body || '')
  return {
    ...classification,
    components,
    displayTitle: localizeStatusTitle(item?.title || ''),
  }
}

function eventKindForFeedPhase(phase) {
  if (phase === 'incident') return 'incident'
  if (phase === 'recovery') return 'recovery'
  if (phase === 'maintenance') return 'maintenance'
  return 'feed'
}

function eventEmojiForFeedPhase(phase, severity) {
  if (phase === 'recovery') return '🟢'
  if (phase === 'maintenance') return '🔧'
  if (phase === 'incident') return Number(severity) >= 3 ? '🔴' : '🟡'
  return '🔔'
}

/** RSS / Atom -> 事件 + 新快照。 */
export function collectFeedEvents({ source, feed, previous, endpoint = '', maxSeen = 500 }) {
  const previousSeen = previous?.seen || {}
  const initialised = previous?.adapter === 'rss' && previous.initialized === true
  // v2.1.x 的 RSS 快照没有 incidents 状态；第一次升级后先静默重建状态，
  // 避免旧条目被当成新动态一次性补发。
  const legacySnapshot = initialised && !previous?.incidents
  const seed = !snapshotHasData(previous, 'rss') || legacySnapshot
  const nextSeen = {}
  const nextIncidents = { ...(previous?.incidents || {}) }
  const items = Array.isArray(feed.items) ? feed.items : []
  const changedItems = []

  for (const item of items) {
    const key = String(item.id || item.url || item.title || '').trim()
    if (!key) continue
    const hash = feedContentHash(item)
    const previousEntry = previousSeen[key]
    const previousAt = typeof previousEntry === 'number' ? previousEntry : Number(previousEntry?.at) || 0
    const previousHash = typeof previousEntry === 'object' && previousEntry ? String(previousEntry.hash || '') : ''
    nextSeen[key] = {
      at: previousAt || Number(item.publishedAt) || Date.now(),
      hash,
    }
    if (seed) continue
    if (!previousEntry || !previousHash || previousHash !== hash) {
      changedItems.push({
        item,
        key,
        hash,
        incidentKey: feedIncidentKey(item),
        publishedAt: Number(item.publishedAt) || 0,
        index: changedItems.length,
      })
    }
  }

  // 保留上一次快照里的历史 guid / 哈希，防止 RSS 源短暂缺失条目后重复推送。
  for (const [key, entry] of Object.entries(previousSeen)) {
    if (nextSeen[key]) continue
    const at = typeof entry === 'number' ? Number(entry) || 0 : Number(entry?.at) || 0
    const hash = typeof entry === 'object' && entry ? String(entry.hash || '') : ''
    nextSeen[key] = { at: at || Date.now(), hash }
  }

  const events = []

  if (seed) {
    // 只建立基线：当前已经处于异常中的条目记录为 baselineActive，之后
    // 不会因为“调查中 → 观察中”这种过程更新而补发。
    for (const item of [...items].sort((a, b) => (Number(a.publishedAt) || 0) - (Number(b.publishedAt) || 0))) {
      const key = String(item.id || item.url || item.title || '').trim()
      if (!key) continue
      const incidentKey = feedIncidentKey(item)
      const info = classifyFeedItem(item)
      if (info.phase === 'info') continue
      nextIncidents[incidentKey] = {
        key: incidentKey,
        phase: info.phase,
        statusKey: info.statusKey,
        severity: info.severity,
        importantActive: false,
        importantResolved: false,
        baselineActive: info.phase === 'incident' || info.phase === 'maintenance',
        hash: feedContentHash(item),
        at: Number(item.publishedAt) || Date.now(),
        title: info.displayTitle || item.title || '',
      }
    }
  } else {
    changedItems.sort((a, b) => {
      const at = (Number(a.publishedAt) || 0) - (Number(b.publishedAt) || 0)
      return at || a.index - b.index
    })

    for (const entry of changedItems) {
      const info = classifyFeedItem(entry.item)
      const prevState = nextIncidents[entry.incidentKey]
      if (info.phase === 'info') {
        // 普通公告：默认不推送（important=false），但仍记录到最近事件。
        events.push(
          baseEvent(source, {
            id: `${source.id}:feed:${entry.key}:${entry.hash}`,
            eventType: 'feed',
            kind: 'feed',
            title: info.displayTitle || entry.item.title || '状态页动态',
            at: Number(entry.item.publishedAt) || Date.now(),
            statusLabel: info.label,
            body: summarizeStatusBody(entry.item.body || '', { label: info.label, components: info.components }),
            components: info.components.map(name => ({ id: name, name })),
            url: entry.item.url || '',
            important: false,
            severityLevel: 0,
          }),
        )
        continue
      }

      let important = false
      let importantActive = !!prevState?.importantActive
      let importantResolved = !!prevState?.importantResolved
      let baselineActive = !!prevState?.baselineActive

      if (info.phase === 'incident') {
        if (!prevState) {
          important = info.severity >= 2
          importantActive = important
          baselineActive = false
        } else if (baselineActive) {
          important = false
          baselineActive = true
        } else if (prevState.phase === 'incident') {
          important = false
        } else if (info.severity >= 2) {
          important = true
          importantActive = true
          importantResolved = false
          baselineActive = false
        }
      } else if (info.phase === 'recovery') {
        important = importantActive && !importantResolved
        if (important) importantResolved = true
        baselineActive = false
      } else if (info.phase === 'maintenance') {
        if (!prevState) {
          important = true
          importantActive = true
          baselineActive = false
        } else if (prevState.phase === 'maintenance') {
          important = false
          baselineActive = !!prevState.baselineActive
        } else {
          important = true
          importantActive = true
          importantResolved = false
          baselineActive = false
        }
      }

      nextIncidents[entry.incidentKey] = {
        key: entry.incidentKey,
        phase: info.phase,
        statusKey: info.statusKey,
        severity: info.severity,
        importantActive,
        importantResolved,
        baselineActive,
        hash: entry.hash,
        at: Number(entry.item.publishedAt) || Date.now(),
        title: info.displayTitle || entry.item.title || '',
      }

      const sameGuidUpdated = Boolean(previousSeen[entry.key])
      events.push(
        baseEvent(source, {
          id: `${source.id}:feed:${entry.incidentKey}:${info.phase}:${entry.hash}`,
          eventType: eventKindForFeedPhase(info.phase),
          kind: eventKindForFeedPhase(info.phase),
          title: info.displayTitle || entry.item.title || '状态页动态',
          at: sameGuidUpdated ? Date.now() : Number(entry.item.publishedAt) || Date.now(),
          statusLabel: info.label,
          statusEmoji: eventEmojiForFeedPhase(info.phase, info.severity),
          impactLabel: info.phase === 'incident' && info.severity >= 3 ? '服务异常' : '',
          body: summarizeStatusBody(entry.item.body || '', { label: info.label, components: info.components }),
          components: info.components.map(name => ({ id: name, name })),
          url: entry.item.url || '',
          important: important === true,
          severityLevel: info.phase === 'recovery' ? 0 : info.severity,
        }),
      )
    }

    // 没有变化的 incident 状态保留；已经不在 feed 里的也保留，等恢复动态
    // 出现时还能知道此前是否已经推送过异常。
    for (const [key, state] of Object.entries(previous?.incidents || {})) {
      if (!nextIncidents[key]) nextIncidents[key] = state
    }
  }

  const trimmedSeen = Object.entries(nextSeen)
    .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
    .slice(0, Math.max(1, Number(maxSeen) || 500))
  const seen = Object.fromEntries(trimmedSeen)

  const incidentLimit = Math.max(100, Number(maxSeen) || 500)
  const incidents = Object.fromEntries(
    Object.entries(nextIncidents)
      .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
      .slice(0, incidentLimit),
  )

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
      incidents,
    },
  }
}

/** Google Cloud incidents.json -> 事件 + 新快照。 */
export function collectGoogleCloudEvents({ source, parsed, previous, endpoint = '' }) {
  const seed = !snapshotHasData(previous, 'google-cloud')
  const previousIncidents = previous?.incidents || {}
  const legacySnapshot =
    previous?.adapter === 'google-cloud' &&
    previous?.initialized === true &&
    Object.values(previousIncidents).some(item => item && item.importantActive === undefined)
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
    const prev = previousIncidents[incident.id]
    const status = String(incident.status || '')
    const done = !!incident.resolvedAt || /SERVICE_AVAILABLE/i.test(status)
    const isMaintenance = /SERVICE_MAINTENANCE/i.test(status)
    const isInfo = /SERVICE_INFORMATION/i.test(status)
    const level = done ? 0 : /SERVICE_OUTAGE/i.test(status) ? 4 : /SERVICE_DISRUPTION/i.test(status) ? 3 : isMaintenance ? 1 : isInfo ? 0 : 2
    const changed =
      !prev ||
      Number(prev.updatedAt) !== Number(incident.updatedAt) ||
      Number(prev.resolvedAt) !== Number(incident.resolvedAt) ||
      prev.status !== status
    let important = false
    let importantActive = prev?.importantActive === true
    let importantResolved = prev?.importantResolved === true
    let baselineActive = prev?.baselineActive === true

    if (seed) {
      importantActive = false
      importantResolved = false
      baselineActive = !done && !isInfo
    } else if (changed) {
      if (done) {
        important = importantActive && !importantResolved
        if (important) importantResolved = true
        baselineActive = false
      } else if (!prev) {
        important = level >= 2 || isMaintenance
        importantActive = important
        baselineActive = false
      } else if (!done && prev.resolvedAt) {
        important = level >= 2 || isMaintenance
        importantActive = important
        importantResolved = false
        baselineActive = false
      } else if (prev.baselineActive === true || legacySnapshot) {
        important = false
        baselineActive = true
      } else if (!isInfo && level >= 2) {
        // 过程中升级严重程度可跟一条；同级或降级不再重复。
        const prevLevel = /SERVICE_OUTAGE/i.test(String(prev.status || '')) ? 4 : /SERVICE_DISRUPTION/i.test(String(prev.status || '')) ? 3 : 1
        if (level > prevLevel && level >= 3) {
          important = true
          importantActive = true
        } else {
          important = false
        }
      } else if (isMaintenance && !prev.importantActive) {
        important = true
        importantActive = true
      }
    }

    if (!seed && changed) {
      const kind = done ? 'recovery' : isMaintenance ? 'maintenance' : 'incident'
      const components = componentListOf(incident)
      events.push(
        baseEvent(source, {
          id: `${source.id}:${kind}:${incident.id}:${incident.updatedAt || incident.resolvedAt || kind}`,
          eventType: kind,
          kind,
          title: incident.title,
          at: (done ? incident.resolvedAt : incident.updatedAt) || incident.updatedAt || Date.now(),
          status: incident.status,
          statusLabel: done ? '已恢复' : incident.statusLabel || googleImpactLabel(incident.status),
          statusEmoji: done ? '🟢' : incident.statusEmoji || googleImpactEmoji(incident.status),
          impact: incident.status,
          impactLabel: done ? '' : incident.statusLabel || googleImpactLabel(incident.status),
          body: summarizeStatusBody(incident.body, {
            label: incident.statusLabel || googleImpactLabel(incident.status),
            components,
          }),
          components,
          url: incident.url,
          important,
          severityLevel: level,
        }),
      )
    }

    next.incidents[incident.id] = {
      id: incident.id,
      title: incident.title,
      status: incident.status,
      statusLabel: incident.statusLabel,
      updatedAt: incident.updatedAt,
      resolvedAt: incident.resolvedAt,
      importantActive,
      importantResolved,
      baselineActive,
    }
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

function appendStatusLine(lines, event, fallbackLabel = '') {
  const status = String(event?.statusLabel || fallbackLabel || '').trim()
  const impact = String(event?.impactLabel || '').trim()
  const extras = impact && impact !== status ? ` · 影响：${impact}` : ''
  if (status || extras) lines.push(`状态：${status || '未知'}${extras}`)
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
    lines.push(`状态：${event.oldStatusLabel || '未知'} → ${event.newStatusLabel || componentStatusLabel(event.newStatus)}`)
    if (event.body) lines.push(`说明：${truncateText(event.body, 500)}`)
    lines.push(`时间：${time}`)
    if (event.url) lines.push(`详情：${event.url}`)
  } else if (kind === 'recovery' || kind === 'maintenance') {
    const title = kind === 'recovery' ? '服务恢复' : '计划维护'
    lines.push(`【模型状态 · ${title}】${sourceName}`)
    lines.push(`${event.statusEmoji || (kind === 'recovery' ? '🟢' : '🔧')} ${event.title || '状态更新'}`)
    appendStatusLine(lines, event, kind === 'recovery' ? '已恢复' : '维护中')
    const components = formatComponents(event)
    if (components) lines.push(`组件：${components}`)
    if (event.body) lines.push(`进展：${truncateText(event.body, 600)}`)
    lines.push(`时间：${time}`)
    if (event.url) lines.push(`详情：${event.url}`)
  } else if (kind === 'feed') {
    lines.push(`【模型状态 · 状态动态】${sourceName}`)
    lines.push(`🔔 ${event.title || '状态页更新'}`)
    if (event.statusLabel) lines.push(`状态：${event.statusLabel}`)
    if (event.body) lines.push(truncateText(event.body, 700))
    lines.push(`时间：${time}`)
    if (event.url) lines.push(`详情：${event.url}`)
  } else if (kind === 'test') {
    lines.push('【模型状态订阅 · 测试消息】')
    lines.push(event.body || '如果你在群里看到这条消息，说明订阅推送链路已经打通。')
    lines.push(`时间：${time}`)
  } else {
    lines.push(`【模型状态 · 服务异常】${sourceName}`)
    lines.push(`${event.statusEmoji || '🔴'} ${event.title || '服务状态更新'}`)
    appendStatusLine(lines, event, '服务异常')
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

function digestItemText(event) {
  const kind = String(event?.kind || '')
  const components = formatComponents(event, 3)
  if (kind === 'recovery') return `✅ ${event.title || '服务恢复'}${components ? `（${components}）` : ''}`
  if (kind === 'component') {
    return `${event.statusEmoji || '⚪'} ${event.componentName || event.title || '组件'}：${event.oldStatusLabel || '未知'} → ${event.newStatusLabel || componentStatusLabel(event.newStatus)}`
  }
  if (kind === 'maintenance') return `${event.statusEmoji || '🔧'} ${event.title || '计划维护'}（${event.statusLabel || '维护中'}）`
  if (kind === 'feed') return `🔔 ${event.title || '状态动态'}${event.statusLabel ? `（${event.statusLabel}）` : ''}`
  return `${event.statusEmoji || '🔴'} ${event.title || '服务异常'}（${event.statusLabel || '异常'}）${components ? ` — ${components}` : ''}`
}

/**
 * 同一轮检查里同一来源产生多条同类型事件时，合并成一条摘要，
 * 避免一个全局故障把 20+ 个组件的变化拆成 20+ 条消息。
 */
export function formatEventDigestText(events, config = {}) {
  const list = (Array.isArray(events) ? events : []).filter(Boolean)
  if (!list.length) return ''
  if (list.length === 1) return formatEventText(list[0], config)
  const maxChars = Math.max(200, Math.min(4000, Number(config.maxTextChars) || 1200))
  const timeZone = config.timeZone || 'Asia/Shanghai'
  const sourceName = list[0]?.sourceName || '模型状态'
  const kind = String(list[0]?.kind || 'incident')
  const headerMap = {
    incident: '服务异常汇总',
    recovery: '服务恢复',
    maintenance: '计划维护',
    component: '组件状态变化',
    feed: '状态动态',
  }
  const nounMap = {
    incident: '项服务异常',
    recovery: '项服务恢复',
    maintenance: '项维护安排',
    component: '个组件状态变化',
    feed: '条状态动态',
  }
  const emojiMap = {
    incident: '🔴',
    recovery: '✅',
    maintenance: '🔧',
    component: '🔁',
    feed: '🔔',
  }
  const lines = [`【模型状态 · ${headerMap[kind] || '状态汇总'}】${sourceName}`]
  lines.push(`${emojiMap[kind] || '📡'} 共 ${list.length} ${nounMap[kind] || '项变化'}：`)
  const maxItems = Math.max(3, Math.min(8, Math.floor(maxChars / 180)))
  for (const event of list.slice(0, maxItems)) lines.push(`· ${digestItemText(event)}`)
  if (list.length > maxItems) lines.push(`· 其余 ${list.length - maxItems} 项已省略，可到设置页「最近事件」查看。`)

  const at = list.reduce((max, event) => Math.max(max, Number(event?.at) || 0), 0) || Date.now()
  const urls = uniqueBy(
    list.map(event => String(event?.url || '').trim()).filter(Boolean),
    item => item,
  ).slice(0, 2)
  lines.push(`时间：${formatTime(at, timeZone)}`)
  if (urls.length) lines.push(`详情：${urls.join(' ')}`)

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
    important: event?.important === true,
    severityLevel: Number(event?.severityLevel) || 0,
  }
}

