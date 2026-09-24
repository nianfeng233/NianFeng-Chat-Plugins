/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * agnes-media · 独立 HTTP 通道。
 *
 * 需求里最核心的两条：
 *   1. 插件可以配置自己的 http(s) 代理，不依赖本体 network.proxy；
 *   2. 参考图可以从公网 URL 拉取后转成 Data URI 再喂给 Agnes，避免
 *      Agnes 服务端访问不到带防盗链 / 需要 Cookie 的图片源。
 *
 * 实现上保持零第三方依赖：
 *   - 直连：http / https.request；
 *   - http(s) 代理：https 目标走 CONNECT 隧道，http 目标走 absolute-form；
 *   - 公网参考图先经过 net-guard 校验，默认拒绝 localhost / 内网 / 云元数据。
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolvePublicHttpUrl } from './net-guard.mjs'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

function headerValue(headers, name) {
  const key = String(name || '').toLowerCase()
  for (const [header, value] of Object.entries(headers || {})) {
    if (String(header).toLowerCase() === key) return value
  }
  return ''
}

function headersToObject(headers) {
  const out = {}
  if (!headers) return out
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value
  return out
}

function proxyAuthorization(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return ''
  const raw = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
  return `Basic ${Buffer.from(raw).toString('base64')}`
}

function normalizeProxy(proxy) {
  const raw = String(proxy || '').trim()
  if (!raw) return null
  let parsed
  try {
    parsed = new URL(raw)
  } catch (_) {
    throw Object.assign(new Error(`代理地址不合法：${raw}`), { code: 'PROXY_INVALID' })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error(`不支持的代理协议：${parsed.protocol}`), { code: 'PROXY_PROTOCOL' })
  }
  return parsed
}

function networkError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return new Error('请求已取消')
  return error instanceof Error ? error : new Error(String(error))
}

async function readStream(stream, maxBytes = 4 * 1024 * 1024) {
  const limit = Math.max(1024, Number(maxBytes) || 4 * 1024 * 1024)
  const chunks = []
  let size = 0
  let truncated = false
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (size + buffer.length >= limit) {
      chunks.push(buffer.subarray(0, Math.max(0, limit - size)))
      size = limit
      truncated = true
      try {
        stream.destroy()
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

/**
 * 发起一次不自动跟随重定向的请求，返回 Node IncomingMessage。
 * 返回的 stream 必须由调用方消费或 destroy。
 */
function requestOnce(input, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30000,
    proxy = '',
    trusted = false,
    allowPrivate = false,
    addresses = null,
  } = options
  const target = input instanceof URL ? input : new URL(String(input))
  const headersOut = { ...headers }
  if (body !== undefined && body !== null && !Object.keys(headersOut).some(key => key.toLowerCase() === 'content-length')) {
    headersOut['Content-Length'] = Buffer.byteLength(body)
  }
  const proxyUrl = normalizeProxy(proxy)
  const hostHeader = headerValue(headersOut, 'host') || target.host

  if (proxyUrl) {
    const proxyLib = proxyUrl.protocol === 'https:' ? https : http
    const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80)
    const proxyAuth = proxyAuthorization(proxyUrl)

    if (target.protocol === 'https:') {
      return new Promise((resolve, reject) => {
        let settled = false
        const fail = error => {
          if (settled) return
          settled = true
          reject(networkError(error))
        }
        const connectReq = proxyLib.request({
          host: proxyUrl.hostname,
          port: proxyPort,
          method: 'CONNECT',
          path: `${target.hostname}:${target.port || 443}`,
          headers: { Host: `${target.hostname}:${target.port || 443}`, ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {}) },
          timeout: timeoutMs,
          ...(proxyUrl.protocol === 'https:' ? { servername: proxyUrl.hostname } : {}),
        })
        connectReq.on('timeout', () => {
          connectReq.destroy(new Error('代理连接超时'))
        })
        connectReq.on('error', error => fail(new Error(`代理连接失败：${error.message}`)))
        connectReq.on('connect', (connectRes, socket, head) => {
          if (connectRes.statusCode !== 200) {
            socket.destroy()
            return fail(new Error(`代理拒绝 CONNECT：HTTP ${connectRes.statusCode}`))
          }
          if (head?.length) socket.unshift(head)
          const tlsSocket = tls.connect({ socket, servername: target.hostname })
          tlsSocket.once('error', error => fail(new Error(`TLS 连接失败：${error.message}`)))
          tlsSocket.once('secureConnect', () => {
            const tunnelHeaders = { ...headersOut, Host: hostHeader }
            const req = https.request(
              {
                host: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method,
                headers: tunnelHeaders,
                createConnection: () => tlsSocket,
                agent: false,
                timeout: timeoutMs,
              },
              response => {
                settled = true
                resolve(response)
              },
            )
            req.on('timeout', () => req.destroy(new Error('请求超时')))
            req.on('error', error => fail(new Error(`代理请求失败：${error.message}`)))
            if (body !== undefined && body !== null) req.write(body)
            req.end()
          })
        })
        connectReq.end()
      })
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const req = proxyLib.request(
        {
          host: proxyUrl.hostname,
          port: proxyPort,
          method,
          path: target.href,
          headers: { Host: hostHeader, ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {}), ...headersOut },
          timeout: timeoutMs,
          ...(proxyUrl.protocol === 'https:' ? { servername: proxyUrl.hostname } : {}),
        },
        response => {
          settled = true
          resolve(response)
        },
      )
      req.on('timeout', () => req.destroy(new Error('请求超时')))
      req.on('error', error => {
        if (settled) return
        settled = true
        reject(networkError(new Error(`代理请求失败：${error.message}`)))
      })
      if (body !== undefined && body !== null) req.write(body)
      req.end()
    })
  }

  const lib = target.protocol === 'https:' ? https : http
  const lookup =
    trusted || allowPrivate || !Array.isArray(addresses) || !addresses.length
      ? undefined
      : (hostname, lookupOptions, callback) => {
          const wanted = String(hostname || '').toLowerCase()
          const servername = String(target.hostname || '').toLowerCase()
          if (wanted !== servername) {
            return callback(Object.assign(new Error(`DNS 校验失败：${hostname}`), { code: 'ENOTFOUND' }))
          }
          const family = typeof lookupOptions === 'number' ? lookupOptions : Number(lookupOptions?.family) || 0
          const list = family ? addresses.filter(item => Number(item.family) === family) : addresses
          if (!list.length) return callback(Object.assign(new Error('没有可用的目标地址'), { code: 'ENOTFOUND' }))
          if (typeof lookupOptions === 'object' && lookupOptions?.all) return callback(null, list)
          return callback(null, list[0].address, Number(list[0].family))
        }

  return new Promise((resolve, reject) => {
    let settled = false
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: headersOut,
        agent: false,
        timeout: timeoutMs,
        ...(lookup ? { lookup } : {}),
      },
      response => {
        settled = true
        resolve(response)
      },
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', error => {
      if (settled) return
      settled = true
      reject(networkError(error))
    })
    if (body !== undefined && body !== null) req.write(body)
    req.end()
  })
}

async function requestWithRedirects(rawUrl, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    maxRedirects = 5,
    timeoutMs = 30000,
    proxy = '',
    trusted = false,
    allowPrivate = false,
    maxBytes = 4 * 1024 * 1024,
  } = options
  let current = String(rawUrl || '').trim()
  let currentMethod = String(method || 'GET').toUpperCase()
  let currentBody = body
  let redirects = Math.min(Math.max(Number(maxRedirects) || 0, 0), 8)

  for (let hop = 0; hop <= redirects; hop += 1) {
    if (!current) throw Object.assign(new Error('缺少 URL'), { code: 'INVALID_URL' })
    let addresses = null
    let parsed = new URL(current)
    if (!trusted && !allowPrivate) {
      const resolved = await resolvePublicHttpUrl(current)
      parsed = resolved.url
      addresses = resolved.addresses
    }

    let response
    try {
      response = await requestOnce(parsed, {
        method: currentMethod,
        headers: currentMethod === 'GET' || currentMethod === 'HEAD' ? headers : headers,
        body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody,
        timeoutMs,
        proxy,
        trusted,
        allowPrivate,
        addresses,
      })
    } catch (error) {
      throw Object.assign(new Error(`请求失败：${error?.message || error}`), { code: error?.code || 'REQUEST_FAILED', cause: error })
    }

    const status = Number(response.statusCode) || 0
    const location = response.headers?.location
    if (status >= 300 && status < 400 && location && hop < redirects) {
      response.resume()
      current = new URL(String(location), parsed).href
      if (status === 303 || ((status === 301 || status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET'
        currentBody = undefined
      }
      redirects -= 1
      continue
    }

    const { buffer, truncated } = await readStream(response, maxBytes)
    return {
      ok: status >= 200 && status < 300,
      status,
      url: parsed.href,
      headers: headersToObject(response.headers),
      contentType: String(response.headers?.['content-type'] || ''),
      buffer,
      truncated,
    }
  }

  throw Object.assign(new Error('重定向次数过多'), { code: 'TOO_MANY_REDIRECTS' })
}

/** 请求一个 URL，返回 { ok,status,url,headers,contentType,buffer,truncated }。 */
export function requestBuffer(rawUrl, options = {}) {
  return requestWithRedirects(rawUrl, options)
}

/** 请求 JSON；非 2xx 时会尽量把 Agnes / 站点返回的错误信息带出来。 */
export async function requestJson(rawUrl, options = {}) {
  const response = await requestBuffer(rawUrl, options)
  let data = null
  try {
    data = JSON.parse(response.buffer.toString('utf8'))
  } catch (_) {
    data = null
  }
  if (!response.ok) {
    const text = response.buffer.toString('utf8').replace(/\s+/g, ' ').slice(0, 600)
    const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`
    throw Object.assign(new Error(`${response.status} · ${message}`), { status: response.status, body: data || text })
  }
  return { ...response, data }
}

/**
 * 下载到本地文件。返回 { ok,status,url,headers,bytes,contentType }。
 * 失败时会尝试删除半截文件。
 */
export async function downloadToFile(rawUrl, filePath, options = {}) {
  const {
    method = 'GET',
    headers = {},
    timeoutMs = 120000,
    proxy = '',
    trusted = false,
    allowPrivate = false,
    maxBytes = 200 * 1024 * 1024,
    maxRedirects = 5,
  } = options
  let current = String(rawUrl || '').trim()
  let currentMethod = String(method || 'GET').toUpperCase()
  let redirects = Math.min(Math.max(Number(maxRedirects) || 0, 0), 8)

  for (let hop = 0; hop <= redirects; hop += 1) {
    if (!current) throw Object.assign(new Error('缺少 URL'), { code: 'INVALID_URL' })
    let addresses = null
    let parsed = new URL(current)
    if (!trusted && !allowPrivate) {
      const resolved = await resolvePublicHttpUrl(current)
      parsed = resolved.url
      addresses = resolved.addresses
    }

    let response
    try {
      response = await requestOnce(parsed, { method: currentMethod, headers, timeoutMs, proxy, trusted, allowPrivate, addresses })
    } catch (error) {
      throw Object.assign(new Error(`请求失败：${error?.message || error}`), { code: error?.code || 'REQUEST_FAILED', cause: error })
    }

    const status = Number(response.statusCode) || 0
    const location = response.headers?.location
    if (status >= 300 && status < 400 && location && hop < redirects) {
      response.resume()
      current = new URL(String(location), parsed).href
      if (status === 303 || ((status === 301 || status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET'
      }
      redirects -= 1
      continue
    }

    const limit = Math.max(1024, Number(maxBytes) || 200 * 1024 * 1024)
    let size = 0
    let truncated = false
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await new Promise((resolve, reject) => {
        const output = createWriteStream(filePath, { flags: 'w' })
        const fail = error => {
          output.destroy()
          reject(networkError(error))
        }
        response.on('error', fail)
        output.on('error', fail)
        output.on('finish', resolve)
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          if (size + buffer.length >= limit) {
            truncated = true
            size = limit
            response.destroy(new Error('文件超过大小限制'))
            try {
              output.end()
            } catch (_) {
              /* ignore */
            }
            return
          }
          size += buffer.length
          output.write(buffer)
        })
        response.on('end', () => {
          try {
            output.end()
          } catch (_) {
            /* ignore */
          }
        })
      })
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => {})
      if (error?.message === '文件超过大小限制') {
        throw Object.assign(new Error(`文件超过大小限制（>${Math.round(limit / 1024 / 1024)}MB）`), { code: 'TOO_LARGE' })
      }
      throw networkError(error)
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      url: parsed.href,
      headers: headersToObject(response.headers),
      contentType: String(response.headers?.['content-type'] || ''),
      bytes: size,
      truncated,
    }
  }

  throw Object.assign(new Error('重定向次数过多'), { code: 'TOO_MANY_REDIRECTS' })
}

/** 小工具：判断 content-type 是否为图片。 */
export function isImageContentType(contentType) {
  return /^image\//i.test(String(contentType || '').split(';')[0].trim())
}

export { DEFAULT_UA }
