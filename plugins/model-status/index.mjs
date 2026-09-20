/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 模型状态订阅（外部插件，独立目录，不改本体）。
 *
 *   前端职责：
 *     1. 设置页：按渠道选择要订阅的状态站点 / 模型组件；
 *     2. 投递：把后端桥生成的状态通知写进渠道会话，由 channel-base 外发到 QQ / 微信等群；
 *     3. 通知中心的本地提醒。
 *   后端职责（bridge.mjs）：
 *     轮询 Statuspage API / RSS / Google Cloud incidents，检测状态变化。
 */
export const name = 'model-status'
export const version = '2.1.0'
export const scope = 'both'
export const displayName = '模型状态订阅'
export const description = '订阅 DeepSeek、Claude、GPT、Gemini、Grok 等模型厂商状态页，故障 / 恢复 / 组件状态变化推送到渠道。'
export const author = '念风扩展'
export const icon = '📡'
export const core = false
export const enabled = true
export const depends = {
  'event-bus': '*',
  'tool-registry': '^1.0.0',
  'channel-registry': '^1.0.0',
  'session-service': '^2.0.0',
  'message-service': '^1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'plugin-manager': '>=1.0.0',
  'settings-container': '^1.0.0',
  'channel-base': '^1.0.0',
  'notification': '^2.0.0',
  'toast-host': '>=1.0.0',
  'modal-host': '>=1.0.0',
}
export const inject = ['event-bus', 'tool-registry', 'channel-registry', 'session-service', 'message-service']
export const provides = []
export const permissions = ['network', 'storage']

import { MODEL_STATUS_ICON, PANEL_CSS, useStyle } from './ui.mjs'
import { renderModelStatusPanel } from './panel.mjs'
import { formatTime, truncateText } from './lib/util.mjs'

const BRIDGE_NOT_LOADED_HINT = '请在「设置 → 插件」点一次「重新扫描」热加载外置后端桥；如果当前内核版本较旧，请安装后重启念风后端。'

export function apply(ctx) {
  const tools = ctx.inject('tool-registry')
  const channels = ctx.inject('channel-registry')
  const sessions = ctx.inject('session-service')
  const messages = ctx.inject('message-service')

  useStyle(ctx, PANEL_CSS, { id: 'model-status' })

  const pluginId = 'model-status'
  const runtimeRole = globalThis.__NIANFENG_SERVER_AGENT__ === true ? 'agent' : 'web'
  const runtimeId = `ms-${runtimeRole}-${Math.random().toString(36).slice(2, 8)}`
  const deliveredNotificationKeys = new Set()
  const queuedNotificationKeys = new Set()
  const processingNotifications = new Set()
  const canceledNotificationIds = new Set()
  const localShownNotifications = new Set()
  let deliveryChain = Promise.resolve()
  let eventSource = null
  let bridgeWarned = false

  const getApi = () => ctx.registry.get('api')
  const getToast = () => ctx.registry.get('toast')
  const getModal = () => ctx.registry.get('modal')
  const getNotification = () => ctx.registry.get('notification')
  const getChannelBase = () => ctx.registry.get('channel-base')

  const toastError = message => {
    try {
      const toast = getToast()
      if (toast?.error) toast.error(message)
      else toast?.warn?.(message)
    } catch (_) {
      /* ignore */
    }
  }

  const apiBaseUrl = () => {
    try {
      return String(getApi()?.baseUrl?.() || '/api').replace(/\/+$/, '')
    } catch (_) {
      return '/api'
    }
  }

  const tokenQuery = () => {
    if (typeof location === 'undefined') return ''
    try {
      const token = new URLSearchParams(location.search || '').get('token')
      return token ? `?token=${encodeURIComponent(token)}` : ''
    } catch (_) {
      return ''
    }
  }

  const absoluteUrl = path => {
    const value = `${apiBaseUrl()}${path}`
    if (/^https?:\/\//i.test(value)) return value
    if (typeof location !== 'undefined' && location.href) {
      try {
        return new URL(value, location.href).href
      } catch (_) {
        return value
      }
    }
    return value
  }

  const bridgeCall = async (method, path, body, timeoutMs = 30000, extra = {}) => {
    const api = getApi()
    if (!api) {
      return {
        ok: false,
        code: 'BACKEND_OFFLINE',
        error: '本地后端未连接，模型状态订阅暂时不可用。',
        hint: '请在「设置 → 网络」确认后端状态，然后重新打开设置页。',
      }
    }
    const upper = String(method || 'GET').toUpperCase()
    try {
      let result
      const options = { timeoutMs }
      if (upper === 'GET') result = await api.get(path, options)
      else if (upper === 'POST') result = await api.post(path, body ?? {}, options)
      else if (upper === 'PUT') result = await api.put(path, body ?? {}, options)
      else if (upper === 'DELETE') result = await api.del(path, options)
      else throw new Error(`不支持的请求方法：${upper}`)
      return result && typeof result === 'object' ? result : { ok: true, result }
    } catch (error) {
      const status = Number(error?.status) || 0
      if (status === 404) {
        if (extra?.silent404 !== true && !bridgeWarned) {
          bridgeWarned = true
          toastError(`模型状态订阅后端桥未加载。${BRIDGE_NOT_LOADED_HINT}`)
        }
        return { ok: false, code: 'BRIDGE_NOT_LOADED', error: '模型状态订阅后端桥未加载。', hint: BRIDGE_NOT_LOADED_HINT }
      }
      return {
        ok: false,
        code: status === 401 ? 'BACKEND_AUTH' : status === 403 ? 'BACKEND_FORBIDDEN' : 'BACKEND_ERROR',
        error: `本地后端调用失败：${error?.message || error}`,
      }
    }
  }

  const findChannelById = channelId => {
    const wanted = String(channelId || '')
    if (!wanted) return null
    for (const tab of channels.tabs()) {
      for (const group of channels.groups(tab)) {
        const channel = (group.channels || []).find(item => String(item.id) === wanted)
        if (channel) return { tab, group, channel }
      }
    }
    return null
  }

  const getChannelList = () => {
    const out = []
    for (const tab of channels.tabs()) {
      for (const group of channels.groups(tab)) {
        for (const channel of group.channels || []) {
          out.push({
            id: channel.id,
            name: channel.name || channel.id,
            type: channel.type || '',
            status: channel.status || 'offline',
            tab,
            groupId: group.id,
            groupName: group.name || '',
            conversationId: String(channel.meta?.conversationId || ''),
            meta: channel.meta || {},
          })
        }
      }
    }
    return out
  }

  const centralScopeAllows = context => {
    try {
      const scope = ctx.registry.get('plugin-scope')
      if (typeof scope?.allows !== 'function') return true
      return scope.allows(pluginId, context) !== false
    } catch (_) {
      return true
    }
  }

  const ensureConversation = found => {
    const { tab, channel } = found
    const channelBase = getChannelBase()
    if (channelBase?.conversationFor) {
      const existing = channelBase.conversationFor(channel)
      if (existing) return existing
    }
    const currentId = String(channel.meta?.conversationId || '')
    if (currentId && sessions.get(currentId)) return currentId
    const conv = sessions.create({
      name: channel.name || channel.id,
      avatar: (channel.name || 'M').slice(0, 1),
      c1: channel.color,
      c2: channel.color,
      preview: `${channel.name || channel.id} 已接入`,
      meta: { channelId: channel.id, channelType: channel.type },
    })
    channels.updateChannel(tab, channel.id, { meta: { ...(channel.meta || {}), conversationId: conv.id } })
    return conv.id
  }

  const openExternal = url => {
    const value = String(url || '').trim()
    if (!value || typeof window === 'undefined') return
    try {
      window.open(value, '_blank', 'noopener,noreferrer')
    } catch (_) {
      /* ignore */
    }
  }

  const confirmDialog = async (title, message) => {
    const modal = getModal()
    if (typeof modal?.confirm === 'function') {
      try {
        return await modal.confirm(title, message)
      } catch (_) {
        return false
      }
    }
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(`${title}\n\n${message}`)
    return true
  }

  const canDeliverChannels = () => {
    const api = getApi()
    if (!api) return false
    if (typeof api.configured === 'function' && api.configured() !== true) return false
    if (globalThis.__NIANFENG_SERVER_AGENT__ === true) return true
    return !api?.supports?.('server-agent')
  }

  const isBrowserRuntime = () => typeof document !== 'undefined' && globalThis.__NIANFENG_SERVER_AGENT__ !== true

  const notificationScopeContext = notification => ({
    conversationId: String(findChannelById(notification?.target?.channelId)?.channel?.meta?.conversationId || ''),
    channelId: String(notification?.target?.channelId || ''),
    roleId: String(notification?.target?.roleId || ''),
  })

  const notificationScopeAllows = notification => centralScopeAllows(notificationScopeContext(notification))

  const showLocalNotification = notification => {
    if (!isBrowserRuntime() || !notification?.id || localShownNotifications.has(notification.id)) return
    localShownNotifications.add(notification.id)
    if (localShownNotifications.size > 500) localShownNotifications.clear()
    const service = getNotification()
    if (!service?.notify) return
    const event = notification.event || {}
    const text = String(notification.target?.text || '').replace(/\s+/g, ' ').trim()
    try {
      service.notify({
        kind: 'other',
        title: `模型状态 · ${event.sourceName || '状态更新'}`,
        body: truncateText(text || event.title || '收到新的模型状态动态', 180),
        plugin: true,
        background: true,
        sound: false,
        onClick: () => openExternal(event.url),
      })
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 渠道通知投递                                                        */
  /* ------------------------------------------------------------------ */

  const notificationIdOf = notification => String(notification?.id || '')
  const deliveryKeyOf = notification => `${notificationIdOf(notification)}:${notification?.target?.channelId || ''}`

  const markNotificationDelivered = key => {
    if (!key) return
    deliveredNotificationKeys.add(key)
    if (deliveredNotificationKeys.size <= 1000) return
    const oldest = deliveredNotificationKeys.values().next().value
    if (oldest) deliveredNotificationKeys.delete(oldest)
  }

  const markNotificationCanceled = id => {
    const key = String(id || '')
    if (!key) return
    canceledNotificationIds.add(key)
    if (canceledNotificationIds.size > 1000) {
      const oldest = canceledNotificationIds.values().next().value
      if (oldest) canceledNotificationIds.delete(oldest)
    }
  }

  const ackNotification = async (notification, ok, error = '') => {
    try {
      const result = await bridgeCall('POST', '/model-status/notifications/ack', {
        id: notification.id,
        channelId: notification.target?.channelId || '',
        ok,
        error,
      })
      return result?.ok !== false
    } catch (_) {
      return false
    }
  }

  const deliverNotification = async notification => {
    const key = deliveryKeyOf(notification)
    if (canceledNotificationIds.has(notificationIdOf(notification))) {
      queuedNotificationKeys.delete(key)
      await ackNotification(notification, true, '订阅已取消，通知已丢弃')
      return
    }
    if (deliveredNotificationKeys.has(key)) {
      queuedNotificationKeys.delete(key)
      await ackNotification(notification, true)
      return
    }
    if (processingNotifications.has(key)) return
    processingNotifications.add(key)
    let succeeded = false
    try {
      const target = notification.target || {}
      const found = findChannelById(target.channelId)
      if (!found) {
        await ackNotification(notification, false, `渠道不存在（${target.channelId || '未知'}）`)
        return
      }
      const channel = found.channel
      const scopeContext = {
        conversationId: String(channel.meta?.conversationId || ''),
        channelId: String(target.channelId || ''),
        roleId: String(channel.meta?.roleId || target.roleId || ''),
      }
      if (!centralScopeAllows(scopeContext)) {
        succeeded = true
        await ackNotification(notification, true, '插件未在当前角色 / 渠道启用，通知已丢弃')
        return
      }
      const conversationId = ensureConversation(found)
      if (!conversationId) {
        await ackNotification(notification, false, '无法创建渠道会话')
        return
      }
      scopeContext.conversationId = conversationId

      // 最后一道幂等：热重载 / 双端启动时同一通知不要写两条。
      if (typeof messages.list === 'function') {
        const list = messages.list(conversationId) || []
        for (let index = list.length - 1; index >= 0; index -= 1) {
          const item = list[index]
          if (String(item?.meta?.modelStatusNotificationId || '') !== String(notification.id)) continue
          if (item?.meta?.outboundError) continue
          succeeded = true
          await ackNotification(notification, true)
          return
        }
      }

      if (canceledNotificationIds.has(notificationIdOf(notification))) {
        succeeded = true
        await ackNotification(notification, true, '订阅已取消，通知已丢弃')
        return
      }
      if (!centralScopeAllows(scopeContext)) {
        succeeded = true
        await ackNotification(notification, true, '插件未在当前角色 / 渠道启用，通知已丢弃')
        return
      }

      const message = messages.add(conversationId, {
        role: 'assistant',
        content: String(target.text || ''),
        meta: {
          via: 'model-status',
          modelStatusNotificationId: notification.id,
          modelStatusEventId: String(notification.event?.id || ''),
          modelStatusSourceId: String(notification.event?.sourceId || ''),
          modelStatusKind: String(notification.event?.kind || ''),
        },
      })
      if (!message) {
        await ackNotification(notification, false, '消息写入失败')
        return
      }
      const channelBase = getChannelBase()
      if (channelBase?.outboundIdle) {
        await Promise.race([channelBase.outboundIdle(conversationId), new Promise(resolve => setTimeout(resolve, 20000))]).catch(() => {})
      }
      const updated = messages.get(conversationId, message.id)
      if (updated?.meta?.outboundError) {
        await ackNotification(notification, false, String(updated.meta.outboundError))
        return
      }
      await ackNotification(notification, true)
      succeeded = true
      ctx.logger.debug(`[model-status] 通知已投递到 ${channel.name || channel.id}`)
    } finally {
      processingNotifications.delete(key)
      queuedNotificationKeys.delete(key)
      if (succeeded) markNotificationDelivered(key)
    }
  }

  const enqueueDelivery = notification => {
    deliveryChain = deliveryChain.catch(() => {}).then(() => deliverNotification(notification)).catch(error => {
      ctx.logger.warn(`[model-status] 渠道通知投递失败：${error?.message || error}`)
    })
    return deliveryChain
  }

  const releaseClaimedNotifications = async list => {
    const ids = (Array.isArray(list) ? list : []).map(item => String(item?.id || '')).filter(Boolean)
    if (!ids.length) return
    await bridgeCall('POST', '/model-status/notifications/release', { owner: runtimeId, ids }, 30000, { silent404: true }).catch(() => {})
  }

  const handleNotifications = list => {
    for (const notification of Array.isArray(list) ? list : []) {
      if (!notification?.id || notification.delivered === true) continue
      if (canceledNotificationIds.has(notificationIdOf(notification))) {
        markNotificationDelivered(deliveryKeyOf(notification))
        ackNotification(notification, true, '订阅已取消，通知已丢弃')
        continue
      }
      if (!notificationScopeAllows(notification)) {
        markNotificationDelivered(deliveryKeyOf(notification))
        ackNotification(notification, true, '插件未在当前角色 / 渠道启用，通知已丢弃')
        continue
      }
      showLocalNotification(notification)
      if (!canDeliverChannels()) {
        releaseClaimedNotifications([notification]).catch(() => {})
        continue
      }
      const key = deliveryKeyOf(notification)
      if (!key || deliveredNotificationKeys.has(key) || queuedNotificationKeys.has(key) || processingNotifications.has(key)) continue
      queuedNotificationKeys.add(key)
      enqueueDelivery(notification)
    }
  }

  const claimPending = async () => {
    const result = await bridgeCall('POST', '/model-status/notifications/claim', { owner: runtimeId, limit: 20 }, 30000, { silent404: true })
    if (result?.ok !== false) return Array.isArray(result?.notifications) ? result.notifications : []
    if (result?.code === 'BRIDGE_NOT_LOADED') return null
    return []
  }

  const withDeliveryMutex = async task => {
    const locks = typeof navigator !== 'undefined' ? navigator?.locks : null
    if (typeof locks?.request !== 'function') return task()
    try {
      return await locks.request('model-status:delivery', { mode: 'exclusive' }, task)
    } catch (_) {
      return task()
    }
  }

  const flushPending = () =>
    withDeliveryMutex(async () => {
      const claimed = canDeliverChannels() ? await claimPending() : null
      if (claimed !== null) {
        handleNotifications(claimed)
        return
      }
      const result = await bridgeCall('GET', '/model-status/notifications?pending=1')
      if (result?.ok === false) return
      handleNotifications(result.notifications || [])
    })

  /* ------------------------------------------------------------------ */
  /* SSE 与轮询                                                          */
  /* ------------------------------------------------------------------ */

  const connectEventStream = () => {
    if (eventSource || typeof EventSource === 'undefined') return
    try {
      const source = new EventSource(`${absoluteUrl('/events')}${tokenQuery()}`, { withCredentials: true })
      eventSource = source
      source.addEventListener('open', () => {
        flushPending().catch(() => {})
      })
      source.addEventListener('model-status:event', event => {
        let payload = null
        try {
          payload = event?.data ? JSON.parse(event.data) : null
        } catch (_) {
          payload = null
        }
        if (!payload) return
        if (payload.kind === 'notifications' && Array.isArray(payload.notifications)) {
          for (const notification of payload.notifications) {
            if (notificationScopeAllows(notification)) showLocalNotification(notification)
          }
        }
        if (payload.kind === 'canceled' && Array.isArray(payload.ids)) {
          for (const id of payload.ids) markNotificationCanceled(id)
        }
        flushPending().catch(() => {})
      })
      source.addEventListener('error', () => {
        /* EventSource 会自动重连，轮询兜底继续生效 */
      })
      ctx.effect(() => {
        try {
          source.close()
        } catch (_) {
          /* ignore */
        }
        if (eventSource === source) eventSource = null
      })
    } catch (error) {
      ctx.logger.debug(`[model-status] SSE 订阅失败，改用轮询：${error?.message || error}`)
    }
  }

  ctx.setInterval(() => {
    flushPending().catch(() => {})
  }, 30000)
  ctx.setTimeout(() => {
    connectEventStream()
    flushPending().catch(() => {})
  }, 1500)
  flushPending().catch(() => {})
  /* ------------------------------------------------------------------ */
  /* 模型状态查询工具                                                    */
  /* ------------------------------------------------------------------ */

  if (tools?.register) {
    try {
      const toolDispose = tools.register(
        'model_status_query',
        {
          description:
            '查询各模型厂商的官方服务状态。支持 DeepSeek / Claude / OpenAI (GPT) / Gemini / Grok 以及插件内置的其它厂商；可列出支持的来源、查询指定厂商当前整体状态 / 组件状态 / 进行中故障与计划维护，或查看插件最近捕获的状态变化事件。用户问“DeepSeek 现在正常吗”“Claude 有没有故障”“Gemini API 状态怎么样”“查一下最近哪些模型出问题了”时使用。',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['status', 'list', 'events'],
                description: 'status=查询指定厂商当前状态（默认）；list=列出插件支持的全部厂商来源；events=查看插件最近捕获的状态变化事件。',
              },
              vendor: {
                type: 'string',
                description: '厂商 id / 名称 / 关键词，例如 deepseek、claude、anthropic、openai、gpt、gemini、grok、xai、groq、moonshot 等；action=status 时使用。',
              },
              keyword: {
                type: 'string',
                description: '可选：只关注包含该关键词的模型组件、产品或事件，例如 API、R1、ChatGPT、Gemini。',
              },
              limit: {
                type: 'number',
                description: '可选：action=events 时返回几条，默认 10，最大 50。',
              },
            },
            required: ['action'],
          },
        },
        async (args = {}, context = {}) => {
          if (
            !centralScopeAllows({
              conversationId: context?.conversationId,
              channelId: context?.channelId,
              roleId: context?.roleId,
            })
          ) {
            return { ok: false, error: '模型状态订阅未在当前角色 / 渠道启用。' }
          }
          const action = String(args.action || 'status').toLowerCase()
          if (!['status', 'list', 'events'].includes(action)) {
            return { ok: false, error: 'action 只支持 status / list / events。' }
          }
          const params = new URLSearchParams()
          params.set('action', action)
          if (args.vendor) params.set('vendor', String(args.vendor))
          if (args.keyword) params.set('keyword', String(args.keyword))
          if (args.limit !== undefined && args.limit !== null && args.limit !== '') {
            params.set('limit', String(Math.max(1, Math.min(50, Number(args.limit) || 10))))
          }
          const result = await bridgeCall('GET', `/model-status/query?${params.toString()}`, null, 60000)
          if (result?.ok === false) {
            const candidates = Array.isArray(result.candidates) ? result.candidates : []
            const hint = candidates.length ? `\n候选来源：${candidates.map(item => `${item.id}（${item.name}）`).join('、')}` : ''
            return { ok: false, error: `${result.error || '查询失败'}${hint}` }
          }
          if (action === 'list') {
            const sources = Array.isArray(result.sources) ? result.sources : []
            const text = sources
              .map(item => `- ${item.id}：${item.name}（${item.adapter}${item.subscribed ? ' · 已订阅' : ''}）`)
              .join('\n')
            return { ok: true, result: `插件当前支持 ${sources.length} 个状态来源：\n${text}` }
          }
          if (action === 'events') {
            const events = Array.isArray(result.events) ? result.events : []
            if (!events.length) return { ok: true, result: '最近没有捕获到状态变化事件。' }
            const text = events
              .map(event => {
                const status = event.statusLabel ? `（${event.statusLabel}）` : ''
                return `- [${formatTime(event.at, 'Asia/Shanghai')}] ${event.sourceName || event.sourceId} · ${event.title || event.kind || '状态更新'}${status}${event.body ? `\n  ${event.body}` : ''}${event.url ? `\n  ${event.url}` : ''}`
              })
              .join('\n')
            return { ok: true, result: text }
          }
          return { ok: true, result: result.text || '没有查询到状态信息。' }
        },
      )
      ctx.effect(() => () => toolDispose?.())
      ctx.logger.info('模型状态查询工具已注册：model_status_query')
    } catch (error) {
      ctx.logger.warn(`[model-status] 注册模型状态查询工具失败：${error?.message || error}`)
    }
  }



  /* ------------------------------------------------------------------ */
  /* 设置面板                                                            */
  /* ------------------------------------------------------------------ */

  const panelHelpers = {
    request: (method, path, body) => bridgeCall(method, path, body, 45000),
    getChannels: getChannelList,
    toast: null,
    openUrl: openExternal,
    confirm: confirmDialog,
    allowsScope: context => centralScopeAllows(context),
  }

  const renderPanel = container => {
    panelHelpers.toast = getToast()
    return renderModelStatusPanel(container, panelHelpers)
  }

  const manager = ctx.registry.get('plugin-manager')
  const pages = ctx.registry.get('settings-container')
  if (manager?.registerSettings) {
    try {
      const dispose = manager.registerSettings({
        id: pluginId,
        title: '模型状态订阅',
        description: '订阅各模型厂商状态页，故障 / 恢复 / 组件变化推送到渠道。',
        render: container => renderPanel(container),
      })
      ctx.effect(() => () => dispose?.())
    } catch (error) {
      ctx.logger.warn(`[model-status] 注册插件设置面板失败：${error?.message || error}`)
    }
  }
  if (pages?.register) {
    try {
      const dispose = pages.register({
        id: pluginId,
        group: '功能',
        groupOrder: 50,
        label: '模型状态订阅',
        icon: MODEL_STATUS_ICON,
        order: 79,
        render(container) {
          return renderPanel(container)
        },
      })
      ctx.effect(() => () => dispose?.())
    } catch (error) {
      ctx.logger.warn(`[model-status] 注册设置页失败：${error?.message || error}`)
    }
  }

  ctx.logger.info('模型状态订阅已启用：渠道订阅 · 状态推送 · 组件筛选')
}
