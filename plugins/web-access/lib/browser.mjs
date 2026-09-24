/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * web-access · 浏览器自动化（自包含扩展版本，零依赖 CDP over --remote-debugging-pipe）。
 *
 * 为什么不用 Playwright/Puppeteer：
 *   - 不增加 npm 依赖、不额外下载 Chromium；
 *   - 直接复用用户机器上的 Edge / Chrome；
 *   - 使用独立 user-data-dir，登录态 / Cookie 持久化，与用户日常浏览器互不干扰。
 *
 * 能力：打开页面、DOM 读取、真实鼠标点击、键盘输入、下拉选择、滚动、截图、下载、
 * 标签页、Cookie 导入导出、页面内 JS（仅页面上下文，不是 Node 权限）。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/*
 * 热更新缓存穿透：内核热重载只会给 bridge.mjs 附带 ?v= revision，如果 lib 之间
 * 继续用静态 import，更新插件时仍会命中原进程里旧的 Node ESM 模块缓存，出现
 * “新 bridge + 旧 lib（缺少新导出）”导致后端桥加载失败、接口 404。
 * 这里把 revision 继续传给依赖链，保证热更新后加载到的是一整棵新模块图。
 */
const __revision = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || ''
  } catch (_) {
    return ''
  }
})()
const libUrl = file => `./${String(file).replace(/^\.\//, '')}${__revision ? `?v=${encodeURIComponent(__revision)}` : ''}`

const { randomToken, sleep } = await import(libUrl('util.mjs'))

export class BrowserError extends Error {
  constructor(code, message, hint = '') {
    super(message)
    this.name = 'BrowserError'
    this.code = code
    if (hint) this.hint = hint
  }
}

const STEALTH_SOURCE = `
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] }); } catch (e) {}
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }],
    });
  } catch (e) {}
`

const CLICKABLE_SELECTOR = 'a,button,[role="button"],[role="link"],[role="menuitem"],input[type="submit"],input[type="button"],summary,label'

function maxVersionDir(baseDir) {
  try {
    const versions = readdirSync(baseDir)
      .filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .map(name => ({ name, parts: name.split('.').map(Number) }))
      .sort((a, b) => {
        for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
          const diff = (a.parts[i] || 0) - (b.parts[i] || 0)
          if (diff) return diff
        }
        return 0
      })
    return versions.length ? versions[versions.length - 1].name : ''
  } catch (_) {
    return ''
  }
}

/** 探测本机可用的 Chromium 浏览器；返回 { path, label, version } 或 null。 */
export function detectBrowserExecutable(preferredPath = '') {
  const envPath = String(process.env.NIANFENG_BROWSER_PATH || process.env.FENGYU_BROWSER_PATH || '').trim()
  const home = process.env.LOCALAPPDATA || process.env.HOME || ''
  const candidates = []
  const add = (path, label) => {
    if (path) candidates.push({ path, label })
  }
  if (preferredPath) add(preferredPath, '自定义浏览器')
  if (envPath) add(envPath, '环境变量浏览器')
  if (process.platform === 'win32') {
    add(join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Microsoft Edge')
    add(join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Microsoft Edge')
    add(join(home, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Microsoft Edge')
    add(join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome')
    add(join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome')
    add(join(home, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome')
    add(join(home, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave')
  } else if (process.platform === 'darwin') {
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Microsoft Edge')
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome')
    add('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave')
  } else {
    add('/usr/bin/microsoft-edge', 'Microsoft Edge')
    add('/usr/bin/google-chrome', 'Google Chrome')
    add('/usr/bin/chromium', 'Chromium')
    add('/usr/bin/chromium-browser', 'Chromium')
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    const version = maxVersionDir(dirname(candidate.path))
    return { path: candidate.path, label: candidate.label, version }
  }
  return null
}

export function buildUserAgent(version, label = '') {
  if (!version) return ''
  const major = String(version).split('.')[0] || ''
  if (!major) return ''
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64'
  const edge = /edge|edg/i.test(label)
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${edge ? ` Edg/${major}.0.0.0` : ''}`
}

/* ------------------------------------------------------------------ */
/* CDP pipe 传输                                                       */
/* ------------------------------------------------------------------ */

export class CdpTransport {
  constructor(child, logger) {
    this.child = child
    this.logger = logger
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.listeners = new Map()
    this.nextId = 1
    this.closed = false
    this.lastStderr = ''
    this.exitInfo = null
    const stdout = child.stdio?.[4]
    const stderr = child.stdio?.[2]
    stdout?.on('data', chunk => this.onData(chunk))
    stderr?.on('data', chunk => {
      this.lastStderr = (this.lastStderr + chunk.toString('utf8')).slice(-4000)
    })
    child.on('error', error => {
      this.failAll(new BrowserError('BROWSER_START_FAILED', `浏览器进程启动失败：${error.message}`, '可在 设置 → 联网访问 中手动指定浏览器路径。'))
    })
    child.on('exit', (code, signal) => {
      this.closed = true
      this.exitInfo = { code, signal }
      this.emit('__exit__', { code, signal })
      this.failAll(
        new BrowserError(
          'BROWSER_CLOSED',
          code ? `浏览器进程已退出（code=${code}）。${this.lastStderr ? ` stderr: ${this.lastStderr.slice(-300)}` : ''}` : '浏览器进程已关闭。',
        ),
      )
    })
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    let index
    while ((index = this.buffer.indexOf(0)) >= 0) {
      const raw = this.buffer.subarray(0, index).toString('utf8')
      this.buffer = this.buffer.subarray(index + 1)
      if (!raw.trim()) continue
      try {
        this.handle(JSON.parse(raw))
      } catch (error) {
        this.logger?.debug?.(`[web-access] CDP 消息解析失败：${error.message}`)
      }
    }
  }

  handle(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id)
      clearTimeout(timer)
      this.pending.delete(message.id)
      if (message.error) {
        const error = new BrowserError('CDP_ERROR', message.error.message || 'CDP 调用失败')
        error.cdp = message.error
        reject(error)
      } else {
        resolve(message.result)
      }
      return
    }
    if (message.method) this.emit(message.method, message.params || {}, message.sessionId || '')
  }

  emit(method, params, sessionId) {
    const handlers = this.listeners.get(method)
    if (!handlers) return
    for (const handler of [...handlers]) {
      try {
        handler(params, sessionId)
      } catch (error) {
        this.logger?.warn?.(`[web-access] CDP 事件处理失败 ${method}：${error.message}`)
      }
    }
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(handler)
    return () => this.listeners.get(method)?.delete(handler)
  }

  onceEvent(method, { sessionId = '', timeoutMs = 15000, predicate = null } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null
      const off = this.on(method, (params, eventSessionId) => {
        if (sessionId && eventSessionId !== sessionId) return
        if (predicate && !predicate(params)) return
        cleanup()
        resolve(params)
      })
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        off()
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new BrowserError('TIMEOUT', `等待浏览器事件超时：${method}`))
      }, timeoutMs)
      if (this.closed) {
        cleanup()
        reject(new BrowserError('BROWSER_CLOSED', '浏览器已关闭'))
      }
    })
  }

  send(method, params = {}, sessionId = '', timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new BrowserError('BROWSER_CLOSED', '浏览器已关闭'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserError('TIMEOUT', `CDP 调用超时：${method}`))
      }, Math.max(1000, timeoutMs))
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdio[3].write(JSON.stringify(payload) + '\0')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new BrowserError('CDP_WRITE_FAILED', `无法写入浏览器进程：${error.message}`))
      }
    })
  }

  failAll(error) {
    for (const [, item] of this.pending) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
  }

  dispose() {
    this.closed = true
    this.failAll(new BrowserError('BROWSER_CLOSED', '浏览器已关闭'))
    this.listeners.clear()
  }
}

/* ------------------------------------------------------------------ */
/* BrowserController                                                   */
/* ------------------------------------------------------------------ */

export class BrowserController {
  constructor({ executablePath = '', profileDir, filesDir, logger = null, userAgent = '', proxy = '', headless = true } = {}) {
    const detected = executablePath ? { path: executablePath, label: '自定义浏览器', version: maxVersionDir(dirname(executablePath)) } : detectBrowserExecutable()
    this.executablePath = detected?.path || ''
    this.executableLabel = detected?.label || ''
    this.version = detected?.version || ''
    this.profileDir = profileDir
    this.filesDir = filesDir
    this.logger = logger
    this.customUserAgent = userAgent || ''
    this.proxy = proxy || ''
    this.defaultHeadless = headless !== false
    this.child = null
    this.transport = null
    this.headless = this.defaultHeadless
    this.sessions = new Map()
    this.currentTargetId = ''
    this.lastError = ''
    this.startedAt = 0
  }

  get available() {
    return !!this.executablePath && existsSync(this.executablePath)
  }

  get running() {
    return !!this.child && !this.child.killed && !this.transport?.closed
  }

  get sessionId() {
    return this.sessions.get(this.currentTargetId) || ''
  }

  status() {
    return {
      available: this.available,
      running: this.running,
      executable: this.executablePath,
      label: this.executableLabel,
      version: this.version,
      headless: this.headless,
      profileDir: this.profileDir,
      userAgent: this.customUserAgent || buildUserAgent(this.version, this.executableLabel),
      lastError: this.lastError,
      startedAt: this.startedAt,
      targets: this.sessions.size,
    }
  }

  async ensure({ headless = this.defaultHeadless, timeoutMs = 20000 } = {}) {
    const wantHeadless = headless !== false
    if (this.running && this.headless === wantHeadless) return this
    if (this.running) await this.close()
    if (!this.available) {
      throw new BrowserError(
        'BROWSER_UNAVAILABLE',
        this.executablePath ? `浏览器不存在：${this.executablePath}` : '没有找到 Edge / Chrome，可在设置页手动指定浏览器路径。',
      )
    }
    await mkdir(this.profileDir, { recursive: true })
    await mkdir(this.filesDir, { recursive: true })

    const userAgent = this.customUserAgent || buildUserAgent(this.version, this.executableLabel)
    const args = [
      `--user-data-dir=${this.profileDir}`,
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-default-apps',
      '--mute-audio',
      '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,960',
      '--lang=zh-CN',
    ]
    if (userAgent) args.push(`--user-agent=${userAgent}`)
    if (this.proxy) args.push(`--proxy-server=${this.proxy}`)
    if (wantHeadless) args.push('--headless=new', '--disable-gpu')
    args.push('about:blank')

    this.headless = wantHeadless
    let child
    try {
      child = spawn(this.executablePath, args, {
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
        windowsHide: wantHeadless,
      })
    } catch (error) {
      this.lastError = error.message
      throw new BrowserError('BROWSER_START_FAILED', `启动浏览器失败：${error.message}`, '本地安全软件 / 远程桌面环境可能限制了子进程创建。')
    }
    this.child = child
    this.transport = new CdpTransport(child, this.logger)

    try {
      const versionInfo = await this.transport.send('Browser.getVersion', {}, '', timeoutMs)
      if (versionInfo?.product) this.product = versionInfo.product
      await this.transport.send('Target.setDiscoverTargets', { discover: true }, '', timeoutMs)
      const { targetInfos = [] } = await this.transport.send('Target.getTargets', {}, '', timeoutMs)
      const existing = targetInfos.find(info => info.type === 'page')
      if (existing) await this.attach(existing.targetId)
      else await this.newPage('about:blank')
      this.startedAt = Date.now()
      this.lastError = ''
      this.logger?.info?.(`[web-access] 浏览器已启动：${this.executableLabel} ${this.version} · ${wantHeadless ? 'headless' : 'headful'}`)
      return this
    } catch (error) {
      this.lastError = error.message
      await this.close().catch(() => {})
      throw error instanceof BrowserError
        ? error
        : new BrowserError('BROWSER_START_FAILED', `浏览器启动失败：${error.message}`, '可在设置页关闭无头模式观察浏览器窗口，或手动指定浏览器路径。')
    }
  }

  async attach(targetId) {
    if (!targetId) throw new BrowserError('NO_TARGET', '没有可用的浏览器页面')
    if (this.sessions.has(targetId)) {
      this.currentTargetId = targetId
      return this.sessions.get(targetId)
    }
    const { sessionId } = await this.transport.send('Target.attachToTarget', { targetId, flatten: true })
    this.sessions.set(targetId, sessionId)
    this.currentTargetId = targetId
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) {
      try {
        await this.transport.send(method, {}, sessionId)
      } catch (_) {
        /* 非 page target 可能不支持，忽略 */
      }
    }
    try {
      await this.transport.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SOURCE }, sessionId)
    } catch (_) {
      /* ignore */
    }
    return sessionId
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.transport.send('Target.createTarget', { url })
    await this.attach(targetId)
    return targetId
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = 15000, returnByValue = true } = {}) {
    const sessionId = this.sessionId
    if (!sessionId) throw new BrowserError('NO_PAGE', '当前没有打开的页面')
    const result = await this.transport.send(
      'Runtime.evaluate',
      {
        expression: String(expression),
        returnByValue,
        awaitPromise,
        userGesture: true,
        timeout: Math.max(1000, timeoutMs),
      },
      sessionId,
      timeoutMs + 2000,
    )
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        result.exceptionDetails.exception?.value ||
        '页面脚本执行失败'
      throw new BrowserError('EVAL_FAILED', String(text).slice(0, 1000))
    }
    if (!returnByValue) return result.result
    return result.result?.value
  }

  async waitReady(timeoutMs = 15000) {
    const deadline = Date.now() + Math.max(500, Math.min(Number(timeoutMs) || 15000, 60000))
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState', { timeoutMs: 3000 })
        if (state === 'complete' || state === 'interactive') return true
      } catch (_) {
        /* 页面切换过程中可能短暂不可用 */
      }
      await sleep(200)
    }
    return false
  }

  async navigate(url, { timeoutMs = 30000, waitMs = 0, waitUntil = 'load' } = {}) {
    const sessionId = this.sessionId
    if (!sessionId) throw new BrowserError('NO_PAGE', '当前没有打开的页面')
    const loadPromise =
      waitUntil === 'none'
        ? Promise.resolve()
        : this.transport.onceEvent('Page.loadEventFired', { sessionId, timeoutMs }).catch(() => null)
    const result = await this.transport.send('Page.navigate', { url }, sessionId, timeoutMs)
    if (result?.errorText && !result.loaderId && !/ERR_ABORTED/i.test(result.errorText)) {
      throw new BrowserError('NAVIGATION_FAILED', `打开页面失败：${result.errorText}`)
    }
    await loadPromise
    await this.waitReady(Math.min(timeoutMs, 12000))
    if (waitMs > 0) await sleep(waitMs)
    return this.currentUrl()
  }

  async currentUrl() {
    try {
      return await this.evaluate('location.href', { timeoutMs: 4000 })
    } catch (_) {
      return ''
    }
  }

  async title() {
    try {
      return await this.evaluate('document.title', { timeoutMs: 4000 })
    } catch (_) {
      return ''
    }
  }

  async getText(limit = 20000) {
    const text = await this.evaluate(
      `(() => { const body = document.body; return body ? (body.innerText || body.textContent || '') : ''; })()`,
      { timeoutMs: 10000 },
    )
    const value = String(text || '')
    return { text: value.slice(0, limit), truncated: value.length > limit, length: value.length }
  }

  async getHtml(limit = 400000) {
    const html = await this.evaluate('document.documentElement ? document.documentElement.outerHTML : ""', { timeoutMs: 15000 })
    const value = String(html || '')
    return { html: value.slice(0, limit), truncated: value.length > limit, length: value.length }
  }

  async elementPoint({ selector = '', text = '', index = 0 } = {}) {
    const expression = `(() => {
      const selector = ${JSON.stringify(String(selector || ''))};
      const text = ${JSON.stringify(String(text || ''))};
      const index = ${Number.isFinite(Number(index)) ? Math.max(0, Math.floor(Number(index))) : 0};
      const visible = el => {
        if (!el || !el.getBoundingClientRect) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
      let list = [];
      if (selector) list = [...document.querySelectorAll(selector)].filter(visible);
      else if (text) {
        const all = [...document.querySelectorAll(${JSON.stringify(CLICKABLE_SELECTOR)})].filter(visible);
        const exact = all.filter(el => norm(el.innerText || el.textContent) === norm(text));
        list = exact.length ? exact : all.filter(el => norm(el.innerText || el.textContent).includes(norm(text)));
      } else if (document.activeElement && document.activeElement !== document.body) {
        list = [document.activeElement];
      }
      const el = list[index] || null;
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        tag: el.tagName,
        text: norm(el.innerText || el.textContent || el.value || '').slice(0, 120),
        value: String(el.value || '').slice(0, 120),
        href: String(el.href || '').slice(0, 300),
      };
    })()`
    return this.evaluate(expression, { timeoutMs: 8000 })
  }

  async clickableCandidates(limit = 30) {
    try {
      return await this.evaluate(
        `[...document.querySelectorAll(${JSON.stringify(CLICKABLE_SELECTOR)})]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(el => String(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean).slice(0, ${Math.max(1, Math.min(limit, 60))})`,
        { timeoutMs: 6000 },
      )
    } catch (_) {
      return []
    }
  }

  async click({ selector = '', text = '', index = 0, download = false, waitMs = 400 } = {}) {
    const point = await this.elementPoint({ selector, text, index })
    if (!point) {
      const candidates = await this.clickableCandidates()
      throw new BrowserError(
        'ELEMENT_NOT_FOUND',
        `没有找到可点击元素${text ? `（文本：${String(text).slice(0, 60)}）` : ''}${selector ? `（选择器：${String(selector).slice(0, 80)}）` : ''}。`,
        candidates.length ? `当前页面可点击项：${candidates.join(' | ')}` : '可以先 action=read 查看页面结构。',
      )
    }
    const beforeTabs = new Set((await this.pageTargets()).map(item => item.id))
    if (download) {
      await this.setDownloadBehavior()
    }
    const sessionId = this.sessionId
    const coordinates = { x: Math.max(0, point.x), y: Math.max(0, point.y) }
    await this.transport.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...coordinates, button: 'none' }, sessionId)
    await this.transport.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...coordinates, button: 'left', clickCount: 1 }, sessionId)
    await this.transport.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...coordinates, button: 'left', clickCount: 1 }, sessionId)
    await sleep(Math.max(200, Number(waitMs) || 400))
    await this.switchToNewPage(beforeTabs)
    return { clicked: true, ...point, url: await this.currentUrl() }
  }

  async type({ selector = '', text = '', clear = true, submit = false, waitMs = 300 } = {}) {
    const sessionId = this.sessionId
    if (!sessionId) throw new BrowserError('NO_PAGE', '当前没有打开的页面')
    if (selector) {
      const focused = await this.evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(String(selector))});
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.focus();
          if (${clear ? 'true' : 'false'}) {
            if (typeof el.select === 'function') el.select();
            else if (el.isContentEditable) {
              const range = document.createRange();
              range.selectNodeContents(el);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            } else if ('value' in el) el.value = '';
          }
          return true;
        })()`,
        { timeoutMs: 8000 },
      )
      if (!focused) throw new BrowserError('ELEMENT_NOT_FOUND', `没有找到输入框：${String(selector).slice(0, 100)}`, '可先 action=read 并带 include_interactive=true 查看页面表单。')
    }
    await this.transport.send('Input.insertText', { text: String(text ?? '') }, sessionId)
    const activeTag = await this.evaluate('document.activeElement ? document.activeElement.tagName : ""', { timeoutMs: 4000 }).catch(() => '')
    if (!selector && (!activeTag || activeTag === 'BODY')) {
      throw new BrowserError('ELEMENT_NOT_FOUND', '页面上没有聚焦的输入框；请先 action=click 点击输入框，或用 selector 指定。')
    }
    await this.evaluate(
      `(() => { const el = document.activeElement; if (el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`,
      { timeoutMs: 4000 },
    ).catch(() => {})
    if (submit) {
      await this.press('Enter')
      await sleep(Math.max(600, Number(waitMs) || 1200))
    } else if (waitMs > 0) {
      await sleep(waitMs)
    }
    return { typed: true, submitted: !!submit, url: await this.currentUrl() }
  }

  async selectOption({ selector = '', value = '', text = '', index = 0 } = {}) {
    if (!this.sessionId) throw new BrowserError('NO_PAGE', '当前没有打开的页面')
    const result = await this.evaluate(
      `(() => {
        const selector = ${JSON.stringify(String(selector || ''))};
        const value = ${JSON.stringify(String(value ?? ''))};
        const text = ${JSON.stringify(String(text ?? ''))};
        const index = ${Number.isFinite(Number(index)) ? Math.max(0, Math.floor(Number(index))) : 0};
        const el = selector ? document.querySelector(selector) : document.activeElement;
        if (!el) return { ok: false, error: '没有找到下拉框，请用 selector 指定。' };
        if (el.tagName !== 'SELECT') return { ok: false, error: '目标元素不是 <select>，当前是 ' + el.tagName + '。' };
        const options = [...el.options];
        let target = null;
        if (value !== '') target = options.find(option => option.value === value) || null;
        else if (text !== '') target = options.find(option => String(option.textContent || '').trim().includes(text)) || null;
        else target = options[index] || null;
        if (!target) return { ok: false, error: '没有匹配的选项。', options: options.slice(0, 30).map(option => ({ value: option.value, text: String(option.textContent || '').trim() })) };
        el.value = target.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: target.value, text: String(target.textContent || '').trim() };
      })()`,
      { timeoutMs: 8000 },
    )
    if (!result?.ok) {
      throw new BrowserError('ELEMENT_NOT_FOUND', result?.error || '选择下拉选项失败', result?.options ? `可用选项：${result.options.map(option => option.text || option.value).join(' | ')}` : '')
    }
    await sleep(200)
    return { selected: true, ...result, url: await this.currentUrl() }
  }

  async press(key) {
    const sessionId = this.sessionId
    if (!sessionId) throw new BrowserError('NO_PAGE', '当前没有打开的页面')
    const name = String(key || 'Enter')
    const definitions = {
      Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', vk: 9 },
      Escape: { key: 'Escape', code: 'Escape', vk: 27, text: '' },
      Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
      Delete: { key: 'Delete', code: 'Delete', vk: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
      PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
      PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
      Home: { key: 'Home', code: 'Home', vk: 36 },
      End: { key: 'End', code: 'End', vk: 35 },
      Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
    }
    const definition = definitions[name] || (name.length === 1 ? { key: name, code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0), text: name } : null)
    if (!definition) throw new BrowserError('INVALID_ARGS', `不支持的按键：${name}`)
    const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.vk, nativeVirtualKeyCode: definition.vk }
    await this.transport.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' }, sessionId)
    if (definition.text !== undefined && definition.text !== '') {
      await this.transport.send('Input.dispatchKeyEvent', { ...base, type: 'char', text: definition.text, unmodifiedText: definition.text }, sessionId).catch(() => {})
    }
    await this.transport.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId)
    await sleep(300)
    return { pressed: name, url: await this.currentUrl() }
  }

  async scroll({ direction = 'down', amount = 0, times = 1, selector = '', waitMs = 400 } = {}) {
    const rounds = Math.max(1, Math.min(Number(times) || 1, 20))
    let position = null
    for (let i = 0; i < rounds; i += 1) {
      const expression = `(() => {
        const selector = ${JSON.stringify(String(selector || ''))};
        const container = selector ? document.querySelector(selector) : null;
        const target = container || window;
        const dir = ${JSON.stringify(String(direction || 'down'))};
        const amount = ${Number(amount) || 0};
        const viewport = container ? container.clientHeight : window.innerHeight;
        const step = amount > 0 ? amount : Math.round(viewport * 0.85);
        if (dir === 'top') {
          if (container) container.scrollTop = 0; else window.scrollTo(0, 0);
        } else if (dir === 'bottom') {
          if (container) container.scrollTop = container.scrollHeight; else window.scrollTo(0, document.body.scrollHeight);
        } else if (dir === 'up' || dir === 'page_up') {
          if (container) container.scrollTop -= step; else window.scrollBy(0, -step);
        } else {
          if (container) container.scrollTop += step; else window.scrollBy(0, step);
        }
        return {
          scrollY: Math.round(container ? container.scrollTop : window.scrollY),
          scrollHeight: Math.round(container ? container.scrollHeight : document.documentElement.scrollHeight),
          viewportHeight: Math.round(container ? container.clientHeight : window.innerHeight),
        };
      })()`
      position = await this.evaluate(expression, { timeoutMs: 6000 })
      if (i < rounds - 1) await sleep(Math.max(120, Number(waitMs) || 400))
    }
    await sleep(200)
    return position
  }

  async waitFor({ ms = 0, selector = '', text = '', timeoutMs = 20000, pollMs = 400 } = {}) {
    if (ms > 0) await sleep(Math.min(Number(ms) || 0, 120000))
    if (!selector && !text) return { waited: ms > 0 }
    const deadline = Date.now() + Math.max(500, Math.min(Number(timeoutMs) || 20000, 120000))
    const poll = Math.max(100, Math.min(Number(pollMs) || 400, 2000))
    while (Date.now() < deadline) {
      try {
        const found = await this.evaluate(
          `(() => {
            if (${JSON.stringify(String(selector || ''))}) return !!document.querySelector(${JSON.stringify(String(selector || ''))});
            const body = document.body ? (document.body.innerText || '') : '';
            return body.includes(${JSON.stringify(String(text || ''))});
          })()`,
          { timeoutMs: 4000 },
        )
        if (found) return { waited: true, selector, text }
      } catch (_) {
        /* 页面切换中 */
      }
      await sleep(poll)
    }
    throw new BrowserError('TIMEOUT', `等待超时：${selector ? `选择器 ${selector}` : `文本「${text}」`} 未出现。`)
  }

  async pruneFiles(keep = 120) {
    const files = await readdir(this.filesDir).catch(() => [])
    if (files.length <= keep) return
    const entries = await Promise.all(
      files.map(async name => {
        const info = await stat(join(this.filesDir, name)).catch(() => null)
        return { name, mtime: info?.mtimeMs || 0 }
      }),
    )
    entries.sort((a, b) => a.mtime - b.mtime)
    for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) {
      await rm(join(this.filesDir, entry.name), { force: true }).catch(() => {})
    }
  }

  async screenshot({ fullPage = false } = {}) {
    const result = await this.transport.send(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: !!fullPage },
      this.sessionId,
      30000,
    )
    const buffer = Buffer.from(result.data || '', 'base64')
    if (!buffer.length) throw new BrowserError('SCREENSHOT_FAILED', '截图返回为空')
    await mkdir(this.filesDir, { recursive: true })
    const name = `shot-${Date.now()}-${randomToken(6)}.png`
    await writeFile(join(this.filesDir, name), buffer)
    await this.pruneFiles(120).catch(() => {})
    return { file: name, bytes: buffer.length }
  }

  async pageTargets() {
    try {
      const { targetInfos = [] } = await this.transport.send('Target.getTargets', {}, '', 8000)
      return targetInfos.filter(info => info.type === 'page' && !String(info.url || '').startsWith('devtools://'))
    } catch (_) {
      return []
    }
  }

  async tabs() {
    const targets = await this.pageTargets()
    return targets.map((target, index) => ({
      index,
      id: target.targetId,
      url: target.url,
      title: target.title || '',
      current: target.targetId === this.currentTargetId,
    }))
  }

  findTabRef(ref, tabs) {
    if (ref === undefined || ref === null || ref === '') {
      return tabs.find(tab => tab.current)?.id || ''
    }
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const index = Number(ref)
      return tabs.find(tab => tab.index === index)?.id || tabs[index]?.id || ''
    }
    const text = String(ref)
    return tabs.find(tab => tab.id === text)?.id || tabs.find(tab => tab.url.includes(text) || tab.title.includes(text))?.id || ''
  }

  async useTab(ref) {
    const tabs = await this.tabs()
    const targetId = this.findTabRef(ref, tabs)
    if (!targetId) throw new BrowserError('TAB_NOT_FOUND', `没有找到标签页：${String(ref)}`, `当前标签页：${tabs.map(tab => `${tab.index}:${tab.title || tab.url}`).join(' | ')}`)
    await this.attach(targetId)
    await this.waitReady(5000).catch(() => {})
    return { active: targetId, url: await this.currentUrl(), title: await this.title() }
  }

  async closeTab(ref) {
    const tabs = await this.tabs()
    const targetId = this.findTabRef(ref, tabs)
    if (!targetId) throw new BrowserError('TAB_NOT_FOUND', `没有找到标签页：${String(ref)}`)
    const wasCurrent = targetId === this.currentTargetId
    this.sessions.delete(targetId)
    await this.transport.send('Target.closeTarget', { targetId }).catch(() => {})
    if (wasCurrent) {
      const rest = await this.pageTargets()
      if (rest.length) await this.attach(rest[0].targetId)
      else await this.newPage('about:blank')
    }
    return { closed: targetId, url: await this.currentUrl() }
  }

  async switchToNewPage(beforeIds) {
    const after = await this.pageTargets()
    const created = after.filter(item => !beforeIds.has(item.targetId))
    if (!created.length) return false
    await this.attach(created[created.length - 1].targetId)
    await this.waitReady(5000).catch(() => {})
    return true
  }

  async history(direction) {
    const sessionId = this.sessionId
    if (!sessionId) throw new BrowserError('NO_PAGE', '当前没有打开的页面')
    const mode = String(direction || 'reload')
    if (mode === 'reload') {
      const load = this.transport.onceEvent('Page.loadEventFired', { sessionId, timeoutMs: 20000 }).catch(() => null)
      await this.transport.send('Page.reload', {}, sessionId)
      await load
      await this.waitReady(10000)
      return { reloaded: true, url: await this.currentUrl() }
    }
    const historyInfo = await this.transport.send('Page.getNavigationHistory', {}, sessionId)
    const entries = historyInfo.entries || []
    const index = Number(historyInfo.currentIndex) || 0
    const nextIndex = mode === 'forward' ? index + 1 : index - 1
    if (nextIndex < 0 || nextIndex >= entries.length) return { url: await this.currentUrl(), atEnd: true }
    await this.transport.send('Page.navigateToHistoryEntry', { entryId: entries[nextIndex].id }, sessionId)
    await this.waitReady(10000)
    await sleep(300)
    return { url: await this.currentUrl(), direction: mode }
  }

  /** 读取浏览器上下文全部 Cookie。
   *  新版 Chromium/Edge 在 browser 端只有 Storage 域，旧版用 Network 域，这里多级降级。 */
  async allCookies() {
    const attempts = [
      () => this.transport.send('Storage.getCookies', {}, '', 15000),
      () => this.transport.send('Network.getAllCookies', {}, '', 15000),
      () => this.transport.send('Storage.getCookies', {}, this.sessionId, 15000),
      () => this.transport.send('Network.getAllCookies', {}, this.sessionId, 15000),
      () => this.transport.send('Network.getCookies', {}, this.sessionId, 15000),
    ]
    for (const attempt of attempts) {
      try {
        const result = await attempt()
        if (Array.isArray(result?.cookies)) return result.cookies
      } catch (_) {
        /* 尝试下一种 */
      }
    }
    return []
  }

  async setCookies(cookies) {
    if (!Array.isArray(cookies) || !cookies.length) return 0
    const attempts = [
      () => this.transport.send('Storage.setCookies', { cookies }, '', 15000),
      () => this.transport.send('Network.setCookies', { cookies }, '', 15000),
      () => this.transport.send('Storage.setCookies', { cookies }, this.sessionId, 15000),
      () => this.transport.send('Network.setCookies', { cookies }, this.sessionId, 15000),
    ]
    let lastError = null
    for (const attempt of attempts) {
      try {
        await attempt()
        return cookies.length
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) throw lastError
    return 0
  }

  async clearCookies() {
    for (const method of ['Storage.clearCookies', 'Network.clearBrowserCookies']) {
      try {
        await this.transport.send(method, {}, '', 15000)
        return true
      } catch (_) {
        /* 尝试下一种 */
      }
    }
    return false
  }

  /** 删除某可注册域（含子域）在浏览器里的 Cookie，避免删除后又被同步回 Cookie 库。 */
  async clearCookiesForDomain(domain) {
    const target = String(domain || '').toLowerCase().replace(/^\.+/, '')
    if (!target || target === '*') return this.clearCookies()
    const cookies = await this.allCookies().catch(() => [])
    const matched = cookies.filter(cookie => {
      const host = String(cookie.domain || '').toLowerCase().replace(/^\.+/, '')
      return host === target || host.endsWith(`.${target}`) || target.endsWith(`.${host}`)
    })
    let removed = 0
    for (const cookie of matched) {
      const params = { name: cookie.name, path: cookie.path || '/' }
      if (cookie.domain) params.domain = cookie.domain
      try {
        await this.transport.send('Network.deleteCookies', params, this.sessionId || '', 8000)
        removed += 1
        continue
      } catch (_) {
        /* 尝试带 URL 的旧接口 */
      }
      try {
        await this.transport.send('Network.deleteCookies', { name: cookie.name, url: `https://${cookie.domain || target}${cookie.path || '/'}` }, '', 8000)
        removed += 1
      } catch (_) {
        /* 忽略单条失败 */
      }
    }
    return removed > 0 ? { removed } : false
  }

  async setDownloadBehavior() {
    await mkdir(this.filesDir, { recursive: true })
    const params = { behavior: 'allow', downloadPath: this.filesDir, eventsEnabled: true }
    try {
      await this.transport.send('Browser.setDownloadBehavior', params, '', 10000)
    } catch (_) {
      await this.transport.send('Page.setDownloadBehavior', params, this.sessionId, 10000).catch(() => {})
    }
  }

  async waitForDownload(beforeFiles, { timeoutMs = 20000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(500)
      const files = await readdir(this.filesDir).catch(() => [])
      const created = files.filter(name => !beforeFiles.has(name) && !name.endsWith('.crdownload'))
      if (created.length) {
        const target = join(this.filesDir, created[created.length - 1])
        const info = await stat(target).catch(() => null)
        if (info?.size > 0) return created
      }
    }
    return []
  }

  async listFiles() {
    return readdir(this.filesDir).catch(() => [])
  }

  async close() {
    const child = this.child
    const transport = this.transport
    this.child = null
    this.transport = null
    this.sessions.clear()
    this.currentTargetId = ''
    if (transport) {
      try {
        await transport.send('Browser.close', {}, '', 3000)
      } catch (_) {
        /* ignore */
      }
      transport.dispose()
    }
    if (child && !child.killed) {
      const exited = await Promise.race([
        new Promise(resolve => child.once('exit', () => resolve(true))),
        sleep(1500).then(() => false),
      ])
      if (!exited) {
        try {
          child.kill('SIGKILL')
        } catch (_) {
          /* ignore */
        }
      }
    }
    this.logger?.info?.('[web-access] 浏览器已关闭')
  }
}

export default BrowserController
