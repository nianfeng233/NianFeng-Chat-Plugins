/*
 * 念风chat · 扩展插件 · github-hub
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * GitHub 助手设置面板：渠道订阅、全局配置、自动回复、草稿与最近动态。
 */
import {
  badge,
  button,
  card,
  escapeHtml,
  fieldValue,
  input,
  row,
  section,
  select,
  switchButton,
  textarea,
} from './ui.mjs'
import {
  DEFAULT_EVENT_FILTERS,
  EVENT_FILTER_KEYS,
  EVENT_FILTER_LABELS,
  normalizeEventFilters,
  normalizeRepoFullName,
} from './lib/github.mjs'
import { formatTime, relativeTime, truncate } from './lib/util.mjs'

const AUTO_MODES = [
  { value: 'off', label: '关闭：只通知，不分析' },
  { value: 'draft', label: '草稿：分析后通知我确认（推荐）' },
  { value: 'auto', label: '自动：分析后直接回复 Issue' },
]

const DRAFT_STATUS = {
  draft: { text: '待确认', tone: 'orange' },
  posted: { text: '已回复', tone: 'green' },
  failed: { text: '失败', tone: 'red' },
  dismissed: { text: '已忽略', tone: 'gray' },
}

const safeJson = value => {
  try {
    return JSON.stringify(value ?? null)
  } catch (_) {
    return ''
  }
}

export function renderGithubHubPanel(container, helpers = {}) {
  const { request, getChannels, getRoles: getRoleList, allowsScope, toast, openUrl, confirm: confirmDialog } = helpers
  const state = {
    status: null,
    subscriptions: {},
    blockedUsers: [],
    drafts: [],
    events: [],
    filter: '',
    loading: true,
    error: '',
    bridgeMissing: false,
    autoRepos: [],
  }
  let disposed = false

  const notify = (kind, message) => {
    const text = String(message || '')
    if (!text) return
    if (kind === 'error') toast?.error?.(text) ?? toast?.warn?.(text)
    else if (kind === 'warn') toast?.warn?.(text)
    else toast?.success?.(text) ?? toast?.info?.(text)
  }

  const confirmAction = async (title, message) => {
    if (typeof confirmDialog === 'function') return await confirmDialog(title, message)
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(`${title}\n\n${message}`)
    return false
  }

  const api = async (method, path, body) => {
    if (typeof request !== 'function') return { ok: false, error: '插件未连接本地后端' }
    try {
      return await request(method, path, body)
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  const loadAll = async () => {
    if (disposed) return
    state.loading = true
    state.error = ''
    try {
      const [statusResult, subResult, blockedResult, draftResult, eventResult] = await Promise.all([
        api('GET', '/github-hub/status'),
        api('GET', '/github-hub/subscriptions'),
        api('GET', '/github-hub/blocked-users'),
        api('GET', '/github-hub/drafts?status=draft'),
        api('GET', '/github-hub/events?limit=15'),
      ])
      if (disposed) return
      if (statusResult?.ok === false && /BRIDGE_NOT_LOADED|404|未加载/i.test(`${statusResult.code || ''} ${statusResult.error || ''}`)) {
        state.bridgeMissing = true
      }
      if (statusResult?.ok !== false) state.status = statusResult || {}
      if (subResult?.ok !== false) state.subscriptions = subResult?.subscriptions || {}
      if (blockedResult?.ok !== false) state.blockedUsers = Array.isArray(blockedResult?.users) ? blockedResult.users : []
      if (draftResult?.ok !== false) state.drafts = Array.isArray(draftResult?.drafts) ? draftResult.drafts : []
      if (eventResult?.ok !== false) state.events = Array.isArray(eventResult?.events) ? eventResult.events : []
      if (statusResult?.ok === false) state.error = statusResult.error || '后端桥未就绪'
    } catch (error) {
      state.error = error?.message || String(error)
    } finally {
      if (!disposed) {
        state.loading = false
        render()
      }
    }
  }

  const channels = () => {
    try {
      const list = getChannels?.() || []
      return Array.isArray(list) ? list.filter(channel => channel && channel.id) : []
    } catch (_) {
      return []
    }
  }

  const roles = () => {
    try {
      const list = getRoleList?.() || []
      return Array.isArray(list) ? list.filter(role => role && role.id) : []
    } catch (_) {
      return []
    }
  }

  const channelGroups = () => {
    const groups = new Map()
    for (const channel of channels()) {
      const key = `${channel.tab || 'private'}:${channel.groupName || '我的渠道'}`
      if (!groups.has(key)) groups.set(key, { key, tab: channel.tab || 'private', name: channel.groupName || '我的渠道', channels: [] })
      groups.get(key).channels.push(channel)
    }
    return [...groups.values()]
  }

  const findChannel = channelId => channels().find(channel => String(channel.id) === String(channelId)) || null

  const subscriptionOf = channelId => state.subscriptions[channelId] || { enabled: false, repos: {} }

  const saveSubscription = async channelId => {
    const channel = findChannel(channelId)
    if (!channel) return notify('error', '渠道不存在或已被删除')
    const current = subscriptionOf(channelId)
    const repos = Object.values(current.repos || {})
    const payload = {
      enabled: current.enabled !== false && repos.length > 0,
      name: channel.name || '',
      type: channel.type || '',
      tab: channel.tab || '',
      groupName: channel.groupName || '',
      // 后端桥无法访问渠道注册表；把角色 id 一并保存，通知生成 / 认领时才能
      // 按「设置 → 插件启用」的角色范围做最终拦截。
      roleId: String(channel.meta?.roleId || ''),
      repos: repos.map(item => ({ repo: item.repo, events: normalizeEventFilters(item.events) })),
    }
    const result = await api('PUT', `/github-hub/subscriptions/${encodeURIComponent(channelId)}`, payload)
    if (result?.ok === false) {
      notify('error', result.error || '订阅保存失败')
      return false
    }
    state.subscriptions[channelId] = result?.subscription || { ...payload, repos: Object.fromEntries(repos.map(item => [item.repo, item])) }
    renderChannelList()
    notify('success', `已更新「${channel.name}」的订阅`)
    return true
  }

  const toggleChannel = (channelId, on) => {
    const sub = subscriptionOf(channelId)
    sub.enabled = on
    state.subscriptions[channelId] = sub
    saveSubscription(channelId)
  }

  const toggleEvent = (channelId, repo, key, checked) => {
    const sub = subscriptionOf(channelId)
    const item = sub.repos?.[repo]
    if (!item) return
    item.events = normalizeEventFilters({ ...item.events, [key]: checked })
    state.subscriptions[channelId] = sub
    saveSubscription(channelId)
  }

  const addRepo = channelId => {
    const channel = findChannel(channelId)
    const wrap = [...container.querySelectorAll('[data-channel-card]')].find(item => item.dataset.channelCard === String(channelId))
    const inputEl = wrap?.querySelector('[data-role="add-repo-input"]')
    const repo = normalizeRepoFullName(inputEl?.value || '')
    if (!repo || !channel) {
      notify('warn', '请填写 owner/repo 格式的 GitHub 仓库')
      return
    }
    const sub = subscriptionOf(channelId)
    if (!sub.repos) sub.repos = {}
    if (sub.repos[repo]) {
      notify('warn', '这个仓库已经订阅过了')
      return
    }
    sub.repos[repo] = { repo, events: { ...DEFAULT_EVENT_FILTERS }, addedAt: Date.now() }
    sub.enabled = true
    state.subscriptions[channelId] = sub
    saveSubscription(channelId).then(ok => {
      if (ok && inputEl) inputEl.value = ''
    })
  }

  const removeRepo = (channelId, repo) => {
    const sub = subscriptionOf(channelId)
    if (!sub.repos?.[repo]) return
    delete sub.repos[repo]
    state.subscriptions[channelId] = sub
    saveSubscription(channelId)
  }

  const saveGlobalConfig = async () => {
    const tokenInput = container.querySelector('[data-field="githubToken"]')
    const token = String(tokenInput?.value || '').trim()
    const pollSeconds = Number(fieldValue(container, 'pollSeconds')) || 120
    const body = {
      githubToken: token || undefined,
      userLogin: String(fieldValue(container, 'userLogin') || '').trim(),
      ignoreSelf: fieldValue(container, 'ignoreSelf') === true,
      pollIntervalMs: Math.max(30, pollSeconds) * 1000,
      apiBase: String(fieldValue(container, 'apiBase') || '').trim(),
      proxy: String(fieldValue(container, 'proxy') || '').trim(),
      channels: {
        sendCard: fieldValue(container, 'channels.sendCard') === true,
        maxTextChars: Number(fieldValue(container, 'channels.maxTextChars')) || 900,
        timeZone: String(fieldValue(container, 'channels.timeZone') || '').trim() || 'Asia/Shanghai',
        maxEventAgeMs: Number(fieldValue(container, 'channels.maxEventAgeMs')) || 30 * 60 * 1000,
        maxPendingAgeMs: Number(fieldValue(container, 'channels.maxPendingAgeMs')) || 30 * 60 * 1000,
      },
      preview: {
        enabled: fieldValue(container, 'preview.enabled') === true,
        maxLinks: Number(fieldValue(container, 'preview.maxLinks')) || 2,
        channelEnabled: fieldValue(container, 'preview.channelEnabled') === true,
      },
    }
    if (tokenInput) tokenInput.value = ''
    const result = await api('PUT', '/github-hub/config', body)
    if (result?.ok === false) return notify('error', result.error || '配置保存失败')
    notify('success', '全局配置已保存')
    await loadAll()
  }

  const clearToken = async () => {
    const confirmed = await confirmAction('清除 GitHub Token', '清除后只能以未登录状态读取公开仓库，自动回复也会停止。确定继续？')
    if (!confirmed) return
    const result = await api('PUT', '/github-hub/config', { clearToken: true })
    if (result?.ok === false) return notify('error', result.error || '清除失败')
    notify('success', 'GitHub Token 已清除')
    await loadAll()
  }

  const saveScope = async () => {
    const enabled = fieldValue(container, 'scope.enabled') === true
    const roleIds = [...container.querySelectorAll('[data-scope-role]')]
      .filter(el => el.checked === true)
      .map(el => String(el.value || '').trim())
      .filter(Boolean)
    const channelIds = [...container.querySelectorAll('[data-scope-channel]')]
      .filter(el => el.checked === true)
      .map(el => String(el.value || '').trim())
      .filter(Boolean)
    if (enabled && !roleIds.length && !channelIds.length) {
      return notify('warn', '要限制启用范围，至少要勾选一个角色或渠道；否则所有会话都会看不到 GitHub 工具。')
    }
    const result = await api('PUT', '/github-hub/config', { scope: { enabled, roleIds, channelIds } })
    if (result?.ok === false) return notify('error', result.error || '启用范围保存失败')
    notify('success', enabled ? `启用范围已保存：${roleIds.length} 个角色 / ${channelIds.length} 个渠道` : '已关闭启用范围限制，所有角色都能使用 GitHub 工具')
    await loadAll()
  }

  const saveAutoReply = async () => {
    const config = state.status?.config?.autoReply || {}
    const body = {
      autoReply: {
        enabled: fieldValue(container, 'auto.enabled') === true,
        mode: String(fieldValue(container, 'auto.mode') || config.mode || 'draft'),
        repos: String(fieldValue(container, 'auto.repos') || '')
          .split(/[,，、;\s]+/)
          .map(item => normalizeRepoFullName(item))
          .filter(Boolean),
        provider: String(fieldValue(container, 'auto.provider') || '').trim(),
        model: String(fieldValue(container, 'auto.model') || '').trim(),
        onIssueOpened: fieldValue(container, 'auto.onIssueOpened') === true,
        onIssueComments: fieldValue(container, 'auto.onIssueComments') === true,
        maxFiles: Math.max(1, Math.min(12, Number(fieldValue(container, 'auto.maxFiles')) || 6)),
        maxContextChars: Math.max(4000, Math.min(120000, Number(fieldValue(container, 'auto.maxContextChars')) || 30000)),
        temperature: Math.max(0, Math.min(2, Number(fieldValue(container, 'auto.temperature')) || 0.2)),
        maxTokens: Math.max(200, Math.min(8000, Number(fieldValue(container, 'auto.maxTokens')) || 1200)),
        skipUsers: String(fieldValue(container, 'auto.skipUsers') || '')
          .split(/[,，、;\s]+/)
          .map(item => item.trim())
          .filter(Boolean),
        skipLabels: String(fieldValue(container, 'auto.skipLabels') || '')
          .split(/[,，、;\s]+/)
          .map(item => item.trim())
          .filter(Boolean),
        signature: String(fieldValue(container, 'auto.signature') || ''),
        systemPrompt: String(fieldValue(container, 'auto.systemPrompt') || ''),
        autoBlock: fieldValue(container, 'auto.autoBlock') === true,
      },
    }
    const result = await api('PUT', '/github-hub/config', body)
    if (result?.ok === false) return notify('error', result.error || '自动回复设置保存失败')
    notify('success', '自动回复设置已保存')
    await loadAll()
  }

  const pollNow = async () => {
    const result = await api('POST', '/github-hub/poll', {})
    if (result?.ok === false) return notify('error', result.error || '检查失败')
    notify('success', result.checked ? `已检查 ${result.checked} 个仓库` : '检查完成，没有已订阅仓库')
    await loadAll()
  }

  const publishDraft = async draft => {
    const confirmed = await confirmAction(
      '发布 Issue 回复',
      `将把下面的内容作为评论发布到 ${draft.repo} #${draft.number}：\n\n${truncate(draft.reply || '', 300)}`,
    )
    if (!confirmed) return
    const result = await api('POST', '/github-hub/reply', { repo: draft.repo, number: draft.number, body: draft.reply, draftId: draft.id })
    if (result?.ok === false) return notify('error', result.error || '回复发布失败')
    notify('success', '回复已发布到 Issue')
    await loadAll()
  }

  const dismissDraft = async draft => {
    const result = await api('POST', `/github-hub/drafts/${encodeURIComponent(draft.id)}/dismiss`, {})
    if (result?.ok === false) return notify('error', result.error || '操作失败')
    notify('success', '草稿已忽略')
    await loadAll()
  }

  const eventIcon = kind => ({ issue: '📮', issue_comment: '💬', push: '🚀', release: '📦', pull_request: '🔀', fork: '🍴', star: '⭐', create: '🌿', delete: '🧹' })[kind] || '🔔'

  const eventLabel = event => {
    const repo = event.repo || ''
    const number = event.number ? ` #${event.number}` : ''
    return `${event.actionText || '有更新'}${number}${event.title ? `：${event.title}` : ''}`
  }

  const renderStatusBadges = () => {
    const status = state.status || {}
    const config = status.config || {}
    const rate = status.rateLimit || {}
    const badges = [
      status.hasToken ? badge('GitHub Token 已配置', { tone: 'green' }) : badge('未配置 Token（建议配置）', { tone: 'orange' }),
      badge(`监控 ${status.monitoredRepos?.length ?? 0} 个仓库`, { tone: 'blue' }),
      badge(`订阅 ${status.subscriptionCount ?? 0} 个渠道`, { tone: 'gray' }),
      badge(config.autoReply?.enabled ? `自动回复：${config.autoReply.mode === 'auto' ? '直接回复' : '草稿'}` : '自动回复：关闭', { tone: config.autoReply?.enabled ? 'green' : 'gray' }),
    ]
    if (rate.remaining !== undefined) badges.push(badge(`API 余额 ${rate.remaining}${rate.resetAt ? ` · ${formatTime(rate.resetAt).slice(11)} 重置` : ''}`, { tone: rate.remaining <= 5 ? 'red' : 'gray' }))
    if (status.githubLogin) badges.push(badge(`Token 账号 ${status.githubLogin}`, { tone: 'gray' }))
    if (Number(status.blockedCount) > 0) badges.push(badge(`已屏蔽 ${status.blockedCount} 人`, { tone: 'red' }))
    if (status.polling) badges.push(badge('正在检查…', { tone: 'blue' }))
    if (status.lastError) badges.push(badge(`最近错误：${truncate(status.lastError, 60)}`, { tone: 'red' }))
    return badges.join('')
  }

  const renderGlobalSection = () => {
    const config = state.status?.config || {}
    const preview = config.preview || {}
    const channelsConfig = config.channels || {}
    const providers = state.status?.providers || []
    return section(
      '接入配置',
      card(
        row(
          'GitHub Token',
          '只保存在本机后端（AES-256-GCM 加密）。公开仓库只读可不填；自动回复 Issue、读取私有仓库或提高 API 限额时必须填写。留空表示不修改已保存的 Token。',
          `<span class="ghh-toolbar">${input('githubToken', '', { type: 'password', placeholder: state.status?.hasToken ? '已配置（留空保持不变）' : 'ghp_... 或 github_pat_...', width: 260 })}${button('保存配置', 'save-config', { variant: 'primary' })}${button('清除 Token', 'clear-token', { variant: 'danger' })}</span>`,
        ) +
          row('GitHub 登录名', '可选。用于在通知里识别你自己的操作；配置 Token 后插件也会自动识别 Token 所属账号并一起忽略。', input('userLogin', config.userLogin || '', { placeholder: '例如 nianfeng233', width: 220 })) +
          row('忽略自己触发的事件', '开启后，你自己账号创建的 Issue、评论不会推送通知，也不会自动分析；分支 Push / Release 仍会按订阅推送。默认开启。', switchButton('忽略自己', 'ignoreSelf', config.ignoreSelf !== false)) +
          row('轮询间隔', '越短越及时；未配置 Token 时 GitHub 限额较低，插件会自动放慢。', select('pollSeconds', Math.round((Number(config.pollIntervalMs) || 120000) / 1000), [30, 60, 120, 300, 600, 1800, 3600].map(value => ({ value, label: value < 60 ? `${value} 秒` : `${value / 60} 分钟` })), { width: 150 })) +
          row('HTTP 代理', 'GitHub API 访问代理，例如 http://127.0.0.1:7890。留空则跟随「设置 → 网络」的全局代理。', input('proxy', config.proxy || '', { placeholder: '跟随全局代理', width: 240 })) +
          row('GitHub API 地址', '高级选项。GitHub Enterprise 可改为 https://your-host/api/v3。', input('apiBase', config.apiBase || 'https://api.github.com', { width: 280 })) +
          row('通知卡片发到渠道', '开启后，渠道通知会附带一张 SVG 项目卡片。部分渠道（如 QQ）可能不支持 SVG 图片，失败会自动降级为纯文本。', switchButton('发送卡片', 'channels.sendCard', channelsConfig.sendCard === true)) +
          row('渠道通知长度上限', '单条渠道通知最多保留多少字符，默认 900。', input('channels.maxTextChars', channelsConfig.maxTextChars || 900, { type: 'number', width: 110 })) +
          row('时间显示时区', 'GitHub 返回 UTC，通知里会转换成这里选择的时区显示。默认 Asia/Shanghai；填错会保留原配置。', input('channels.timeZone', channelsConfig.timeZone || 'Asia/Shanghai', { placeholder: 'Asia/Shanghai', width: 170 })) +
          row('旧事件补发上限', '休眠 / 重装 / 重启后，只补发这个时间以内的新事件；更早的历史事件只记 seen，不再通知。默认 30 分钟，且至少覆盖两个轮询周期。', select('channels.maxEventAgeMs', Number(channelsConfig.maxEventAgeMs) || 1800000, [5, 10, 30, 60, 180].map(value => ({ value: value * 60000, label: `${value} 分钟` })), { width: 130 })) +
          row('通知队列过期时间', '通知生成后超过这个时间仍未投递，就自动作废，避免睡醒后一次刷出一堆旧动态。默认 30 分钟。', select('channels.maxPendingAgeMs', Number(channelsConfig.maxPendingAgeMs) || 1800000, [5, 10, 30, 60, 180].map(value => ({ value: value * 60000, label: `${value} 分钟` })), { width: 130 })) +
          row('链接自动预览', '聊天里出现 GitHub 链接时，自动生成项目卡片；仅在普通会话里展示，不会主动发到外部渠道。', switchButton('启用预览', 'preview.enabled', preview.enabled !== false)) +
          row('单条消息最多预览', '一条消息里最多解析几张项目卡片，默认 2。', select('preview.maxLinks', preview.maxLinks || 2, [1, 2, 3].map(value => ({ value, label: `${value} 张` })), { width: 110 })) +
          row('渠道会话里也生成预览', '开启后，QQ / 微信 / NapCat 等渠道里的 GitHub 链接也会自动生成预览；浏览器环境会栅格化成 PNG，服务端代聊环境会降级为文字卡片。', switchButton('渠道里启用', 'preview.channelEnabled', preview.channelEnabled === true)),
      ),
    )
  }

  const renderScopeSection = () => {
    const scope = state.status?.config?.scope || {}
    const enabled = scope.enabled === true
    const selectedRoles = new Set((scope.roleIds || []).map(value => String(value)))
    const selectedChannels = new Set((scope.channelIds || []).map(value => String(value)))
    const roleList = roles()
    const channelList = channels()
    const roleById = new Map(roleList.map(role => [String(role.id), role]))
    const roleItems = roleList.length
      ? roleList
          .map(
            role => `<label class="ghh-scope-item">
              <input type="checkbox" data-scope-role value="${escapeHtml(role.id)}"${selectedRoles.has(String(role.id)) ? ' checked' : ''} />
              <span class="ghh-scope-name">${escapeHtml(role.name || role.id)}</span>
              <span class="ghh-mono ghh-dim">${escapeHtml(role.id)}</span>
            </label>`,
          )
          .join('')
      : '<div class="ghh-empty">还没有角色。先在会话列表里创建一个角色，再回来勾选。</div>'
    const channelItems = channelList.length
      ? channelList
          .map(channel => {
            const roleId = String(channel.meta?.roleId || '')
            const roleName = roleById.get(roleId)?.name || roleId || '未绑定角色'
            return `<label class="ghh-scope-item">
              <input type="checkbox" data-scope-channel value="${escapeHtml(channel.id)}"${selectedChannels.has(String(channel.id)) ? ' checked' : ''} />
              <span class="ghh-scope-name">${escapeHtml(channel.name || channel.id)}</span>
              ${badge(channel.type || '渠道', { tone: 'gray' })}
              <span class="ghh-dim">角色：${escapeHtml(roleName)}</span>
            </label>`
          })
          .join('')
      : '<div class="ghh-empty">当前还没有渠道；也可以只按角色限制。</div>'
    return section(
      '启用范围（工具与链接预览）',
      card(
        row(
          '限制启用的角色 / 渠道',
          '默认关闭：所有角色都能加载 GitHub 工具，消息里的 GitHub 链接也会自动预览。开启后只有勾选的“角色”或“渠道”命中时才加载，其它会话完全看不到这些工具，能有效避免误触发、工具递归调用；渠道通知也按同一份启用范围执行。',
          switchButton('仅勾选的角色 / 渠道', 'scope.enabled', enabled),
        ) +
          `<div class="ghh-scope-options" data-scope-options style="display:${enabled ? 'block' : 'none'}">
            <div class="ghh-scope-group">
              <div class="ghh-scope-head">
                <span class="ghh-scope-title">角色（${roleList.length}）</span>
                <span class="ghh-toolbar" style="margin:0">${button('全选', 'scope-toggle', { dataset: { scopeType: 'role', scopeMode: 'all' } })}${button('清空', 'scope-toggle', { dataset: { scopeType: 'role', scopeMode: 'none' } })}</span>
              </div>
              <div class="ghh-scope-list">${roleItems}</div>
            </div>
            <div class="ghh-scope-group">
              <div class="ghh-scope-head">
                <span class="ghh-scope-title">渠道（${channelList.length}）</span>
                <span class="ghh-toolbar" style="margin:0">${button('全选', 'scope-toggle', { dataset: { scopeType: 'channel', scopeMode: 'all' } })}${button('清空', 'scope-toggle', { dataset: { scopeType: 'channel', scopeMode: 'none' } })}</span>
              </div>
              <div class="ghh-scope-list">${channelItems}</div>
            </div>
          </div>
          <div class="ghh-toolbar" style="margin-bottom:0">${button('保存启用范围', 'save-scope', { variant: 'primary' })}<span class="ghh-dim">保存后立即生效，无需刷新。</span></div>`,
      ),
    )
  }

  const renderChannelRepoEditor = (channel, sub) => {
    const repos = Object.values(sub.repos || {}).sort((a, b) => String(a.repo).localeCompare(String(b.repo)))
    const repoHtml = repos.length
      ? repos
          .map(item => {
            const events = normalizeEventFilters(item.events)
            return `<div class="ghh-repo">
              <div class="ghh-repo-head">
                <span class="ghh-repo-name">${escapeHtml(item.repo)}</span>
                ${button('移除', 'remove-repo', { variant: 'danger' })}
              </div>
              <div class="ghh-events">
                ${EVENT_FILTER_KEYS.map(key => `<label class="ghh-evt"><input type="checkbox" data-action="toggle-event" data-channel-id="${escapeHtml(channel.id)}" data-repo="${escapeHtml(item.repo)}" data-event-key="${key}"${events[key] ? ' checked' : ''} />${escapeHtml(EVENT_FILTER_LABELS[key])}</label>`).join('')}
              </div>
            </div>`
          })
          .join('')
      : '<div class="ghh-empty">还没有订阅仓库，添加一个 owner/repo 后即可收到 Issue / Push / Release 等通知。</div>'
    return `<div class="ghh-repos">${repoHtml}
      <div class="ghh-add">
        <input class="ghh-input" data-role="add-repo-input" data-channel-id="${escapeHtml(channel.id)}" placeholder="owner/repo，例如 nianfeng233/NianFeng-Chat" style="width:280px" />
        ${button('添加仓库', 'add-repo')}
      </div>
    </div>`
  }

  const renderChannelList = () => {
    const host = container.querySelector('[data-role="channels"]')
    if (!host) return
    const keyword = state.filter.trim().toLowerCase()
    const groups = channelGroups()
      .map(group => ({
        ...group,
        channels: group.channels.filter(channel => {
          if (!keyword) return true
          return [channel.name, channel.type, channel.id, channel.groupName, channel.tab].some(value => String(value || '').toLowerCase().includes(keyword))
        }),
      }))
      .filter(group => group.channels.length)
    if (!channels().length) {
      host.innerHTML = '<div class="ghh-empty">当前还没有任何渠道。先在「渠道」页添加一个 QQ / NapCat / 微信等渠道，再回来订阅 GitHub 仓库。</div>'
      return
    }
    if (!groups.length) {
      host.innerHTML = '<div class="ghh-empty">没有匹配的渠道。</div>'
      return
    }
    host.innerHTML = groups
      .map(
        group => `
        <div class="ghh-dim" style="margin:12px 0 4px;">${escapeHtml(group.name)} · ${group.tab === 'group' ? '群聊' : group.tab === 'privacy' ? '隐私' : '私聊'}</div>
        ${group.channels
          .map(channel => {
            const sub = subscriptionOf(channel.id)
            const repoCount = Object.keys(sub.repos || {}).length
            const statusClass = channel.status === 'online' ? 'online' : channel.status === 'error' ? 'error' : channel.status === 'connecting' ? 'connecting' : ''
            return `<div class="ghh-channel" data-channel-card="${escapeHtml(channel.id)}">
              <div class="ghh-channel-head">
                <span class="ghh-dot ${statusClass}"></span>
                <strong>${escapeHtml(channel.name || channel.id)}</strong>
                ${badge(channel.type || '未知类型', { tone: 'gray' })}
                <span class="ghh-dim">${repoCount ? `已订阅 ${repoCount} 个仓库` : '未订阅仓库'}</span>
                <span style="flex:1"></span>
                ${button('测试通知', 'test-notification', { dataset: { channelId: channel.id } })}
                ${switchButton(sub.enabled !== false && repoCount > 0 ? '订阅中' : '未启用', 'channel-toggle', sub.enabled !== false && repoCount > 0)}
              </div>
              ${renderChannelRepoEditor(channel, sub)}
            </div>`
          })
          .join('')}
      `,
      )
      .join('')
    for (const buttonEl of host.querySelectorAll('.ghh-switch[data-field="channel-toggle"]')) {
      const cardEl = buttonEl.closest('[data-channel-card]')
      if (!cardEl) continue
      buttonEl.dataset.channelId = cardEl.dataset.channelCard
    }
  }

  const renderAutoReplySection = () => {
    const config = state.status?.config?.autoReply || {}
    const providers = state.status?.providers || []
    const models = state.status?.models || []
    const selectedProvider = config.provider || state.status?.defaultProvider || ''
    const providerOptions = [{ value: '', label: '跟随当前模型设置' }, ...providers.map(provider => ({ value: provider.id, label: `${provider.name || provider.id}${provider.configured ? '' : '（未配置 Key）'}` }))]
    const modelOptions = models
      .filter(model => !selectedProvider || model.providerId === selectedProvider)
      .map(model => ({ value: model.id, label: model.name || model.id }))
    const repoText = (config.repos || []).join(', ')
    return section(
      '自动分析 Issue 并回复（LLM）',
      card(
        row('总开关', '开启后，新 Issue 到达时会让后端读取仓库内容分析问题。默认只生成草稿并通知你确认，不会自动发帖；只有选择「自动回复」才会直接发布。', switchButton('启用', 'auto.enabled', config.enabled === true)) +
          row('处理模式', '草稿模式最安全：分析结果会推送到已订阅渠道，你确认后再发布。', select('auto.mode', config.mode || 'draft', AUTO_MODES, { width: 240 })) +
          row('适用仓库', '逗号分隔的 owner/repo；留空表示所有已订阅仓库。支持手动输入。', input('auto.repos', repoText, { placeholder: '留空 = 所有已订阅仓库', width: 320 })) +
          row('模型提供商 / 模型', '提供商可选；模型 id 留空会自动使用该提供商下第一个可用模型（推荐）。分析 Issue 会消耗模型 token。', `<span class="ghh-toolbar">${select('auto.provider', selectedProvider, providerOptions, { width: 190 })}${input('auto.model', config.model || '', { placeholder: '留空 = 自动选第一个模型', width: 190 })}</span>`) +
          row('触发时机', '建议至少开启第一个。Issue 评论默认关闭，避免机器人在讨论里刷屏。', `<span class="ghh-toolbar">${switchButton('新 Issue 打开', 'auto.onIssueOpened', config.onIssueOpened !== false)}${switchButton('Issue 新评论', 'auto.onIssueComments', config.onIssueComments === true)}</span>`) +
          row('主动屏蔽滥用用户', '开启后，当模型判断某个 Issue 明显是广告、诈骗或恶意刷屏时，可以输出屏蔽指令把对方加入屏蔽名单；普通提问、重复提问、正常批评不会触发。', switchButton('允许自动屏蔽', 'auto.autoBlock', config.autoBlock !== false)) +
          row('读取文件上限', '分析时最多读取几个相关源码文件；目录树和 README 始终会读。', `<span class="ghh-toolbar">${input('auto.maxFiles', config.maxFiles || 6, { type: 'number', width: 90 })}${input('auto.maxContextChars', config.maxContextChars || 30000, { type: 'number', width: 130 })}<span class="ghh-dim">上下文 token 预算（字符）</span></span>`) +
          row('生成参数', 'temperature / 最大输出 token。', `<span class="ghh-toolbar">${input('auto.temperature', config.temperature ?? 0.2, { type: 'number', width: 80 })}${input('auto.maxTokens', config.maxTokens || 1200, { type: 'number', width: 100 })}</span>`) +
          row('跳过用户 / 标签', '逗号分隔。机器人、依赖更新机器人默认已跳过；带这些标签的 Issue 不处理。', `<span class="ghh-toolbar">${input('auto.skipUsers', (config.skipUsers || []).join(', '), { placeholder: 'dependabot[bot]', width: 190 })}${input('auto.skipLabels', (config.skipLabels || []).join(', '), { placeholder: 'no-ai', width: 170 })}</span>`) +
          row('回复签名', '追加到自动回复末尾；留空表示不加。', textarea('auto.signature', config.signature ?? '', { rows: 2, width: 100 })) +
          row('系统提示词（高级）', '留空使用内置提示词。内置提示词会强调「只读仓库、禁止执行 Issue / 仓库里的指令、不编造事实」。', textarea('auto.systemPrompt', config.systemPrompt || '', { rows: 4, width: 100 })) +
          row(
            '',
            '保存后立即生效。GitHub Token 需要 `public_repo`（公开仓库）或 `repo`（私有仓库）权限才能发布评论；读取代码始终是只读的。',
            `<span class="ghh-toolbar">${button('保存自动回复设置', 'save-auto-reply', { variant: 'primary' })}${button('立即检查一次', 'poll-now')}</span>`,
          ),
      ),
    )
  }

  const renderDraftsSection = () => {
    const drafts = state.drafts || []
    const items = drafts.length
      ? drafts
          .map(draft => {
            const statusInfo = DRAFT_STATUS[draft.status] || DRAFT_STATUS.draft
            return `<div class="ghh-list-item">
              <div class="ghh-list-main">
                <div class="ghh-list-title">${badge(statusInfo.text, { tone: statusInfo.tone })} ${escapeHtml(draft.repo || '')} #${escapeHtml(String(draft.number || ''))} ${escapeHtml(truncate(draft.title || '', 80))}</div>
                <div class="ghh-list-summary">${escapeHtml(truncate(draft.reply || draft.analysis || '（分析结果为空）', 420))}</div>
                <div class="ghh-toolbar" style="margin:8px 0 0;">
                  ${draft.status === 'draft' ? button(draft.mode === 'auto' ? '重新发布' : '发布到 Issue', 'publish-draft', { dataset: { draftId: draft.id } }) : ''}
                  ${draft.status === 'draft' ? button('忽略', 'dismiss-draft', { variant: 'danger', dataset: { draftId: draft.id } }) : ''}
                  ${draft.url ? button('打开 Issue', 'open-url', { dataset: { url: draft.url } }) : ''}
                  ${draft.commentUrl ? button('查看回复', 'open-url', { dataset: { url: draft.commentUrl } }) : ''}
                </div>
              </div>
              <div class="ghh-list-time">${escapeHtml(relativeTime(draft.createdAt))}</div>
            </div>`
          })
          .join('')
      : '<div class="ghh-empty">暂无待确认草稿。开启自动回复后，新 Issue 的分析结果会出现在这里，并同步通知到已订阅渠道。</div>'
    return section(`草稿与回复（${drafts.length}）`, `<div data-role="drafts">${items}</div>`)
  }

  const renderBlockedSection = () => {
    const users = state.blockedUsers || []
    const items = users.length
      ? users
          .map(
            user => `<div class="ghh-list-item">
              <div class="ghh-list-main">
                <div class="ghh-list-title">${badge('已屏蔽', { tone: 'red' })} ${escapeHtml(user.login)}</div>
                <div class="ghh-list-summary">${escapeHtml(user.reason || '未填写原因')} · ${escapeHtml(relativeTime(user.at))}${user.by ? ` · ${escapeHtml(user.by)}` : ''}</div>
              </div>
              ${button('解开', 'unblock-user', { dataset: { username: user.login } })}
            </div>`,
          )
          .join('')
      : '<div class="ghh-empty">屏蔽名单为空。被屏蔽用户的 Issue / 评论不会推送通知，也不会触发 LLM 分析。</div>'
    return section(
      `屏蔽名单（${users.length}）`,
      `<div class="ghh-note">当前角色可以在对话里通过 <code>github_user_block</code> 工具主动屏蔽刷屏 / 广告用户；也可以在这里手动添加或解开。屏蔽只会影响本插件，不会在 GitHub 上做任何操作。</div>
       <div class="ghh-toolbar"><input class="ghh-input" data-role="block-input" placeholder="GitHub 用户名" style="width:220px" />${button('加入屏蔽', 'block-user')}${button('刷新', 'refresh')}</div>
       ${items}`,
    )
  }

  const renderEventsSection = () => {
    const events = state.events || []
    const items = events.length
      ? events
          .map(
            event => `<div class="ghh-list-item">
            <div style="font-size:20px;line-height:1;">${eventIcon(event.kind)}</div>
            <div class="ghh-list-main">
              <div class="ghh-list-title">${escapeHtml(event.repo || '')} · ${escapeHtml(eventLabel(event))}</div>
              <div class="ghh-list-summary">${escapeHtml(truncate(event.body || event.commitMessage || '', 180))}</div>
              <div class="ghh-toolbar" style="margin:6px 0 0;">${event.url ? button('打开', 'open-url', { dataset: { url: event.url } }) : ''}</div>
            </div>
            <div class="ghh-list-time">${escapeHtml(relativeTime(event.time || event.at))}</div>
          </div>`,
          )
          .join('')
      : '<div class="ghh-empty">还没有捕获到动态。订阅仓库后，新的 Issue / Push / Release 会出现在这里。</div>'
    return section('最近动态', `<div data-role="events">${items}</div>`)
  }

  const render = () => {
    if (disposed) return
    if (state.loading && !state.status) {
      container.innerHTML = '<div class="ghh-loading">正在连接 GitHub 助手后端桥…</div>'
      return
    }
    if (state.bridgeMissing) {
      container.innerHTML = `<div class="ghh-error">GitHub 助手后端桥尚未加载。请到「设置 → 插件」点一次「重新扫描」；老内核可在安装后重启后端。</div>`
      return
    }
    const config = state.status?.config || {}
    container.innerHTML = `
      <div class="ghh-head">
        <div>
          <div class="settings-title">GitHub 助手</div>
          <div class="settings-desc">订阅仓库动态推送到渠道 · 聊天链接自动预览项目 · LLM 只读分析并回复 Issue</div>
        </div>
        <div class="ghh-actions">${button('刷新', 'refresh')}${button('立即检查', 'poll-now', { variant: 'primary' })}</div>
      </div>
      <div class="ghh-status">${renderStatusBadges()}</div>
      ${state.error ? `<div class="ghh-error">${escapeHtml(state.error)}</div>` : ''}
      ${
        /fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT/i.test(String(state.status?.lastError || ''))
          ? `<div class="ghh-error">后端当前访问 GitHub API 失败（${escapeHtml(state.status?.lastError || '')}）。这会导致仓库事件根本拉不下来，和角色 / 渠道启用范围无关；请给后端进程配置 HTTPS_PROXY / HTTP_PROXY 环境变量，或在下方「HTTP 代理」里填写代理地址。</div>`
          : ''
      }
      ${renderGlobalSection()}
      ${section(
        '启用范围',
        card(
          row(
            '按角色 / 渠道启用 GitHub 助手',
            '已接入本体统一入口：打开「设置 → 插件启用」，选择 GitHub 助手后可按角色或单个渠道开启 / 关闭。关闭后该角色 / 渠道的模型看不到 GitHub 工具定义，链接预览会停用，渠道通知（含测试通知）也会一并丢弃；重新启用前不会补发历史通知。',
            '<span class="ghh-dim">设置 → 插件启用</span>',
          ),
        ),
      )}
      ${section(
        `渠道订阅（${channels().length} 个渠道）`,
        `<div class="ghh-note">在下面每个渠道里添加 GitHub 仓库，并勾选需要推送的事件类型。支持 Issue、Issue 评论、分支更新（Push）、Release、Pull Request、Fork / Star 等。保存后自动开始轮询。</div>
         <div class="ghh-toolbar"><input class="ghh-input" data-role="channel-filter" placeholder="筛选渠道…" value="${escapeHtml(state.filter)}" style="width:220px" /></div>
         <div data-role="channels"></div>`,
      )}
      ${renderAutoReplySection()}
      ${renderBlockedSection()}
      ${renderDraftsSection()}
      ${renderEventsSection()}
    `
    renderChannelList()
    const filterInput = container.querySelector('[data-role="channel-filter"]')
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        state.filter = filterInput.value
        renderChannelList()
      })
    }
  }

  const draftById = buttonEl => state.drafts.find(draft => String(draft.id) === String(buttonEl.dataset.draftId)) || null

  const onClick = async event => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    const action = target.dataset.action
    const channelCard = target.closest('[data-channel-card]')
    const channelId = channelCard?.dataset.channelCard || target.dataset.channelId || ''
    if (action === 'refresh') return loadAll()
    if (action === 'poll-now') return pollNow()
    if (action === 'save-config') return saveGlobalConfig()
    if (action === 'save-scope') return saveScope()
    if (action === 'scope-toggle') {
      const selector = target.dataset.scopeType === 'channel' ? '[data-scope-channel]' : '[data-scope-role]'
      const checked = target.dataset.scopeMode === 'all'
      container.querySelectorAll(selector).forEach(el => {
        el.checked = checked
      })
      return
    }
    if (action === 'clear-token') return clearToken()
    if (action === 'save-auto-reply') return saveAutoReply()
    if (action === 'add-repo') return addRepo(channelId)
    if (action === 'remove-repo') {
      const repo = target.closest('.ghh-repo')?.querySelector('.ghh-repo-name')?.textContent || ''
      return removeRepo(channelId, repo)
    }
    if (action === 'open-url') {
      const url = target.dataset.url || ''
      if (url) openUrl?.(url)
      return
    }
    if (action === 'test-notification') {
      // 防止双击 / 连续点击在短时间内生成多条测试通知。
      if (target.dataset.testing === '1') return
      target.dataset.testing = '1'
      target.setAttribute('disabled', 'disabled')
      try {
        const channel = findChannel(channelId)
        const roleId = String(channel?.meta?.roleId || '')
        if (typeof allowsScope === 'function' && allowsScope({ channelId, roleId }) === false) {
          return notify('warn', 'GitHub 助手在当前角色 / 渠道已被关闭，请先到「设置 → 插件启用」开启后再测试。')
        }
        const result = await api('POST', '/github-hub/test-notification', {
          channelId,
          roleId,
          name: channel?.name || channelId,
          type: channel?.type || '',
        })
        if (result?.ok === false) notify('error', result.error || '测试通知失败')
        else notify('success', '测试通知已进入投递队列；如果渠道正常，几秒内会收到')
      } finally {
        target.removeAttribute('disabled')
        delete target.dataset.testing
      }
      return
    }
    if (action === 'block-user') {
      const inputEl = container.querySelector('[data-role="block-input"]')
      const username = String(inputEl?.value || '').trim().replace(/^@+/, '')
      if (!username) return notify('warn', '请先填写要屏蔽的 GitHub 用户名')
      const result = await api('POST', '/github-hub/blocked-users', { action: 'block', username, reason: '手动添加', by: 'panel' })
      if (result?.ok === false) return notify('error', result.error || '添加屏蔽失败')
      notify('success', `已屏蔽 ${username}`)
      await loadAll()
      return
    }
    if (action === 'unblock-user') {
      const username = String(target.dataset.username || '').trim()
      if (!username) return
      const result = await api('POST', '/github-hub/blocked-users', { action: 'unblock', username, by: 'panel' })
      if (result?.ok === false) return notify('error', result.error || '解开屏蔽失败')
      notify('success', `已解开 ${username}`)
      await loadAll()
      return
    }
    if (action === 'publish-draft') {
      const draft = draftById(target)
      if (draft) return publishDraft(draft)
      return
    }
    if (action === 'dismiss-draft') {
      const draft = draftById(target)
      if (draft) return dismissDraft(draft)
      return
    }
  }

  const onChange = event => {
    const target = event.target
    if (!target) return
    if (target.dataset.action === 'toggle-event') {
      toggleEvent(target.dataset.channelId, target.dataset.repo, target.dataset.eventKey, target.checked)
    }
  }

  const onSwitchClick = event => {
    const target = event.target.closest('.ghh-switch')
    if (!target || !container.contains(target)) return
    const field = target.dataset.field
    if (field === 'channel-toggle') {
      const on = !target.classList.contains('on')
      target.classList.toggle('on', on)
      target.setAttribute('aria-checked', on ? 'true' : 'false')
      const channelId = target.dataset.channelId || target.closest('[data-channel-card]')?.dataset.channelCard
      if (channelId) toggleChannel(channelId, on)
      return
    }
    const on = !target.classList.contains('on')
    target.classList.toggle('on', on)
    target.setAttribute('aria-checked', on ? 'true' : 'false')
    if (field === 'scope.enabled') {
      const options = container.querySelector('[data-scope-options]')
      if (options) options.style.display = on ? 'block' : 'none'
    }
  }

  container.addEventListener('click', onSwitchClick)
  container.addEventListener('click', onClick)
  container.addEventListener('change', onChange)
  loadAll()

  return () => {
    disposed = true
    container.removeEventListener('click', onSwitchClick)
    container.removeEventListener('click', onClick)
    container.removeEventListener('change', onChange)
    container.innerHTML = ''
  }
}
