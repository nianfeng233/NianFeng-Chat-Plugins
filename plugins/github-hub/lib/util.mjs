/*
 * 念风chat · 扩展插件 · github-hub
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 自包含小工具：浏览器、Node 前端代聊、Node 后端桥共用。
 * 这里不依赖任何念风内置模块，保证外置安装后仍可独立运行。
 */

export const clampNumber = (value, min, max, fallback) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

export const escapeXml = value =>
  String(value ?? '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[match])

export const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[match])

export const truncate = (value, max = 500, suffix = '…') => {
  const text = String(value ?? '')
  const limit = Math.max(0, Number(max) || 0)
  if (text.length <= limit) return text
  return limit <= suffix.length ? text.slice(0, limit) : `${text.slice(0, limit - suffix.length)}${suffix}`
}

export const truncateMiddle = (value, max = 200) => {
  const text = String(value ?? '')
  const limit = Math.max(8, Number(max) || 0)
  if (text.length <= limit) return text
  const half = Math.floor((limit - 1) / 2)
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`
}

export const parseList = value => {
  if (Array.isArray(value)) return value.map(item => String(item ?? '').trim()).filter(Boolean)
  return String(value ?? '')
    .split(/[,，、;；\s]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

export const uniqueList = list => [...new Set((Array.isArray(list) ? list : []).map(item => String(item ?? '').trim()).filter(Boolean))]

export const formatTime = value => {
  const num = Number(value)
  const date = Number.isFinite(num) && num > 0 ? new Date(num < 1e12 ? num * 1000 : num) : new Date(String(value || ''))
  if (Number.isNaN(date.getTime())) return ''
  const pad = part => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const relativeTime = (value, now = Date.now()) => {
  const num = Number(value)
  const at = Number.isFinite(num) && num > 0 ? (num < 1e12 ? num * 1000 : num) : Date.parse(String(value || ''))
  if (!Number.isFinite(at)) return ''
  const diff = Math.max(0, now - at)
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`
  return formatTime(at).slice(0, 10)
}

/** 计算字符串在给定字号下的近似像素宽度：中日韩全角按 1em，其余按比例估算。 */
export const approxTextWidth = (text, fontSize = 16) => {
  let width = 0
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0)
    if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd))) {
      width += fontSize
    } else if (/\s/.test(char)) {
      width += fontSize * 0.3
    } else if (/[A-Z0-9]/.test(char)) {
      width += fontSize * 0.62
    } else if (/[mwMW@%]/.test(char)) {
      width += fontSize * 0.82
    } else if (/[iltfjr.,:;!'|]/.test(char)) {
      width += fontSize * 0.3
    } else {
      width += fontSize * 0.52
    }
  }
  return width
}

/**
 * 按近似像素宽度折行。返回最多 maxLines 行；超出时最后一行以省略号结束。
 */
export const wrapByWidth = (text, maxWidth, fontSize, maxLines = 3) => {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  const lines = []
  if (!source) return lines
  const limit = Math.max(1, Number(maxLines) || 1)
  let truncated = false
  let line = ''
  const pushLine = () => {
    if (line) lines.push(line.replace(/\s+$/, ''))
    line = ''
  }
  for (const paragraph of source.split('\n')) {
    if (lines.length >= limit) {
      truncated = true
      break
    }
    if (!paragraph.trim()) {
      if (line) pushLine()
      if (lines.length >= limit) {
        truncated = true
        break
      }
      lines.push('')
      continue
    }
    for (const char of paragraph) {
      const next = line + char
      if (line && approxTextWidth(next, fontSize) > maxWidth) {
        pushLine()
        if (lines.length >= limit) {
          truncated = true
          break
        }
      }
      line = next
    }
    if (truncated) break
    pushLine()
  }
  if (line && lines.length < limit) pushLine()
  if (lines.length > limit) {
    lines.length = limit
    truncated = true
  }
  if (truncated && lines.length) {
    let last = lines[lines.length - 1]
    while (last && approxTextWidth(`${last}…`, fontSize) > maxWidth) last = last.slice(0, -1)
    lines[lines.length - 1] = `${last}…`
  }
  return lines.length ? lines : ['']
}

/** 把任意文本压成适合渠道发送的一行摘要。 */
export const oneLine = (value, max = 160) => truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max)

/** base64 编码：浏览器 / Node 都能用。 */
export const bytesToBase64 = bytes => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') return Buffer.from(view).toString('base64')
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < view.length; index += chunk) binary += String.fromCharCode.apply(null, view.subarray(index, index + chunk))
  if (typeof btoa === 'function') return btoa(binary)
  throw new Error('当前环境不支持 base64 编码')
}

export const bytesToDataUrl = (bytes, mime = 'image/png') => `data:${mime};base64,${bytesToBase64(bytes)}`

/** data URL -> Buffer（Node）或 Uint8Array；接口失败时返回 null。 */
export const dataUrlToBytes = dataUrl => {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''))
  if (!match) return null
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(match[3].replace(/\s+/g, ''), match[2] ? 'base64' : 'utf8')
    if (match[2]) {
      const binary = atob(match[3].replace(/\s+/g, ''))
      return Uint8Array.from(binary, char => char.charCodeAt(0))
    }
    return new TextEncoder().encode(decodeURIComponent(match[3]))
  } catch (_) {
    return null
  }
}

export const isAbortError = error => error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || ''))

/** 简单并发限制执行器：每批最多 limit 个任务，保持结果顺序。 */
export const mapLimit = async (list, limit, mapper) => {
  const items = Array.isArray(list) ? list : []
  const size = Math.max(1, Number(limit) || 1)
  const results = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()))
  return results
}
