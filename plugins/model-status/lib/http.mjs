/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 模型状态订阅 · 受控出网通道。
 *
 *   - 没有配置代理时，使用 net-guard 的 DNS 固定请求（SSRF 防护 + 手动重定向）；
 *   - 配置了代理时，通过 HTTP(S) 代理访问目标；状态页基本都是 HTTPS，
 *     因此 HTTPS 目标走 CONNECT 隧道；
 *   - 每一跳重定向都会重新校验目标地址，避免内网 / DNS rebinding 绕过。
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { Buffer } from 'node:buffer'
import { isIP } from 'node:net'
import { isPrivateAddress, resolvePublicHttpUrl, requestPinned } from './net-guard.mjs'

export const DEFAULT_UA = 'NianFeng-ModelStatus/2.0 (+https://github.com/nianfeng233/NianFeng-Chat)'

function assertProxyTargetAllowed(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch (_) {
    throw new Error('目标 URL 不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`不支持的目标协议：${url.protocol}`)
  if (url.username || url.password) throw new Error('URL 不允许携带用户名 / 密码')
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) throw new Error('目标主机名为空')
  if (isIP(host) && isPrivateAddress(host)) throw new Error('禁止访问内网 / 本机地址')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    ['metadata', 'metadata.google.internal', 'instance-data'].includes(host) ||
    ['.local', '.internal', '.home.arpa', '.lan', '.intranet', '.test', '.invalid'].some(suffix => host.endsWith(suffix))
  ) {
    throw new Error('禁止访问本机 / 内网地址')
  }
}

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

export function decodeText(buffer, contentType = '') {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''))?.[1] || ''
  const label = String(charset || 'utf-8').trim().toLowerCase()
  try {
    return new TextDecoder(label === 'gb2312' || label === 'gb18030' ? 'gbk' : label).decode(buf)
  } catch (_) {
    return buf.toString('utf8')
  }
}

async function readResponseStream(response, maxBytes) {
  const limit = Math.max(1024, Number(maxBytes) || 2 * 1024 * 1024)
  const chunks = []
  let size = 0
  let truncated = false
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (size + buffer.length >= limit) {
      chunks.push(buffer.subarray(0, Math.max(0, limit - size)))
      size = limit
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

async function requestOncePinned(rawUrl, { method = 'GET', headers = {}, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const { url, addresses } = await resolvePublicHttpUrl(rawUrl)
  const response = await requestPinned(url, { addresses, method, headers, timeoutMs })
  const { buffer, truncated } = await readResponseStream(response, maxBytes)
  return {
    status: Number(response.statusCode) || 0,
    headers: headersToObject(response.headers),
    buffer,
    truncated,
    url: url.href,
  }
}

/** 通过 HTTP(S) 代理发一次请求；HTTPS 目标使用 CONNECT 隧道。 */
function proxiedRequest(rawUrl, { method = 'GET', headers = {}, proxy = '', timeoutMs = 20000, maxBytes = 2 * 1024 * 1024 } = {}) {
  let target
  let proxyUrl
  try {
    target = new URL(String(rawUrl))
  } catch (_) {
    return Promise.reject(new Error('目标 URL 不合法'))
  }
  try {
    proxyUrl = new URL(String(proxy))
  } catch (_) {
    return Promise.reject(new Error(`代理地址不合法：${proxy}`))
  }
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    return Promise.reject(new Error(`不支持的代理协议：${proxyUrl.protocol}`))
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return Promise.reject(new Error(`不支持的目标协议：${target.protocol}`))
  }

  const proxyLib = proxyUrl.protocol === 'https:' ? https : http
  const proxyPort = proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80)
  const auth = proxyUrl.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || '')}`).toString('base64')}`
    : ''
  const proxyHeaders = auth ? { 'Proxy-Authorization': auth } : {}

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      reject(error)
    }

    // HTTP 目标：直接让代理转发绝对地址。
    if (target.protocol === 'http:') {
      const request = proxyLib.request(
        {
          hostname: proxyUrl.hostname,
          port: proxyPort,
          method,
          path: target.href,
          headers: { ...headers, Host: target.host, ...proxyHeaders },
          timeout: timeoutMs,
        },
        async response => {
          try {
            const { buffer, truncated } = await readResponseStream(response, maxBytes)
            settled = true
            resolve({
              status: Number(response.statusCode) || 0,
              headers: headersToObject(response.headers),
              buffer,
              truncated,
              url: target.href,
            })
          } catch (error) {
            fail(error)
          }
        },
      )
      request.on('timeout', () => request.destroy(new Error('代理请求超时')))
      request.on('error', error => fail(new Error(`代理请求失败：${error.message}`)))
      request.end()
      return
    }

    // HTTPS 目标：先 CONNECT，再在隧道上建立 TLS。
    const connectRequest = proxyLib.request({
      hostname: proxyUrl.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}`, ...proxyHeaders },
      timeout: timeoutMs,
    })
    connectRequest.on('timeout', () => {
      connectRequest.destroy()
      fail(new Error('代理连接超时'))
    })
    connectRequest.on('error', error => fail(new Error(`代理连接失败：${error.message}`)))
    connectRequest.on('connect', (connectRes, socket) => {
      if (Number(connectRes.statusCode) !== 200) {
        try {
          socket.destroy()
        } catch (_) {
          /* ignore */
        }
        fail(new Error(`代理拒绝 CONNECT：HTTP ${connectRes.statusCode}`))
        return
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname })
      tlsSocket.once('error', error => fail(new Error(`TLS 连接失败：${error.message}`)))
      tlsSocket.once('secureConnect', () => {
        const request = https.request(
          {
            hostname: target.hostname,
            port: target.port || 443,
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
                status: Number(response.statusCode) || 0,
                headers: headersToObject(response.headers),
                buffer,
                truncated,
                url: target.href,
              })
            } catch (error) {
              fail(error)
            }
          },
        )
        request.on('error', error => fail(new Error(`代理请求失败：${error.message}`)))
        request.end()
      })
    })
    connectRequest.end()
  })
}

/**
 * 拉取远程文本。
 * @param {string} rawUrl
 * @param {{headers?:object, proxy?:string, timeoutMs?:number, maxBytes?:number, maxRedirects?:number}} options
 */
export async function fetchText(rawUrl, options = {}) {
  const {
    headers = {},
    proxy = '',
    timeoutMs = 20000,
    maxBytes = 2 * 1024 * 1024,
    maxRedirects = 5,
  } = options
  const redirectLimit = Math.min(Math.max(Number(maxRedirects) || 0, 0), 8)
  let current = String(rawUrl || '')
  let lastError = null

  for (let hop = 0; hop <= redirectLimit; hop += 1) {
    let result
    try {
      if (proxy) {
        // 代理模式下不再做本地 DNS 解析：目标域名可能只在代理侧可达。
        // 仍保留协议 / 主机名 / 私网字面量检查，避免误访问本机服务。
        assertProxyTargetAllowed(current)
        result = await proxiedRequest(current, { method: 'GET', headers, proxy, timeoutMs, maxBytes })
      } else {
        result = await requestOncePinned(current, { method: 'GET', headers, timeoutMs, maxBytes })
      }
    } catch (error) {
      lastError = error
      throw Object.assign(new Error(`请求失败：${error?.message || error}`), { cause: error })
    }

    const status = Number(result.status) || 0
    const location = result.headers?.location
    if (status >= 300 && status < 400 && location) {
      if (hop === redirectLimit) break
      current = new URL(String(location), result.url || current).href
      continue
    }

    const contentType = String(result.headers?.['content-type'] || '')
    return {
      ok: status >= 200 && status < 300,
      status,
      url: result.url || current,
      headers: result.headers || {},
      contentType,
      buffer: result.buffer,
      truncated: !!result.truncated,
      text: decodeText(result.buffer, contentType),
    }
  }

  const error = new Error(lastError ? `重定向失败：${lastError.message}` : '重定向次数过多')
  error.code = 'TOO_MANY_REDIRECTS'
  throw error
}

export async function fetchJson(rawUrl, options = {}) {
  const response = await fetchText(rawUrl, {
    ...options,
    headers: { Accept: 'application/json, text/plain, */*', ...(options.headers || {}) },
  })
  let data = null
  try {
    data = JSON.parse(response.text)
  } catch (_) {
    data = null
  }
  return { ...response, data }
}
