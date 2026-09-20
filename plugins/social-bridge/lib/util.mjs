/*
 * social-bridge · 公共工具
 * 只做纯函数，方便单测和两个平台适配器复用。
 */

export const PLATFORMS = ['bilibili', 'douyin']

export function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra }
}

export function ok(data = {}) {
  return { ok: true, ...data }
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    const text = value === null || value === undefined ? '' : String(value).trim()
    if (text) return text
  }
  return ''
}

export function textOf(value, limit = 0) {
  const text = String(value ?? '').replace(/\u200B|\u200C|\u200D|\uFEFF/g, '').replace(/\r\n/g, '\n').trim()
  return limit > 0 ? text.slice(0, limit) : text
}

export function oneLine(value, limit = 200) {
  return textOf(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

export function stableId(parts = []) {
  return parts
    .map(part => String(part ?? '').trim())
    .filter(Boolean)
    .join(':')
}

export function asNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function toIso(timestamp) {
  const number = Number(timestamp)
  if (!number) return ''
  const ms = number < 10 ** 11 ? number * 1000 : number
  try {
    return new Date(ms).toISOString()
  } catch (_) {
    return ''
  }
}

export function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 解析类似 "昵称：正文" / "昵称 ... 正文" 的 B站 / 抖音 DOM 文本。 */
export function splitDisplayText(raw, fallbackName = '访客') {
  const text = textOf(raw)
  if (!text) return { name: fallbackName, content: '' }
  const match = /^(.{1,40}?)[：:]\s*([\s\S]+)$/.exec(text)
  if (match) return { name: match[1].trim() || fallbackName, content: match[2].trim() }
  const match2 = /^(.{1,40}?)\s*\.\.\.\s*([\s\S]+)$/.exec(text)
  if (match2) return { name: match2[1].trim() || fallbackName, content: match2[2].trim() }
  return { name: fallbackName, content: text }
}

/** 简易节流/去重：按 key 保留最近 N 条。 */
export function createSeenSet(limit = 500) {
  const set = new Set()
  return {
    has: key => set.has(String(key || '')),
    add(key) {
      const value = String(key || '')
      if (!value) return false
      if (set.has(value)) return false
      set.add(value)
      if (set.size > limit) {
        const first = set.values().next().value
        set.delete(first)
      }
      return true
    },
    clear: () => set.clear(),
    size: () => set.size,
    values: () => [...set.values()],
  }
}

export function randomToken(size = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < size; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}
