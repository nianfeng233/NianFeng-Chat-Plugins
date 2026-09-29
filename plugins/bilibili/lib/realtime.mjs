/*
 * bilibili · 私信实时接收（浏览器 WebSocket 镜像）
 *
 * 思路：官方 message.bilibili.com 页面自己维护私信长连接（含鉴权 / 心跳 / 设备指纹），
 * 我们不逆向这套协议，而是在该渠道独立的 Edge 里常驻一个消息页标签：
 *   - 通过 CDP Runtime.addBinding + Page.addScriptToEvaluateOnNewDocument 注入 WebSocket hook；
 *   - 页面每收到一帧，hook 就把原文回传 Node；同时用 Network.webSocketFrameReceived 兜底；
 *   - Node 侧用容错解析器提取消息对象，交给现有私信模块去重 / 归一化 / 广播。
 *
 * 解析失败不会影响业务：轮询仍然在跑，只是实时这一路静默降级。
 * B站页面可能随时改版或换协议，发现帧里提取不到消息时看 debug 日志即可定位。
 */
import { libUrl } from './rev.mjs'

const { normalizeDmMessage } = await import(libUrl('normalize.mjs'))

const MAX_FRAME_BYTES = 2 * 1024 * 1024
const MAX_NODES = 4000
const MAX_DEPTH = 8
const MAX_SEEN = 500
const WS_WATCHDOG_MS = 20000
const RECONNECT_DELAY_MS = 5000
// 帧信号 → REST 补收：就算帧格式不认识，只要长连接有动静就立刻拉一次。
const SIGNAL_DEBOUNCE_MS = 800
const SIGNAL_COOLDOWN_MS = 8000

const HOOK_SOURCE = `(() => {
  try {
    if (window.__nfBiliHooked) return
    window.__nfBiliHooked = true
    const NativeWebSocket = window.WebSocket
    const toBase64 = buffer => {
      let text = ''
      const bytes = new Uint8Array(buffer)
      for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i])
      return btoa(text)
    }
    const decode = data => {
      if (typeof data === 'string') return data
      if (data instanceof ArrayBuffer) return toBase64(data)
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data.text().then(text => { try { window.__nfBiliPush?.(text) } catch (_) {} }).catch(() => {})
        return ''
      }
      return ''
    }
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args)
        try {
          this.addEventListener('message', event => {
            try {
              const text = decode(event.data)
              if (text) window.__nfBiliPush?.(text)
            } catch (_) {}
          })
        } catch (_) {}
      }
    }
  } catch (_) {}
})()`

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch (_) {
    return null
  }
}

function extractJsonText(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
  const start = trimmed.search(/[\[{]/)
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1)
  return ''
}

function normalizeKeys(value) {
  if (!value || typeof value !== 'object') return value
  const out = { ...value }
  for (const [from, to] of [
    ['msgKey', 'msg_key'],
    ['senderUid', 'sender_uid'],
    ['receiverUid', 'receiver_uid'],
    ['msgType', 'msg_type'],
    ['talkerId', 'talker_id'],
  ]) {
    if (out[to] === undefined && out[from] !== undefined) out[to] = out[from]
  }
  return out
}

/** 容错扫描：从任意 JSON 结构里找出私信消息 / 会话对象。 */
export function extractMessageCandidates(value) {
  const messages = []
  const sessions = []
  let nodes = 0
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || nodes > MAX_NODES) return
    nodes += 1
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    const shaped = normalizeKeys(node)
    const hasMsgKey = typeof shaped.msg_key === 'string' && shaped.msg_key
    const looksLikeMessage =
      hasMsgKey &&
      (shaped.sender_uid !== undefined || shaped.receiver_uid !== undefined || shaped.content !== undefined || shaped.msg_type !== undefined)
    const looksLikeSession = shaped.talker_id !== undefined && shaped.last_msg && typeof shaped.last_msg === 'object'
    if (looksLikeMessage) messages.push(shaped)
    if (looksLikeSession) sessions.push(shaped)
    let visited = 0
    for (const key of Object.keys(shaped)) {
      if (visited > 60) break
      const child = shaped[key]
      if (!child || typeof child !== 'object') continue
      visited += 1
      walk(child, depth + 1)
    }
  }
  walk(value, 0)
  return { messages, sessions }
}

export function parseRealtimeText(text) {
  let data = safeJson(text)
  if (!data) {
    const candidate = extractJsonText(text)
    if (candidate) data = safeJson(candidate)
  }
  if (!data) return null
  const result = extractMessageCandidates(data)
  if (!result.messages.length && !result.sessions.length) return null
  return result
}

export class RealtimeDm {
  constructor({ channelId, dm, getSelfUid, getSettings, getCookies, logger = null, onStatus = null, onSignal = null, runExclusive = null } = {}) {
    this.channelId = String(channelId)
    this.dm = dm
    this.getSelfUid = getSelfUid || (() => 0)
    this.getSettings = getSettings || (() => ({}))
    this.getCookies = typeof getCookies === 'function' ? getCookies : null
    this.logger = logger
    this.onStatus = onStatus || (() => {})
    this.runExclusive = typeof runExclusive === 'function' ? runExclusive : task => Promise.resolve().then(task)
    this.controller = null
    this.sessionId = ''
    this.targetId = ''
    this.offs = []
    this.seen = new Set()
    this.running = false
    this.startedAt = 0
    this.lastFrameAt = 0
    this.frames = 0
    this.messages = 0
    this.wsConnected = false
    this.pageUrl = ''
    this.lastError = ''
    this.watchdogTimer = null
    this.reloadTimer = null
    this.unrecognized = 0
    this.samples = []
    this.protobufMode = false
    this.onSignal = typeof onSignal === 'function' ? onSignal : null
    this.lastSignalAt = 0
    this.signalTimer = null
    this.degraded = false
  }

  status() {
    return {
      running: this.running,
      healthy: this.healthy(),
      degraded: this.degraded,
      wsConnected: this.wsConnected,
      pageUrl: this.pageUrl,
      startedAt: this.startedAt,
      lastFrameAt: this.lastFrameAt,
      lastSignalAt: this.lastSignalAt,
      frames: this.frames,
      messages: this.messages,
      unrecognized: this.unrecognized,
      protobufMode: this.protobufMode,
      samples: this.samples,
      error: this.lastError,
    }
  }

  /** 实时链路是否可信到可以把轮询降频：有长连接帧（不要求解析成功）且未被判定降级。 */
  healthy() {
    return !!this.running && !this.degraded && (this.wsConnected || this.lastFrameAt > 0)
  }

  /** 收到任意长连接帧（无论能否解析）都触发一次带冷却的 REST 补收。 */
  signal() {
    if (!this.running || !this.onSignal) return
    const now = Date.now()
    if (now - this.lastSignalAt < SIGNAL_COOLDOWN_MS) return
    this.lastSignalAt = now
    if (this.signalTimer) clearTimeout(this.signalTimer)
    this.signalTimer = setTimeout(() => {
      this.signalTimer = null
      try {
        Promise.resolve(this.onSignal(this)).catch(() => {})
      } catch (_) {
        /* ignore */
      }
    }, SIGNAL_DEBOUNCE_MS)
    this.signalTimer.unref?.()
  }

  pushStatus() {
    try {
      this.onStatus?.(this.status())
    } catch (_) {
      /* ignore */
    }
  }

  remember(key) {
    if (!key) return true
    if (this.seen.has(key)) return false
    this.seen.add(key)
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value)
    return true
  }

  handleText(text) {
    const raw = String(text || '')
    if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return 0
    this.frames += 1
    this.lastFrameAt = Date.now()
    let parsed = parseRealtimeText(raw)
    if (!parsed && /^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 64) {
      try {
        parsed = parseRealtimeText(Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8'))
      } catch (_) {
        parsed = null
      }
    }
    if (!parsed) {
      this.unrecognized += 1
      // B站私信页用的是 protobuf gRPC 广播（bilibili.broadcast.v1.*）。我们没有必要逆向它：
      // 收到任意帧就当“有变化”的信号，由 REST 补收；这里只做一次说明，不再刷样本日志。
      const looksProtobuf = (() => {
        if (raw.includes('bilibili.broadcast')) return true
        try {
          return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8').includes('bilibili.broadcast')
        } catch (_) {
          return false
        }
      })()
      if (looksProtobuf) {
        if (!this.protobufMode) {
          this.protobufMode = true
          this.logger?.info?.(`[bilibili] ${this.channelId} 实时长连接为 protobuf 广播帧，不解析帧内容，改由「帧信号 + REST 补收」保证实时性`)
        }
        return 0
      }
      // 其它未知格式只留前 3 条样本（截断），方便后续适配。
      if (this.samples.length < 3) {
        const sample = raw.length > 600 ? `${raw.slice(0, 600)}…` : raw
        this.samples.push(sample)
        this.logger?.info?.(`[bilibili] 实时帧未识别样本（${raw.length} 字符）：${sample}`)
      }
      return 0
    }
    const selfUid = this.getSelfUid()
    let count = 0
    for (const candidate of parsed.messages) {
      const item = normalizeDmMessage(candidate, { selfUid })
      if (!item) continue
      const msgKey = String(candidate.msg_key || item.id)
      if (!this.remember(msgKey)) continue
      try {
        this.dm?.markSeen?.(item.target.peerUid, String(candidate.msg_key || ''), Math.floor(item.at / 1000))
      } catch (_) {
        /* ignore */
      }
      item.thread.name = `B站私信 · ${item.sender.name || item.sender.uid}`
      try {
        this.dm?.emit?.(item)
        count += 1
        this.messages += 1
      } catch (err) {
        this.logger?.warn?.(`[bilibili] 实时私信广播失败：${err?.message || err}`)
      }
    }
    for (const session of parsed.sessions) {
      const peerUid = String(session.talker_id || '')
      const last = session.last_msg || {}
      if (!peerUid || !last.msg_key) continue
      const item = normalizeDmMessage({ ...last, msg_key: last.msg_key }, { selfUid })
      if (!item || !this.remember(String(last.msg_key))) continue
      this.dm?.markSeen?.(peerUid, String(last.msg_key), Number(last.timestamp) || 0)
      item.thread.name = `B站私信 · ${item.sender.name || item.sender.uid}`
      try {
        this.dm?.emit?.(item)
        count += 1
        this.messages += 1
      } catch (_) {
        /* ignore */
      }
    }
    if (count) this.logger?.debug?.(`[bilibili] 实时私信推送 ${count} 条`)
    return count
  }

  async start(controller) {
    if (this.running && this.controller === controller) return true
    await this.stop()
    if (!controller?.running) throw new Error('浏览器未运行')
    this.controller = controller
    this.running = true
    this.startedAt = Date.now()
    this.lastError = ''
    this.lastFrameAt = 0
    try {
      // 与浏览器兜底的临时标签页互斥，避免并发抢当前 target。
      await this.runExclusive(async () => {
      this.targetId = await controller.newPage('about:blank')
      this.sessionId = controller.sessions.get(this.targetId) || ''
      if (!this.sessionId) throw new Error('没有拿到实时标签页的 CDP session')
      // 协议扫码登录不会把 Cookie 写进浏览器 profile；这里把登录态注入实时页，否则
      // message.bilibili.com 会停在未登录页、根本不会建立私信长连接。
      const cookies = this.getCookies ? this.getCookies() : []
      if (Array.isArray(cookies) && cookies.length) {
        await controller
          .setCookies(cookies.map(cookie => ({
            name: cookie.name,
            value: cookie.value,
            // CDP 里主域带上前导点，确保 message./api./www. 子域都能带上登录态。
            domain: (() => {
              const domain = String(cookie.domain || 'bilibili.com').replace(/^\./, '')
              return domain === 'bilibili.com' ? '.bilibili.com' : domain
            })(),
            path: cookie.path || '/',
            secure: cookie.secure !== false,
            httpOnly: cookie.httpOnly === true,
            ...(cookie.expires ? { expires: Math.floor(cookie.expires / 1000) } : {}),
          })))
          .catch(() => 0)
      }
      await controller.transport.send('Runtime.addBinding', { name: '__nfBiliPush' }, this.sessionId, 10000)
      await controller.transport.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SOURCE }, this.sessionId, 10000)
      this.offs.push(
        controller.transport.on('Runtime.bindingCalled', (params, sessionId) => {
          if (sessionId !== this.sessionId) return
          if (params?.name !== '__nfBiliPush') return
          this.handleText(params?.payload)
          this.signal()
        }),
      )
      this.offs.push(
        controller.transport.on('Network.webSocketFrameReceived', (params, sessionId) => {
          if (sessionId !== this.sessionId) return
          const data = params?.response?.payloadData
          if (!data) return
          if (Number(params.response.opcode) === 2) {
            try {
              this.handleText(Buffer.from(String(data), 'base64').toString('utf8'))
            } catch (_) {
              /* 忽略无法解码的帧 */
            }
            this.signal()
            return
          }
          this.handleText(String(data))
          this.signal()
        }),
      )
      this.offs.push(
        controller.transport.on('Network.webSocketCreated', (params, sessionId) => {
          if (sessionId !== this.sessionId) return
          this.wsConnected = true
          this.degraded = false
          this.logger?.info?.(`[bilibili] ${this.channelId} 私信长连接已建立：${String(params?.url || '').slice(0, 80)}`)
          this.signal()
          this.pushStatus()
        }),
      )
      this.offs.push(
        controller.transport.on('Network.webSocketClosed', (params, sessionId) => {
          if (sessionId !== this.sessionId) return
          this.wsConnected = false
          this.pushStatus()
        }),
      )
      await controller.navigate('https://message.bilibili.com/', { timeoutMs: 40000, waitMs: 1200 })
      this.pageUrl = await controller.currentUrl().catch(() => '')
      if (/passport|passport-login|\/login/i.test(this.pageUrl)) {
        this.logger?.warn?.(`[bilibili] ${this.channelId} 实时页面停留在登录页（${this.pageUrl}），登录 Cookie 可能未注入成功`)
      } else {
        this.logger?.info?.(`[bilibili] ${this.channelId} 实时消息页已加载：${this.pageUrl}`)
      }
      })
      this.watchdogTimer = setInterval(() => this.checkHealth().catch(() => {}), WS_WATCHDOG_MS)
      this.watchdogTimer.unref?.()
      this.logger?.info?.(`[bilibili] ${this.channelId} 私信实时镜像已启动`)
      this.pushStatus()
      return true
    } catch (err) {
      this.lastError = String(err?.message || err).slice(0, 200)
      this.logger?.warn?.(`[bilibili] ${this.channelId} 实时私信启动失败，退回轮询：${this.lastError}`)
      await this.stop()
      return false
    }
  }

  async checkHealth() {
    if (!this.running) return
    if (!this.controller?.running) {
      this.logger?.warn?.(`[bilibili] ${this.channelId} 托管浏览器已关闭，实时私信停止，轮询恢复常规间隔`)
      await this.stop()
      return
    }
    try {
      await this.controller.transport.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, this.sessionId, 8000)
    } catch (_) {
      this.logger?.warn?.(`[bilibili] ${this.channelId} 实时标签页异常，尝试重载`)
      this.reload().catch(() => {})
      return
    }
    if (this.frames === 0 && Date.now() - this.startedAt > 25000 && !this.degraded) {
      this.degraded = true
      this.logger?.warn?.(
        `[bilibili] ${this.channelId} 实时标签页 25 秒内没有收到任何长连接帧，已降级为常规轮询（不保证即时，但不会再等 120 秒）`,
      )
      this.pushStatus()
    } else if (this.frames > 0 && this.degraded) {
      this.degraded = false
      this.pushStatus()
    }
  }

  async reload() {
    if (!this.running || !this.controller?.running) return
    clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      Promise.resolve()
        .then(() => this.controller.navigate('https://message.bilibili.com/', { timeoutMs: 40000, waitMs: 1200 }))
        .catch(err => this.logger?.warn?.(`[bilibili] 实时页重载失败：${err?.message || err}`))
    }, RECONNECT_DELAY_MS)
    this.reloadTimer.unref?.()
  }

  async stop() {
    this.running = false
    this.wsConnected = false
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = null
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = null
    if (this.signalTimer) clearTimeout(this.signalTimer)
    this.signalTimer = null
    while (this.offs.length) {
      const off = this.offs.pop()
      try {
        off?.()
      } catch (_) {
        /* ignore */
      }
    }
    const controller = this.controller
    const targetId = this.targetId
    this.controller = null
    this.sessionId = ''
    this.targetId = ''
    if (controller?.running && targetId) {
      await this.runExclusive(() => controller.closeTab(targetId)).catch(() => {})
    }
    this.pushStatus()
  }
}
