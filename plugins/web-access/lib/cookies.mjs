/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * web-access · Cookie 库（自包含扩展版本）。
 *
 *  - CookieJar：按域名保存 / 匹配 / 注入 / 自动落盘（由 bridge 统一加密持久化）
 *  - parseCookieInput：兼容 Cookie 头、document.cookie、JSON、Netscape 文件、cURL 命令、Set-Cookie
 *  - importLocalBrowserCookies：从本机 Edge / Chrome / Firefox 读取 Cookie
 *      · Chromium v10/v11：DPAPI 解出 AES 密钥后解密（Windows）
 *      · Chromium v20（App-Bound Encryption）：系统权限才能解，明确跳过并提示
 *      · Firefox：cookies.sqlite 明文存储，直接读取
 */
import { spawn } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/*
 * 热更新缓存穿透：bridge.mjs 热重载时带 ?v= revision，lib 依赖链继续复用同一
 * revision，避免更新插件后仍命中旧 ESM 模块缓存导致新导出缺失、后端桥 404。
 */
const __revision = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || ''
  } catch (_) {
    return ''
  }
})()
const libUrl = file => `./${String(file).replace(/^\.\//, '')}${__revision ? `?v=${encodeURIComponent(__revision)}` : ''}`

const { randomToken, safeJsonParse } = await import(libUrl('util.mjs'))

/* ------------------------------------------------------------------ */
/* 域名 / Cookie 基础                                                  */
/* ------------------------------------------------------------------ */

const MULTI_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'com.hk', 'org.hk', 'com.tw', 'org.tw', 'com.au', 'net.au', 'org.au',
  'com.br', 'com.sg', 'com.my', 'co.kr', 'co.in', 'com.mx', 'com.tr',
])

export function stripDomainDot(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
}

export function registrableDomain(host) {
  const name = stripDomainDot(host)
  if (!name || !name.includes('.')) return name
  const parts = name.split('.')
  if (parts.length <= 2) return name
  const last2 = parts.slice(-2).join('.')
  if (MULTI_SUFFIXES.has(last2) && parts.length >= 3) return parts.slice(-3).join('.')
  return last2
}

export function domainMatches(cookieDomain, host) {
  const domain = stripDomainDot(cookieDomain)
  const target = stripDomainDot(host)
  if (!domain || !target) return false
  return target === domain || target.endsWith(`.${domain}`)
}

export function defaultCookiePath(url) {
  try {
    const pathname = new URL(String(url)).pathname || '/'
    if (pathname === '/' || !pathname.includes('/')) return '/'
    return pathname.slice(0, pathname.lastIndexOf('/')) || '/'
  } catch (_) {
    return '/'
  }
}

function normalizeSameSite(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'strict') return 'strict'
  if (raw === 'lax') return 'lax'
  if (raw === 'none' || raw === 'no_restriction' || raw === 'unspecified') return 'none'
  return ''
}

function cookieKey(cookie) {
  return `${stripDomainDot(cookie.domain)}\u0000${cookie.path || '/'}\u0000${cookie.name}`
}

function toExpires(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  // 兼容秒 / 毫秒两种时间戳
  return n < 10_000_000_000 ? Math.round(n * 1000) : Math.round(n)
}

function validCookieName(name) {
  const text = String(name ?? '').trim()
  return !!text && !/[\s;=,]/.test(text)
}

export function normalizeCookie(cookie = {}, { source = '', url = '', domain = '' } = {}) {
  const name = String(cookie.name ?? cookie.key ?? '').trim()
  if (!validCookieName(name)) return null
  let value = cookie.value
  if (value === undefined || value === null) value = ''
  const rawDomain = String(cookie.domain || domain || '')
  // Cookie 作用域：带前导点 = 域级（子域共享）；无点 = host-only。
  // 浏览器 CDP 导入 / Set-Cookie Domain 属性 / 用户粘贴时各自的原始格式不同，这里统一保留。
  const hostOnly = cookie.hostOnly !== undefined ? cookie.hostOnly === true : !rawDomain.startsWith('.')
  let host = stripDomainDot(rawDomain)
  if (!host && url) {
    try {
      host = stripDomainDot(new URL(url).hostname)
    } catch (_) {
      host = ''
    }
  }
  if (!host) return null
  let expires = toExpires(cookie.expires ?? cookie.expiry ?? cookie.expirationDate ?? cookie.expires_utc ?? 0)
  // Chromium 的 expires_utc 是 1601 年以来的微秒数
  if (Number(cookie.expires_utc) > 100_000_000_000) {
    expires = Math.max(0, Math.round(Number(cookie.expires_utc) / 1000 - 11_644_473_600_000))
  }
  return {
    domain: host,
    hostOnly,
    name,
    value: String(value),
    path: String(cookie.path || '/') || '/',
    secure: cookie.secure === true || cookie.secure === 1 || cookie.isSecure === true || cookie.isSecure === 1,
    httpOnly: cookie.httpOnly === true || cookie.httpOnly === 1 || cookie.isHttpOnly === true || cookie.isHttpOnly === 1,
    expires,
    sameSite: normalizeSameSite(cookie.sameSite || cookie.samesite),
    source: String(cookie.source || source || ''),
    updatedAt: Number(cookie.updatedAt) || Date.now(),
  }
}

export function parseSetCookie(header, fallbackUrl = '') {
  const text = String(header || '').trim()
  if (!text) return null
  const parts = text.split(';')
  const first = parts.shift() || ''
  const index = first.indexOf('=')
  if (index <= 0) return null
  const name = first.slice(0, index).trim()
  const value = first.slice(index + 1).trim()
  if (!validCookieName(name)) return null

  const cookie = { name, value, path: '', domain: '', secure: false, httpOnly: false, expires: 0, sameSite: '', hostOnly: true }
  let hasDomainAttr = false
  for (const rawAttr of parts) {
    const attr = rawAttr.trim()
    if (!attr) continue
    const eq = attr.indexOf('=')
    const key = (eq >= 0 ? attr.slice(0, eq) : attr).trim().toLowerCase()
    const val = eq >= 0 ? attr.slice(eq + 1).trim() : ''
    if (key === 'domain') {
      hasDomainAttr = true
      cookie.domain = stripDomainDot(val)
    } else if (key === 'path') cookie.path = val || '/'
    else if (key === 'secure') cookie.secure = true
    else if (key === 'httponly') cookie.httpOnly = true
    else if (key === 'samesite') cookie.sameSite = val
    else if (key === 'max-age') {
      const seconds = Number(val)
      cookie.expires = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : 0
    } else if (key === 'expires') {
      const date = Date.parse(val)
      cookie.expires = Number.isFinite(date) ? date : 0
    }
  }
  cookie.hostOnly = !hasDomainAttr

  let host = ''
  let path = cookie.path || ''
  if (fallbackUrl) {
    try {
      const url = new URL(String(fallbackUrl))
      host = stripDomainDot(url.hostname)
      if (!path) path = defaultCookiePath(url.href)
      if (!cookie.domain) cookie.domain = host
    } catch (_) {
      /* ignore */
    }
  }
  if (!cookie.domain && host) cookie.domain = host
  if (!cookie.domain) return null
  if (!cookie.path) cookie.path = path || '/'
  return normalizeCookie(cookie, { source: 'set-cookie' })
}

/** 从一段“剪贴板里的 Cookie”解析出 Cookie 列表。
 *  支持：Cookie 头 / document.cookie / JSON / Netscape 文件 / cURL 命令 / Set-Cookie 行。
 */
export function parseCookieInput(input, { url = '', domain = '' } = {}) {
  const warnings = []
  const out = []
  const rawText = Array.isArray(input) ? '' : String(input ?? '').trim()
  if (!rawText && !Array.isArray(input)) return { cookies: out, warnings }

  let defaultHost = stripDomainDot(domain)
  let defaultHostOnly = !String(domain || '').trim().startsWith('.')
  let defaultSecure = false
  if (!defaultHost && url) {
    try {
      const parsed = new URL(String(url))
      defaultHost = stripDomainDot(parsed.hostname)
      defaultHostOnly = true
      defaultSecure = parsed.protocol === 'https:'
    } catch (_) {
      /* ignore */
    }
  }

  const push = cookie => {
    const candidate = cookie && typeof cookie === 'object' ? { ...cookie } : cookie
    if (candidate && typeof candidate === 'object' && candidate.domain === undefined && candidate.hostOnly === undefined) {
      candidate.hostOnly = defaultHostOnly
    }
    const normalized = normalizeCookie(candidate, { source: 'user', url, domain: defaultHost })
    if (normalized) out.push(normalized)
    else warnings.push(`忽略无法识别的 Cookie：${String(cookie?.name || '').slice(0, 40) || '(空)'}`)
  }

  const parsePairs = (text, { setCookieMode = false } = {}) => {
    const chunks = String(text || '')
      .split(/[\n\r]+/)
      .flatMap(line => line.split(';'))
      .map(part => part.trim())
      .filter(Boolean)
    let last = null
    for (const chunk of chunks) {
      if (setCookieMode) {
        const parsed = parseSetCookie(chunk + (defaultHost ? '' : ''), url)
        if (parsed) {
          last = parsed
          push(parsed)
        }
        continue
      }
      const lowerChunk = chunk.toLowerCase()
      if (last && (lowerChunk === 'secure' || lowerChunk === 'httponly')) {
        if (lowerChunk === 'secure') last.secure = true
        else last.httpOnly = true
        continue
      }
      const index = chunk.indexOf('=')
      if (index <= 0) continue
      const name = chunk.slice(0, index).trim()
      const value = chunk.slice(index + 1).trim().replace(/^"|"$/g, '')
      const lower = name.toLowerCase()
      if (['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'].includes(lower) && last) {
        if (lower === 'path') last.path = value || '/'
        else if (lower === 'domain') {
          last.domain = stripDomainDot(value)
          last.hostOnly = false
        } else if (lower === 'secure') last.secure = true
        else if (lower === 'httponly') last.httpOnly = true
        else if (lower === 'samesite') last.sameSite = value
        continue
      }
      if (!validCookieName(name)) continue
      const cookie = normalizeCookie(
        { name, value, domain: defaultHost, hostOnly: defaultHostOnly, secure: defaultSecure, expires: 0, source: 'user' },
        { source: 'user', url, domain: defaultHost },
      )
      if (cookie) {
        out.push(cookie)
        last = cookie
      }
    }
  }

  /* 1. 数组 / 对象 / JSON */
  const candidates = Array.isArray(input) ? input : []
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (Array.isArray(input.cookies)) candidates.push(...input.cookies)
    else candidates.push(input)
  }
  for (const item of candidates) {
    if (typeof item === 'string') parsePairs(item)
    else push(item)
  }
  if (out.length) return { cookies: out, warnings }

  const looksLikeJson = /^[[{]/.test(rawText)
  if (looksLikeJson) {
    const parsed = safeJsonParse(rawText, null)
    if (parsed) {
      const list = Array.isArray(parsed) ? parsed : parsed.cookies && Array.isArray(parsed.cookies) ? parsed.cookies : [parsed]
      for (const item of list) {
        if (typeof item === 'string') parsePairs(item)
        else push(item)
      }
      if (out.length) return { cookies: out, warnings }
    }
  }

  /* 2. Netscape cookies.txt：domain flag path secure expiry name value */
  if (rawText.includes('\t') && !out.length) {
    let netscapeCount = 0
    for (const line of rawText.split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('//')) continue
      const fields = line.split('\t')
      if (fields.length < 7) continue
      const [host, , path, secure, expiry, name, ...valueParts] = fields
      push({
        name,
        value: valueParts.join('\t'),
        domain: host,
        path,
        secure: String(secure).toUpperCase() === 'TRUE',
        expires: toExpires(expiry),
        source: 'user',
      })
      netscapeCount += 1
    }
    if (netscapeCount) return { cookies: out, warnings }
  }

  /* 3. cURL 命令：从 -H 'cookie: ...' / -b '...' / --cookie 提取 */
  if (/curl\s|--cookie|-H\s|--header/i.test(rawText)) {
    const headerMatch = rawText.match(/--(?:header|cookie)|-H|-b/i)
    if (headerMatch) {
      const quoted = rawText.match(/(?:-H|--header|-b|--cookie)\s+(['"])([\s\S]*?)\1/i)
      const inline = rawText.match(/(?:-H|--header)\s+([^\s'"]*cookie[^\s'"]*)/i)
      const chunk = quoted?.[2] || inline?.[1] || ''
      const withoutPrefix = chunk.replace(/^\s*cookie\s*:\s*/i, '')
      if (withoutPrefix) {
        parsePairs(withoutPrefix)
        if (out.length) return { cookies: out, warnings }
      }
    }
  }

  /* 4. 普通 Cookie 头 / document.cookie / 多行 Set-Cookie */
  const hadSetCookiePrefix = /^\s*set-cookie\s*:/i.test(rawText)
  const cleaned = rawText.replace(/^\s*(?:set-)?cookie\s*:\s*/i, '')
  parsePairs(cleaned)
  if (!out.length && hadSetCookiePrefix) {
    for (const line of cleaned.split(/\r?\n/)) {
      if (!line.trim() || !line.includes('=')) continue
      const parsed = parseSetCookie(line, url)
      if (parsed) push(parsed)
    }
  }
  if (!out.length && !defaultHost) warnings.push('没有识别出 Cookie；请同时提供 Cookie 对应的网站 URL 或域名。')
  return { cookies: out, warnings }
}

/* ------------------------------------------------------------------ */
/* CookieJar                                                           */
/* ------------------------------------------------------------------ */

export class CookieJar {
  constructor(cookies = []) {
    this.cookies = []
    this.replaceAll(cookies)
  }

  replaceAll(cookies = []) {
    this.cookies = []
    for (const item of cookies) {
      const normalized = normalizeCookie(item)
      if (normalized) this.cookies.push(normalized)
    }
    this.pruneExpired()
    return this.cookies.length
  }

  pruneExpired(now = Date.now()) {
    const before = this.cookies.length
    this.cookies = this.cookies.filter(cookie => !cookie.expires || cookie.expires > now)
    return before - this.cookies.length
  }

  /** 合并 Cookie；返回新增或更新的条数（值相同不计变更） */
  merge(list, { source = '', now = Date.now() } = {}) {
    const map = new Map(this.cookies.map(cookie => [cookieKey(cookie), cookie]))
    let changed = 0
    for (const raw of list || []) {
      const cookie = normalizeCookie(raw, { source: raw?.source || source })
      if (!cookie) continue
      if (cookie.expires && cookie.expires <= now) {
        if (map.delete(cookieKey(cookie))) changed += 1
        continue
      }
      if (!cookie.updatedAt) cookie.updatedAt = now
      const key = cookieKey(cookie)
      const current = map.get(key)
      if (!current || current.value !== cookie.value || current.expires !== cookie.expires) changed += 1
      map.set(key, { ...current, ...cookie })
    }
    this.cookies = [...map.values()]
    this.pruneExpired(now)
    return changed
  }

  getForUrl(url, now = Date.now()) {
    let parsed
    try {
      parsed = new URL(String(url))
    } catch (_) {
      return []
    }
    const host = stripDomainDot(parsed.hostname)
    const secure = parsed.protocol === 'https:'
    const path = parsed.pathname || '/'
    return this.cookies
      .filter(cookie => cookie.expires === 0 || cookie.expires > now)
      .filter(cookie => domainMatches(cookie.domain, host))
      .filter(cookie => !cookie.secure || secure)
      .filter(cookie => {
        const cookiePath = cookie.path || '/'
        if (cookiePath === '/') return true
        return path === cookiePath || path.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`) || path.startsWith(cookiePath)
      })
      .sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0))
  }

  headerForUrl(url) {
    return this.getForUrl(url)
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ')
  }

  applySetCookie(url, setCookieValues, { source = 'http' } = {}) {
    const list = []
    for (const header of Array.isArray(setCookieValues) ? setCookieValues : [setCookieValues]) {
      const parsed = parseSetCookie(header, url)
      if (parsed) list.push({ ...parsed, source })
    }
    return this.merge(list, { source })
  }

  summary(domain = '') {
    const filter = stripDomainDot(domain)
    this.pruneExpired()
    const byDomain = new Map()
    for (const cookie of this.cookies) {
      if (filter && !domainMatches(cookie.domain, filter) && !domainMatches(filter, cookie.domain)) continue
      const key = stripDomainDot(cookie.domain)
      const entry = byDomain.get(key) || { domain: key, count: 0, names: [], sources: {}, updatedAt: 0 }
      entry.count += 1
      if (entry.names.length < 12 && !entry.names.includes(cookie.name)) entry.names.push(cookie.name)
      entry.sources[cookie.source || 'unknown'] = (entry.sources[cookie.source || 'unknown'] || 0) + 1
      entry.updatedAt = Math.max(entry.updatedAt, Number(cookie.updatedAt) || 0)
      byDomain.set(key, entry)
    }
    const domains = [...byDomain.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    return { total: this.cookies.length, matched: domains.reduce((sum, item) => sum + item.count, 0), domains }
  }

  removeDomain(domain) {
    const target = stripDomainDot(domain)
    if (!target || target === '*') {
      const count = this.cookies.length
      this.cookies = []
      return count
    }
    const before = this.cookies.length
    this.cookies = this.cookies.filter(cookie => !domainMatches(cookie.domain, target) && !domainMatches(target, cookie.domain))
    return before - this.cookies.length
  }

  /** 转成 CDP Storage/Network setCookies 需要的形状（domain 前导点决定是否子域共享）。 */
  toCdpCookies(url) {
    return this.getForUrl(url).map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`,
      path: cookie.path || '/',
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      ...(cookie.expires ? { expires: Math.floor(cookie.expires / 1000) } : {}),
      ...(cookie.sameSite === 'strict' ? { sameSite: 'Strict' } : cookie.sameSite === 'lax' ? { sameSite: 'Lax' } : cookie.sameSite === 'none' ? { sameSite: 'None' } : {}),
    }))
  }

  /** CDP getAllCookies -> 内部结构（host-only / 域级由 domain 是否有前导点判断）。 */
  fromCdpCookies(list) {
    const out = []
    for (const cookie of list || []) {
      const normalized = normalizeCookie(
        {
          domain: cookie.domain,
          hostOnly: !String(cookie.domain || '').startsWith('.'),
          name: cookie.name,
          value: cookie.value,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expires: cookie.expires ? cookie.expires * 1000 : 0,
          sameSite: cookie.sameSite,
          source: 'browser',
        },
        { source: 'browser' },
      )
      if (normalized) out.push(normalized)
    }
    return out
  }

  toJSON() {
    return this.cookies.map(cookie => ({ ...cookie }))
  }
}

/* ------------------------------------------------------------------ */
/* 本机浏览器 Cookie 导入                                               */
/* ------------------------------------------------------------------ */

function localBrowserCandidates() {
  const list = []
  const platform = process.platform
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const home = homedir()

  const addChromium = (id, label, base, localState = true) => {
    if (!base) return
    list.push({ id, label, engine: 'chromium', base, localState })
  }

  if (platform === 'win32') {
    addChromium('edge', 'Microsoft Edge', join(localAppData, 'Microsoft', 'Edge', 'User Data'))
    addChromium('chrome', 'Google Chrome', join(localAppData, 'Google', 'Chrome', 'User Data'))
    addChromium('brave', 'Brave', join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'))
  } else if (platform === 'darwin') {
    addChromium('edge', 'Microsoft Edge', join(home, 'Library', 'Application Support', 'Microsoft Edge'))
    addChromium('chrome', 'Google Chrome', join(home, 'Library', 'Application Support', 'Google', 'Chrome'))
    addChromium('brave', 'Brave', join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'))
  } else {
    addChromium('edge', 'Microsoft Edge', join(home, '.config', 'microsoft-edge'))
    addChromium('chrome', 'Google Chrome', join(home, '.config', 'google-chrome'))
    addChromium('brave', 'Brave', join(home, '.config', 'BraveSoftware', 'Brave-Browser'))
  }

  const firefoxRoot =
    platform === 'win32'
      ? join(appData, 'Mozilla', 'Firefox', 'Profiles')
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')
        : join(home, '.mozilla', 'firefox')
  list.push({ id: 'firefox', label: 'Mozilla Firefox', engine: 'firefox', base: firefoxRoot, localState: false })
  return list
}

export function detectLocalBrowsers() {
  return localBrowserCandidates().map(browser => ({ ...browser, profiles: [] }))
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (_) {
    return false
  }
}

async function collectChromiumProfiles(base) {
  const out = []
  let entries = []
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name) && entry.name !== 'Guest Profile') continue
    const dir = join(base, entry.name)
    for (const candidate of [join(dir, 'Network', 'Cookies'), join(dir, 'Cookies')]) {
      if (await exists(candidate)) {
        out.push({ name: entry.name, dir, cookieDb: candidate })
        break
      }
    }
  }
  return out
}

async function collectFirefoxProfiles(base) {
  const out = []
  let entries = []
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const cookieDb = join(base, entry.name, 'cookies.sqlite')
    if (await exists(cookieDb)) out.push({ name: entry.name, dir: join(base, entry.name), cookieDb })
  }
  return out
}

/** 当前平台的浏览器安装情况（只做目录探测，不读 Cookie 内容）。 */
export async function listLocalBrowserProfiles() {
  const browsers = []
  for (const browser of localBrowserCandidates()) {
    let profiles = []
    if (browser.engine === 'firefox') profiles = await collectFirefoxProfiles(browser.base)
    else profiles = await collectChromiumProfiles(browser.base)
    browsers.push({
      id: browser.id,
      label: browser.label,
      engine: browser.engine,
      base: browser.base,
      available: profiles.length > 0,
      profiles: profiles.map(profile => ({ name: profile.name, cookieDb: profile.cookieDb })),
    })
  }
  return browsers
}

const dpapiKeyCache = new Map()

function dpapiScript() {
  return [
    'Add-Type -AssemblyName System.Security',
    '$raw = [Console]::In.ReadToEnd().Trim()',
    'if (-not $raw) { exit 2 }',
    '$bytes = [Convert]::FromBase64String($raw)',
    '$out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($out)',
  ].join('\n')
}

/** 用 Windows DPAPI 解出 Chromium 的 os_crypt.encrypted_key（base64 输入 / 输出） */
export function unprotectDpapi(base64Value, { timeoutMs = 20000 } = {}) {
  const encoded = Buffer.from(dpapiScript(), 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => finish(new Error('DPAPI 解密超时')), timeoutMs)
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      if (error) reject(error)
      else resolve(stdout.trim())
    }
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', error => finish(error))
    child.on('exit', code => {
      if (code === 0 && stdout.trim()) finish()
      else finish(new Error(`DPAPI 解密失败（exit=${code}）${stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ''}`))
    })
    try {
      child.stdin.end(String(base64Value || ''))
    } catch (err) {
      finish(err)
    }
  })
}

async function chromiumAesKey(localStatePath) {
  if (dpapiKeyCache.has(localStatePath)) return dpapiKeyCache.get(localStatePath)
  let key = null
  try {
    const raw = JSON.parse(await readFile(localStatePath, 'utf8'))
    const encoded = String(raw?.os_crypt?.encrypted_key || '')
    if (encoded) {
      const blob = Buffer.from(encoded, 'base64')
      const body = blob.subarray(0, 5).toString('latin1') === 'DPAPI' ? blob.subarray(5) : blob
      const plain = Buffer.from(await unprotectDpapi(body.toString('base64')), 'base64')
      if (plain.length === 32) key = plain
    }
  } catch (_) {
    key = null
  }
  // 只缓存成功解出的密钥：DPAPI 临时失败（如安全软件拦截）时下次导入仍会重试。
  if (key) dpapiKeyCache.set(localStatePath, key)
  return key
}

/** 解开单条 Chromium encrypted_value；纯函数，便于单测。 */
export function decryptChromiumValue(buffer, key) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  if (!buf.length) return { value: '', error: '' }
  const prefix = buf.subarray(0, 3).toString('latin1')
  if (prefix === 'v20') return { value: '', error: 'app-bound-v20' }
  if (prefix === 'v10' || prefix === 'v11') {
    if (!key || key.length !== 32) return { value: '', error: 'missing-dpapi-key' }
    try {
      const iv = buf.subarray(3, 15)
      const tag = buf.subarray(buf.length - 16)
      const data = buf.subarray(15, buf.length - 16)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return { value: Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'), error: '' }
    } catch (_) {
      return { value: '', error: 'decrypt-failed' }
    }
  }
  return { value: '', error: 'legacy-dpapi' }
}

async function copySqliteDatabase(source, destDir) {
  const name = `${basename(source)}-${randomToken(8)}`
  const dest = join(destDir, name)
  await copyFile(source, dest)
  for (const suffix of ['-wal', '-shm']) {
    try {
      await copyFile(`${source}${suffix}`, `${dest}${suffix}`)
    } catch (_) {
      /* WAL 不一定存在 */
    }
  }
  return dest
}

async function querySqliteRows(file, sql) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (err) {
    const error = new Error('当前 Node 运行时不支持 node:sqlite（需要 Node 22+），无法读取本机浏览器 Cookie 数据库。')
    error.code = 'SQLITE_UNAVAILABLE'
    throw error
  }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const statement = db.prepare(sql)
    // Chromium 的 expires_utc 是 1601 年以来的微秒数，超出 JS safe integer；
    // node:sqlite 默认按 number 读取会直接报 ERR_OUT_OF_RANGE，这里统一按 BigInt 读，
    // 调用方用 Number() 转换（时间精度损失 1~2 微秒，不影响 Cookie 过期判断）。
    if (typeof statement.setReadBigInts === 'function') statement.setReadBigInts(true)
    return statement.all()
  } finally {
    try {
      db.close()
    } catch (_) {
      /* ignore */
    }
  }
}

function chromiumExpiryToMs(expiresUtc) {
  const value = Number(expiresUtc) || 0
  if (value <= 0) return 0
  return Math.max(0, Math.round(value / 1000 - 11_644_473_600_000))
}

function chromiumSameSite(value) {
  const n = Number(value)
  if (n === 1) return 'lax'
  if (n === 2) return 'strict'
  if (n === 0) return 'none'
  return ''
}

/**
 * 从本机浏览器导入 Cookie。
 * @returns {Promise<{cookies:object[], summary:object}>}
 */
export async function importLocalBrowserCookies(browserId, { domain = '', profileName = '', maxCookies = 3000 } = {}) {
  const descriptors = await listLocalBrowserProfiles()
  const descriptor = descriptors.find(item => item.id === String(browserId || '').toLowerCase()) || null
  const errors = []
  const cookies = []
  let skippedAppBound = 0
  let profilesRead = 0

  if (!descriptor || !descriptor.available) {
    const error = new Error(`没有找到可用的 ${browserId || '浏览器'} 配置文件。`)
    error.code = 'NO_BROWSER'
    throw error
  }

  const tempDir = join(tmpdir(), `nianfeng-cookie-${randomToken(8)}`)
  await mkdir(tempDir, { recursive: true })

  const wanted = stripDomainDot(domain)
  const accept = cookie => (!wanted || domainMatches(cookie.domain, wanted) || domainMatches(wanted, cookie.domain))
  const push = cookie => {
    if (cookies.length >= maxCookies) return
    if (accept(cookie)) cookies.push(cookie)
  }

  try {
    for (const profile of descriptor.profiles) {
      if (profileName && profile.name !== profileName) continue
      try {
        let copied
        try {
          copied = await copySqliteDatabase(profile.cookieDb, tempDir)
        } catch (err) {
          const code = err.code === 'EBUSY' || err.code === 'EPERM' ? 'BROWSER_RUNNING' : 'COPY_FAILED'
          errors.push({
            profile: profile.name,
            code,
            error:
              code === 'BROWSER_RUNNING'
                ? `${descriptor.label} 正在运行，Cookie 数据库被独占锁定。请先完全退出浏览器（包括后台进程）后重试。`
                : `读取 Cookie 数据库失败：${err.message}`,
          })
          continue
        }

        if (descriptor.engine === 'firefox') {
          const rows = await querySqliteRows(
            copied,
            'SELECT host, name, value, path, expiry, isSecure, isHttpOnly FROM moz_cookies',
          )
          for (const row of rows) push(normalizeCookie({ domain: row.host, name: row.name, value: row.value, path: row.path, expires: toExpires(row.expiry), secure: !!row.isSecure, httpOnly: !!row.isHttpOnly, source: 'firefox' }))
          profilesRead += 1
          continue
        }

        const localStatePath = join(descriptor.base, 'Local State')
        const key = await chromiumAesKey(localStatePath).catch(() => null)
        const rows = await querySqliteRows(
          copied,
          'SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies',
        )
        for (const row of rows) {
          let value = String(row.value || '')
          if (!value && row.encrypted_value) {
            const buffer = Buffer.isBuffer(row.encrypted_value) ? row.encrypted_value : Buffer.from(row.encrypted_value)
            const decrypted = decryptChromiumValue(buffer, key)
            if (decrypted.value) value = decrypted.value
            else if (decrypted.error === 'app-bound-v20') {
              skippedAppBound += 1
              continue
            } else if (decrypted.error === 'legacy-dpapi') {
              try {
                value = Buffer.from(await unprotectDpapi(buffer.toString('base64')), 'base64').toString('utf8')
              } catch (_) {
                continue
              }
            } else {
              continue
            }
          }
          if (!value) continue
          push(
            normalizeCookie({
              domain: row.host_key,
              name: row.name,
              value,
              path: row.path,
              expires: chromiumExpiryToMs(row.expires_utc),
              secure: !!row.is_secure,
              httpOnly: !!row.is_httponly,
              sameSite: chromiumSameSite(row.samesite),
              source: descriptor.id,
            }),
          )
        }
        profilesRead += 1
      } catch (err) {
        errors.push({
          profile: profile.name,
          code: err.code || 'IMPORT_FAILED',
          error: err.message,
          ...(process.env.NIANFENG_DEBUG_WEB_ACCESS ? { stack: String(err.stack || '').split('\n').slice(0, 6).join('\n') } : {}),
        })
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  return {
    cookies,
    summary: {
      browser: descriptor.label,
      profilesRead,
      imported: cookies.length,
      skippedAppBound,
      errors,
      note:
        skippedAppBound > 0
          ? `有 ${skippedAppBound} 条 Cookie 使用 Chrome/Edge 127+ 的 App-Bound 加密（v20），需要 SYSTEM 权限才能解密，已跳过。可改用「打开登录窗口」让用户在本插件浏览器里登录一次，或在页面手动粘贴 Cookie。`
          : '',
    },
  }
}

/** 供 bridge / 前端状态页展示：浏览器安装与配置目录概览 */
export async function localBrowserOverview() {
  const list = await listLocalBrowserProfiles()
  return list.map(item => ({
    id: item.id,
    label: item.label,
    engine: item.engine,
    available: item.available,
    profiles: item.profiles.length,
  }))
}
