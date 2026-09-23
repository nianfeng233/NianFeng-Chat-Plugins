/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 模型状态订阅 · 状态文本分类与中文化（纯函数）。
 *
 * 只解决一件事：状态页 / RSS 里大量英文、过程性、冗长的内容，不该按原文
 * 直接刷到群里。这里把一条动态分类成：
 *   - incident  服务异常（故障 / 中断 / 错误率升高 / 性能下降）
 *   - recovery  服务恢复
 *   - maintenance 计划维护
 *   - info      普通公告（默认不推送）
 * 并尽量从英文文本中提取中文状态、受影响组件；无法提取时宁可少说，
 * 也不要整段英文原文刷屏。
 */

import { normalizeWhitespace, truncateText } from './util.mjs'

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

export function hasCjk(value) {
  return CJK_RE.test(String(value || ''))
}

export function cjkRatio(value) {
  const text = String(value || '')
  const letters = text.replace(/[^A-Za-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, '')
  if (!letters) return 0
  let cjk = 0
  for (const char of letters) if (CJK_RE.test(char)) cjk += 1
  return cjk / letters.length
}

/* 顺序很重要：先替换完整短语，再替换零散词。 */
const LOCALIZE_RULES = [
  [/all impacted services have now fully recovered\.?/gi, '受影响服务已全部恢复。'],
  [/all systems? (?:are )?operational\.?/gi, '所有系统运行正常。'],
  [/(?:we are|we're|we are currently) investigating/gi, '正在调查'],
  [/is being investigated/gi, '正在调查'],
  [/elevated error rates?/gi, '错误率升高'],
  [/increased error rates?/gi, '错误率升高'],
  [/elevated errors?/gi, '错误率升高'],
  [/increased errors?/gi, '错误率升高'],
  [/\bAPI\s+latency\b/gi, 'API 延迟升高'],
  [/elevated latency/gi, '延迟升高'],
  [/increased latency/gi, '延迟升高'],
  [/degraded performance/gi, '性能下降'],
  [/partial outage/gi, '部分服务中断'],
  [/major outage/gi, '重大服务中断'],
  [/service outage/gi, '服务中断'],
  [/service disruption/gi, '服务中断'],
  [/scheduled maintenance/gi, '计划维护'],
  [/planned maintenance/gi, '计划维护'],
  [/maintenance window/gi, '维护窗口'],
  [/under maintenance/gi, '维护中'],
  [/\bresolved\b/gi, '已恢复'],
  [/\brecovered\b/gi, '已恢复'],
  [/\brestored\b/gi, '已恢复'],
  [/\binvestigating\b/gi, '调查中'],
  [/\bidentified\b/gi, '已定位'],
  [/\bmonitoring\b/gi, '观察中'],
  [/\bverifying\b/gi, '验证中'],
  [/\bdegraded\b/gi, '性能下降'],
  [/\boutage\b/gi, '服务中断'],
  [/\bunavailable\b/gi, '不可用'],
  [/\btimeouts?\b/gi, '超时'],
  [/\berrors?\b/gi, '错误'],
  [/\blatency\b/gi, '延迟'],
  [/\bslow\b/gi, '响应变慢'],
  [/\bdown\b/gi, '中断'],
]

export const FEED_STATUS_LABELS = {
  investigating: '调查中',
  identified: '已定位',
  monitoring: '观察中',
  verifying: '验证中',
  in_progress: '处理中',
  scheduled: '已计划',
  resolved: '已恢复',
  outage: '服务中断',
  disruption: '服务受阻',
  degraded: '性能下降',
  error_rate: '错误率升高',
  latency: '延迟升高',
  maintenance: '维护中',
  info: '状态公告',
}

function translateOnce(text) {
  const raw = normalizeWhitespace(text)
  if (!raw) return ''
  if (!/[A-Za-z]/.test(raw)) return raw
  let out = raw
  for (const [pattern, replacement] of LOCALIZE_RULES) {
    out = out.replace(pattern, replacement)
  }
  // 去掉中英混排时残留的 “: ” 之类痕迹，但不破坏正文。
  return normalizeWhitespace(out.replace(/\s*[:：]\s*(?=[，。；、]|$)/g, ''))
}

export function localizeStatusText(value) {
  return translateOnce(value)
}

/** 去掉标题里的 Resolved / Investigating 前缀，返回适合做中文标题的文本。 */
export function localizeStatusTitle(value) {
  const raw = normalizeWhitespace(value)
  if (!raw) return ''
  const cleaned = raw.replace(/^(?:status\s*[::]\s*)?(resolved|recovered|restored|investigating|identified|monitoring|completed|scheduled|partial outage|major outage)\s*[:\-–—]\s*/i, '')
  const text = translateOnce(cleaned || raw)
  // 纯英文标题尽量保持原样，由通知里的中文「状态」行补充；不要为了翻译而乱换词。
  return text
}

function statusToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

function severityFromText(text) {
  const lower = String(text || '').toLowerCase()
  if (/(major outage|full outage|complete outage|service outage|entirely down|service unavailable|\bdown\b|中断|不可用|无法访问)/i.test(lower)) return 4
  if (/(partial outage|service disruption|disruption|严重|大面积|服务受阻|部分服务|部分故障)/i.test(lower)) return 3
  if (/(elevated error|increased error|error rates?|errors?\b|错误率|错误|报错|elevated latency|increased latency|latency|延迟|timeout|超时|degraded|degradation|性能下降|质量下降|变慢)/i.test(lower)) return 2
  return 0
}

/**
 * 从一条状态页 / RSS 动态中识别它属于哪类事件。
 * @returns {{phase:'incident'|'recovery'|'maintenance'|'info', severity:number, label:string, statusKey:string}}
 */
export function classifyStatusText({ title = '', body = '' } = {}) {
  const text = normalizeWhitespace(`${title} ${body}`)
  const lower = text.toLowerCase()

  // 1. 明确带有 “Status: xxx” 的动态优先按状态字段判断。
  const statusMatch = lower.match(/\bstatus\s*[::]\s*(resolved|recovered|restored|completed|available|operational|scheduled|investigating|identified|monitoring|verifying|in[_\s-]?progress)\b/)
  const token = statusMatch ? statusToken(statusMatch[1]) : ''
  if (token) {
    if (/^(resolved|recovered|restored|completed|available|operational)/.test(token)) {
      return { phase: 'recovery', severity: 0, label: FEED_STATUS_LABELS.resolved, statusKey: 'resolved' }
    }
    if (/^(scheduled)/.test(token)) {
      return { phase: 'maintenance', severity: 1, label: FEED_STATUS_LABELS.maintenance, statusKey: 'maintenance' }
    }
    if (/^(investigating|identified|monitoring|verifying|in_progress|inprogress)/.test(token)) {
      const statusKey = /^in[_]?progress$/.test(token) || token === 'inprogress' ? 'in_progress' : token
      return {
        phase: 'incident',
        severity: Math.max(2, severityFromText(text)),
        label: FEED_STATUS_LABELS[statusKey] || FEED_STATUS_LABELS.degraded,
        statusKey,
      }
    }
  }

  // 2. 标题里的 Resolved: — 明确是恢复动态。
  if (/^(resolved|recovered|restored)\s*[:\-–—]/i.test(String(title || '').trim())) {
    return { phase: 'recovery', severity: 0, label: FEED_STATUS_LABELS.resolved, statusKey: 'resolved' }
  }

  // 3. 中文 / 英文恢复词；排除“尚未恢复 / 仍在中断”之类的否定表达。
  const notRecovered = /(尚未恢复|仍未恢复|没有恢复|not (?:yet )?recovered|has not recovered|still down|仍然中断|仍然不可用)/i.test(text)
  if (!notRecovered && /(针对.*(?:已恢复|已解决|已修复)|(?:问题|故障|服务).{0,12}(?:已恢复|已解决|已修复)|恢复(?:正常|服务)?|已正常运行|服务正常|all systems? operational|all impacted services have now fully recovered|fully recovered|(?:service|services|issue|incident|problem)s? (?:has|have|is|are|was|were)(?: now| been)? (?:recovered|resolved|restored|fixed)|back to normal|issue fixed|service restored)/i.test(text)) {
    return { phase: 'recovery', severity: 0, label: FEED_STATUS_LABELS.resolved, statusKey: 'resolved' }
  }

  // 4. 计划维护。
  if (/(scheduled maintenance|planned maintenance|maintenance window|under maintenance|计划维护|维护窗口|维护中)/i.test(text)) {
    return { phase: 'maintenance', severity: 1, label: FEED_STATUS_LABELS.maintenance, statusKey: 'maintenance' }
  }

  // 5. 主动故障 / 质量下降。先判断中文，再判断英文；避免英文长句整段翻译。
  const severity = severityFromText(text)
  if (severity > 0) {
    const statusKey = /error|错误|报错/.test(lower) ? 'error_rate' : /latency|延迟|timeout|超时|变慢/.test(lower) ? 'latency' : severity >= 3 ? 'outage' : 'degraded'
    return { phase: 'incident', severity, label: FEED_STATUS_LABELS[statusKey] || FEED_STATUS_LABELS.degraded, statusKey }
  }
  if (/(investigating|under investigation|调查中|排查中|正在处理|已定位|观察中)/i.test(text)) {
    return { phase: 'incident', severity: 2, label: FEED_STATUS_LABELS.investigating, statusKey: 'investigating' }
  }

  return { phase: 'info', severity: 0, label: FEED_STATUS_LABELS.info, statusKey: 'info' }
}

const RESERVED_COMPONENT_NAMES = new Set([
  'affected components',
  'affected component',
  'affected services',
  'affected service',
  'status',
  'all systems',
  'all impacted services',
  'impacted services',
  'components',
  'operational',
  'degraded performance',
  'partial outage',
  'major outage',
  'under maintenance',
  'service disruption',
])

function cleanComponentName(value) {
  const name = normalizeWhitespace(value)
    .replace(/^[\s,，、;；:：\-–—•·]+/, '')
    .replace(/[\s,，、;；:：\-–—•·]+$/, '')
    .replace(/[.。]+$/, '')
    .replace(/^affected components?\s*/i, '')
    .replace(/^影响(?:的)?组件\s*/, '')
    .trim()
  if (!name) return ''
  if (name.length < 2 || name.length > 80) return ''
  if (RESERVED_COMPONENT_NAMES.has(name.toLowerCase())) return ''
  if (/^(?:status|all|affected|impacted|the)\b/i.test(name) && name.split(/\s+/).length <= 2) return ''
  return name
}

/**
 * 从 “Affected components A (Operational), B (Partial Outage)” 这类正文里
 * 提取受影响组件名称。只取名字，丢掉后面的 (Operational) 等冗长状态。
 */
export function extractAffectedComponents(value, { limit = 12 } = {}) {
  const text = normalizeWhitespace(value)
  if (!text) return []
  const marker = text.match(/affected (?:components?|services?)|受影响(?:的)?组件|影响组件/i)
  const section = marker ? text.slice(marker.index + marker[0].length, marker.index + marker[0].length + 2200) : text
  const out = []
  const push = raw => {
    const name = cleanComponentName(raw)
    if (name) out.push(name)
  }

  // A (Operational) / A (Degraded Performance) / A（正常）
  const withStatus = /([A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff ._&+/#'’:’()\-]{1,70}?)\s*[\(（](?:operational|degraded performance|partial outage|major outage|under maintenance|service disruption|正常|性能下降|部分故障|重大故障|维护中|异常|中断|服务受阻)[\)）]/gi
  for (const match of section.matchAll(withStatus)) push(match[1])

  // 中文括号状态可能被 normalizeWhitespace 保留，上面的正则覆盖不到时，
  // 再扫一次 “名称（状态）”。
  const withStatusCn = /([A-Za-z0-9\u4e00-\u9fff][^,，、;；()（）\n]{1,50}?)\s*[\(（](?:正常|性能下降|部分故障|重大故障|维护中|异常|中断|服务受阻)[\)）]/g
  for (const match of section.matchAll(withStatusCn)) push(match[1])

  // 列表项 / 简单逗号列表：仅在明确出现 “Affected components” 标记，
  // 且没有提取到“名称（状态）”时兜底，避免把普通英文句子误当组件名。
  if (!out.length && marker) {
    const listPart = section.split(/(?:read more|更多|详情)/i)[0] || section
    for (const part of listPart.split(/[,，、;；\n]+/)) {
      const raw = part.replace(/^[\s\-–—•·]+/, '').replace(/[.。]+$/, '').trim()
      if (!raw || raw.length > 70) continue
      if (/\b(?:is|are|was|were|has|have|will|and)\b/i.test(raw)) continue
      push(raw)
    }
  }

  const seen = new Set()
  const result = []
  for (const name of out) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(name)
    if (result.length >= Math.max(1, Number(limit) || 12)) break
  }
  return result
}

/**
 * 生成适合放进通知正文的简短说明：
 *   - 中文原文：保留（局部中文化后截断）
 *   - 英文原文：只保留可确定的中文短句；提取不到就返回空，让格式化层
 *     只展示标题 / 状态 / 受影响组件，不再刷大段英文。
 */
export function summarizeStatusBody(value, { label = '', components = [], max = 500 } = {}) {
  const raw = normalizeWhitespace(value)
  if (!raw) return ''
  const localized = localizeStatusText(raw)
  if (cjkRatio(raw) >= 0.12 || cjkRatio(localized) >= 0.25) {
    // 组件列表已经由通知的「组件：」单独展示，正文里不再重复整段列表。
    const bodyOnly = localized.replace(/(?:affected components?|受影响(?:的)?组件)[\s\S]*$/i, '').trim()
    return truncateText(bodyOnly || localized, max)
  }
  const parts = []
  if (/(all impacted services have now fully recovered|all systems? operational)/i.test(raw)) {
    parts.push('受影响服务已全部恢复。')
  } else if (label && /(resolved|recovered|restored)/i.test(label)) {
    parts.push('服务已恢复。')
  }
  // 受影响组件由格式化层单独列成「组件：」，这里不重复。
  return truncateText(parts.filter(Boolean).join('\n'), max)
}

/** 判断事件是否值得在“仅异常与恢复”模式下推送。 */
export function isImportantStatus(phase, severity) {
  const level = Number(severity) || 0
  if (phase === 'recovery') return true
  if (phase === 'maintenance') return level > 0
  if (phase === 'incident') return level >= 2
  return false
}
