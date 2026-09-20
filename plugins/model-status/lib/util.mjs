/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 模型状态订阅 · 通用纯函数工具（无副作用，便于扩展自测脚本直接单测）。
 */

export const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

export function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function truncateText(value, max = 12000, { ellipsis = '…' } = {}) {
  const text = String(value ?? '')
  const limit = Math.max(0, Number(max) || 0)
  if (!limit || text.length <= limit) return text
  return text.slice(0, limit) + ellipsis
}

export function normalizeWhitespace(value, { keepNewlines = false } = {}) {
  let text = String(value ?? '')
  if (keepNewlines) {
    text = text.replace(/[ \t\f\v\u00a0]+/g, ' ')
    text = text.replace(/\r\n?/g, '\n')
    text = text.replace(/\n{3,}/g, '\n\n')
    return text.replace(/^\s+|\s+$/g, '')
  }
  return text.replace(/\s+/g, ' ').trim()
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  times: '×',
  divide: '÷',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  laquo: '«',
  raquo: '»',
}

export function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch (_) {
        return match
      }
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      try {
        return String.fromCodePoint(Number(dec))
      } catch (_) {
        return match
      }
    })
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => {
      const lower = name.toLowerCase()
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : match
    })
}

export function stripHtml(value) {
  return decodeHtmlEntities(
    String(value ?? '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function safeJsonParse(text, fallback = null) {
  if (text && typeof text === 'object') return text
  try {
    return JSON.parse(String(text ?? ''))
  } catch (_) {
    return fallback
  }
}

export function randomToken(length = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < Math.max(1, Number(length) || 1); i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export function nowIso() {
  return new Date().toISOString()
}

export function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function deepMerge(base, patch) {
  const out = isObject(base) ? { ...base } : {}
  if (!isObject(patch)) return out
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : value
  }
  return out
}

export function uniqueList(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const out = []
  for (const item of list) {
    const text = String(item ?? '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

export function uniqueBy(list, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const key = keyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 逗号 / 顿号 / 分号 / 空白混合分隔的列表。 */
export function parseList(value) {
  if (Array.isArray(value)) return uniqueList(value)
  return uniqueList(String(value ?? '').split(/[,，、;；\n\r]+/).map(item => item.trim()))
}

export function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '')
}

export function firstLine(value, max = 160) {
  const text = normalizeWhitespace(stripHtml(value || ''))
  if (!text) return ''
  const line = text.split(/\n/)[0] || text
  return truncateText(line, max)
}

export function formatDateParts(value, timeZone = 'Asia/Shanghai') {
  const date = value instanceof Date ? value : new Date(Number(value) || value)
  if (Number.isNaN(date.getTime())) return { date: '', time: '', text: '' }
  const format = (zone, options) => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', ...options }).format(date)
    } catch (_) {
      try {
        return new Intl.DateTimeFormat('en-CA', { hourCycle: 'h23', ...options }).format(date)
      } catch (_) {
        return ''
      }
    }
  }
  const dateText = format(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const timeText = format(timeZone, { hour: '2-digit', minute: '2-digit', hour12: false })
  return { date: dateText, time: timeText, text: [dateText, timeText].filter(Boolean).join(' ') }
}

export function formatTime(value, timeZone = 'Asia/Shanghai') {
  return formatDateParts(value, timeZone).text
}

export function relativeTime(value, now = Date.now()) {
  const at = Number(value) || (value instanceof Date ? value.getTime() : 0)
  if (!at) return ''
  const diff = Math.max(0, now - at)
  if (diff < 60 * 1000) return '刚刚'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/** 只保留一段文本的前 N 个字符，并把换行压成 Markdown 引用行。 */
export function compactMultiline(value, max = 600) {
  const text = truncateText(String(value ?? '').trim(), max)
  return text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
}
