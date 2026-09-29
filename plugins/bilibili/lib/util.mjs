/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * web-access · 通用小工具（后端桥共用）。
 * 这里只放无副作用纯函数，便于扩展自测脚本直接单测。
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
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim()
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

export function maskSecret(value) {
  const text = String(value ?? '')
  if (!text) return ''
  if (text.length <= 8) return '••••'
  return `${text.slice(0, 3)}…${text.slice(-4)}`
}

/** 从多个候选里取第一个非空字符串 */
export function firstString(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const text = String(value)
    if (text.trim()) return text
  }
  return ''
}

export function uniqueBy(list, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of list || []) {
    const key = keyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export function toAbsoluteUrl(href, base) {
  const raw = String(href || '').trim()
  if (!raw || raw.startsWith('javascript:') || raw.startsWith('data:') || raw.startsWith('#')) return ''
  try {
    const url = new URL(raw, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.href
  } catch (_) {
    return ''
  }
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch (_) {
    return false
  }
}

/** 把用户/模型给的字符串规格化成一个可访问 URL（自动补 https://） */
export function normalizeUrl(value) {
  let raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) raw = `https:${raw}`
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.href
  } catch (_) {
    return ''
  }
}
