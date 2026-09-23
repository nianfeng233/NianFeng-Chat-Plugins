/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 模型状态订阅 · 设置面板。
 *
 * 三个核心区域：
 *   1. 渠道订阅：每个已有渠道勾选要订阅哪些状态站点，可选到具体模型 / 组件；
 *   2. 来源目录：内置 20+ 厂商状态页 + 自定义 Statuspage / RSS 来源；
 *   3. 最近事件：查看插件实际捕获到的状态变化，便于确认推送是否正确。
 */

import {
  ADAPTERS,
  ADAPTER_LABELS,
  CATEGORY_LABELS,
  CONFIDENCE_LABELS,
} from './lib/sources.mjs'
import { eventKindLabel } from './lib/detect.mjs'
import { formatTime, relativeTime, truncateText } from './lib/util.mjs'
import {
  badge,
  button,
  card,
  escapeHtml,
  fieldValue,
  input,
  MODEL_STATUS_ICON,
  row,
  select,
  switchButton,
} from './ui.mjs'

export const PANEL_VERSION = '2.2.0'

const CATEGORY_ORDER = ['llm', 'coding', 'image', 'audio', 'infra', 'custom']

function sourceSort(a, b) {
  const aCustom = a.builtin === false ? 1 : 0
  const bCustom = b.builtin === false ? 1 : 0
  if (aCustom !== bCustom) return aCustom - bCustom
  const ai = CATEGORY_ORDER.indexOf(a.category)
  const bi = CATEGORY_ORDER.indexOf(b.category)
  if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')
}

function adapterTone(adapter) {
  if (adapter === 'statuspage') return 'blue'
  if (adapter === 'rss') return 'orange'
  if (adapter === 'google-cloud') return 'purple'
  return 'gray'
}

export function renderModelStatusPanel(container, helpers = {}) {
  const { request, getChannels, toast, openUrl, confirm: confirmDialog, allowsScope } = helpers
  const state = {
    loading: true,
    error: '',
    bridgeMissing: false,
    status: null,
    config: null,
    sources: [],
    subscriptions: {},
    events: [],
    catalogQuery: '',
    catalogCategory: 'all',
    expanded: {},
    components: {},
    componentsLoading: {},
    componentsError: {},
    notice: null,
  }

  const notify = (kind, message) => {
    const text = String(message || '')
    if (!text) return
    if (kind === 'error') toast?.error?.(text) ?? toast?.warn?.(text)
    else if (kind === 'warn') toast?.warn?.(text)
    else toast?.success?.(text) ?? toast?.info?.(text)
    state.notice = { kind, message: text, at: Date.now() }
  }

  const confirmAction = async (title, message) => {
    if (typeof confirmDialog === 'function') return await confirmDialog(title, message)
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(`${title}\n\n${message}`)
    return false
  }

  const api = async (method, path, body) => {
    if (typeof request !== 'function') return { ok: false, error: '插件未连接本地后端' }
    try {
      const result = await request(method, path, body)
      return result && typeof result === 'object' ? result : { ok: true }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  const channelList = () => {
    try {
      const list = getChannels?.() || []
      return Array.isArray(list) ? list.filter(channel => channel && channel.id) : []
    } catch (_) {
      return []
    }
  }

  const channelById = channelId => channelList().find(channel => String(channel.id) === String(channelId)) || null

  const subFor = channelId => {
    const key = String(channelId)
    if (!state.subscriptions[key]) {
      state.subscriptions[key] = { channelId: key, enabled: false, sources: {} }
    }
    const sub = state.subscriptions[key]
    if (!sub.sources || typeof sub.sources !== 'object') sub.sources = {}
    return sub
  }

  const sourceFor = sourceId => state.sources.find(item => String(item.id) === String(sourceId)) || null

  const loadAll = async () => {
    state.loading = true
    state.error = ''
    const [statusResult, eventResult] = await Promise.all([
      api('GET', '/model-status/status'),
      api('GET', '/model-status/events?limit=30'),
    ])
    if (statusResult?.ok === false) {
      const code = String(statusResult.code || '')
      const errorText = String(statusResult.error || '')
      if (code === 'BRIDGE_NOT_LOADED' || /404|未加载|后端桥/i.test(errorText)) state.bridgeMissing = true
      state.error = errorText || '后端桥未就绪'
    } else {
      state.status = statusResult
      state.config = statusResult?.config || null
      state.sources = Array.isArray(statusResult?.sources) ? statusResult.sources : []
      state.subscriptions = statusResult?.subscriptions && typeof statusResult.subscriptions === 'object' ? statusResult.subscriptions : {}
      state.bridgeMissing = false
      state.error = ''
    }
    if (eventResult?.ok !== false) state.events = Array.isArray(eventResult?.events) ? eventResult.events : []
    state.loading = false
    render()
  }

  const saveSubscription = async channelId => {
    const sub = subFor(channelId)
    const channel = channelById(channelId)
    const sources = {}
    for (const [sourceId, item] of Object.entries(sub.sources || {})) {
      if (!item || !sourceId) continue
      sources[sourceId] = {
        enabled: item.enabled !== false,
        components: Array.isArray(item.components) ? item.components : [],
        keywords: Array.isArray(item.keywords) ? item.keywords : [],
        events: {
          incident: item.events?.incident !== false,
          maintenance: item.events?.maintenance !== false,
          component: item.events?.component !== false,
        },
      }
    }
    const payload = {
      enabled: sub.enabled !== false,
      name: channel?.name || sub.name || '',
      type: channel?.type || sub.type || '',
      tab: channel?.tab || sub.tab || '',
      groupName: channel?.groupName || sub.groupName || '',
      roleId: String(channel?.meta?.roleId || sub.roleId || ''),
      sources,
    }
    const result = await api('PUT', `/model-status/subscriptions/${encodeURIComponent(channelId)}`, payload)
    if (result?.ok === false) {
      notify('error', result.error || '订阅保存失败')
      return false
    }
    state.subscriptions[String(channelId)] = result?.subscription || { channelId: String(channelId), ...payload }
    render()
    notify('success', `已更新「${channel?.name || channelId}」的订阅`)
    return true
  }

  const saveConfig = async () => {
    const pollSeconds = Number(fieldValue(container, 'ms-poll-seconds'))
    const timeoutSeconds = Number(fieldValue(container, 'ms-timeout-seconds'))
    const maxAgeHours = Number(fieldValue(container, 'ms-max-age-hours'))
    const pendingMinutes = Number(fieldValue(container, 'ms-pending-minutes'))
    const maxChars = Number(fieldValue(container, 'ms-max-chars'))
    const body = {
      pollIntervalMs: Math.round(Math.max(30, pollSeconds || 120) * 1000),
      requestTimeoutMs: Math.round(Math.max(3, timeoutSeconds || 20) * 1000),
      proxy: String(fieldValue(container, 'ms-proxy') || '').trim(),
      timeZone: String(fieldValue(container, 'ms-timezone') || '').trim() || 'Asia/Shanghai',
      notifyMode: String(fieldValue(container, 'ms-notify-mode') || 'important') === 'all' ? 'all' : 'important',
      maxEventAgeMs: Math.round(Math.max(1, maxAgeHours || 24) * 60 * 60 * 1000),
      maxPendingAgeMs: Math.round(Math.max(1, pendingMinutes || 30) * 60 * 1000),
      maxTextChars: Math.round(Math.max(200, Math.min(4000, maxChars || 1200))),
    }
    const result = await api('PUT', '/model-status/config', body)
    if (result?.ok === false) {
      notify('error', result.error || '配置保存失败')
      return
    }
    state.config = result?.config || { ...(state.config || {}), ...body }
    notify('success', '轮询配置已保存')
    render()
  }

  const testSource = async sourceId => {
    const source = sourceFor(sourceId)
    notify('info', `正在检查「${source?.name || sourceId}」…`)
    const result = await api('POST', '/model-status/source/test', { sourceId })
    if (result?.ok === false) {
      notify('error', `${source?.name || sourceId} 检查失败：${result.error || '未知错误'}`)
      render()
      return
    }
    const summary = result.summary || {}
    notify('success', `${source?.name || sourceId} 连接正常（${ADAPTER_LABELS[result.adapter] || result.adapter}）· ${summary.pageName || ''}`)
    await loadAll()
  }

  const toggleComponents = async (channelId, sourceId) => {
    const key = `${channelId}:${sourceId}`
    state.expanded[key] = !state.expanded[key]
    if (state.expanded[key] && !state.components[sourceId]) {
      state.componentsLoading[sourceId] = true
      render()
      const result = await api('GET', `/model-status/source/${encodeURIComponent(sourceId)}/components`)
      state.componentsLoading[sourceId] = false
      if (result?.ok === false) {
        state.componentsError[sourceId] = result.error || '组件列表加载失败'
      } else {
        state.components[sourceId] = Array.isArray(result?.components) ? result.components : []
        state.componentsError[sourceId] = ''
      }
    }
    render()
  }

  const addSource = async channelId => {
    const escaped = String(channelId).replace(/["\\]/g, '\\$&')
    const element = container.querySelector(`[data-field="ms-add-source-${escaped}"]`)
    const sourceId = String(element?.value || '').trim()
    if (!sourceId) {
      notify('warn', '请选择要订阅的来源')
      return
    }
    const sub = subFor(channelId)
    const source = sourceFor(sourceId)
    if (sub.sources[sourceId]) {
      notify('warn', `「${source?.name || sourceId}」已经订阅过了`)
      return
    }
    sub.sources[sourceId] = {
      enabled: true,
      components: [],
      keywords: Array.isArray(source?.keywords) ? [...source.keywords] : [],
      events: { incident: true, maintenance: true, component: true },
    }
    sub.enabled = true
    await saveSubscription(channelId)
  }

  const removeSource = async (channelId, sourceId) => {
    const sub = subFor(channelId)
    if (!sub.sources?.[sourceId]) return
    const source = sourceFor(sourceId)
    delete sub.sources[sourceId]
    if (!Object.keys(sub.sources).length) sub.enabled = false
    await saveSubscription(channelId)
    notify('success', `已移除「${source?.name || sourceId}」`)
  }

  const addCustomSource = async () => {
    const body = {
      name: String(fieldValue(container, 'ms-custom-name') || '').trim(),
      url: String(fieldValue(container, 'ms-custom-url') || '').trim(),
      adapter: String(fieldValue(container, 'ms-custom-adapter') || 'auto'),
    }
    if (!body.name || !body.url) {
      notify('warn', '请填写自定义来源的名称和地址')
      return
    }
    const result = await api('POST', '/model-status/sources', body)
    if (result?.ok === false) {
      notify('error', result.error || '添加自定义来源失败')
      return
    }
    notify('success', `已添加「${result?.source?.name || body.name}」`)
    await loadAll()
  }

  const removeCustomSource = async sourceId => {
    const source = sourceFor(sourceId)
    const ok = await confirmAction('删除自定义来源', `确定删除「${source?.name || sourceId}」？使用该来源的渠道订阅也会一并移除。`)
    if (!ok) return
    const result = await api('DELETE', `/model-status/sources/${encodeURIComponent(sourceId)}`)
    if (result?.ok === false) {
      notify('error', result.error || '删除失败')
      return
    }
    notify('success', '自定义来源已删除')
    await loadAll()
  }

  /* ------------------------------------------------------------------ */
  /* HTML 片段                                                          */
  /* ------------------------------------------------------------------ */

  const renderStatusCard = () => {
    const stats = state.status?.stats || {}
    const config = state.config || {}
    const failed = Number(stats.lastError ? 1 : 0)
    const actionBar = `<div class="ms-actions">
      ${button('立即检查', 'poll-now', { variant: 'primary' })}
      ${button('刷新面板', 'refresh')}
    </div>`
    return `<div class="ms-head">
      <div>
        <div class="ms-title">${MODEL_STATUS_ICON} 模型状态订阅</div>
        <div class="ms-desc">为每个渠道订阅厂商状态页；默认只推送服务异常、质量下降与恢复，自动过滤调查中 / 观察中等过程动态和多条同时变化的刷屏。首次检查只建立基线，不会补发历史故障。</div>
        <div class="ms-status">
          ${badge(state.bridgeMissing ? '后端桥未加载' : '后端桥已连接', { tone: state.bridgeMissing ? 'red' : 'green' })}
          ${badge(`后端 v${escapeHtml(state.status?.version || '?')}`, { tone: 'gray' })}
          ${badge(`面板 v${PANEL_VERSION}`, { tone: 'purple' })}
          ${badge(`轮询 ${Math.round((Number(config.pollIntervalMs) || 120000) / 1000)}s`, { tone: 'blue' })}
          ${badge(`监控 ${Array.isArray(stats.activeSourceIds) ? stats.activeSourceIds.length : 0} 个来源`, { tone: 'gray' })}
          ${badge(`待投递 ${Number(stats.pendingNotifications) || 0}`, { tone: Number(stats.pendingNotifications) ? 'orange' : 'gray' })}
          ${badge(stats.lastPollAt ? `上次检查 ${relativeTime(stats.lastPollAt)}` : '尚未检查', { tone: failed ? 'red' : 'gray' })}
        </div>
        ${state.error ? `<div class="ms-error">${escapeHtml(state.error)}</div>` : ''}
        ${state.notice ? `<div class="ms-note" style="margin-top:4px">${escapeHtml(state.notice.message)}</div>` : ''}
      </div>
      ${actionBar}
    </div>`
  }

  const renderConfigCard = () => {
    const config = state.config || {}
    const content = [
      row('轮询间隔', '每个来源最慢多久检查一次；状态页通常 1～2 分钟更新一次。', input('ms-poll-seconds', Math.round((Number(config.pollIntervalMs) || 120000) / 1000), { type: 'number', min: 30, max: 21600, width: 110 })),
      row('请求超时', '单次访问状态页的最长等待时间（秒）。', input('ms-timeout-seconds', Math.round((Number(config.requestTimeoutMs) || 20000) / 1000), { type: 'number', min: 3, max: 120, width: 110 })),
      row('HTTP 代理', '留空跟随「设置 → 网络」的全局代理；OpenAI 等站点无法直连时可在这里单独指定。', input('ms-proxy', config.proxy || '', { placeholder: 'http://127.0.0.1:7890', width: 260 })),
      row('时区', '事件时间与消息里的时间戳使用此时区显示。', input('ms-timezone', config.timeZone || 'Asia/Shanghai', { placeholder: 'Asia/Shanghai', width: 180 })),
      row('通知模式', '默认只推送服务异常、质量下降与恢复；选择「全部状态更新」会包含调查中 / 观察中等过程动态，消息会明显变多。', select('ms-notify-mode', config.notifyMode || 'important', [
        { value: 'important', label: '仅异常与恢复（推荐）' },
        { value: 'all', label: '全部状态更新' },
      ], { width: 220 })),
      row('旧事件补发上限', '休眠 / 重启 / 后端离线期间产生的、早于该时长的状态变化只记录不推送（小时）。', input('ms-max-age-hours', Math.round((Number(config.maxEventAgeMs) || 86400000) / 3600000), { type: 'number', min: 1, max: 720, width: 110 })),
      row('通知过期时间', '通知生成后超过该时长仍无人投递就自动作废，避免睡醒后刷屏（分钟）。', input('ms-pending-minutes', Math.round((Number(config.maxPendingAgeMs) || 1800000) / 60000), { type: 'number', min: 1, max: 10080, width: 110 })),
      row('消息最大长度', '单条状态推送最多保留多少字符，防止超长故障说明被渠道截断。', input('ms-max-chars', Number(config.maxTextChars) || 1200, { type: 'number', min: 200, max: 4000, width: 110 })),
    ].join('')
    return card('轮询与通知设置', '修改后点右侧保存；状态页访问遵循上面的代理设置。', `${content}
      <div class="ms-toolbar">${button('保存配置', 'save-config', { variant: 'primary' })}</div>`)
  }

  const filteredSources = () => {
    const query = String(state.catalogQuery || '').trim().toLowerCase()
    const category = state.catalogCategory || 'all'
    return [...state.sources]
      .sort(sourceSort)
      .filter(item => {
        if (category !== 'all' && item.category !== category) return false
        if (!query) return true
        const haystack = `${item.name || ''} ${item.vendor || ''} ${item.description || ''} ${item.id || ''} ${(item.keywords || []).join(' ')}`.toLowerCase()
        return haystack.includes(query)
      })
  }

  const sourceTone = meta => {
    if (meta?.lastError) return 'red'
    if (meta?.lastOkAt) return 'green'
    return 'gray'
  }

  const renderSourceItem = item => {
    const meta = item.meta || null
    const isCustom = item.builtin === false || item.custom === true
    const selected = item.subscribed ? badge('已订阅', { tone: 'green' }) : ''
    return `<div class="ms-source-item">
      <div class="ms-source-emoji">${escapeHtml(item.emoji || '📡')}</div>
      <div class="ms-source-info">
        <div class="ms-source-title" title="${escapeHtml(item.name || '')}">${escapeHtml(item.name || item.id || '')}</div>
        <div class="ms-source-desc">${escapeHtml(item.description || item.url || '')}</div>
        <div class="ms-status" style="margin:6px 0 0">
          ${badge(ADAPTER_LABELS[item.adapter] || item.adapter || '自动识别', { tone: adapterTone(item.adapter) })}
          ${badge(CATEGORY_LABELS[item.category] || item.category || '其他', { tone: 'gray' })}
          ${item.confidence === 'community' ? badge(CONFIDENCE_LABELS.community, { tone: 'orange' }) : ''}
          ${selected}
          ${meta?.lastError ? badge('检查失败', { tone: 'red' }) : meta?.lastOkAt ? badge('连接正常', { tone: 'green' }) : ''}
        </div>
        ${meta?.lastError ? `<div class="ms-source-desc" style="margin-top:4px">${escapeHtml(truncateText(meta.lastError, 120))}</div>` : ''}
        <div class="ms-actions" style="margin-top:7px">
          ${button('测试连接', 'test-source', { variant: 'small', dataset: { sourceId: item.id } })}
          ${button('打开状态页', 'open-url', { variant: 'small', dataset: { url: item.homepage || item.url } })}
          ${isCustom ? button('删除', 'delete-custom-source', { variant: 'small danger', dataset: { sourceId: item.id } }) : ''}
        </div>
      </div>
    </div>`
  }

  const renderSourceGrid = () => {
    const grid = container.querySelector('[data-role="source-grid"]')
    if (!grid) return
    const list = filteredSources()
    grid.innerHTML = list.length
      ? `<div class="ms-grid">${list.map(renderSourceItem).join('')}</div>`
      : '<div class="ms-empty">没有匹配的来源。可以切换分类，或在下方添加自定义 Statuspage / RSS 地址。</div>'
  }

  const renderSourcesCard = () => {
    const categories = [{ value: 'all', label: '全部分类' }, ...CATEGORY_ORDER.map(value => ({ value, label: CATEGORY_LABELS[value] }))]
    const customForm = `<div class="ms-custom-form">
      <div class="ms-row-name">添加自定义来源</div>
      <div class="ms-row-help">没有内置的厂商可以自己填状态页根地址或 RSS 地址；auto 会优先识别 Statuspage API，再尝试 RSS / Atom。</div>
      <div class="ms-toolbar">
        ${input('ms-custom-name', '', { placeholder: '名称，如 Kimi', width: 150 })}
        ${input('ms-custom-url', '', { placeholder: 'https://status.example.com 或 RSS 地址', width: 260 })}
        ${select('ms-custom-adapter', 'auto', ADAPTERS.map(value => ({ value, label: ADAPTER_LABELS[value] })), { width: 150 })}
        ${button('添加来源', 'add-custom-source')}
      </div>
    </div>`
    return card('来源目录', '内置厂商状态页 + 自定义来源；点「测试连接」会立即访问一次并建立基线。', `
      <div class="ms-toolbar">
        <input class="ms-input" data-action="catalog-search" placeholder="搜索厂商 / 模型 / 地址…" value="${escapeHtml(state.catalogQuery)}" style="width:260px" />
        <select class="ms-select" data-action="catalog-category" style="width:140px">
          ${categories.map(item => `<option value="${escapeHtml(item.value)}"${item.value === state.catalogCategory ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
        </select>
        <span class="ms-dim">${filteredSources().length} / ${state.sources.length} 个来源</span>
      </div>
      <div data-role="source-grid"></div>
      ${customForm}`)
  }

  const sourceOptions = channelId => {
    const sub = subFor(channelId)
    const available = state.sources.filter(item => !sub.sources?.[item.id]).sort(sourceSort)
    if (!available.length) return ''
    const groups = new Map()
    for (const item of available) {
      const key = item.category || 'custom'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    const blocks = [...groups.entries()]
      .sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]))
      .map(([category, list]) => `<optgroup label="${escapeHtml(CATEGORY_LABELS[category] || category)}">${list
        .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.emoji ? `${item.emoji} ` : '')}${escapeHtml(item.name)}</option>`)
        .join('')}</optgroup>`)
    return blocks.join('')
  }

  const renderComponentsBlock = (channelId, sourceId, item) => {
    const components = Array.isArray(state.components[sourceId]) ? state.components[sourceId] : []
    const loading = state.componentsLoading[sourceId]
    const error = state.componentsError[sourceId]
    if (loading) return '<div class="ms-components"><div class="ms-dim">正在读取组件列表…</div></div>'
    if (error) return `<div class="ms-components"><div class="ms-error">${escapeHtml(error)}</div></div>`
    const selectable = components.filter(component => !component.isGroup)
    const list = selectable.length ? selectable : components
    const selected = new Set((item.components || []).map(String))
    const componentHtml = list.length
      ? list
          .map(component => {
            const key = String(component.id || component.name)
            return `<label class="ms-component-item"><input type="checkbox" data-action="toggle-component" data-channel-id="${escapeHtml(channelId)}" data-source-id="${escapeHtml(sourceId)}" data-component-id="${escapeHtml(key)}"${selected.has(key) ? ' checked' : ''} />
              <span>${escapeHtml(component.name || key)}</span>
              ${component.statusLabel ? `<span class="ms-dim">· ${escapeHtml(component.statusLabel)}</span>` : ''}
            </label>`
          })
          .join('')
      : '<div class="ms-dim">该来源没有可列出的模型 / 组件（RSS / Atom 动态流可用下方关键词过滤）。</div>'
    const keywordValue = Array.isArray(item.keywords) ? item.keywords.join(', ') : ''
    return `<div class="ms-components">
      <div class="ms-dim">勾选具体模型 / 组件后，只有影响这些组件的动态才会推送；一个都不勾选表示全部。${list.length ? `（共 ${list.length} 个）` : ''}</div>
      ${componentHtml}
      <div class="ms-dim" style="margin-top:6px">关键词过滤（逗号分隔，留空不启用）</div>
      <input class="ms-input" data-action="filter-keywords" data-channel-id="${escapeHtml(channelId)}" data-source-id="${escapeHtml(sourceId)}" value="${escapeHtml(keywordValue)}" placeholder="例如 gemini, API, Claude" style="width:100%" />
    </div>`
  }

  const renderSourceRow = (channelId, sourceId, item) => {
    const source = sourceFor(sourceId) || { id: sourceId, name: sourceId, emoji: '❓', adapter: 'auto' }
    const meta = source.meta || {}
    const expandedKey = `${channelId}:${sourceId}`
    const events = item.events || {}
    const eventChecks = [
      ['incident', '异常与恢复'],
      ['maintenance', '计划维护'],
      ['component', '组件状态变化'],
    ]
      .map(([key, label]) => `<label class="ms-evt"><input type="checkbox" data-action="toggle-event" data-channel-id="${escapeHtml(channelId)}" data-source-id="${escapeHtml(sourceId)}" data-event-key="${escapeHtml(key)}"${events[key] !== false ? ' checked' : ''} />${escapeHtml(label)}</label>`)
      .join('')
    return `<div class="ms-source">
      <div class="ms-source-head">
        <span>${escapeHtml(source.emoji || '📡')}</span>
        <span class="ms-source-name">${escapeHtml(source.name || sourceId)}</span>
        ${badge(ADAPTER_LABELS[source.adapter] || source.adapter || '自动识别', { tone: adapterTone(source.adapter) })}
        ${meta.lastError ? badge('检查失败', { tone: 'red' }) : meta.lastOkAt ? badge('正常', { tone: 'green' }) : ''}
        <span style="flex:1"></span>
        ${button(state.expanded[expandedKey] ? '收起组件' : '组件筛选', 'toggle-components', { variant: 'small', dataset: { channelId, sourceId } })}
        ${button('移除', 'remove-source', { variant: 'small danger', dataset: { channelId, sourceId } })}
      </div>
      <div class="ms-events">${eventChecks}</div>
      ${state.expanded[expandedKey] ? renderComponentsBlock(channelId, sourceId, item) : ''}
    </div>`
  }

  const renderChannelCard = channel => {
    const channelId = String(channel?.id || channel?.channelId || '')
    const sub = subFor(channelId)
    const found = channelById(channelId)
    const missing = !found
    const name = found?.name || sub.name || channelId
    const roleId = String(found?.meta?.roleId || sub.roleId || '')
    const dotClass = found?.status === 'online' ? 'online' : found?.status === 'error' ? 'error' : found?.status === 'connecting' ? 'connecting' : ''
    const sourceRows = Object.entries(sub.sources || {})
      .map(([sourceId, item]) => renderSourceRow(channelId, sourceId, item))
      .join('')
    const options = sourceOptions(channelId)
    return `<div class="ms-channel" data-channel-card="${escapeHtml(channelId)}">
      <div class="ms-channel-head">
        <span class="ms-dot ${dotClass}"></span>
        <span class="ms-channel-name">${escapeHtml(name)}</span>
        ${badge(found?.type || sub.type || '渠道', { tone: 'gray' })}
        ${found?.groupName ? badge(found.groupName, { tone: 'gray' }) : ''}
        ${missing ? badge('渠道已不存在', { tone: 'red' }) : ''}
        <span style="flex:1"></span>
        ${switchButton(sub.enabled !== false ? '订阅中' : '未启用', 'toggle-channel', sub.enabled !== false, { channelId })}
        ${button('测试推送', 'test-channel', { variant: 'small', dataset: { channelId, roleId, channelName: name } })}
        ${button('删除订阅', 'delete-subscription', { variant: 'small danger', dataset: { channelId } })}
      </div>
      <div class="ms-dim" style="margin-top:3px">${roleId ? `角色：${escapeHtml(roleId)}` : '未绑定角色（通知会按渠道自身判断插件启用范围）'}</div>
      <div class="ms-repos" style="margin-top:8px">
        ${sourceRows || '<div class="ms-empty">还没有订阅来源。选择下面的站点并点「添加来源」即可。</div>'}
      </div>
      ${options
        ? `<div class="ms-add"><select class="ms-select" data-field="ms-add-source-${escapeHtml(channelId)}" style="width:300px">${options}</select>${button('添加来源', 'add-source', { dataset: { channelId } })}</div>`
        : '<div class="ms-empty">所有来源都已订阅。</div>'}
    </div>`
  }

  const renderChannelsCard = () => {
    const channels = channelList()
    const known = new Set(channels.map(channel => String(channel.id)))
    const orphanIds = Object.keys(state.subscriptions).filter(id => !known.has(String(id)))
    const cards = channels.map(renderChannelCard)
    for (const id of orphanIds) cards.push(renderChannelCard({ id }))
    const content = cards.length ? cards.join('') : '<div class="ms-empty">还没有添加任何渠道。请先在「渠道」页添加 NapCat / QQ 机器人 / 微信等渠道，再回到这里订阅状态来源。</div>'
    return card('渠道订阅', '每个渠道单独选择站点、事件类型和组件；私聊 / 群聊渠道都会按渠道配置推送。', content)
  }

  const renderEventsCard = () => {
    const list = Array.isArray(state.events) ? state.events : []
    if (!list.length) return card('最近事件', '还没有捕获到状态变化。第一次检查某个来源时只建立基线，后续变化才会出现在这里。', '<div class="ms-empty">暂无记录</div>')
    const items = list
      .slice(0, 30)
      .map(event => {
        const title = event.title || eventKindLabel(event.kind) || '状态更新'
        const sourceName = event.sourceName || event.sourceId || ''
        const summary = truncateText(event.body || event.statusLabel || '', 180)
        const badges = [
          event.suppressed ? badge('未推送', { tone: 'orange' }) : '',
          event.important === false ? badge('过程动态', { tone: 'gray' }) : '',
        ].filter(Boolean).join(' ')
        return `<div class="ms-list-item">
          <div class="ms-list-main">
            <div class="ms-list-title">${escapeHtml(event.statusEmoji || '📡')} ${escapeHtml(title)}${badges ? ` ${badges}` : ''}</div>
            <div class="ms-list-summary">${escapeHtml(sourceName)}${summary ? ` · ${escapeHtml(summary)}` : ''}</div>
          </div>
          <div style="text-align:right">
            <div class="ms-list-time">${escapeHtml(event.at ? formatTime(event.at, state.config?.timeZone || 'Asia/Shanghai') : '')}</div>
            ${event.url ? button('打开', 'open-url', { variant: 'small', dataset: { url: event.url } }) : ''}
          </div>
        </div>`
      })
      .join('')
    return card('最近事件', '这里记录插件捕获到的状态变化；「未推送」表示超过补发时限或建立基线时忽略，「过程动态」表示默认只记录、不发送渠道通知。', items)
  }

  const renderBody = () => `
    ${renderStatusCard()}
    ${renderConfigCard()}
    ${renderSourcesCard()}
    ${renderChannelsCard()}
    ${renderEventsCard()}`

  const render = () => {
    if (state.loading) {
      container.innerHTML = `<div class="ms-loading">正在读取模型状态订阅配置…</div>`
      return
    }
    container.innerHTML = `<div class="ms-panel">${renderBody()}</div>`
    renderSourceGrid()
    bindEvents()
  }

  /* ------------------------------------------------------------------ */
  /* 事件处理                                                            */
  /* ------------------------------------------------------------------ */

  let clickHandler = null
  let changeHandler = null
  let inputHandler = null

  const bindEvents = () => {
    if (clickHandler) container.removeEventListener('click', clickHandler)
    if (changeHandler) container.removeEventListener('change', changeHandler)
    if (inputHandler) container.removeEventListener('input', inputHandler)

    clickHandler = async event => {
      const target = event.target.closest('[data-action]')
      if (!target || !container.contains(target)) return
      const action = String(target.dataset.action || '')
      const channelId = String(target.dataset.channelId || '')
      const sourceId = String(target.dataset.sourceId || '')
      if (action === 'refresh') {
        await loadAll()
      } else if (action === 'poll-now') {
        notify('info', '正在检查所有已订阅来源…')
        const result = await api('POST', '/model-status/poll', {})
        if (result?.ok === false) notify('error', result.error || '检查失败')
        else notify('success', `检查完成：${result.checked || 0} 个来源，${result.events || 0} 条新事件，${result.notifications || 0} 条通知`)
        await loadAll()
      } else if (action === 'save-config') {
        await saveConfig()
      } else if (action === 'toggle-channel') {
        const sub = subFor(channelId)
        sub.enabled = target.getAttribute('aria-checked') !== 'true'
        await saveSubscription(channelId)
      } else if (action === 'test-channel') {
        const result = await api('POST', '/model-status/test', {
          channelId,
          roleId: target.dataset.roleId || '',
          channelName: target.dataset.channelName || '',
        })
        if (result?.ok === false) notify('error', result.error || '测试通知创建失败')
        else notify('success', '测试通知已创建，稍后会在对应渠道发送')
      } else if (action === 'add-source') {
        await addSource(channelId)
      } else if (action === 'remove-source') {
        await removeSource(channelId, sourceId)
      } else if (action === 'toggle-components') {
        await toggleComponents(channelId, sourceId)
      } else if (action === 'delete-subscription') {
        const ok = await confirmAction('删除渠道订阅', '确定删除该渠道的所有状态订阅？待投递的旧通知也会取消。')
        if (!ok) return
        const result = await api('DELETE', `/model-status/subscriptions/${encodeURIComponent(channelId)}`)
        if (result?.ok === false) notify('error', result.error || '删除失败')
        else {
          delete state.subscriptions[channelId]
          notify('success', '渠道订阅已删除')
          render()
        }
      } else if (action === 'test-source') {
        await testSource(sourceId)
      } else if (action === 'delete-custom-source') {
        await removeCustomSource(sourceId)
      } else if (action === 'add-custom-source') {
        await addCustomSource()
      } else if (action === 'open-url') {
        const url = String(target.dataset.url || '')
        if (url) {
          if (typeof openUrl === 'function') openUrl(url)
          else window.open(url, '_blank', 'noopener,noreferrer')
        }
      }
    }

    changeHandler = async event => {
      const target = event.target.closest('[data-action]')
      if (!target || !container.contains(target)) return
      const action = String(target.dataset.action || '')
      const channelId = String(target.dataset.channelId || '')
      const sourceId = String(target.dataset.sourceId || '')
      if (action === 'catalog-category') {
        state.catalogCategory = String(target.value || 'all')
        renderSourceGrid()
      } else if (action === 'toggle-event') {
        const key = String(target.dataset.eventKey || '')
        const sub = subFor(channelId)
        const item = sub.sources?.[sourceId]
        if (!item || !key) return
        item.events = { incident: true, maintenance: true, component: true, ...(item.events || {}), [key]: target.checked }
        await saveSubscription(channelId)
      } else if (action === 'toggle-component') {
        const sub = subFor(channelId)
        const item = sub.sources?.[sourceId]
        if (!item) return
        const key = String(target.dataset.componentId || '')
        const selected = new Set((item.components || []).map(String))
        if (target.checked) selected.add(key)
        else selected.delete(key)
        item.components = [...selected]
        await saveSubscription(channelId)
      } else if (action === 'filter-keywords') {
        const sub = subFor(channelId)
        const item = sub.sources?.[sourceId]
        if (!item) return
        item.keywords = String(target.value || '')
          .split(/[,，、;；]+/)
          .map(value => value.trim())
          .filter(Boolean)
          .slice(0, 30)
        await saveSubscription(channelId)
      }
    }

    inputHandler = event => {
      const target = event.target.closest('[data-action="catalog-search"]')
      if (!target || !container.contains(target)) return
      state.catalogQuery = String(target.value || '')
      renderSourceGrid()
    }

    container.addEventListener('click', clickHandler)
    container.addEventListener('change', changeHandler)
    container.addEventListener('input', inputHandler)
  }

  const cleanup = () => {
    if (clickHandler) container.removeEventListener('click', clickHandler)
    if (changeHandler) container.removeEventListener('change', changeHandler)
    if (inputHandler) container.removeEventListener('input', inputHandler)
    container.innerHTML = ''
  }

  render()
  loadAll().catch(error => {
    state.loading = false
    state.error = error?.message || String(error)
    render()
  })

  return cleanup
}
