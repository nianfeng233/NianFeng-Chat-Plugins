/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * web-access · 受控 HTTP 通道 + HTML 解析（自包含扩展版本）。
 *
 *  - safeFetch：使用同目录 net-guard.mjs 的 SSRF 防护（默认拒绝本机 / 内网 / 云元数据），
 *    手动跟随重定向、逐跳写 Cookie 库；allowPrivate=true 时才放开（用户在设置页显式开启）。
 *  - requestText：固定外部 API（如 Tavily）使用；可选 http(s) 代理隧道。
 *  - HTML 工具：标题 / meta / 正文 / 链接 / JSON-LD / 表单控件，全部零依赖。
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { Buffer } from 'node:buffer'
import { requestPinned, resolvePublicHttpUrl } from './net-guard.mjs'
import { decodeHtmlEntities, firstString, normalizeWhitespace, stripHtml, toAbsoluteUrl, truncateText, uniqueBy } from './util.mjs'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

function headersToObject(headers) {
  const out = {}
  if (!headers) return out
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = value
    })
    return out
  }
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value
  return out
}

function getSetCookie(headers) {
  if (!headers) return []
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const raw = headers['set-cookie'] || headers['Set-Cookie']
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

/** 按 content-type / meta charset 解码字节 */
export function decodeText(buffer, contentType = '', { html = false } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''))?.[1] || ''
  if (!charset && html) {
    const head = buf.subarray(0, 8192).toString('latin1')
    charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] || ''
  }
  const label = String(charset || 'utf-8').trim().toLowerCase()
  try {
    return new TextDecoder(label === 'gb2312' ? 'gbk' : label).decode(buf)
  } catch (_) {
    return buf.toString('utf8')
  }
}

/* ------------------------------------------------------------------ */
/* 单次请求                                                            */
/* ------------------------------------------------------------------ */

async function readResponseStream(response, maxBytes) {
  const chunks = []
  let size = 0
  let truncated = false
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (size + buffer.length >= maxBytes) {
      chunks.push(buffer.subarray(0, Math.max(0, maxBytes - size)))
      size = maxBytes
      truncated = true
      try {
        response.destroy()
      } catch (_) {
        /* ignore */
      }
      break
    }
    chunks.push(buffer)
    size += buffer.length
  }
  return { buffer: Buffer.concat(chunks), truncated }
}

async function requestOncePinned(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const { url: parsed, addresses } = await resolvePublicHttpUrl(url)
  const response = await requestPinned(parsed, { addresses, method, headers, timeoutMs })
  const { buffer, truncated } = await readResponseStream(response, maxBytes)
  return {
    status: Number(response.statusCode) || 0,
    headers: headersToObject(response.headers),
    setCookie: getSetCookie(response.headers),
    buffer,
    truncated,
    url: parsed.href,
  }
}

async function requestOnceDirect(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
      cache: 'no-store',
    })
    const arrayBuffer = await response.arrayBuffer()
    let buffer = Buffer.from(arrayBuffer)
    let truncated = false
    if (buffer.length > maxBytes) {
      buffer = buffer.subarray(0, maxBytes)
      truncated = true
    }
    return {
      status: response.status,
      headers: headersToObject(response.headers),
      setCookie: getSetCookie(response.headers),
      buffer,
      truncated,
      url: response.url || url,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 通过 http(s) 代理发一次请求（HTTPS 目标走 CONNECT 隧道）。 */
function proxiedRequest(url, { method = 'GET', headers = {}, body, proxy = '', timeoutMs = 20000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const target = new URL(String(url))
  if (target.protocol !== 'https:') return Promise.reject(new Error('代理模式目前只支持 https 目标'))
  let proxyUrl
  try {
    proxyUrl = new URL(String(proxy))
  } catch (_) {
    return Promise.reject(new Error(`代理地址不合法：${proxy}`))
  }
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') return Promise.reject(new Error(`不支持的代理协议：${proxyUrl.protocol}`))
  const lib = proxyUrl.protocol === 'https:' ? https : http
  const port = proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80)
  const auth = proxyUrl.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`
    : ''

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      reject(error)
    }
    const connectReq = lib.request({
      host: proxyUrl.hostname,
      port,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: { Host: target.hostname, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
      timeout: timeoutMs,
    })
    connectReq.on('timeout', () => {
      connectReq.destroy()
      fail(new Error('代理连接超时'))
    })
    connectReq.on('error', error => fail(new Error(`代理连接失败：${error.message}`)))
    connectReq.on('connect', (connectRes, socket, head) => {
      if (connectRes.statusCode !== 200) {
        socket.destroy()
        return fail(new Error(`代理拒绝 CONNECT：HTTP ${connectRes.statusCode}`))
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname })
      tlsSocket.once('error', error => fail(new Error(`TLS 连接失败：${error.message}`)))
      tlsSocket.once('secureConnect', () => {
        const req = https.request(
          {
            host: target.hostname,
            port: 443,
            path: `${target.pathname}${target.search}`,
            method,
            headers,
            socket: tlsSocket,
            servername: target.hostname,
            agent: false,
          },
          async response => {
            try {
              const { buffer, truncated } = await readResponseStream(response, maxBytes)
              settled = true
              resolve({
                status: response.statusCode || 0,
                headers: headersToObject(response.headers),
                setCookie: getSetCookie(response.headers),
                buffer,
                truncated,
                url: target.href,
              })
            } catch (error) {
              fail(error)
            }
          },
        )
        req.on('error', error => fail(new Error(`代理请求失败：${error.message}`)))
        if (body !== undefined && body !== null) req.write(body)
        req.end()
      })
    })
    connectReq.end()
  })
}

/** 通用单次请求（Tavily / 固定外部 API）；无 SSRF 校验，不要用于模型给的任意 URL。 */
export async function requestText(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024, proxy = '' } = {}) {
  const result = proxy
    ? await proxiedRequest(url, { method, headers, body, timeoutMs, maxBytes, proxy })
    : await requestOnceDirect(url, { method, headers, body, timeoutMs, maxBytes })
  const contentType = String(result.headers['content-type'] || '')
  const text = decodeText(result.buffer, contentType, { html: /text\/html/i.test(contentType) })
  return { ...result, text }
}

/* ------------------------------------------------------------------ */
/* safeFetch：浏览工具 / B站 API / 通用网页                               */
/* ------------------------------------------------------------------ */

/**
 * @param {string} rawUrl
 * @param {{method?:string, headers?:object, body?:any, jar?:import('./cookies.mjs').CookieJar, timeoutMs?:number,
 *          maxBytes?:number, maxRedirects?:number, allowPrivate?:boolean, cookieSource?:string}} options
 */
export async function safeFetch(rawUrl, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    jar = null,
    timeoutMs = 20000,
    maxBytes = 2 * 1024 * 1024,
    maxRedirects = 5,
    allowPrivate = false,
    cookieSource = 'http',
  } = options

  let currentUrl = String(rawUrl || '')
  let currentMethod = String(method || 'GET').toUpperCase()
  let currentBody = body
  let redirects = Math.min(Math.max(Number(maxRedirects) || 0, 0), 8)

  for (let hop = 0; hop <= redirects; hop += 1) {
    const hopHeaders = { ...headers }
    if (!Object.keys(hopHeaders).some(key => key.toLowerCase() === 'user-agent')) hopHeaders['User-Agent'] = DEFAULT_UA
    if (jar && !Object.keys(hopHeaders).some(key => key.toLowerCase() === 'cookie')) {
      const cookie = jar.headerForUrl(currentUrl)
      if (cookie) hopHeaders.Cookie = cookie
    }

    let response
    try {
      response = allowPrivate
        ? await requestOnceDirect(currentUrl, { method: currentMethod, headers: hopHeaders, body: currentBody, timeoutMs, maxBytes })
        : await requestOncePinned(currentUrl, { method: currentMethod, headers: hopHeaders, body: currentBody, timeoutMs, maxBytes })
    } catch (error) {
      if (error?.status) throw error
      const wrapped = new Error(`请求失败：${error?.message || error}`)
      wrapped.code = 'REQUEST_FAILED'
      throw wrapped
    }

    if (jar && response.setCookie?.length) jar.applySetCookie(currentUrl, response.setCookie, { source: cookieSource })

    const status = Number(response.status) || 0
    const location = response.headers.location
    if (status >= 300 && status < 400 && location && hop < redirects) {
      currentUrl = toAbsoluteUrl(String(location), currentUrl) || currentUrl
      if (status === 303 || ((status === 301 || status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET'
        currentBody = undefined
      }
      redirects -= 1
      continue
    }

    const contentType = String(response.headers['content-type'] || '')
    const text = decodeText(response.buffer, contentType, { html: /text\/html/i.test(contentType) })
    return {
      ok: status >= 200 && status < 300,
      status,
      url: response.url || currentUrl,
      headers: response.headers,
      setCookie: response.setCookie,
      text,
      buffer: response.buffer,
      truncated: !!response.truncated,
      contentType,
    }
  }
  const error = new Error('重定向次数过多')
  error.code = 'TOO_MANY_REDIRECTS'
  throw error
}

export async function fetchJson(url, options = {}) {
  const response = await safeFetch(url, options)
  let data = null
  try {
    data = JSON.parse(response.text)
  } catch (_) {
    data = null
  }
  return { ...response, data }
}

/* ------------------------------------------------------------------ */
/* HTML 解析                                                           */
/* ------------------------------------------------------------------ */

function removeBlock(html, tag) {
  return String(html).replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
}

export function htmlToReadableText(html) {
  let source = String(html || '')
  source = source.replace(/<!--[\s\S]*?-->/g, ' ')
  for (const tag of ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas']) source = removeBlock(source, tag)

  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(source)
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(source)
  if (article?.[1]) source = article[1]
  else if (main?.[1]) source = main[1]
  else {
    const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(source)
    if (body?.[1]) source = body[1]
  }

  for (const tag of ['nav', 'footer', 'aside', 'form', 'header']) source = removeBlock(source, tag)
  source = source.replace(/<(br|hr)\s*\/?>/gi, '\n')
  source = source.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
  source = source.replace(/<li\b[^>]*>/gi, '\n· ')
  source = source.replace(/<[^>]+>/g, ' ')
  const text = decodeHtmlEntities(source)
  return normalizeWhitespace(text, { keepNewlines: true })
}

function matchMeta(html, names) {
  for (const name of names) {
    const pattern = new RegExp(
      `<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>|<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["'][^>]*>`,
      'i',
    )
    const match = pattern.exec(html)
    if (match) return decodeHtmlEntities(match[1] || match[2] || '')
  }
  return ''
}

export function extractLinks(html, baseUrl, { limit = 100 } = {}) {
  const out = []
  const pattern = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = pattern.exec(String(html || '')))) {
    const href = toAbsoluteUrl(match[1] || match[2] || match[3] || '', baseUrl)
    if (!href) continue
    const text = normalizeWhitespace(stripHtml(match[4] || '')).slice(0, 120)
    out.push({ url: href, text })
    if (out.length >= limit * 3) break
  }
  return uniqueBy(out, item => item.url).slice(0, limit)
}

export function extractInteractive(html, baseUrl, { limit = 40 } = {}) {
  const out = []
  const pattern = /<(input|textarea|select|button)\b([^>]*)>/gi
  let match
  while ((match = pattern.exec(String(html || '')))) {
    const tag = match[1].toLowerCase()
    const attrs = match[2] || ''
    const attr = name => {
      const result = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
      return result ? decodeHtmlEntities(result[1] ?? result[2] ?? result[3] ?? '') : ''
    }
    const type = attr('type') || (tag === 'button' ? 'submit' : tag === 'textarea' ? 'textarea' : '')
    const item = {
      tag,
      type,
      name: attr('name'),
      placeholder: attr('placeholder'),
      label: attr('aria-label') || attr('title'),
      text: tag === 'button' ? normalizeWhitespace(stripHtml(match[0])) : '',
    }
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

export function extractJsonLd(html, { limit = 6 } = {}) {
  const out = []
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = pattern.exec(String(html || '')))) {
    try {
      out.push(JSON.parse(match[1].trim()))
    } catch (_) {
      /* 单个 JSON-LD 解析失败不影响其它 */
    }
    if (out.length >= limit) break
  }
  return out
}

/** 通用 HTML 提取：标题 / 描述 / 正文 / 链接 / 结构化数据。 */
export function extractHtml(html, baseUrl, { textLimit = 12000, linkLimit = 40, interactiveLimit = 0 } = {}) {
  const source = String(html || '')
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || ''
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source)?.[1] || ''
  const title = firstString(matchMeta(source, ['og:title', 'twitter:title']), stripHtml(titleTag), stripHtml(h1))
  const description = firstString(matchMeta(source, ['description', 'og:description', 'twitter:description']))
  const canonical = firstString(
    /<link[^>]+rel\s*=\s*["']canonical["'][^>]+href\s*=\s*["']([^"']+)["']/i.exec(source)?.[1],
    matchMeta(source, ['og:url']),
  )
  const fullText = htmlToReadableText(source)
  return {
    title,
    description: description.slice(0, 600),
    canonical: canonical ? toAbsoluteUrl(canonical, baseUrl) : '',
    text: truncateText(fullText, textLimit),
    textLength: fullText.length,
    truncated: fullText.length > textLimit,
    links: extractLinks(source, baseUrl, { limit: linkLimit }),
    interactive: interactiveLimit ? extractInteractive(source, baseUrl, { limit: interactiveLimit }) : [],
    jsonLd: extractJsonLd(source),
    lang: /<html[^>]+lang\s*=\s*["']([^"']+)["']/i.exec(source)?.[1] || '',
  }
}

export { DEFAULT_UA }
