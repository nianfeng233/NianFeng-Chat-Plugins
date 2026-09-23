/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 模型状态订阅 · 后端桥（独立扩展版本，所有依赖都在本扩展目录内）。
 *
 *   GET    /api/model-status/status                         状态 / 配置 / 来源 / 订阅
 *   PUT    /api/model-status/config                         保存轮询参数
 *   GET    /api/model-status/sources                        来源目录 + 最近检查状态
 *   POST   /api/model-status/sources                        新增自定义来源
 *   DELETE /api/model-status/sources/:id                    删除自定义来源
 *   GET    /api/model-status/source/:id/components          来源可用组件 / 产品列表
 *   POST   /api/model-status/source/test                    测试来源并建立基线
 *   PUT    /api/model-status/subscriptions/:channelId       保存渠道订阅
 *   DELETE /api/model-status/subscriptions/:channelId       删除渠道订阅
 *   POST   /api/model-status/poll                           立即检查（支持单来源）
 *   GET    /api/model-status/events                         最近捕获的事件
 *   GET    /api/model-status/notifications                  待投递通知
 *   POST   /api/model-status/notifications/claim            原子认领待投递通知
 *   POST   /api/model-status/notifications/release          释放认领
 *   POST   /api/model-status/notifications/ack              投递结果回执
 *   POST   /api/model-status/test                           创建测试通知
 *
 * 持久化：<数据目录>/model-status.json。
 * 网络：复用扩展内 lib/http.mjs 与 lib/net-guard.mjs，支持全局 / 插件代理，
 *       对自定义 URL 做 SSRF 校验，每一跳重定向都会重新校验。
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  clampNumber,
  formatTime,
  isObject,
  randomToken,
  truncateText,
  uniqueList,
} from './lib/util.mjs'
import { DEFAULT_UA, fetchText } from './lib/http.mjs'
import {
  buildCustomSource,
  findSourceById,
  listAllSources,
  sourceUrlCandidates,
} from './lib/sources.mjs'
import {
  componentStatusLabel,
  incidentStatusLabel,
  isStatusPageSummary,
  parseStatusPageSummary,
  statusPageHistoryFeedUrl,
  statusPageOverallLabel,
  statusPageSummaryUrl,
} from './lib/statuspage.mjs'
import { looksLikeFeed, parseFeed } from './lib/feed.mjs'
import { googleCloudProducts, isGoogleCloudIncidents, parseGoogleCloudIncidents } from './lib/google-cloud.mjs'
import {
  collectFeedEvents,
  collectGoogleCloudEvents,
  collectStatusPageEvents,
  compactEvent,
  eventMatchesSubscription,
  formatEventDigestText,
  formatEventText,
} from './lib/detect.mjs'

export const name = 'model-status-bridge'
export const version = '2.2.0'
export const displayName = '模型状态订阅后端桥'
export const description = '轮询各厂商状态页 / RSS，检测模型服务状态变化并生成渠道通知。'
export const author = '念风扩展'
export const icon = '📡'
export const core = false
export const enabled = true
export const inject = ['settings', 'httpApi', 'hub']
export const provides = [{ name: 'model-status-bridge', type: 'singleton' }]
export const permissions = ['network', 'storage']

const STATE_FILE = 'model-status.json'
const TICK_MS = 5000
const MAX_EVENTS = 200
const MAX_NOTIFICATIONS = 300
const MAX_NOTIFIED_KEYS = 1200
const NOTIFICATION_CLAIM_MS = 2 * 60 * 1000
const MAX_REQUEST_BYTES = 2 * 1024 * 1024

const DEFAULT_CONFIG = {
  pollIntervalMs: 120000,
  requestTimeoutMs: 20000,
  proxy: '',
  timeZone: 'Asia/Shanghai',
  /* important：只推送服务异常 / 质量下降 / 恢复等重要节点；all：保留全部动态。 */
  notifyMode: 'important',
  /* 事件发生到这个时间之前只记入最近事件，不再推送。默认 24 小时。 */
  maxEventAgeMs: 24 * 60 * 60 * 1000,
  /* 通知生成后超过这个时间仍未投递则作废，避免睡醒后一次性刷屏。 */
  maxPendingAgeMs: 30 * 60 * 1000,
  maxTextChars: 1200,
}

const PLUGIN_SCOPE_KEY = 'plugin.scope'

function createDefaultState() {
  return {
    version: 2,
    config: { ...DEFAULT_CONFIG },
    customSources: {},
    subscriptions: {},
    snapshots: {},
    sourcesMeta: {},
    events: [],
    notifications: [],
    notifiedKeys: {},
    seq: 0,
    lastPollAt: 0,
    lastError: '',
  }
}

function sanitizeConfigPatch(patch, current = {}) {
  const next = { ...current }
  if (!isObject(patch)) return next
  const setNumber = (key, min, max) => {
    if (patch[key] !== undefined) {
      next[key] = Math.round(clampNumber(patch[key], min, max, Number(next[key]) || min))
    }
  }
  setNumber('pollIntervalMs', 30 * 1000, 6 * 60 * 60 * 1000)
  setNumber('requestTimeoutMs', 3000, 120000)
  setNumber('maxEventAgeMs', 60 * 1000, 30 * 24 * 60 * 60 * 1000)
  setNumber('maxPendingAgeMs', 60 * 1000, 7 * 24 * 60 * 60 * 1000)
  setNumber('maxTextChars', 200, 4000)
  if (patch.proxy !== undefined) next.proxy = String(patch.proxy || '').trim().slice(0, 500)
  if (patch.notifyMode !== undefined) {
    next.notifyMode = String(patch.notifyMode || '').trim() === 'all' ? 'all' : 'important'
  }
  if (patch.timeZone !== undefined) {
    const value = String(patch.timeZone || '').trim().slice(0, 64) || 'Asia/Shanghai'
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format(new Date())
      next.timeZone = value
    } catch (_) {
      next.timeZone = 'Asia/Shanghai'
    }
  }
  return next
}

function normalizeSubscription(raw, channelId) {
  const input = isObject(raw) ? raw : {}
  const sources = {}
  const incoming = isObject(input.sources) ? input.sources : {}
  for (const [sourceId, item] of Object.entries(incoming)) {
    const key = String(sourceId || '').trim()
    if (!key || !isObject(item)) continue
    sources[key] = {
      enabled: item.enabled !== false,
      components: uniqueList(item.components).slice(0, 200),
      keywords: uniqueList(item.keywords).slice(0, 30),
      events: {
        incident: item.events?.incident !== false,
        maintenance: item.events?.maintenance !== false,
        component: item.events?.component !== false,
      },
    }
  }
  return {
    channelId: String(input.channelId || channelId || '').trim(),
    name: String(input.name || '').slice(0, 120),
    type: String(input.type || '').slice(0, 40),
    tab: String(input.tab || '').slice(0, 40),
    groupName: String(input.groupName || '').slice(0, 120),
    roleId: String(input.roleId || '').slice(0, 200),
    enabled: input.enabled !== false,
    sources,
    updatedAt: Date.now(),
  }
}

function subscriptionSourceIds(subscription, enabledOnly = true) {
  const out = []
  if (!subscription) return out
  if (enabledOnly && subscription.enabled === false) return out
  for (const [sourceId, item] of Object.entries(subscription.sources || {})) {
    if (item?.enabled === false) continue
    out.push(sourceId)
  }
  return out
}

function isJsonText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim()
  return raw.startsWith('{') || raw.startsWith('[')
}

function jsonContentType(response) {
  return /json/i.test(String(response?.contentType || ''))
}

export function apply(ctx) {
  const settings = ctx.settings
  const httpApi = ctx.httpApi
  const hub = ctx.hub

  let state = createDefaultState()
  let closed = false
  let readyResolve = () => {}
  const ready = new Promise(resolve => {
    readyResolve = resolve
  })
  let persistTimer = null
  let persistChain = Promise.resolve()
  let pollTimer = null
  let pollRunning = false
  let pollPromise = null
  let nextPollAt = 0

  const dataDir = () => settings.dataDir || process.cwd()
  const statePath = () => join(dataDir(), STATE_FILE)

  const dataDirReady = async () => {
    await mkdir(dataDir(), { recursive: true })
  }

  /* ------------------------------------------------------------------ */
  /* 持久化                                                              */
  /* ------------------------------------------------------------------ */

  const persistState = () => {
    const task = async () => {
      await dataDirReady()
      const payload = {
        version: 2,
        updatedAt: Date.now(),
        config: state.config,
        customSources: state.customSources,
        subscriptions: state.subscriptions,
        snapshots: state.snapshots,
        sourcesMeta: state.sourcesMeta,
        events: state.events.slice(0, MAX_EVENTS),
        notifications: state.notifications.slice(-MAX_NOTIFICATIONS),
        notifiedKeys: state.notifiedKeys,
        seq: state.seq,
        lastPollAt: state.lastPollAt,
        lastError: state.lastError,
      }
      const tmp = `${statePath()}.${process.pid}.${Date.now().toString(36)}.tmp`
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tmp, statePath())
      await chmod(statePath(), 0o600).catch(() => {})
    }
    persistChain = persistChain.then(task, task)
    return persistChain
  }

  const schedulePersist = () => {
    if (closed || persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistState().catch(error => ctx.logger.warn(`[model-status] 状态写入失败：${error?.message || error}`))
    }, 400)
    persistTimer.unref?.()
  }

  const pruneNotifiedKeys = () => {
    const entries = Object.entries(state.notifiedKeys || {})
    if (entries.length <= MAX_NOTIFIED_KEYS) return
    entries.sort((a, b) => Number(a[1]) - Number(b[1]))
    for (const [key] of entries.slice(0, entries.length - MAX_NOTIFIED_KEYS)) delete state.notifiedKeys[key]
  }

  const trimNotifications = () => {
    if (!Array.isArray(state.notifications)) state.notifications = []
    state.notifications.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0))
    while (state.notifications.length > MAX_NOTIFICATIONS) {
      const index = state.notifications.findIndex(item => item?.delivered === true)
      if (index < 0) break
      state.notifications.splice(index, 1)
    }
    if (state.notifications.length > MAX_NOTIFICATIONS) {
      state.notifications.splice(0, state.notifications.length - MAX_NOTIFICATIONS)
    }
  }

  const notificationExpired = (notification, now = Date.now()) => {
    const maxAge = clampNumber(state.config.maxPendingAgeMs, 60 * 1000, 7 * 24 * 60 * 60 * 1000, DEFAULT_CONFIG.maxPendingAgeMs)
    const at = Number(notification?.at) || 0
    return !!at && now - at > maxAge
  }

  const expireNotification = (notification, now = Date.now(), reason = '超过可投递时限，已自动丢弃') => {
    notification.delivered = true
    notification.deliveredAt = now
    notification.expiredAt = now
    notification.lastError = reason
    notification.claimedAt = 0
    notification.claimedBy = ''
  }

  const loadState = async () => {
    await dataDirReady()
    let raw = null
    try {
      raw = JSON.parse(await readFile(statePath(), 'utf8'))
    } catch (_) {
      raw = null
    }
    const base = createDefaultState()
    if (!isObject(raw)) {
      state = base
      return
    }
    state = {
      ...base,
      config: sanitizeConfigPatch(isObject(raw.config) ? raw.config : {}, { ...DEFAULT_CONFIG }),
      customSources: isObject(raw.customSources) ? { ...raw.customSources } : {},
      subscriptions: {},
      snapshots: isObject(raw.snapshots) ? { ...raw.snapshots } : {},
      sourcesMeta: isObject(raw.sourcesMeta) ? { ...raw.sourcesMeta } : {},
      events: Array.isArray(raw.events) ? raw.events.slice(0, MAX_EVENTS) : [],
      notifications: Array.isArray(raw.notifications) ? raw.notifications.slice(-MAX_NOTIFICATIONS) : [],
      notifiedKeys: isObject(raw.notifiedKeys) ? { ...raw.notifiedKeys } : {},
      seq: Number(raw.seq) || 0,
      lastPollAt: Number(raw.lastPollAt) || 0,
      lastError: String(raw.lastError || ''),
    }
    for (const [channelId, subscription] of Object.entries(isObject(raw.subscriptions) ? raw.subscriptions : {})) {
      state.subscriptions[channelId] = normalizeSubscription(subscription, channelId)
    }
    const now = Date.now()
    let expired = 0
    for (const notification of state.notifications) {
      if (notification?.delivered !== true && notificationExpired(notification, now)) {
        expireNotification(notification, now)
        expired += 1
      }
    }
    // 清理太旧的已投递通知，避免状态文件无限膨胀。
    state.notifications = state.notifications.filter(item => !item?.delivered || now - (Number(item.deliveredAt) || 0) < 7 * 24 * 60 * 60 * 1000)
    pruneNotifiedKeys()
    if (expired) ctx.logger.info(`[model-status] 已清理 ${expired} 条过期待投递通知`)
    ctx.logger.info(`[model-status] 已加载：${Object.keys(state.subscriptions).length} 个渠道订阅 · ${Object.keys(state.customSources).length} 个自定义来源`)
  }

  readyResolve(loadState().catch(error => {
    state.lastError = String(error?.message || error)
    ctx.logger.error(`[model-status] 初始化失败：${error?.stack || error?.message || error}`)
  }))

  const refreshReady = () => {
    // ready promise 已经在启动时 resolve；实际数据在 await 之后一定可用。
    return ready
  }

  /* ------------------------------------------------------------------ */
  /* 来源与网络                                                          */
  /* ------------------------------------------------------------------ */

  const resolveSource = id => findSourceById(id, state.customSources)

  const allSources = () => listAllSources(state.customSources)

  const proxyOf = () => {
    const configured = String(state.config.proxy || '').trim()
    if (configured) return configured
    try {
      const globalProxy = String(settings.get?.()?.network?.proxy || '').trim()
      if (globalProxy) return globalProxy
    } catch (_) {
      /* ignore */
    }
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy ||
      ''
    )
  }

  const requestTimeout = () => clampNumber(state.config.requestTimeoutMs, 3000, 120000, DEFAULT_CONFIG.requestTimeoutMs)

  const candidateUrlsFor = (source, previous) => {
    const out = []
    const push = value => {
      const url = String(value || '').trim()
      if (url && !out.includes(url)) out.push(url)
    }
    if (previous?.endpoint) push(previous.endpoint)
    switch (source.adapter) {
      case 'statuspage':
        push(statusPageSummaryUrl(source.url))
        push(statusPageHistoryFeedUrl(source.url))
        push(`${String(source.url || '').replace(/\/+$/, '')}/feed.xml`)
        break
      case 'rss':
      case 'google-cloud':
        push(source.url)
        break
      default:
        for (const url of sourceUrlCandidates(source, previous)) push(url)
        break
    }
    push(source.url)
    return out
  }

  const requestCandidate = async url =>
    fetchText(url, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, application/rss+xml, application/atom+xml, text/xml, text/plain, */*',
      },
      proxy: proxyOf(),
      timeoutMs: requestTimeout(),
      maxBytes: MAX_REQUEST_BYTES,
    })

  const probeCandidate = async (source, url) => {
    const response = await requestCandidate(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = String(response.text || '')
    if (looksLikeFeed(text)) {
      return { adapter: 'rss', endpoint: response.url || url, parsed: parseFeed(text, source) }
    }
    if (jsonContentType(response) || isJsonText(text)) {
      let data = null
      try {
        data = JSON.parse(text)
      } catch (_) {
        throw new Error('返回 JSON 无法解析')
      }
      if (isGoogleCloudIncidents(data)) {
        return { adapter: 'google-cloud', endpoint: response.url || url, parsed: parseGoogleCloudIncidents(data, source) }
      }
      if (isStatusPageSummary(data)) {
        return { adapter: 'statuspage', endpoint: response.url || url, parsed: parseStatusPageSummary(data, source) }
      }
      throw new Error('JSON 不是 Statuspage summary 或 Google Cloud incidents 格式')
    }
    throw new Error('目标不是 Statuspage JSON / RSS 数据')
  }

  const loadSourceWithFallback = async (source, previous = null) => {
    const candidates = candidateUrlsFor(source, previous)
    let lastError = null
    for (const url of candidates) {
      try {
        const loaded = await probeCandidate(source, url)
        return loaded
      } catch (error) {
        lastError = error
        ctx.logger.debug(`[model-status] ${source.id} 候选地址失败：${truncateText(url, 120)} · ${error?.message || error}`)
      }
    }
    throw lastError || new Error('没有可用的状态地址')
  }

  const detectLoaded = (source, loaded, previous) => {
    const usablePrevious = previous && previous.adapter === loaded.adapter ? previous : null
    if (loaded.adapter === 'statuspage') {
      return {
        ...collectStatusPageEvents({ source, parsed: loaded.parsed, previous: usablePrevious, endpoint: loaded.endpoint }),
        summary: loaded.parsed,
      }
    }
    if (loaded.adapter === 'rss') {
      return {
        ...collectFeedEvents({ source, feed: loaded.parsed, previous: usablePrevious, endpoint: loaded.endpoint }),
        summary: loaded.parsed,
      }
    }
    return {
      ...collectGoogleCloudEvents({ source, parsed: loaded.parsed, previous: usablePrevious, endpoint: loaded.endpoint }),
      summary: loaded.parsed,
    }
  }

  const summarizeLoaded = (source, loaded) => {
    if (loaded.adapter === 'statuspage') {
      const parsed = loaded.parsed
      return {
        adapter: 'statuspage',
        pageName: parsed.page?.name || source.name,
        overallStatus: parsed.overall?.description || parsed.overall?.indicator || '',
        componentCount: parsed.components.length,
        activeIncidents: parsed.incidents.filter(item => item.status !== 'resolved').length,
        maintenanceCount: parsed.maintenances.filter(item => item.status !== 'completed').length,
        components: parsed.components.map(item => ({
          id: item.id,
          name: item.name,
          status: item.status,
          statusLabel: item.statusLabel,
          group: item.group,
          isGroup: !!item.isGroup,
        })),
        incidents: parsed.incidents.slice(0, 10).map(item => ({
          id: item.id,
          name: item.name,
          status: item.status,
          statusLabel: item.statusLabel,
          impactLabel: item.impactLabel,
          updatedAt: item.updatedAt,
        })),
      }
    }
    if (loaded.adapter === 'google-cloud') {
      return {
        adapter: 'google-cloud',
        pageName: loaded.parsed.page?.name || source.name,
        overallStatus: '',
        componentCount: googleCloudProducts(loaded.parsed, source).length,
        activeIncidents: loaded.parsed.incidents.filter(item => !item.resolvedAt).length,
        maintenanceCount: 0,
        components: googleCloudProducts(loaded.parsed, source).map(item => ({ id: item.id, name: item.name })),
        incidents: loaded.parsed.incidents.slice(0, 10).map(item => ({
          id: item.id,
          name: item.title,
          status: item.status,
          statusLabel: item.statusLabel,
          updatedAt: item.updatedAt,
        })),
      }
    }
    return {
      adapter: 'rss',
      pageName: loaded.parsed.page?.name || source.name,
      overallStatus: '',
      componentCount: 0,
      activeIncidents: 0,
      maintenanceCount: 0,
      components: [],
      incidents: [],
      itemCount: loaded.parsed.items.length,
    }
  }

  const componentsFor = async source => {
    const previous = state.snapshots[source.id]
    const loaded = await loadSourceWithFallback(source, previous)
    const summary = summarizeLoaded(source, loaded)
    return { adapter: loaded.adapter, components: summary.components || [] }
  }

  /* ------------------------------------------------------------------ */
  /* 事件检测与通知                                                      */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* 模型状态查询（工具 / API 共用）                                     */
  /* ------------------------------------------------------------------ */

  const queryCache = new Map()

  const resolveSourceHint = hint => {
    const key = String(hint || '').trim().toLowerCase()
    const list = allSources()
    if (!key) return { source: null, matches: list, exact: false }
    const exact = list.find(source =>
      [source.id, source.name, source.vendor]
        .filter(Boolean)
        .some(value => String(value).toLowerCase() === key),
    )
    if (exact) return { source: exact, matches: [exact], exact: true }
    const matches = list.filter(source => {
      const haystack = [source.id, source.name, source.vendor, source.description, ...(Array.isArray(source.keywords) ? source.keywords : [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(key)
    })
    return { source: matches.length === 1 ? matches[0] : null, matches, exact: false }
  }

  const queryKeywordMatches = (keyword, ...values) => {
    if (!keyword) return true
    const wanted = String(keyword).toLowerCase()
    return values
      .flatMap(value => (Array.isArray(value) ? value : [value]))
      .filter(value => value !== undefined && value !== null)
      .map(value => String(value).toLowerCase())
      .some(value => value.includes(wanted))
  }

  const publicSourceInfo = source => {
    const meta = state.sourcesMeta[source.id] || null
    return {
      id: source.id,
      name: source.name,
      vendor: source.vendor || '',
      emoji: source.emoji || '📡',
      category: source.category || '',
      adapter: source.adapter || 'auto',
      url: source.url || '',
      homepage: source.homepage || source.url || '',
      description: source.description || '',
      confidence: source.confidence || 'community',
      subscribed: Object.values(state.subscriptions).some(
        subscription => subscription.enabled !== false && subscription.sources?.[source.id]?.enabled !== false,
      ),
      meta: meta
        ? {
            lastCheckedAt: Number(meta.lastCheckedAt) || 0,
            lastError: String(meta.lastError || ''),
            pageName: String(meta.pageName || ''),
            overallStatus: String(meta.overallStatus || ''),
          }
        : null,
    }
  }

  const querySourceStatus = async (source, keyword = '') => {
    const cacheKey = `${source.id}:${String(keyword || '').trim().toLowerCase()}`
    const ttl = Math.max(15000, Math.min(5 * 60 * 1000, effectiveIntervalMs()))
    const cached = queryCache.get(cacheKey)
    if (cached && Date.now() - Number(cached.at || 0) < ttl) return cached.data

    const loaded = await loadSourceWithFallback(source, state.snapshots[source.id])
    const timeZone = state.config.timeZone || 'Asia/Shanghai'
    const nowText = formatTime(Date.now(), timeZone)
    const lines = []
    let data = null

    if (loaded.adapter === 'statuspage') {
      const parsed = loaded.parsed
      const keywordMatches = incident =>
        queryKeywordMatches(
          keyword,
          incident.name,
          incident.latestBody,
          ...(incident.components || []).flatMap(component => [component.id, component.name]),
        )
      const componentMatches = component => queryKeywordMatches(keyword, component.id, component.name, component.description)
      const components = (parsed.components || []).filter(component => !component.isGroup && componentMatches(component))
      const visibleComponents = components.length ? components : (parsed.components || []).filter(component => !component.isGroup)
      const incidents = (parsed.incidents || []).filter(incident => incident.status !== 'resolved' && keywordMatches(incident)).slice(0, 12)
      const resolved = (parsed.incidents || []).filter(incident => incident.status === 'resolved' && keywordMatches(incident)).slice(0, 5)
      const maintenances = (parsed.maintenances || []).filter(item => item.status !== 'completed' && keywordMatches(item)).slice(0, 8)
      const overallStatus = statusPageOverallLabel(parsed.overall) || parsed.overall?.description || ''
      lines.push(`【${source.name} 官方状态】`)
      lines.push(`页面：${parsed.page?.name || source.name}`)
      if (overallStatus) lines.push(`整体：${overallStatus}`)
      if (keyword) lines.push(`筛选：${keyword}`)
      if (visibleComponents.length) {
        lines.push('组件：')
        for (const component of visibleComponents.slice(0, 15)) {
          lines.push(`- ${component.name}：${component.statusLabel || componentStatusLabel(component.status)}${component.group ? `（${component.group}）` : ''}`)
        }
      }
      if (incidents.length) {
        lines.push('进行中事件：')
        for (const incident of incidents) {
          lines.push(`- ${incident.name}：${incident.statusLabel || incidentStatusLabel(incident.status)}${incident.impactLabel ? ` · 影响：${incident.impactLabel}` : ''}`)
          if (incident.latestBody) lines.push(`  最新：${truncateText(incident.latestBody, 320)}`)
          if (incident.shortlink) lines.push(`  详情：${incident.shortlink}`)
        }
      } else {
        lines.push('进行中事件：无公开故障。')
      }
      if (maintenances.length) {
        lines.push('计划维护：')
        for (const item of maintenances) {
          lines.push(`- ${item.name}：${item.statusLabel || item.status}${item.scheduledFor ? ` · ${formatTime(item.scheduledFor, timeZone)}` : ''}`)
        }
      }
      if (resolved.length && !keyword) {
        lines.push('最近恢复：')
        for (const item of resolved) lines.push(`- ${item.name}（${formatTime(item.updatedAt || item.resolvedAt, timeZone)}）`)
      }
      data = {
        adapter: 'statuspage',
        pageName: parsed.page?.name || source.name,
        overallStatus,
        components: visibleComponents.slice(0, 60).map(component => ({
          id: component.id,
          name: component.name,
          status: component.status,
          statusLabel: component.statusLabel || componentStatusLabel(component.status),
          group: component.group || '',
        })),
        incidents: incidents.map(incident => ({
          id: incident.id,
          name: incident.name,
          status: incident.status,
          statusLabel: incident.statusLabel,
          impact: incident.impact,
          impactLabel: incident.impactLabel,
          updatedAt: incident.updatedAt,
          body: truncateText(incident.latestBody || '', 600),
          url: incident.shortlink || '',
          components: (incident.components || []).map(component => ({ id: component.id, name: component.name })),
        })),
        maintenances: maintenances.map(item => ({
          id: item.id,
          name: item.name,
          status: item.status,
          statusLabel: item.statusLabel,
          scheduledFor: item.scheduledFor,
          scheduledUntil: item.scheduledUntil,
        })),
      }
    } else if (loaded.adapter === 'rss') {
      const items = (loaded.parsed.items || [])
        .filter(item => queryKeywordMatches(keyword, item.title, item.body, item.url))
        .slice(0, 12)
      lines.push(`【${source.name} 官方动态】`)
      if (keyword) lines.push(`筛选：${keyword}`)
      if (!items.length) {
        lines.push('没有匹配的动态。')
      } else {
        lines.push('最近动态：')
        for (const item of items) {
          lines.push(`- ${item.title || '状态更新'}${item.publishedAt ? `（${formatTime(item.publishedAt, timeZone)}）` : ''}`)
          if (item.body && item.body !== item.title) lines.push(`  ${truncateText(item.body, 220)}`)
          if (item.url) lines.push(`  详情：${item.url}`)
        }
      }
      data = {
        adapter: 'rss',
        pageName: loaded.parsed.page?.name || source.name,
        overallStatus: '',
        components: [],
        incidents: [],
        maintenances: [],
        items: items.map(item => ({
          id: item.id,
          title: item.title,
          body: truncateText(item.body || '', 600),
          url: item.url || '',
          publishedAt: item.publishedAt || 0,
        })),
      }
    } else {
      const parsed = loaded.parsed
      const matchIncident = incident =>
        queryKeywordMatches(
          keyword,
          incident.title,
          incident.body,
          ...(incident.components || []).flatMap(component => [component.id, component.name]),
        )
      const active = (parsed.incidents || []).filter(incident => !incident.resolvedAt && matchIncident(incident)).slice(0, 12)
      const resolved = (parsed.incidents || []).filter(incident => incident.resolvedAt && matchIncident(incident)).slice(0, 5)
      const products = googleCloudProducts(parsed, source).filter(product => queryKeywordMatches(keyword, product.id, product.name))
      lines.push(`【${source.name} 官方状态】`)
      if (keyword) lines.push(`筛选：${keyword}`)
      if (products.length) {
        lines.push(`相关产品：${products.slice(0, 12).map(product => product.name || product.id).join('、')}`)
      }
      if (active.length) {
        lines.push('进行中事件：')
        for (const incident of active) {
          lines.push(`- ${incident.title}：${incident.statusLabel || incident.status}${incident.resolvedAt ? '' : ''}`)
          if (incident.body) lines.push(`  最新：${truncateText(incident.body, 320)}`)
          if (incident.url) lines.push(`  详情：${incident.url}`)
        }
      } else {
        lines.push('进行中事件：无公开故障。')
      }
      if (resolved.length && !keyword) {
        lines.push('最近恢复：')
        for (const incident of resolved) lines.push(`- ${incident.title}（${formatTime(incident.resolvedAt, timeZone)}）`)
      }
      data = {
        adapter: 'google-cloud',
        pageName: parsed.page?.name || source.name,
        overallStatus: '',
        components: products.slice(0, 80).map(product => ({ id: product.id, name: product.name, status: '', statusLabel: '' })),
        incidents: active.map(incident => ({
          id: incident.id,
          name: incident.title,
          status: incident.status,
          statusLabel: incident.statusLabel,
          impactLabel: incident.statusLabel,
          updatedAt: incident.updatedAt,
          body: truncateText(incident.body || '', 600),
          url: incident.url || '',
          components: (incident.components || []).map(component => ({ id: component.id, name: component.name })),
        })),
        maintenances: [],
      }
    }

    lines.push(`数据时间：${nowText}`)
    const text = truncateText(lines.filter(Boolean).join('\n'), 2600)
    const result = {
      source: {
        id: source.id,
        name: source.name,
        vendor: source.vendor || '',
        emoji: source.emoji || '📡',
        adapter: loaded.adapter,
        url: source.url || '',
        homepage: source.homepage || source.url || '',
      },
      endpoint: loaded.endpoint,
      fetchedAt: Date.now(),
      text,
      ...data,
    }
    queryCache.set(cacheKey, { at: Date.now(), data: result })
    return result
  }
  const eventTooOld = event => {
    const maxAge = clampNumber(state.config.maxEventAgeMs, 60 * 1000, 30 * 24 * 60 * 60 * 1000, DEFAULT_CONFIG.maxEventAgeMs)
    const at = Number(event?.at) || 0
    if (!at) return false
    return Date.now() - at > maxAge
  }

  const alreadyNotified = key => Boolean(key && state.notifiedKeys[key])

  const rememberNotified = key => {
    if (!key) return
    state.notifiedKeys[key] = Date.now()
    pruneNotifiedKeys()
  }

  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)

  const sharedPluginScopeAllows = ({ channelId = '', roleId = '' } = {}) => {
    let entry = null
    try {
      const all = settings.get?.()?.preferences?.[PLUGIN_SCOPE_KEY]
      entry = isObject(all) && isObject(all['model-status']) ? all['model-status'] : null
    } catch (_) {
      entry = null
    }
    if (!entry) return true
    const channels = isObject(entry.channels) ? entry.channels : {}
    const roles = isObject(entry.roles) ? entry.roles : {}
    const channelKey = String(channelId || '')
    if (channelKey && hasOwn(channels, channelKey)) return channels[channelKey] !== false
    const roleKey = String(roleId || '')
    if (roleKey && hasOwn(roles, roleKey)) return roles[roleKey] !== false
    if (entry.default === 'none') {
      if (roleKey) return false
      if (!Object.keys(roles).length) return false
    }
    return true
  }

  const makeNotification = ({ channel, event, text, kind = '' }) => {
    const channelId = String(channel?.channelId || channel?.id || '')
    const roleId = String(channel?.roleId || '')
    if (!channelId) return null
    if (!sharedPluginScopeAllows({ channelId, roleId })) return null
    const seq = (Number(state.seq) || 0) + 1
    state.seq = seq
    const notification = {
      id: `ms_${seq}_${randomToken(4)}`,
      seq,
      at: Date.now(),
      kind: kind || event?.kind || 'event',
      event: compactEvent(event || {}),
      target: {
        channelId,
        roleId,
        channelName: String(channel?.name || ''),
        channelType: String(channel?.type || ''),
        sourceId: String(event?.sourceId || ''),
        eventId: String(event?.id || ''),
        text: String(text || ''),
      },
      delivered: false,
      attempts: 0,
      lastError: '',
      nextAttemptAt: 0,
      claimedAt: 0,
      claimedBy: '',
    }
    state.notifications.push(notification)
    trimNotifications()
    return notification
  }

  const broadcastNotifications = list => {
    const notifications = (Array.isArray(list) ? list : []).filter(Boolean)
    if (!notifications.length) return
    try {
      hub.broadcast('model-status:event', { kind: 'notifications', notifications, seq: state.seq, at: Date.now() })
    } catch (error) {
      ctx.logger.debug(`[model-status] 广播通知失败：${error?.message || error}`)
    }
  }

  const broadcastConfigChanged = () => {
    try {
      hub.broadcast('model-status:event', { kind: 'config', at: Date.now() })
    } catch (_) {
      /* ignore */
    }
  }

  const notificationGroupOf = event => {
    const kind = String(event?.kind || 'incident')
    if (kind === 'recovery' || kind === 'maintenance' || kind === 'component' || kind === 'feed') return kind
    return 'incident'
  }

  const notifyModeAllows = event => {
    if (state.config?.notifyMode === 'all') return true
    return event?.important === true
  }

  const notifySubscribers = (input, source) => {
    const events = (Array.isArray(input) ? input : [input]).filter(Boolean)
    const created = []
    if (!events.length) return created

    for (const subscription of Object.values(state.subscriptions)) {
      if (!subscription || subscription.enabled === false) continue
      if (!sharedPluginScopeAllows({ channelId: subscription.channelId, roleId: subscription.roleId })) continue

      const groups = new Map()
      for (const event of events) {
        const item = subscription.sources?.[event.sourceId]
        if (!item || item.enabled === false) continue
        if (!eventMatchesSubscription(event, item)) continue
        if (!notifyModeAllows(event)) continue
        const key = `${subscription.channelId}:${event.id}`
        if (alreadyNotified(key)) continue
        const groupKey = `${event.sourceId}:${notificationGroupOf(event)}`
        if (!groups.has(groupKey)) groups.set(groupKey, [])
        groups.get(groupKey).push(event)
      }

      for (const group of groups.values()) {
        group.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
        const first = group[0]
        const text = group.length === 1 ? formatEventText(first, state.config) : formatEventDigestText(group, state.config)
        const kind = notificationGroupOf(first)
        const notification = makeNotification({
          channel: {
            channelId: subscription.channelId,
            roleId: subscription.roleId,
            name: subscription.name,
            type: subscription.type,
          },
          event: group.length === 1 ? first : { ...first, batchCount: group.length, batchIds: group.map(item => item.id).slice(0, 20) },
          text,
          kind,
        })
        if (!notification) continue
        if (group.length > 1) {
          notification.batch = {
            count: group.length,
            kind,
            ids: group.map(item => item.id).slice(0, 20),
          }
        }
        created.push(notification)
        for (const event of group) rememberNotified(`${subscription.channelId}:${event.id}`)
      }
    }

    if (created.length) {
      trimNotifications()
      schedulePersist()
      broadcastNotifications(created)
      ctx.logger.info(`[model-status] ${source?.name || events[0].sourceName || events[0].sourceId} 事件已生成 ${created.length} 条渠道通知`)
    }
    return created
  }

  const cancelPendingNotificationsForChannel = (channelId, { sourceId = '', all = false, reason = '' } = {}) => {
    const targetChannel = String(channelId || '')
    if (!targetChannel) return []
    const wantedSource = String(sourceId || '')
    const now = Date.now()
    const ids = []
    for (const notification of state.notifications) {
      if (!notification || notification.delivered === true) continue
      if (String(notification.target?.channelId || '') !== targetChannel) continue
      if (!all && wantedSource && String(notification.target?.sourceId || '') !== wantedSource) continue
      notification.delivered = true
      notification.deliveredAt = now
      notification.canceledAt = now
      notification.lastError = String(reason || '订阅已变更，待投递通知已取消').slice(0, 300)
      notification.claimedAt = 0
      notification.claimedBy = ''
      ids.push(String(notification.id || ''))
    }
    if (ids.length) {
      try {
        hub.broadcast('model-status:event', { kind: 'canceled', ids, at: now })
      } catch (_) {
        /* ignore */
      }
      schedulePersist()
    }
    return ids
  }

  const cancelStalePendingForSubscription = subscription => {
    const channelId = String(subscription?.channelId || '')
    if (!channelId) return
    if (subscription.enabled === false) {
      cancelPendingNotificationsForChannel(channelId, { all: true, reason: '渠道订阅已关闭' })
      return
    }
    for (const notification of state.notifications) {
      if (!notification || notification.delivered === true) continue
      if (String(notification.target?.channelId || '') !== channelId) continue
      const item = subscription.sources?.[notification.target?.sourceId]
      if (!item || item.enabled === false) {
        cancelPendingNotificationsForChannel(channelId, {
          sourceId: notification.target?.sourceId,
          reason: '该来源订阅已移除，待投递通知已取消',
        })
      }
    }
  }

  const claimPendingNotifications = ({ owner = '', ids = [], limit = 20 } = {}) => {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(value => String(value || '')).filter(Boolean))
    const now = Date.now()
    const claimed = []
    let expired = 0
    const list = state.notifications.filter(item => item && item.delivered !== true).sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
    for (const notification of list) {
      if (claimed.length >= limit) break
      if (wanted.size && !wanted.has(String(notification.id || ''))) continue
      if (!sharedPluginScopeAllows({ channelId: notification.target?.channelId, roleId: notification.target?.roleId })) {
        expireNotification(notification, now, '插件未在当前角色 / 渠道启用，已丢弃')
        expired += 1
        continue
      }
      const claimedAt = Number(notification.claimedAt) || 0
      const claimedBy = String(notification.claimedBy || '')
      if (claimedAt && now - claimedAt <= NOTIFICATION_CLAIM_MS && claimedBy && claimedBy !== String(owner || '')) continue
      if (notificationExpired(notification, now)) {
        expireNotification(notification, now)
        expired += 1
        continue
      }
      if (Number(notification.nextAttemptAt) > now) continue
      notification.claimedAt = now
      notification.claimedBy = String(owner || 'anonymous').slice(0, 120)
      claimed.push(notification)
    }
    if (claimed.length || expired) schedulePersist()
    return claimed
  }

  const releaseNotificationClaims = ({ owner = '', ids = [] } = {}) => {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(value => String(value || '')).filter(Boolean))
    const claimedBy = String(owner || '')
    if (!claimedBy) return 0
    let released = 0
    for (const notification of state.notifications) {
      if (!notification || notification.delivered === true) continue
      if (wanted.size && !wanted.has(String(notification.id || ''))) continue
      if (String(notification.claimedBy || '') !== claimedBy) continue
      notification.claimedAt = 0
      notification.claimedBy = ''
      released += 1
    }
    if (released) schedulePersist()
    return released
  }

  /* ------------------------------------------------------------------ */
  /* 轮询                                                                */
  /* ------------------------------------------------------------------ */

  const activeSourceIds = () => {
    const out = []
    for (const subscription of Object.values(state.subscriptions)) {
      for (const sourceId of subscriptionSourceIds(subscription, true)) {
        if (!out.includes(sourceId)) out.push(sourceId)
      }
    }
    return out
  }

  const effectiveIntervalMs = () => clampNumber(state.config.pollIntervalMs, 30 * 1000, 6 * 60 * 60 * 1000, DEFAULT_CONFIG.pollIntervalMs)

  const updateMetaSuccess = (source, loaded, summary, detectResult) => {
    const previous = state.sourcesMeta[source.id] || {}
    state.sourcesMeta[source.id] = {
      ...previous,
      id: source.id,
      name: source.name,
      adapter: loaded.adapter,
      endpoint: loaded.endpoint,
      lastCheckedAt: Date.now(),
      lastOkAt: Date.now(),
      lastError: '',
      failures: 0,
      nextAllowedAt: 0,
      pageName: summary.pageName || loaded.parsed?.page?.name || source.name,
      overallStatus: summary.overallStatus || '',
      componentCount: Number(summary.componentCount) || 0,
      activeIncidents: Number(summary.activeIncidents) || 0,
      maintenanceCount: Number(summary.maintenanceCount) || 0,
      itemCount: Number(summary.itemCount) || 0,
      eventCount: Array.isArray(detectResult?.events) ? detectResult.events.length : 0,
      seed: !!detectResult?.seed,
    }
  }

  const updateMetaError = (source, error) => {
    const previous = state.sourcesMeta[source.id] || {}
    const failures = (Number(previous.failures) || 0) + 1
    const backoff = Math.min(effectiveIntervalMs() * 2 ** Math.min(failures, 5), 30 * 60 * 1000)
    state.sourcesMeta[source.id] = {
      ...previous,
      id: source.id,
      name: source.name,
      lastCheckedAt: Date.now(),
      lastError: truncateText(String(error?.message || error || '未知错误'), 300),
      failures,
      nextAllowedAt: Date.now() + backoff,
    }
  }

  const pollSource = async (source, { notify = true } = {}) => {
    const previous = state.snapshots[source.id]
    const loaded = await loadSourceWithFallback(source, previous)
    const detectResult = detectLoaded(source, loaded, previous)
    const summary = summarizeLoaded(source, loaded)
    state.snapshots[source.id] = detectResult.snapshot
    updateMetaSuccess(source, loaded, summary, detectResult)

    let eventCount = 0
    let notificationCount = 0
    if (notify && Array.isArray(detectResult.events) && detectResult.events.length) {
      const fresh = []
      for (const event of detectResult.events) {
        const tooOld = eventTooOld(event)
        state.events.unshift({ ...compactEvent(event), suppressed: tooOld, capturedAt: Date.now() })
        if (!tooOld) fresh.push(event)
      }
      state.events = state.events.slice(0, MAX_EVENTS)
      eventCount = fresh.length
      if (fresh.length) notificationCount += notifySubscribers(fresh, source).length
      if (fresh.length) {
        try {
          hub.broadcast('model-status:event', { kind: 'events', events: fresh.map(compactEvent), at: Date.now() })
        } catch (_) {
          /* ignore */
        }
      }
    } else if (detectResult.events?.length) {
      for (const event of detectResult.events) {
        state.events.unshift({ ...compactEvent(event), suppressed: true, capturedAt: Date.now(), reason: 'seed-or-manual' })
      }
      state.events = state.events.slice(0, MAX_EVENTS)
    }
    schedulePersist()
    return { ok: true, source, adapter: loaded.adapter, endpoint: loaded.endpoint, summary, events: detectResult.events || [], notificationCount, eventCount, seed: !!detectResult.seed }
  }

  const pollSourceSafe = async (sourceId, options = {}) => {
    const source = resolveSource(sourceId)
    if (!source) return { ok: false, sourceId, error: `来源不存在：${sourceId}` }
    try {
      return await pollSource(source, options)
    } catch (error) {
      updateMetaError(source, error)
      state.lastError = `${source.name || sourceId}：${error?.message || error}`
      schedulePersist()
      ctx.logger.debug(`[model-status] ${sourceId} 检查失败：${error?.message || error}`)
      return { ok: false, sourceId, error: String(error?.message || error) }
    }
  }

  const pollAll = ({ reason = 'schedule', sourceIds = null, ignoreBackoff = false } = {}) => {
    if (pollRunning) return pollPromise
    pollRunning = true
    const ids = Array.isArray(sourceIds) ? [...new Set(sourceIds.map(String).filter(Boolean))] : activeSourceIds()
    pollPromise = (async () => {
      const interval = effectiveIntervalMs()
      nextPollAt = Date.now() + interval
      const candidates = ids
        .map(id => resolveSource(id))
        .filter(Boolean)
        .filter(source => {
          if (ignoreBackoff || reason === 'manual') return true
          const meta = state.sourcesMeta[source.id]
          return !meta?.nextAllowedAt || Date.now() >= Number(meta.nextAllowedAt)
        })
      state.lastPollAt = Date.now()
      if (!candidates.length) {
        schedulePersist()
        return { ok: true, checked: 0, failed: 0, notifications: 0, events: 0, reason }
      }
      const queue = [...candidates]
      const results = []
      const workerCount = Math.max(1, Math.min(4, queue.length))
      const workers = Array.from({ length: workerCount }, async () => {
        while (queue.length && !closed) {
          const source = queue.shift()
          if (!source) break
          results.push(await pollSourceSafe(source.id, { notify: true }))
        }
      })
      await Promise.all(workers)
      const failed = results.filter(item => item?.ok === false).length
      const notifications = results.reduce((sum, item) => sum + (Number(item?.notificationCount) || 0), 0)
      const events = results.reduce((sum, item) => sum + (Number(item?.eventCount) || 0), 0)
      state.lastError = failed ? results.find(item => item?.ok === false)?.error || '部分来源检查失败' : ''
      schedulePersist()
      ctx.logger.info(`[model-status] ${reason === 'manual' ? '手动' : '定时'}检查完成：${results.length - failed}/${results.length} 成功 · ${events} 条新事件 · ${notifications} 条通知`)
      try {
        hub.broadcast('model-status:event', {
          kind: 'poll',
          at: Date.now(),
          checked: results.length,
          failed,
          events,
          notifications,
          reason,
        })
      } catch (_) {
        /* ignore */
      }
      return { ok: true, checked: results.length, failed, events, notifications, reason, results }
    })().finally(() => {
      pollRunning = false
      pollPromise = null
    })
    return pollPromise
  }

  const kickPoll = (delay = 600) => {
    const at = Date.now() + delay
    if (!nextPollAt || at < nextPollAt) nextPollAt = at
  }

  /* ------------------------------------------------------------------ */
  /* 路由                                                               */
  /* ------------------------------------------------------------------ */

  const safeRoute = (method, path, handler) =>
    httpApi.route(method, path, async (req, res, params, url) => {
      try {
        await refreshReady()
        await handler(req, res, params, url)
      } catch (error) {
        ctx.logger.warn(`[model-status] ${method} ${url?.pathname || path} 失败：${error?.message || error}`)
        if (!res.headersSent) {
          httpApi.sendJson(res, Number(error?.status) || 500, { ok: false, error: String(error?.message || error) })
        } else {
          try {
            res.end()
          } catch (_) {
            /* ignore */
          }
        }
      }
    })

  const publicConfig = () => ({ ...state.config })
  const subscriptionsPayload = () => state.subscriptions
  const sourcesPayload = () =>
    allSources().map(item => {
      const meta = state.sourcesMeta[item.id] || null
      const subscribed = Object.values(state.subscriptions).some(
        subscription => subscription.enabled !== false && subscription.sources?.[item.id]?.enabled !== false,
      )
      return { ...item, subscribed, meta }
    })

  const routes = [
    safeRoute('GET', '/api/model-status/status', async (req, res) => {
      const pending = state.notifications.filter(item => item && item.delivered !== true).length
      httpApi.sendJson(res, 200, {
        ok: true,
        version,
        config: publicConfig(),
        sources: sourcesPayload(),
        subscriptions: subscriptionsPayload(),
        stats: {
          lastPollAt: state.lastPollAt,
          nextPollAt,
          polling: pollRunning,
          activeSourceIds: activeSourceIds(),
          eventCount: state.events.length,
          pendingNotifications: pending,
          customSourceCount: Object.keys(state.customSources).length,
          lastError: state.lastError,
        },
      })
    }),

    safeRoute('PUT', '/api/model-status/config', async (req, res) => {
      const body = await httpApi.readBody(req)
      state.config = sanitizeConfigPatch(body, state.config)
      nextPollAt = 0
      schedulePersist()
      broadcastConfigChanged()
      httpApi.sendJson(res, 200, { ok: true, config: publicConfig() })
    }),

    safeRoute('GET', '/api/model-status/sources', async (req, res) => {
      httpApi.sendJson(res, 200, { ok: true, sources: sourcesPayload() })
    }),

    safeRoute('POST', '/api/model-status/sources', async (req, res) => {
      const body = await httpApi.readBody(req)
      const source = buildCustomSource(body, Object.keys(state.customSources))
      state.customSources[source.id] = source
      schedulePersist()
      broadcastConfigChanged()
      httpApi.sendJson(res, 200, { ok: true, source })
    }),

    safeRoute('DELETE', '/api/model-status/sources/:id', async (req, res, params) => {
      const id = String(params.id || '')
      const source = state.customSources[id]
      if (!source) {
        httpApi.sendJson(res, 200, { ok: false, error: '只能删除自定义来源' })
        return
      }
      delete state.customSources[id]
      delete state.snapshots[id]
      delete state.sourcesMeta[id]
      for (const subscription of Object.values(state.subscriptions)) {
        if (!subscription.sources?.[id]) continue
        delete subscription.sources[id]
        cancelPendingNotificationsForChannel(subscription.channelId, { sourceId: id, reason: '来源已删除，待投递通知已取消' })
      }
      schedulePersist()
      broadcastConfigChanged()
      httpApi.sendJson(res, 200, { ok: true, removed: id })
    }),

    safeRoute('GET', '/api/model-status/source/:id/components', async (req, res, params) => {
      const source = resolveSource(params.id)
      if (!source) {
        httpApi.sendJson(res, 200, { ok: false, error: '来源不存在' })
        return
      }
      try {
        const result = await componentsFor(source)
        httpApi.sendJson(res, 200, { ok: true, sourceId: source.id, ...result })
      } catch (error) {
        httpApi.sendJson(res, 200, { ok: false, error: String(error?.message || error) })
      }
    }),

    safeRoute('POST', '/api/model-status/source/test', async (req, res) => {
      const body = await httpApi.readBody(req)
      const source = resolveSource(body.sourceId)
      if (!source) {
        httpApi.sendJson(res, 200, { ok: false, error: '来源不存在' })
        return
      }
      try {
        const result = await pollSource(source, { notify: false })
        httpApi.sendJson(res, 200, {
          ok: true,
          sourceId: source.id,
          adapter: result.adapter,
          endpoint: result.endpoint,
          summary: result.summary,
          seed: result.seed,
        })
      } catch (error) {
        updateMetaError(source, error)
        schedulePersist()
        httpApi.sendJson(res, 200, { ok: false, error: String(error?.message || error) })
      }
    }),

    safeRoute('GET', '/api/model-status/subscriptions', async (req, res) => {
      httpApi.sendJson(res, 200, { ok: true, subscriptions: subscriptionsPayload() })
    }),

    safeRoute('PUT', '/api/model-status/subscriptions/:channelId', async (req, res, params) => {
      const channelId = String(params.channelId || '').trim()
      if (!channelId) {
        httpApi.sendJson(res, 400, { ok: false, error: '缺少渠道 id' })
        return
      }
      const body = await httpApi.readBody(req)
      const subscription = normalizeSubscription({ ...(body || {}), channelId }, channelId)
      state.subscriptions[channelId] = subscription
      cancelStalePendingForSubscription(subscription)
      schedulePersist()
      kickPoll(700)
      httpApi.sendJson(res, 200, { ok: true, subscription })
    }),

    safeRoute('DELETE', '/api/model-status/subscriptions/:channelId', async (req, res, params) => {
      const channelId = String(params.channelId || '').trim()
      if (state.subscriptions[channelId]) {
        delete state.subscriptions[channelId]
        cancelPendingNotificationsForChannel(channelId, { all: true, reason: '渠道订阅已删除' })
        schedulePersist()
      }
      httpApi.sendJson(res, 200, { ok: true })
    }),

    safeRoute('POST', '/api/model-status/poll', async (req, res) => {
      const body = await httpApi.readBody(req)
      const sourceId = String(body?.sourceId || '').trim()
      if (sourceId) {
        const source = resolveSource(sourceId)
        if (!source) {
          httpApi.sendJson(res, 200, { ok: false, error: '来源不存在' })
          return
        }
        const result = await pollSourceSafe(sourceId, { notify: true })
        httpApi.sendJson(res, 200, { ok: result.ok !== false, ...result, summary: result.summary || undefined })
        return
      }
      const result = await pollAll({ reason: 'manual', ignoreBackoff: true })
      httpApi.sendJson(res, 200, { ok: true, ...result })
    }),

    safeRoute('GET', '/api/model-status/query', async (req, res, params, url) => {
      const action = String(url?.searchParams?.get('action') || 'status').toLowerCase()
      const vendor = String(url?.searchParams?.get('vendor') || url?.searchParams?.get('source') || url?.searchParams?.get('sourceId') || '').trim()
      const keyword = truncateText(String(url?.searchParams?.get('keyword') || '').trim(), 80)
      const limit = Math.floor(clampNumber(url?.searchParams?.get('limit'), 1, 50, 10))

      if (action === 'list') {
        httpApi.sendJson(res, 200, {
          ok: true,
          action: 'list',
          sources: allSources().map(publicSourceInfo).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        })
        return
      }
      if (action === 'events') {
        httpApi.sendJson(res, 200, {
          ok: true,
          action: 'events',
          events: state.events.slice(0, limit).map(event => ({
            id: event.id,
            sourceId: event.sourceId,
            sourceName: event.sourceName,
            kind: event.kind,
            title: event.title,
            at: event.at,
            statusLabel: event.statusLabel,
            impactLabel: event.impactLabel,
            body: truncateText(event.body || '', 300),
            url: event.url || '',
            suppressed: event.suppressed === true,
          })),
        })
        return
      }
      if (!vendor) {
        httpApi.sendJson(res, 200, {
          ok: false,
          error: '请指定要查询的厂商（vendor），例如 deepseek / claude / openai / gemini / grok。',
          sources: allSources().map(publicSourceInfo).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        })
        return
      }

      const resolved = resolveSourceHint(vendor)
      if (!resolved.source) {
        httpApi.sendJson(res, 200, {
          ok: false,
          error: resolved.matches.length
            ? `「${vendor}」匹配到多个来源，请使用更精确的 id。`
            : `没有找到与「${vendor}」匹配的状态来源。`,
          candidates: resolved.matches.slice(0, 12).map(publicSourceInfo),
        })
        return
      }
      try {
        const result = await querySourceStatus(resolved.source, keyword)
        httpApi.sendJson(res, 200, { ok: true, action: 'status', ...result })
      } catch (error) {
        httpApi.sendJson(res, 200, { ok: false, error: String(error?.message || error) })
      }
    }),
    safeRoute('GET', '/api/model-status/events', async (req, res, params, url) => {
      const limit = clampNumber(url?.searchParams?.get('limit'), 1, 100, 30)
      httpApi.sendJson(res, 200, { ok: true, events: state.events.slice(0, Math.floor(limit)) })
    }),

    safeRoute('GET', '/api/model-status/notifications', async (req, res, params, url) => {
      const pendingOnly = url?.searchParams?.get('pending') === '1'
      const list = state.notifications
        .filter(item => item && (!pendingOnly || item.delivered !== true))
        .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
      httpApi.sendJson(res, 200, { ok: true, notifications: list.slice(0, 100) })
    }),

    safeRoute('POST', '/api/model-status/notifications/claim', async (req, res) => {
      const body = await httpApi.readBody(req)
      const notifications = claimPendingNotifications({
        owner: body?.owner,
        ids: body?.ids,
        limit: clampNumber(body?.limit, 1, 50, 20),
      })
      httpApi.sendJson(res, 200, { ok: true, notifications, seq: state.seq })
    }),

    safeRoute('POST', '/api/model-status/notifications/release', async (req, res) => {
      const body = await httpApi.readBody(req)
      const released = releaseNotificationClaims({ owner: body?.owner, ids: body?.ids })
      httpApi.sendJson(res, 200, { ok: true, released })
    }),

    safeRoute('POST', '/api/model-status/notifications/ack', async (req, res) => {
      const body = await httpApi.readBody(req)
      const id = String(body?.id || '')
      const ok = body?.ok !== false
      const notification = state.notifications.find(item => String(item?.id || '') === id)
      if (!notification) {
        httpApi.sendJson(res, 200, { ok: false, error: '通知不存在或已清理' })
        return
      }
      if (ok) {
        notification.delivered = true
        notification.deliveredAt = Date.now()
        notification.claimedAt = 0
        notification.claimedBy = ''
        notification.lastError = ''
      } else {
        notification.attempts = (Number(notification.attempts) || 0) + 1
        notification.lastError = truncateText(String(body?.error || '投递失败'), 300)
        notification.claimedAt = 0
        notification.claimedBy = ''
        const backoff = Math.min(30000 * notification.attempts, 5 * 60 * 1000)
        notification.nextAttemptAt = Date.now() + backoff
        if (notification.attempts >= 8) {
          notification.delivered = true
          notification.failedAt = Date.now()
          notification.lastError = `${notification.lastError}（重试次数已达上限）`
        }
      }
      schedulePersist()
      httpApi.sendJson(res, 200, { ok: true, notification: { id: notification.id, delivered: !!notification.delivered } })
    }),

    safeRoute('POST', '/api/model-status/test', async (req, res) => {
      const body = await httpApi.readBody(req)
      const channelId = String(body?.channelId || '').trim()
      if (!channelId) {
        httpApi.sendJson(res, 400, { ok: false, error: '缺少渠道 id' })
        return
      }
      const source = body?.sourceId ? resolveSource(body.sourceId) : null
      const event = {
        id: `test:${Date.now()}`,
        sourceId: source?.id || 'test',
        sourceName: source?.name || '模型状态订阅',
        sourceEmoji: '🧪',
        adapter: 'test',
        kind: 'test',
        eventType: 'test',
        title: '测试消息',
        at: Date.now(),
        statusLabel: '正常',
        body: '如果你在群里看到这条消息，说明「模型状态订阅」的渠道推送链路已经打通。',
        components: [],
        url: '',
      }
      const notification = makeNotification({
        channel: {
          channelId,
          roleId: body?.roleId,
          name: body?.channelName,
          type: body?.channelType,
        },
        event,
        text: formatEventText(event, state.config),
        kind: 'test',
      })
      if (!notification) {
        httpApi.sendJson(res, 200, { ok: false, error: '插件未在当前角色 / 渠道启用，测试通知被拦截' })
        return
      }
      schedulePersist()
      broadcastNotifications([notification])
      httpApi.sendJson(res, 200, { ok: true, notification })
    }),
  ]

  httpApi.registerCapability('model-status')
  ctx.effect(() => () => {
    for (const dispose of routes) {
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
  })

  /* ------------------------------------------------------------------ */
  /* 定时器                                                              */
  /* ------------------------------------------------------------------ */

  pollTimer = setInterval(() => {
    if (closed || pollRunning) return
    if (Date.now() < nextPollAt) return
    if (!activeSourceIds().length) {
      nextPollAt = Date.now() + effectiveIntervalMs()
      return
    }
    pollAll({ reason: 'schedule' }).catch(error => ctx.logger.warn(`[model-status] 轮询失败：${error?.message || error}`))
  }, TICK_MS)
  pollTimer.unref?.()

  const startupTimer = setTimeout(() => {
    const ids = activeSourceIds()
    if (!ids.length) return
    nextPollAt = 0
    pollAll({ reason: 'startup' }).catch(error => ctx.logger.warn(`[model-status] 启动检查失败：${error?.message || error}`))
  }, 2500)
  startupTimer.unref?.()

  ctx.effect(() => () => {
    closed = true
    if (persistTimer) clearTimeout(persistTimer)
    if (pollTimer) clearInterval(pollTimer)
    clearTimeout(startupTimer)
    persistState().catch(() => {})
  })

  ctx.logger.info(`模型状态订阅后端桥就绪（/api/model-status/*）· ${allSources().length} 个内置 / 自定义来源`)
}
