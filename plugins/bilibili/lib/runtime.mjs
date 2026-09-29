/*
 * bilibili · 单个渠道（一个 B站账号）的运行时
 *
 * 每渠道独立：协议客户端、收 / 发模块、轮询定时器、Edge profile 与浏览器进程。
 * 登录后按能力开关启动 私信 / 消息中心 / 评论监控 三条互不影响的轮询链。
 */
import { join } from 'node:path'
import { libUrl } from './rev.mjs'

const { BiliClient, BiliApiError, CookieJar, parseSetCookieLines } = await import(libUrl('api.mjs'))
const { BrowserController } = await import(libUrl('browser.mjs'))
const { createTransport, isNetworkError } = await import(libUrl('transport.mjs'))
const { DmModule } = await import(libUrl('dm.mjs'))
const { NoticeModule } = await import(libUrl('notice.mjs'))
const { CommentModule } = await import(libUrl('comment.mjs'))
const { VideoModule } = await import(libUrl('video.mjs'))
const { RealtimeDm } = await import(libUrl('realtime.mjs'))
const { sleep } = await import(libUrl('util.mjs'))

const RISK_PAUSE_MS = 15 * 60 * 1000
const LOGIN_CODES = {
  0: { status: 'success', message: '登录成功' },
  86038: { status: 'expired', message: '二维码已过期，请刷新' },
  86090: { status: 'scanned', message: '已扫码，请在手机上确认' },
  86101: { status: 'waiting', message: '等待扫码' },
}

function jitterMs(base, ratio = 0.25) {
  const value = Math.max(5000, Number(base) || 20000)
  return Math.round(value * (1 - ratio + Math.random() * ratio * 2))
}

export class AccountRuntime {
  constructor({ channelId, channelName = '', dataDir, store, logger = null, broadcast = () => {} }) {
    this.channelId = String(channelId)
    this.channelName = String(channelName || this.channelId)
    this.dataDir = dataDir
    this.store = store
    this.logger = logger
    this.broadcast = broadcast
    this.state = store.account(this.channelId)
    this.client = new BiliClient({ cookies: this.state.cookies || [], logger })
    this.riskPaused = false
    this.browser = null
    this.browserSignature = ''
    this.browserChain = Promise.resolve()
    this.timers = { dm: null, notice: null, comment: null }
    this.lastError = ''
    this.transport = createTransport({
      client: this.client,
      settingsRef: () => this.state.settings || {},
      logger,
      ensureBrowser: options => this.ensureBrowser(options),
      onRisk: risk => this.onRisk(risk),
      onBrowserUnavailable: err => this.logger?.warn?.(`[bilibili] ${this.channelId} 浏览器兜底不可用：${err?.message || err}`),
    })
    this.dm = new DmModule({
      transport: this.transport,
      state: this.state,
      getSettings: () => this.state.settings,
      getSelfUid: () => this.selfUid(),
      logger,
      emit: item => this.pushItem(item),
    })
    this.notice = new NoticeModule({
      transport: this.transport,
      state: this.state,
      getSettings: () => this.state.settings,
      getSelfUid: () => this.selfUid(),
      logger,
      emit: item => this.pushItem(item),
    })
    this.comment = new CommentModule({
      transport: this.transport,
      state: this.state,
      getSettings: () => this.state.settings,
      getSelfUid: () => this.selfUid(),
      logger,
      emit: item => this.pushItem(item),
    })
    this.video = new VideoModule({
      transport: this.transport,
      getSettings: () => this.state.settings,
      logger,
    })
    this.video.applyLimits()
    this.pollSignature = this.pollSignatureOf(this.state.settings)
    this.realtime = new RealtimeDm({
      channelId: this.channelId,
      dm: this.dm,
      getSelfUid: () => this.selfUid(),
      getSettings: () => this.state.settings,
      getCookies: () => this.client.jar.toJSON(),
      logger,
      runExclusive: this.transport.withBrowser,
      onStatus: () => this.broadcastStatus(),
      onSignal: () => {
        this.pokeDm()
        this.pokeNotice()
      },
    })
    this.lastNoticePokeAt = 0
  }

  selfUid() {
    return Number(this.state.profile?.uid) || this.client.selfUid || 0
  }

  loggedIn() {
    return !!this.client.jar.get('SESSDATA') && !!this.selfUid()
  }

  getSettings() {
    return this.state.settings || {}
  }

  /* ---------------- 浏览器（每渠道独立进程 + profile） ---------------- */

  browserPaths() {
    const root = join(this.dataDir, 'bilibili', this.channelId)
    return { profileDir: join(root, 'browser-profile'), filesDir: join(root, 'files') }
  }

  ensureBrowser({ headless } = {}) {
    const run = async () => {
      const settings = this.getSettings()
      const wantHeadless = headless === undefined ? settings.browserHeadless !== false : headless !== false
      const { profileDir, filesDir } = this.browserPaths()
      const signature = `${profileDir}|${wantHeadless}`
      if (!this.browser || (!this.browser.running && this.browserSignature !== signature)) {
        this.browser = new BrowserController({ profileDir, filesDir, logger: this.logger, headless: wantHeadless })
        this.browserSignature = signature
      }
      await this.browser.ensure({ headless: wantHeadless })
      this.transport.markBrowserReady(true)
      return this.browser
    }
    const next = this.browserChain.then(run, run)
    this.browserChain = next.catch(() => {})
    return next
  }

  async closeBrowser() {
    await this.realtime.stop().catch(() => {})
    const controller = this.browser
    this.browser = null
    this.browserSignature = ''
    this.transport.markBrowserReady(false)
    if (controller?.running) await controller.close().catch(() => {})
    return { closed: true }
  }

  async browserStatus() {
    const controller = this.browser
    const base = controller?.status ? controller.status() : { available: false, running: false, label: '', version: '', profileDir: this.browserPaths().profileDir }
    return { ...base, loginActive: !!this.browserLoginActive }
  }

  /* ---------------- 登录 ---------------- */

  async finalizeLogin() {
    this.state.cookies = this.client.jar.toJSON()
    this.client.wbi = { keys: null, at: 0 }
    this.client.setDevId(this.client.jar.get('buvid3') || '')
    await this.client.ensureBuvid(true)
    let profile = { uid: '', nickname: '', avatar: '', loggedAt: Date.now() }
    try {
      const info = await this.client.accountProfile()
      profile = { ...info, loggedAt: Date.now() }
    } catch (err) {
      this.logger?.warn?.(`[bilibili] 获取账号信息失败：${err?.message || err}`)
      profile = { uid: String(this.client.selfUid), nickname: '', avatar: '', loggedAt: Date.now() }
    }
    // 手动只粘贴 SESSDATA 时 Cookie 里可能没有 DedeUserID；用 nav 返回的 uid 补齐，
    // 否则发私信时 sender_uid 会是 0。
    if (profile.uid && !this.client.jar.get('DedeUserID')) {
      this.client.jar.upsert([{ name: 'DedeUserID', value: String(profile.uid), domain: 'bilibili.com', path: '/', secure: true }])
    }
    this.state.profile = profile
    this.state.cookies = this.client.jar.toJSON()
    this.state.risk = { until: 0, code: 0, message: '', at: 0 }
    this.state.error = ''
    this.lastError = ''
    this.store.patchAccount(this.channelId, {
      cookies: this.state.cookies,
      profile: this.state.profile,
      risk: this.state.risk,
    })
    this.transport.clearRisk()
    this.startPollers()
    this.syncRealtime().catch(() => {})
    this.broadcastStatus()
    this.logger?.info?.(`[bilibili] ${this.channelName} 已登录：${profile.nickname || profile.uid}`)
    return profile
  }

  async startQrLogin() {
    this.state.status = 'connecting'
    this.broadcastStatus()
    const qr = await this.client.qrGenerate()
    this.loginQr = { ...qr, at: Date.now() }
    return { url: qr.url, qrcodeKey: qr.qrcodeKey, expiresIn: qr.expiresIn || 180 }
  }

  async pollQrLogin(key) {
    const qrcodeKey = String(key || this.loginQr?.qrcodeKey || '')
    if (!qrcodeKey) throw new BiliApiError('缺少二维码 key，请重新获取')
    const result = await this.client.qrPoll(qrcodeKey)
    const mapped = LOGIN_CODES[result.code] || { status: 'waiting', message: result.message || `扫码状态 ${result.code}` }
    if (result.code === 0) {
      const profile = await this.finalizeLogin()
      return { status: 'success', message: mapped.message, profile }
    }
    if (mapped.status === 'expired') this.state.status = 'offline'
    return { status: mapped.status, message: mapped.message, code: result.code }
  }

  async loginWithCookie(raw) {
    const text = String(raw || '').trim()
    if (!text) throw new BiliApiError('Cookie 为空')
    const jar = new CookieJar()
    if (text.startsWith('[')) {
      try {
        jar.upsert(JSON.parse(text))
      } catch (_) {
        throw new BiliApiError('Cookie JSON 解析失败')
      }
    } else {
      for (const part of text.split(/[;\n]/)) {
        const index = part.indexOf('=')
        if (index <= 0) continue
        jar.upsert([{ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), domain: 'bilibili.com', path: '/', secure: true }])
      }
    }
    if (!jar.get('SESSDATA')) throw new BiliApiError('Cookie 里缺少 SESSDATA，无法登录')
    this.client.jar = new CookieJar(jar.toJSON())
    return this.finalizeLogin()
  }

  async startBrowserLogin({ headless = false } = {}) {
    this.browserLoginActive = true
    this.state.status = 'connecting'
    this.broadcastStatus()
    const controller = await this.ensureBrowser({ headless })
    // 把已有的 buvid / 登录 Cookie 注入独立 profile，减少设备校验概率。
    if ((this.state.cookies || []).length) {
      await controller.setCookies(this.state.cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly === true,
      }))).catch(() => 0)
    }
    await controller.navigate('https://passport.bilibili.com/login', { timeoutMs: 40000, waitMs: 1500 })
    return this.browserStatus()
  }

  async pollBrowserLogin() {
    const controller = this.browser
    if (!controller?.running) return { status: 'idle', message: '浏览器未启动' }
    const cookies = await controller.allCookies().catch(() => [])
    const useful = (Array.isArray(cookies) ? cookies : []).filter(cookie => String(cookie?.domain || '').includes('bilibili'))
    const hasSession = useful.some(cookie => cookie.name === 'SESSDATA' && cookie.value)
    if (!hasSession) return { status: this.browserLoginActive ? 'waiting' : 'idle', message: '等待在浏览器里完成登录' }
    this.client.jar.upsert(useful.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: String(cookie.domain || 'bilibili.com').replace(/^\./, ''),
      path: cookie.path || '/',
      expires: Number(cookie.expires) > 0 ? Number(cookie.expires) * 1000 : 0,
      secure: cookie.secure !== false,
      httpOnly: cookie.httpOnly === true,
    })))
    this.browserLoginActive = false
    const profile = await this.finalizeLogin()
    return { status: 'success', message: '浏览器登录成功', profile }
  }

  async logout({ clearBrowser = true } = {}) {
    this.stopPollers()
    await this.realtime.stop().catch(() => {})
    const buvid = this.client.jar.get('buvid3')
    this.client.jar = new CookieJar(buvid ? [{ name: 'buvid3', value: buvid, domain: 'bilibili.com', path: '/', secure: true }] : [])
    this.client.wbi = { keys: null, at: 0 }
    this.state.cookies = this.client.jar.toJSON()
    this.state.profile = { uid: '', nickname: '', avatar: '', loggedAt: 0 }
    this.state.status = 'offline'
    this.state.error = ''
    this.state.risk = { until: 0, code: 0, message: '', at: 0 }
    this.transport.clearRisk()
    this.store.patchAccount(this.channelId, {
      cookies: this.state.cookies,
      profile: this.state.profile,
      status: this.state.status,
      risk: this.state.risk,
    })
    if (clearBrowser && this.browser?.running) {
      await this.browser.clearCookies().catch(() => {})
    }
    this.broadcastStatus()
    return true
  }

  /* ---------------- 配置 / 轮询 ---------------- */

  pollSignatureOf(settings) {
    return JSON.stringify({
      capabilities: settings?.capabilities || {},
      noticeKinds: settings?.noticeKinds || {},
      poll: settings?.poll || {},
    })
  }

  applyConfig(settings) {
    const merged = this.store.mergeSettings(this.channelId, settings || {})
    if (merged) {
      this.dm.applyLimits()
      this.comment.applyLimits()
      this.video.applyLimits()
      // 只有能力 / 轮询配置真的变了才重排定时器；否则每次启动时前端同步配置会把
      // 已排好的首次轮询往后推，造成“等很久才收到通知”。
      const nextSignature = this.pollSignatureOf(merged)
      if (nextSignature !== this.pollSignature) {
        this.pollSignature = nextSignature
        this.startPollers()
      }
      this.syncRealtime().catch(err => this.logger?.warn?.(`[bilibili] 同步实时私信失败：${err?.message || err}`))
      this.broadcastStatus()
    }
    return merged
  }

  /**
   * 实时私信（浏览器 WebSocket 镜像）：
   *   开着该渠道的 Edge，常驻 message.bilibili.com 标签页并监听其长连接；
   *   启动失败 / 被关掉都不影响业务，轮询会继续兜底。
   */
  async syncRealtime() {
    const settings = this.getSettings() || {}
    const enabled = settings.realtime?.enabled !== false && settings.browserFallback !== false
    if (!enabled || !this.loggedIn()) {
      const wasRunning = this.realtime.running
      await this.realtime.stop().catch(() => {})
      // 关闭实时后要尽快恢复常规轮询间隔，所以主动重排一次。
      if (wasRunning) this.startPollers()
      return false
    }
    try {
      const controller = await this.ensureBrowser({ headless: true })
      const ok = await this.realtime.start(controller)
      // 不调用 startPollers()：那会把刚排好的首次轮询取消并往后推（“等很久”的根因）。
      // 当前定时器跑完后的下一次调度会通过 dmPollSeconds() 自动降频为断线补收。
      this.broadcastStatus()
      return ok
    } catch (err) {
      this.logger?.warn?.(`[bilibili] ${this.channelId} 实时私信不可用，继续轮询：${err?.message || err}`)
      await this.realtime.stop().catch(() => {})
      return false
    }
  }

  stopPollers() {
    for (const key of Object.keys(this.timers)) {
      if (this.timers[key]) clearTimeout(this.timers[key])
      this.timers[key] = null
    }
  }

  /** 实时镜像健康（有长连接帧）时才把私信轮询降频，只做断线补收。 */
  dmPollSeconds() {
    const configured = Number(this.getSettings().poll?.dmSec) || 20
    return this.realtime?.healthy?.() ? Math.max(120, configured) : configured
  }

  /** 长连接帧信号：立刻补收一次私信；若当前正在轮询则稍后重试，不丢信号。 */
  pokeDm() {
    if (!this.loggedIn()) return
    const attempt = () => {
      if (!this.loggedIn()) return
      this.dm
        .pollOnce()
        .then(result => {
          if (result?.skipped) {
            const timer = setTimeout(attempt, 1200)
            timer.unref?.()
          }
        })
        .catch(err => this.logger?.debug?.(`[bilibili] 实时信号补收失败：${err?.message || err}`))
    }
    attempt()
  }

  /** 实时帧信号顺带探一次消息中心未读；25 秒冷却，避免把长连接心跳变成高频请求。 */
  pokeNotice() {
    if (!this.loggedIn()) return
    const now = Date.now()
    if (now - Number(this.lastNoticePokeAt || 0) < 25000) return
    this.lastNoticePokeAt = now
    this.notice.poke().catch(err => this.logger?.debug?.(`[bilibili] 消息中心补收失败：${err?.message || err}`))
  }

  startPollers() {
    this.stopPollers()
    if (!this.loggedIn()) return
    const settings = this.getSettings()
    const noticeEnabled = Object.values(settings.noticeKinds || {}).some(Boolean)
    if (settings.capabilities?.dm !== false) this.schedule('dm', () => this.dm.pollOnce(), this.dmPollSeconds())
    if (settings.capabilities?.notice !== false && noticeEnabled) this.schedule('notice', () => this.notice.pollOnce(), settings.poll?.noticeSec || 30)
    if (settings.capabilities?.commentScan === true) this.schedule('comment', () => this.comment.pollOnce(), settings.poll?.commentSec || 300)
  }

  schedule(key, task, seconds) {
    const run = async () => {
      this.timers[key] = null
      if (!this.loggedIn()) return
      try {
        await task()
      } catch (err) {
        if (err?.risk) this.onRisk({ code: err.biliCode, message: err.message })
        else if (err?.needLogin) {
          this.state.status = 'expired'
          this.lastError = '登录已过期，请重新登录'
          this.broadcastStatus()
          return
        } else {
          this.logger?.warn?.(`[bilibili] ${this.channelId} ${key} 轮询失败：${err?.message || err}`)
        }
      } finally {
        // 轮询会推进各模块的 seen / initialized 游标，定期落盘避免重启后重复回放。
        try {
          this.store.schedulePersist()
        } catch (_) {
          /* ignore */
        }
        if (this.loggedIn() && this.state.status !== 'expired') {
          const base = key === 'dm'
            ? this.dmPollSeconds()
            : key === 'notice'
              ? this.getSettings().poll?.noticeSec || 30
              : this.getSettings().poll?.commentSec || 300
          const delay = this.state.risk?.until > Date.now() ? Math.max(30000, this.state.risk.until - Date.now()) : jitterMs(base * 1000)
          this.timers[key] = setTimeout(run, delay)
          this.timers[key].unref?.()
        }
      }
    }
    const first = jitterMs(Math.max(2, Number(seconds) / 4) * 1000)
    this.timers[key] = setTimeout(run, first)
    this.timers[key].unref?.()
  }

  onRisk(risk) {
    const payload = {
      until: Date.now() + RISK_PAUSE_MS,
      code: Number(risk?.code) || 0,
      message: String(risk?.message || '').slice(0, 300),
      at: Date.now(),
    }
    this.state.risk = payload
    this.riskPaused = true
    const pause = payload.until - Date.now()
    this.dm.queue.pause(pause, 'risk')
    this.comment.queue.pause(pause, 'risk')
    this.store.patchAccount(this.channelId, { risk: payload })
    this.broadcastStatus()
    this.broadcast('bilibili:notice', {
      channelId: this.channelId,
      level: 'warn',
      message: `触发 B站风控（${payload.code || 'HTTP'}），已暂停 15 分钟；后续请求会优先走浏览器兜底。`,
    })
  }

  pushItem(item) {
    if (!item?.id) return 0
    const seq = this.store.pushInbox(this.channelId, item)
    item.seq = seq
    this.broadcast('bilibili:message', { channelId: this.channelId, item })
    return seq
  }

  /* ---------------- 对外动作 ---------------- */

  sendDm(peerUid, text) {
    return this.dm.send(peerUid, text)
  }

  postComment(target, text) {
    return this.comment.post(target, text)
  }

  replyComment(target, rpid, text, extra) {
    return this.comment.reply(target, rpid, text, extra)
  }

  inbox(after = 0) {
    const seq = Number(after) || 0
    return (this.state.inbox || []).filter(item => Number(item.seq) > seq)
  }

  ackInbox(seq) {
    const value = Number(seq) || 0
    if (!value || !Array.isArray(this.state.inbox)) return 0
    const before = this.state.inbox.length
    this.state.inbox = this.state.inbox.filter(item => Number(item.seq) > value)
    if (this.state.inbox.length !== before) this.store.schedulePersist()
    return before - this.state.inbox.length
  }

  statusPayload() {
    const settings = this.getSettings()
    const profile = this.state.profile || {}
    const loggedIn = this.loggedIn()
    const riskActive = Number(this.state.risk?.until) > Date.now()
    let status = this.state.status || ''
    if (loggedIn) status = riskActive ? 'connecting' : 'online'
    else if (status === 'connecting') status = 'connecting'
    else if (status === 'error' || this.state.error) status = 'error'
    else status = this.lastError ? 'error' : 'offline'
    return {
      ok: true,
      channelId: this.channelId,
      name: this.channelName,
      status,
      loggedIn,
      profile,
      error: this.lastError || this.state.error || '',
      risk: { ...(this.state.risk || {}), active: riskActive },
      browser: this.browser?.status ? this.browser.status() : { available: false, running: false, profileDir: this.browserPaths().profileDir },
      browserLoginActive: !!this.browserLoginActive,
      settings,
      realtime: this.realtime?.status ? this.realtime.status() : null,
      queues: { dm: this.dm.stats(), comment: this.comment.stats(), video: this.video.stats() },
    }
  }

  broadcastStatus() {
    this.broadcast('bilibili:status', { channelId: this.channelId, ...this.statusPayload() })
  }

  async stop() {
    this.stopPollers()
    await this.realtime.stop().catch(() => {})
    await sleep(0)
    await this.closeBrowser()
  }
}
