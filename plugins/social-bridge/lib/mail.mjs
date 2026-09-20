/*
 * social-bridge · 邮箱适配器
 *
 * 零依赖的最小 IMAP / SMTP 客户端；QQ 邮箱使用「IMAP/SMTP 授权码」登录，
 * 与网页端同时在线互不影响（授权码不是 QQ 密码）。
 *
 * 覆盖能力：
 *   - status/test：验证 IMAP / SMTP 配置
 *   - list：列出 INBOX 最近邮件
 *   - read：读取某封邮件正文（text/plain 优先，html 降级去标签）
 *   - send：发送纯文本邮件（可带 In-Reply-To / References）
 *   - markSeen：标记已读
 *
 * 编码：按 Content-Type charset 解码 UTF-8 / GBK / GB18030 / GB2312 / Big5 等，
 * 并兼容 RFC2047 编码头、base64 / quoted-printable / 8bit 正文与 multipart 邮件。
 * 说明：IMAP 解析器只实现常规场景；复杂 MIME / 超多附件邮件会降级为可读摘要。
 */
import { createHash } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { TextDecoder } from 'node:util'
import { textOf } from './util.mjs'

const CRLF = '\r\n'

class MailError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MailError'
    this.code = code
  }
}

class LineSocket {
  constructor({ host, port, secure = true, timeoutMs = 20000 }) {
    this.host = host
    this.port = Number(port)
    this.secure = secure
    this.timeoutMs = Number(timeoutMs) || 20000
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.waiters = []
    this.closed = false
    this.lastError = ''
    this.maxBufferBytes = Math.max(256 * 1024, Number(process.env.SOCIAL_BRIDGE_MAIL_MAX_BYTES) || 8 * 1024 * 1024)
  }

  connect() {
    return new Promise((resolve, reject) => {
      const options = { host: this.host, port: this.port, servername: this.secure ? this.host : undefined }
      const socket = this.secure ? tlsConnect(options) : netConnect(options)
      this.socket = socket
      const timer = setTimeout(() => {
        try { socket.destroy() } catch (_) {}
        reject(new MailError('MAIL_TIMEOUT', `连接 ${this.host}:${this.port} 超时`))
      }, this.timeoutMs)
      const onReady = () => {
        clearTimeout(timer)
        socket.setTimeout(this.timeoutMs, () => {
            this.lastError = `读写超时（${this.timeoutMs}ms）`
            try { socket.destroy() } catch (_) { /* ignore */ }
          })
        resolve(this)
      }
      socket.once(this.secure ? 'secureConnect' : 'connect', onReady)
      socket.once('error', error => {
        clearTimeout(timer)
        this.lastError = error.message
        reject(new MailError('MAIL_CONNECT_FAILED', `${this.host}:${this.port} 连接失败：${error.message}`))
      })
      socket.on('data', chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        this.flush()
      })
      socket.on('close', () => {
        this.closed = true
        for (const waiter of this.waiters.splice(0)) {
          if (waiter.mode === 'line') waiter.resolve('')
          else waiter.resolve(Buffer.alloc(0))
        }
      })
    })
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      if (waiter.mode === 'line') {
        const index = this.buffer.indexOf(Buffer.from('\n'))
        if (index < 0) continue
        const raw = this.buffer.subarray(0, index + 1)
        this.buffer = this.buffer.subarray(index + 1)
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(raw.toString('utf8').replace(/\r?\n$/, ''))
      } else if (waiter.mode === 'bytes' && this.buffer.length >= waiter.length) {
        const raw = this.buffer.subarray(0, waiter.length)
        this.buffer = this.buffer.subarray(waiter.length)
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(raw)
      }
    }
  }

  readLine() {
    const index = this.buffer.indexOf(Buffer.from('\n'))
    if (index >= 0) {
      const raw = this.buffer.subarray(0, index + 1)
      this.buffer = this.buffer.subarray(index + 1)
      this.flush()
      return Promise.resolve(raw.toString('utf8').replace(/\r?\n$/, ''))
    }
    if (this.closed) return Promise.resolve('')
    return new Promise(resolve => this.waiters.push({ mode: 'line', resolve }))
  }

  readBytes(length) {
    const wanted = Math.max(0, Number(length) || 0)
    if (this.buffer.length >= wanted) {
      const raw = this.buffer.subarray(0, wanted)
      this.buffer = this.buffer.subarray(wanted)
      return Promise.resolve(raw)
    }
    if (this.closed) return Promise.resolve(Buffer.alloc(0))
    return new Promise(resolve => this.waiters.push({ mode: 'bytes', length: wanted, resolve }))
  }

  write(text) {
    if (!this.socket || this.closed) throw new MailError('MAIL_CLOSED', '连接已关闭')
    this.socket.write(String(text))
  }

  writeLine(text = '') {
    this.write(text + CRLF)
  }

  end() {
    try { this.socket?.end() } catch (_) { /* ignore */ }
    this.closed = true
  }
}

async function readSmtpReply(socket) {
  const lines = []
  let first = ''
  while (true) {
    const text = await socket.readLine()
    if (text === '' && socket.closed) throw new MailError('MAIL_CLOSED', 'SMTP 连接被关闭')
    lines.push(text)
    if (!first) first = text
    if (/^\d{3} /.test(text)) break
  }
  return { status: Number(first.slice(0, 3)), lines }
}

async function smtpCommand(socket, line = null, { expect = [] } = {}) {
  if (line !== null) socket.writeLine(line)
  const reply = await readSmtpReply(socket)
  if (expect.length && !expect.includes(reply.status)) {
    throw new MailError('SMTP_REJECTED', `SMTP 命令失败（${reply.status}）：${reply.lines.join(' | ')}`)
  }
  return reply
}

function encodeHeader(value) {
  const text = String(value ?? '')
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

function formatAddress(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.includes('<')) return text
  return `<${text}>`
}

export async function smtpSend(config, message = {}) {
  const socket = new LineSocket({ host: config.smtpHost, port: config.smtpPort, secure: config.secure !== false, timeoutMs: config.timeoutMs || 20000 })
  await socket.connect()
  try {
    await smtpCommand(socket, null, { expect: [220] })
    await smtpCommand(socket, 'EHLO social-bridge', { expect: [250] })
    await smtpCommand(socket, 'AUTH LOGIN', { expect: [334] })
    socket.writeLine(Buffer.from(String(config.user || ''), 'utf8').toString('base64'))
    let response = await socket.readLine()
    if (!/^334/.test(response)) throw new MailError('SMTP_AUTH', `SMTP 用户名被拒绝：${response}`)
    socket.writeLine(Buffer.from(String(config.authCode || ''), 'utf8').toString('base64'))
    response = await socket.readLine()
    if (!/^235/.test(response)) throw new MailError('SMTP_AUTH', `SMTP 授权码被拒绝：${response}`)
    const from = formatAddress(message.from || config.user)
    await smtpCommand(socket, `MAIL FROM:${from}`, { expect: [250] })
    const recipients = [...(Array.isArray(message.to) ? message.to : String(message.to || '').split(/[;,]/))]
      .map(item => String(item).trim())
      .filter(Boolean)
    if (!recipients.length) throw new MailError('SMTP_NO_RECIPIENT', '没有收件人')
    for (const recipient of recipients) await smtpCommand(socket, `RCPT TO:${formatAddress(recipient)}`, { expect: [250, 251] })
    await smtpCommand(socket, 'DATA', { expect: [354] })
    const headers = []
    headers.push(`From: ${formatAddress(from)}`)
    headers.push(`To: ${recipients.map(formatAddress).join(', ')}`)
    if (message.cc) headers.push(`Cc: ${(Array.isArray(message.cc) ? message.cc : [message.cc]).map(formatAddress).join(', ')}`)
    headers.push(`Subject: ${encodeHeader(message.subject || '(无主题)')}`)
    headers.push(`Date: ${new Date().toUTCString()}`)
    headers.push(`Message-ID: <${createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex')}@social-bridge>`)
    if (message.inReplyTo) headers.push(`In-Reply-To: ${String(message.inReplyTo)}`)
    if (message.references) headers.push(`References: ${Array.isArray(message.references) ? message.references.join(' ') : String(message.references)}`)
    headers.push('MIME-Version: 1.0')
    headers.push('Content-Type: text/plain; charset=UTF-8')
    headers.push('Content-Transfer-Encoding: base64')
    const messageId = headers.find(line => line.startsWith('Message-ID:'))?.slice('Message-ID:'.length).trim() || ''
    const body = Buffer.from(textOf(message.text || message.content || ''), 'utf8').toString('base64')
    const payload = [...headers, '', body.match(/.{1,76}/g)?.join(CRLF) || '', '.', ''].join(CRLF)
    socket.write(payload)
    const sent = await smtpCommand(socket, null, { expect: [250] }).catch(error => ({ status: 0, lines: [error.message] }))
    if (sent.status !== 250) throw new MailError('SMTP_SEND_FAILED', `SMTP 发送失败：${(sent.lines || []).join(' | ')}`)
    await smtpCommand(socket, 'QUIT', { expect: [221, 250] }).catch(() => {})
    return { ok: true, messageId }
  } finally {
    socket.end()
  }
}

function parseImapStatus(line, tag) {
  const regex = new RegExp(`^${tag}\\s+(OK|NO|BAD)\\b`, 'i')
  const match = regex.exec(String(line || ''))
  return match ? { ok: /OK/i.test(match[1]), status: match[1].toUpperCase(), text: line } : null
}

async function imapReadUntilTag(socket, tag, { timeoutMs = 25000 } = {}) {
  const chunks = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = await socket.readLine()
    if (line === '' && socket.closed) throw new MailError('IMAP_CLOSED', 'IMAP 连接被关闭')
    chunks.push(line)
    if (chunks.length > 5000) throw new MailError('IMAP_BAD_RESPONSE', 'IMAP 响应行数异常，已中止')
    let literal = null
    const literalMatch = /\{(\d+)\}$/.exec(line)
    if (literalMatch) {
      literal = await socket.readBytes(Number(literalMatch[1]))
      chunks.push(literal)
    }
    const status = parseImapStatus(line, tag)
    if (status) return { ...status, chunks }
    // 少数服务器把 literal 放在同一行后再跟状态，继续读下一轮即可。
    if (literal && parseImapStatus(literal.toString('utf8'), tag)) return { ok: true, status: 'OK', text: '', chunks }
  }
  throw new MailError('IMAP_TIMEOUT', `等待 IMAP 响应超时：${tag}`)
}

async function imapCommand(socket, tag, command, { timeoutMs = 25000 } = {}) {
  socket.writeLine(`${tag} ${command}`)
  const result = await imapReadUntilTag(socket, tag, { timeoutMs })
  if (!result.ok) throw new MailError('IMAP_COMMAND_FAILED', `IMAP 命令失败：${result.text || result.chunks.slice(-1)[0]}`)
  return result
}

function literalsFromChunks(chunks = []) {
  return chunks.filter(item => Buffer.isBuffer(item))
}

/**
 * MIME 原文统一成“每个字符 0-255 对应一个字节”的二进制字符串。
 * 邮件正文可能声明 GBK / GB2312 / Big5 等编码，任何一次提前 `toString('utf8')`
 * 都会把原始字节替换成 U+FFFD（界面上的方块），之后再也无法还原。
 */
function toBinaryString(value) {
  if (Buffer.isBuffer(value)) return value.toString('latin1')
  const text = String(value ?? '')
  // 已经是二进制字符串就原样保留；普通 JS 文本按 UTF-8 还原成字节，后续再按 charset 解码。
  return /[^\x00-\xff]/.test(text) ? Buffer.from(text, 'utf8').toString('latin1') : text
}

function binaryToBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(toBinaryString(value), 'latin1')
}

const CHARSET_ALIAS = new Map([
  ['utf8', 'utf-8'],
  ['utf-8', 'utf-8'],
  ['unicode-1-1-utf-8', 'utf-8'],
  ['gb2312', 'gb18030'],
  ['gbk', 'gb18030'],
  ['gb18030', 'gb18030'],
  ['x-gbk', 'gb18030'],
  ['csgb2312', 'gb18030'],
  ['big5', 'big5'],
  ['big5-hkscs', 'big5'],
  ['cn-big5', 'big5'],
  ['x-x-big5', 'big5'],
  ['shift_jis', 'shift_jis'],
  ['shift-jis', 'shift_jis'],
  ['sjis', 'shift_jis'],
  ['windows-31j', 'shift_jis'],
  ['x-sjis', 'shift_jis'],
  ['euc-kr', 'euc-kr'],
  ['ks_c_5601-1987', 'euc-kr'],
  ['ksc5601', 'euc-kr'],
  ['iso-8859-1', 'windows-1252'],
  ['latin1', 'windows-1252'],
  ['latin-1', 'windows-1252'],
  ['cp1252', 'windows-1252'],
  ['windows-1252', 'windows-1252'],
  // us-ascii 只应描述 7bit 文本。很多中文邮件实际是 GBK 却错写成 us-ascii，
  // 所以这里不映射成 latin1，而是交给 decodeBytes 做“无声明”探测。
  ['us-ascii', ''],
  ['ascii', ''],
  ['utf-16', 'utf-16le'],
  ['utf16le', 'utf-16le'],
  ['utf-16le', 'utf-16le'],
  ['unicode', 'utf-16le'],
  ['utf16be', 'utf-16be'],
  ['utf-16be', 'utf-16be'],
  ['iso-2022-jp', 'iso-2022-jp'],
])

function normalizeCharset(value) {
  const label = String(value || '').trim().replace(/^["']|["']$/g, '').toLowerCase()
  if (!label) return ''
  // 注意：别名值可能是空字符串（us-ascii 需要走内容探测），不能用 `||` 回退成原值。
  const mapped = CHARSET_ALIAS.get(label)
  return mapped !== undefined ? mapped : label
}

function charsetFromHeader(value) {
  const match = /charset\s*=\s*(["']?)([^"'\s;]+)\1/i.exec(String(value || ''))
  return match?.[2] || ''
}

const decoderCache = new Map()
function textDecoder(label, fatal = false) {
  const key = `${label}:${fatal ? 'fatal' : 'lenient'}`
  let decoder = decoderCache.get(key)
  if (!decoder) {
    decoder = new TextDecoder(label, { fatal })
    decoderCache.set(key, decoder)
  }
  return decoder
}

/** 按邮件声明的 charset 解码字节；声明缺失或明显错误时再做常见中文编码兜底。 */
function decodeBytes(value, charset = '') {
  const buffer = binaryToBuffer(value)
  if (!buffer.length) return ''
  const label = normalizeCharset(charset)
  const tryDecode = (candidate, fatal = false) => {
    if (!candidate) return null
    try {
      return textDecoder(candidate, fatal).decode(buffer)
    } catch (_) {
      return null
    }
  }
  const candidate = label || 'utf-8'
  const text = tryDecode(candidate, false)
  if (text !== null && text && !text.includes('\uFFFD')) return text
  // 实际邮件里最常见的两类问题：
  //   1. 中文正文是 GBK / GB18030，但 Content-Type 写了 us-ascii / utf-8；
  //   2. 内容含 8bit 字节，严格 UTF-8 解码会失败。
  // 依次用严格模式尝试常见编码，成功就直接返回，避免继续产生方块。
  for (const guess of ['gb18030', 'big5', 'shift_jis', 'utf-8']) {
    if (guess === candidate) continue
    const guessed = tryDecode(guess, true)
    if (guessed !== null && guessed && !guessed.includes('\uFFFD')) return guessed
  }
  return text !== null ? text : buffer.toString('latin1')
}

function parseHeaderBlock(text = '') {
  const headers = {}
  let current = ''
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      headers[current] += ` ${line.trim()}`
      continue
    }
    const index = line.indexOf(':')
    if (index <= 0) continue
    current = line.slice(0, index).trim().toLowerCase()
    headers[current] = line.slice(index + 1).trim()
  }
  return headers
}

function decodeWord(value = '') {
  const text = String(value ?? '')
  // RFC2047：相邻 encoded-word 之间的空白必须忽略，否则邮件标题中间会多出空格。
  const compact = text.replace(/\?=\s+=\?/g, '?==?')
  const decoded = compact.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, mode, data) => {
    try {
      let buffer
      if (mode.toLowerCase() === 'b') {
        buffer = Buffer.from(String(data).replace(/\s+/g, ''), 'base64')
      } else {
        const source = String(data).replace(/_/g, ' ')
        const bytes = []
        for (let i = 0; i < source.length; i += 1) {
          if (source[i] === '=' && /^[0-9A-F]{2}$/i.test(source.slice(i + 1, i + 3))) {
            bytes.push(parseInt(source.slice(i + 1, i + 3), 16))
            i += 2
          } else {
            bytes.push(source.charCodeAt(i) & 0xff)
          }
        }
        buffer = Buffer.from(bytes)
      }
      return decodeBytes(buffer, charset)
    } catch (_) {
      return data
    }
  })
  // 极少数老邮件直接把 8bit 原文放在头部，没有 RFC2047 encoded-word，这里兜底按字符集猜一次。
  if (decoded === compact && /[^\x00-\x7f]/.test(text)) return decodeBytes(text)
  return decoded
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeQuotedPrintableBytes(value = '') {
  const source = toBinaryString(value).replace(/=(?:\r\n|\n|\r)/g, '')
  const bytes = []
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '=' && /^[0-9A-F]{2}$/i.test(source.slice(i + 1, i + 3))) {
      bytes.push(parseInt(source.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(source.charCodeAt(i) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

function decodeQuotedPrintable(value = '') {
  return decodeBytes(decodeQuotedPrintableBytes(value))
}

/** 先按 Content-Transfer-Encoding 还原出真正的二进制内容（附件大小 / 正文解码共用）。 */
function decodeTransferBuffer(headers = {}, raw = '') {
  const encoding = String(headers['content-transfer-encoding'] || '').toLowerCase()
  if (encoding.includes('base64')) {
    try {
      return Buffer.from(String(raw).replace(/\s+/g, ''), 'base64')
    } catch (_) {
      return binaryToBuffer(raw)
    }
  }
  if (encoding.includes('quoted-printable')) return decodeQuotedPrintableBytes(raw)
  // 7bit / 8bit / binary：raw 是二进制字符串，每个字符码就是原始字节。
  return binaryToBuffer(raw)
}

function decodeBody(headers = {}, raw = '') {
  return decodeBytes(decodeTransferBuffer(headers, raw), charsetFromHeader(headers['content-type']))
}

function decodeDispositionFilename(disposition = '') {
  const source = String(disposition)
  const extended = /filename\*\s*=\s*(?:(?:"?)(UTF-8|gbk|gb2312|big5)''|")?([^";\r\n]+)/i.exec(source)
  const plain = /filename\s*=\s*"?([^";\r\n]+)/i.exec(source)
  let name = extended?.[2] || plain?.[1] || ''
  name = name.trim().replace(/^"(.*)"$/, '$1')
  if (!name) return ''
  try {
    name = decodeURIComponent(name)
  } catch (_) {
    /* ignore */
  }
  return decodeWord(name)
}

function parseMime(raw = '') {
  const text = toBinaryString(raw)
  const separator = text.search(/\r?\n\r?\n/)
  if (separator < 0) {
    return { headers: {}, body: decodeBytes(text), rawBody: binaryToBuffer(text), attachments: [] }
  }
  const headerText = text.slice(0, separator)
  const body = text.slice(separator).replace(/^\r?\n\r?\n/, '')
  const headers = parseHeaderBlock(headerText)
  const contentType = String(headers['content-type'] || 'text/plain; charset=utf-8')
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType)
  const attachments = []
  const plainBodies = []
  const htmlBodies = []
  let rawBody = binaryToBuffer(body)
  if (boundaryMatch) {
    const boundary = `--${boundaryMatch[1]}`
    for (const part of body.split(boundary).slice(1, -1)) {
      const content = part.replace(/^\r?\n/, '')
      if (!content.trim()) continue
      // 子 Part 必须完整解析一次：它会按自己的 Content-Type / charset 解码，
      // 父层不能再对解码后的文本执行一次 base64 / QP 解码。
      const parsed = parseMime(content)
      const type = String(parsed.headers['content-type'] || 'text/plain').toLowerCase()
      const disposition = String(parsed.headers['content-disposition'] || '')
      const filename = decodeDispositionFilename(disposition)
      if (filename || disposition.toLowerCase().includes('attachment')) {
        attachments.push({ filename: filename || 'attachment', type, size: Number(parsed.rawBody?.length) || 0 })
        continue
      }
      if (type.startsWith('text/plain')) plainBodies.push(parsed.body)
      else if (type.startsWith('text/html')) htmlBodies.push(stripHtml(parsed.body))
      else if (type.startsWith('multipart/') || type.startsWith('message/rfc822')) {
        if (parsed.body) plainBodies.push(parsed.body)
      }
    }
  } else {
    // 叶子节点：先还原传输编码，再按声明 charset 解码；rawBody 保持为真实二进制，供附件大小统计。
    rawBody = decodeTransferBuffer(headers, body)
    const decoded = decodeBytes(rawBody, charsetFromHeader(contentType))
    if (contentType.toLowerCase().includes('text/html')) htmlBodies.push(stripHtml(decoded))
    else plainBodies.push(decoded)
  }
  // multipart/alternative 同时带 text/plain 与 text/html：优先纯文本，避免同一封邮件被拼两遍。
  const contentParts = plainBodies.filter(Boolean)
  if (!contentParts.length) contentParts.push(...htmlBodies.filter(Boolean))
  return {
    headers,
    body: contentParts.join('\n\n').trim(),
    rawBody,
    attachments,
  }
}

export async function imapList(config, { folder = 'INBOX', limit = 10, unreadOnly = false } = {}) {
  const socket = new LineSocket({ host: config.imapHost, port: config.imapPort, secure: config.secure !== false, timeoutMs: config.timeoutMs || 25000 })
  await socket.connect()
  try {
    await socket.readLine() // IMAP banner
    let tag = `a${Math.floor(Math.random() * 1000)}`
    socket.writeLine(`${tag} LOGIN "${String(config.user || '').replace(/"/g, '\\"')}" "${String(config.authCode || '').replace(/"/g, '\\"')}"`)
    let login = await imapReadUntilTag(socket, tag)
    if (!login.ok) throw new MailError('IMAP_AUTH', `IMAP 登录失败：${login.text || ''}`)
    const selectTag = `b${Math.floor(Math.random() * 1000)}`
    await imapCommand(socket, selectTag, `SELECT "${folder.replace(/"/g, '\\"')}"`)
    const searchTag = `c${Math.floor(Math.random() * 1000)}`
    const searchResult = await imapCommand(socket, searchTag, `UID SEARCH ${unreadOnly ? 'UNSEEN' : 'ALL'}`)
    const searchLine = searchResult.chunks.find(item => typeof item === 'string' && /^\* SEARCH/.test(item)) || ''
    const uids = String(searchLine).replace(/^\* SEARCH\s*/, '').trim().split(/\s+/).filter(Boolean).slice(-Math.max(1, Math.min(100, Number(limit) || 10)))
    if (!uids.length) return { ok: true, folder, messages: [] }
    const fetchTag = `d${Math.floor(Math.random() * 1000)}`
    const fetchResult = await imapCommand(
      socket,
      fetchTag,
      `UID FETCH ${uids.join(',')} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)])`,
    )
    const messages = []
    const chunks = fetchResult.chunks
    for (let i = 0; i < chunks.length; i += 1) {
      const line = chunks[i]
      if (typeof line !== 'string' || !/FETCH \(/i.test(line)) continue
      const uid = /UID\s+(\d+)/i.exec(line)?.[1] || ''
      const flags = /FLAGS \(([^)]*)\)/i.exec(line)?.[1] || ''
      const literal = chunks.slice(i + 1).find(item => Buffer.isBuffer(item))
      if (!literal) continue
      const headers = parseHeaderBlock(literal.toString('latin1'))
      messages.push({
        uid,
        unread: !/\\Seen/i.test(flags),
        from: decodeWord(headers.from || ''),
        to: decodeWord(headers.to || ''),
        subject: decodeWord(headers.subject || '(无主题)'),
        date: headers.date || '',
        messageId: headers['message-id'] || '',
        inReplyTo: headers['in-reply-to'] || '',
        references: headers.references || '',
      })
    }
    const unique = new Map()
    for (const message of messages) if (message.uid) unique.set(message.uid, message)
    return { ok: true, folder, messages: [...unique.values()].reverse() }
  } finally {
    try { socket.writeLine(`z LOGOUT`) } catch (_) {}
    socket.end()
  }
}

export async function imapRead(config, uid, { folder = 'INBOX' } = {}) {
  const socket = new LineSocket({ host: config.imapHost, port: config.imapPort, secure: config.secure !== false, timeoutMs: config.timeoutMs || 25000 })
  await socket.connect()
  try {
    await socket.readLine() // IMAP banner
    let tag = `r${Math.floor(Math.random() * 1000)}`
    socket.writeLine(`${tag} LOGIN "${String(config.user || '').replace(/"/g, '\\"')}" "${String(config.authCode || '').replace(/"/g, '\\"')}"`)
    const login = await imapReadUntilTag(socket, tag)
    if (!login.ok) throw new MailError('IMAP_AUTH', `IMAP 登录失败：${login.text || ''}`)
    await imapCommand(socket, `r${Math.floor(Math.random() * 1000)}`, `SELECT "${folder.replace(/"/g, '\\"')}"`)
    const fetchTag = `f${Math.floor(Math.random() * 1000)}`
    const result = await imapCommand(socket, fetchTag, `UID FETCH ${Number(uid) || 1} (BODY.PEEK[])`)
    const literal = literalsFromChunks(result.chunks)[0]
    if (!literal) return { ok: false, code: 'MAIL_NOT_FOUND', error: `没有读到 UID ${uid} 的正文` }
    const parsed = parseMime(literal)
    const markTag = `m${Math.floor(Math.random() * 1000)}`
    await imapCommand(socket, markTag, `UID STORE ${Number(uid) || 1} +FLAGS (\\Seen)`).catch(() => {})
    return {
      ok: true,
      uid: String(uid),
      headers: {
        from: decodeWord(parsed.headers.from || ''),
        to: decodeWord(parsed.headers.to || ''),
        subject: decodeWord(parsed.headers.subject || '(无主题)'),
        date: parsed.headers.date || '',
        messageId: parsed.headers['message-id'] || '',
        inReplyTo: parsed.headers['in-reply-to'] || '',
        references: parsed.headers.references || '',
      },
      text: textOf(parsed.body || ''),
      attachments: parsed.attachments || [],
    }
  } finally {
    try { socket.writeLine('z LOGOUT') } catch (_) {}
    socket.end()
  }
}

export async function imapTest(config) {
  const result = await imapList(config, { limit: 1 })
  return { ok: true, folder: 'INBOX', testedAt: Date.now(), messages: result.messages?.length || 0 }
}

export async function smtpTest(config) {
  const socket = new LineSocket({ host: config.smtpHost, port: config.smtpPort, secure: config.secure !== false, timeoutMs: 12000 })
  await socket.connect()
  try {
    await smtpCommand(socket, null, { expect: [220] })
    const hello = await smtpCommand(socket, 'EHLO social-bridge', { expect: [250] })
    return { ok: true, status: hello.status, testedAt: Date.now() }
  } finally {
    socket.end()
  }
}

export const mailInternals = {
  parseHeaderBlock,
  parseMime,
  decodeWord,
  stripHtml,
  decodeBytes,
  decodeBody,
  decodeQuotedPrintable,
  decodeQuotedPrintableBytes,
  LineSocket,
}
