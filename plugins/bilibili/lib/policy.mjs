/*
 * bilibili · 黑白名单与名单外处理策略（纯函数，前端插件与测试脚本共用）
 *
 * 处理档位只有三种，把「收到消息」和「触发模型回复」拆开：
 *   drop    丢弃：不落库、不进上下文、不回复
 *   ingest  静默入库：写入聊天记录与上下文，但不触发模型、不回复
 *   process 正常处理：触发模型，可以回复
 *
 * 判定顺序：作用域开关 → 黑名单 → 白名单 → 名单外策略（照单全收 / 静默入库 / 概率 / 规则）
 * 启动积压消息即使判定为 process 也会降级为 ingest，避免重启后批量刷屏。
 */

export const OUTCOMES = ['drop', 'ingest', 'process']
export const FALLBACK_MODES = ['all', 'inbox', 'probability', 'rules']
export const SCOPES = ['dm', 'comment', 'at', 'like', 'system']

const isOutcome = value => OUTCOMES.includes(value)

export function scopeForKind(kind) {
  const value = String(kind || '').trim()
  if (value === 'dm') return 'dm'
  if (value === 'at') return 'at'
  if (value === 'like') return 'like'
  if (value === 'system') return 'system'
  // reply / comment / 未知评论类统一按评论策略处理
  return 'comment'
}

export const DEFAULT_SCOPE_POLICY = {
  enabled: true,
  blacklist: [],
  whitelist: [],
  whitelistOutcome: 'process',
  fallback: {
    mode: 'inbox',
    probability: 20,
    defaultOutcome: 'ingest',
    rules: [],
  },
}

export const DEFAULT_POLICY = {
  dm: { ...DEFAULT_SCOPE_POLICY, fallback: { ...DEFAULT_SCOPE_POLICY.fallback } },
  comment: { ...DEFAULT_SCOPE_POLICY, fallback: { ...DEFAULT_SCOPE_POLICY.fallback } },
  at: { ...DEFAULT_SCOPE_POLICY, fallback: { ...DEFAULT_SCOPE_POLICY.fallback } },
  // 点赞 / 系统消息默认不处理，避免消息中心噪音刷屏；需要时可单独打开。
  like: { ...DEFAULT_SCOPE_POLICY, enabled: false, fallback: { ...DEFAULT_SCOPE_POLICY.fallback } },
  system: { ...DEFAULT_SCOPE_POLICY, enabled: false, fallback: { ...DEFAULT_SCOPE_POLICY.fallback } },
}

/** 逗号 / 空格 / 换行分隔的 UID 列表；保留原样字符串，便于未来兼容 uid: 前缀。 */
export function parseIdList(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，;；、]+/)
  const seen = new Set()
  const out = []
  for (const item of source) {
    const text = String(item ?? '').trim().replace(/^uid[:：]/i, '')
    if (!text || seen.has(text) || /[\r\n]/.test(text)) continue
    seen.add(text)
    out.push(text.slice(0, 40))
  }
  return out
}

/**
 * 规则支持两种输入：
 *   - 文本行：uid:123 -> drop / keyword:广告 -> process / regex:优惠|福利 -> ingest
 *   - 对象数组：{ type:'keyword', value:'你好', outcome:'process', flags:'i' }
 * 没有写 -> 档位时默认 process（命中即处理）。
 */
export function parseRules(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/)
  const out = []
  for (const item of list) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const type = String(item.type || '').toLowerCase()
      const text = String(item.value ?? item.pattern ?? '').trim()
      if (!text || !['uid', 'keyword', 'regex'].includes(type)) continue
      out.push({
        type,
        value: text.slice(0, 200),
        outcome: isOutcome(item.outcome) ? item.outcome : 'process',
        flags: String(item.flags || '').replace(/[^gimsuy]/g, '').slice(0, 6) || 'i',
      })
      continue
    }
    const line = String(item ?? '').trim()
    if (!line || line.startsWith('#')) continue
    const arrow = line.lastIndexOf('->')
    const head = (arrow >= 0 ? line.slice(0, arrow) : line).trim()
    const tail = arrow >= 0 ? line.slice(arrow + 2).trim() : ''
    const colon = head.indexOf(':')
    if (colon <= 0) continue
    const type = head.slice(0, colon).trim().toLowerCase()
    const text = head.slice(colon + 1).trim()
    if (!text || !['uid', 'keyword', 'regex'].includes(type)) continue
    out.push({
      type,
      value: text.slice(0, 200),
      outcome: isOutcome(tail) ? tail : 'process',
      flags: 'i',
    })
  }
  return out.slice(0, 200)
}

function normalizeScope(raw, base) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const fallback = source.fallback && typeof source.fallback === 'object' ? source.fallback : {}
  const mode = FALLBACK_MODES.includes(fallback.mode) ? fallback.mode : base.fallback.mode
  return {
    enabled: source.enabled === undefined ? base.enabled : source.enabled !== false,
    blacklist: parseIdList(source.blacklist !== undefined ? source.blacklist : base.blacklist),
    whitelist: parseIdList(source.whitelist !== undefined ? source.whitelist : base.whitelist),
    whitelistOutcome: isOutcome(source.whitelistOutcome) ? source.whitelistOutcome : base.whitelistOutcome,
    fallback: {
      mode,
      probability: Math.max(0, Math.min(100, Number(fallback.probability ?? base.fallback.probability) || 0)),
      defaultOutcome: isOutcome(fallback.defaultOutcome) ? fallback.defaultOutcome : base.fallback.defaultOutcome,
      rules: parseRules(fallback.rules !== undefined ? fallback.rules : base.fallback.rules),
    },
  }
}

export function normalizeScopePolicy(raw, scope = 'dm') {
  const base = DEFAULT_POLICY[scope] || DEFAULT_SCOPE_POLICY
  return normalizeScope(raw, base)
}

export function normalizePolicy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const scope of SCOPES) out[scope] = normalizeScope(source[scope], DEFAULT_POLICY[scope])
  return out
}

export function stableHash(value) {
  const text = String(value ?? '')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function matchRule(rule, input) {
  if (!rule) return false
  if (rule.type === 'uid') return String(input.senderUid || '') === String(rule.value || '')
  if (rule.type === 'keyword') {
    if (!rule.value) return false
    return String(input.text || '').toLowerCase().includes(String(rule.value).toLowerCase())
  }
  if (rule.type === 'regex') {
    try {
      const pattern = new RegExp(rule.value, rule.flags || 'i')
      return pattern.test(String(input.text || ''))
    } catch (_) {
      return false
    }
  }
  return false
}

/**
 * @param {{kind?:string,id?:string,senderUid?:string,senderName?:string,text?:string,backlog?:boolean}} input
 * @param {object} policy normalizePolicy() 的结果，或渠道 meta 里的原始配置
 * @returns {{scope:string,outcome:'drop'|'ingest'|'process',reason:string,rule?:object}}
 */
export function decide(input, policy) {
  const source = input || {}
  const scope = scopeForKind(source.kind)
  const cfg = normalizeScopePolicy(policy?.[scope], scope)
  if (!cfg.enabled) return { scope, outcome: 'drop', reason: 'scope-disabled' }

  const uid = String(source.senderUid || '').trim()
  if (uid && cfg.blacklist.includes(uid)) return { scope, outcome: 'drop', reason: 'blacklist' }
  if (uid && cfg.whitelist.includes(uid)) {
    const outcome = isOutcome(cfg.whitelistOutcome) ? cfg.whitelistOutcome : 'process'
    return { scope, outcome, reason: 'whitelist' }
  }

  let outcome = 'ingest'
  let reason = 'fallback:inbox'
  const fallback = cfg.fallback
  if (fallback.mode === 'all') {
    outcome = 'process'
    reason = 'fallback:all'
  } else if (fallback.mode === 'probability') {
    const roll = stableHash(`${scope}:${uid}:${source.id || source.text || Date.now()}`) % 100
    outcome = roll < fallback.probability ? 'process' : 'ingest'
    reason = `fallback:probability(${fallback.probability}%)`
  } else if (fallback.mode === 'rules') {
    const rule = fallback.rules.find(item => matchRule(item, source))
    if (rule) {
      outcome = rule.outcome
      reason = `rule:${rule.type}`
    } else {
      outcome = fallback.defaultOutcome
      reason = 'fallback:rules-default'
    }
  }

  if (source.backlog && outcome === 'process') {
    return { scope, outcome: 'ingest', reason: `${reason}+backlog` }
  }
  return { scope, outcome, reason }
}

export function describeDecision(decision) {
  if (!decision) return '未判定'
  const label = { drop: '忽略', ingest: '静默入库', process: '触发回复' }[decision.outcome] || decision.outcome
  return `${label}（${decision.reason || decision.scope || ''}）`
}
