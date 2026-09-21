/*
 * 念风chat · 扩展插件 · napcat-group-guard
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 群管助手（外部插件，不随本体打包）。
 *
 * 只响应「群规则」里显式配置过的群（allGroups=true 时恢复旧版“全局默认套所有群”）；
 * 未配置的群即使机器人收到入群 / 退群 / 申请事件也不会处理。
 *
 * 几块纯代码能力，默认都不经过 LLM：
 *   1. 入群申请自动审核：
 *      - QQ 等级限制；查不到等级（隐藏）直接拒绝；
 *      - 进群白词 / 黑词；黑词命中直接拉黑；
 *      - 每个群一份黑名单，也支持多群共用一个黑名单；
 *      - 被踢 / 主动退群 / 连续被拒绝达到次数自动拉黑；
 *      - 拉黑后若人还在群里，自动触发踢出；
 *      - 自动踢人时可以配置是否同时勾选 QQ 的「拒绝再次加群」；
 *      - 申请信息（昵称 / QQ / 等级 / 回答 / 处理结果）推送到群内，可附申请人档案图。
 *   2. 进群 / 退群 QQ 档案图：
 *      - Canvas 生成原创档案卡，随申请提示 / 欢迎 / 退群提示一起发送；
 *      - 图片过大自动降质，发送失败自动退化为纯文字。
 *   3. 定期清理不活跃成员：
 *      - 每隔一定周期在群里 @全体成员 预告；
 *      - x 分钟后按群成员列表的 last_sent_time（兜底 join_time）批量踢出不活跃的人。
 *
 * 安装：把本目录复制到 <数据目录>/plugins/napcat-group-guard/（或用 install.ps1），
 * 重新扫描插件即可；依赖内置 napcat 渠道插件。
 */

export const name = 'napcat-group-guard'
export const version = '2.0.6'
export const scope = 'both'
export const displayName = '群管助手'
export const description = '扩展 · NapCat 群自动管理：仅响应显式配置的群；入群申请自动审核（等级 / 白词 / 黑词 / 共享黑名单）、申请 / 进出群档案图与定时清理不活跃成员；退群 / 被踢与自动拉黑合并为一条提示；档案图服务端渲染，不需要 WebUI 页面常驻。'
export const author = '念风扩展'
export const icon = '🛡️'
export const core = false
export const enabled = true
export const depends = {
  'channel-registry': '^1.0.0',
  'config': '>=1.1.0',
  'event-bus': '*',
  'napcat': '^1.0.0',
  'tool-registry': '^1.0.0',
}
export const optionalDepends = {
  'plugin-manager': '>=1.0.0',
}
export const inject = [
  'tool-registry',
  'channel-registry',
  'config',
  'event-bus',
  'napcat-channel?',
  'plugin-manager?',
  'api?',
]
export const provides = [{ name: 'napcat-group-guard', type: 'singleton' }]
export const permissions = ['network']

/* ================================================================== */
/* 模块级常量与小工具                                                   */
/* ================================================================== */

const DEFAULT_BLACKLIST = 'default'
const DEFAULT_LEVEL_FAIL_REASON = 'qq等级查询失败请打开后重试'
const DEFAULT_ANSWER_REJECT_REASON = '进群答案不符合要求，请修改后重新申请。'
const DEFAULT_BLACKWORD_REJECT_REASON = '命中进群黑词（{word}），已加入黑名单。'
const DEFAULT_NOTIFY_TEMPLATE =
  '【进群申请】\n昵称：{nickname}\nQQ：{qq}\nQQ等级：{level}\n进群回答：{answer}\n处理结果：{result}'
const DEFAULT_JOIN_TEMPLATE = '欢迎 {nickname}（{qq}）加入本群！'
const DEFAULT_LEAVE_TEMPLATE = '【退群提示】\n{nickname}（{qq}）主动退出了群聊。'
const DEFAULT_KICK_TEMPLATE = '【退群提示】\n{nickname}（{qq}）被 {operator} 移出了群聊。'
const DEFAULT_BLACKLIST_KICK_TEMPLATE = '【安全拦截】\n{nickname}（{qq}）在黑名单中，已自动移出群聊。'
const DEFAULT_CLEANUP_KICK_TEMPLATE = '【清理提示】\n{nickname}（{qq}）因长期不活跃被移出群聊。'
const DEFAULT_BLACKLIST_TEMPLATE = '【黑名单提示】\n{nickname}（{qq}）已被加入黑名单。\n原因：{reason}'
const DEFAULT_CLEANUP_MESSAGE = '@全体成员 本群将在 {minutes} 分钟后清理持续 {days} 天未活跃的成员，请及时冒泡。'
const DEFAULT_CLEANUP_NEXT_MESSAGE = '本轮清理已结束。下一轮清理时间：{next_date}，距现在 {days} 天。'
const DEFAULT_CLEANUP_DAILY_MESSAGE = '提醒：下一轮清理时间：{next_date}，当前预计清理 {count} 人，距现在 {days} 天，请长期不活跃的成员及时冒泡。'
/** 自动清理固定在此本地时刻执行，避免凌晨 @全体；工具手动触发的「立即清理」不受此限制。 */
const CLEANUP_KICK_HOUR = 18
const CLEANUP_KICK_MINUTE = 0
/**
 * 对齐宽容窗口：上一轮 startedAt 可能因网络有秒级误差（例如 18:00:04），
 * 此时应仍落在当天 18:00，而不是漂移到次日。
 */
const CLEANUP_ALIGN_TOLERANCE_MS = 15 * 60 * 1000
const PROCESSED_FLAG_LIMIT = 300
const REJECT_COUNT_LIMIT = 500
const CLEANUP_RECENT_MS = 120000
const MEMBER_CACHE_MS = 30000
/** notice 事件去重窗口：同一群 / 同一人 / 同一事件的重复投递只在极短时间内有意义。 */
const NOTICE_DEDUPE_MS = 15000
const NOTICE_DEDUPE_LIMIT = 600
/**
 * 入群 notice 的新鲜度窗口：正常事件会在成员入群后秒级到达；
 * 超过该窗口才收到的 group_increase 基本是 NapCat 断线重连 / 事件积压后补发的旧事件。
 * 这类事件不能再按“新人入群”补欢迎，否则会和历史欢迎重复刷屏。
 */
const JOIN_NOTICE_FRESH_MS = 10 * 60 * 1000
/** 持久化的「已欢迎入群事件」记忆条数，用 join_time 区分同一次入群。 */
const GREETED_JOIN_LIMIT = 500
/**
 * 档案图 base64 字符上限。后端 action 路由默认只接收 2MB JSON，
 * 超过时 send_group_msg 会整体失败（文字也一起丢）。这里主动降质 / 缩放，
 * 保证档案图能放进消息里；仍然超限时至少要把失败写进日志。
 */
const MAX_DOSSIER_BASE64_CHARS = 1600000

/** 逐级降质时使用的 JPEG 质量。 */
const DOSSIER_JPEG_QUALITIES = [0.86, 0.78, 0.7, 0.6, 0.48]

function normalizeQq(value) {
  return String(value ?? '').trim()
}

function isQqId(value) {
  return /^\d{3,20}$/.test(normalizeQq(value))
}

/** 用于群名匹配的归一化：全角转半角、去零宽 / 空白、统一小写。 */
function normalizeKey(value) {
  return String(value ?? '')
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u200b-\u200d\ufeff\s\u00a0]+/g, '')
    .toLowerCase()
    .replace(/^@+/, '')
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', '开', '是'].includes(text)) return true
  if (['0', 'false', 'no', 'off', '关', '否'].includes(text)) return false
  return fallback
}

function clampNumber(value, min, max, fallback, { integer = false } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  let out = Math.max(min, Math.min(max, n))
  if (integer) out = Math.floor(out)
  return out
}

/** 把配置里的词表解析成数组：支持字符串 / 数组，按中英文逗号、顿号、分号、竖线、斜杠、换行拆分。 */
function parseWords(value) {
  if (Array.isArray(value)) return [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))]
  return [...new Set(String(value ?? '').split(/[,，、;；|/\\\n\r]+/).map(item => item.trim()).filter(Boolean))]
}

/** 匹配词表：忽略大小写，返回命中的词；没有命中返回空字符串。 */
function matchWords(text, words) {
  const haystack = String(text ?? '').toLowerCase()
  if (!haystack) return ''
  for (const word of words || []) {
    const needle = String(word ?? '').trim().toLowerCase()
    if (needle && haystack.includes(needle)) return word
  }
  return ''
}

function parseJsonObject(raw, fallback = {}) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch (_) {
    return fallback
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value)
  } catch (_) {
    return '{}'
  }
}

/** 把秒 / 毫秒时间戳统一成秒；无法识别时返回 0。 */
function epochSeconds(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n > 1e12 ? n / 1000 : n)
}

function fmtTime(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  const date = new Date(n < 1e12 ? n * 1000 : n)
  if (Number.isNaN(date.getTime())) return ''
  const pad = v => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 聊天文案用的短日期：YYYY-MM-DD HH:mm */
function fmtShortTime(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  const date = new Date(n < 1e12 ? n * 1000 : n)
  if (Number.isNaN(date.getTime())) return ''
  const pad = v => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 本地日期 key：用于“每天最多播报一次”的状态。 */
function localDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(Number(value) || Date.now())
  const pad = v => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 把清理周期算出的时间戳对齐到固定的本地时刻（默认 18:00）。
 * - 原时间是凌晨 / 上午：落到当天 18:00；
 * - 原时间已明显晚于 18:00：落到次日 18:00（避免把时间设到过去）；
 * - 只差几分钟（上一轮 startedAt 的秒级误差）：仍落在同一天，避免周期漂移。
 */
function alignCleanupKickAt(timestamp) {
  const base = Number(timestamp) || Date.now()
  const candidate = new Date(base)
  candidate.setHours(CLEANUP_KICK_HOUR, CLEANUP_KICK_MINUTE, 0, 0)
  if (candidate.getTime() < base && base - candidate.getTime() > CLEANUP_ALIGN_TOLERANCE_MS) {
    candidate.setDate(candidate.getDate() + 1)
    candidate.setHours(CLEANUP_KICK_HOUR, CLEANUP_KICK_MINUTE, 0, 0)
  }
  return candidate.getTime()
}

function formatTemplate(template, vars = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

/** 从 NapCat 的 comment 里提取答案：兼容「问题：xxx\n答案：yyy」。 */
function extractAnswer(comment) {
  const text = String(comment ?? '').trim()
  if (!text) return ''
  const match = text.match(/(?:^|\n)\s*答案\s*[:：]\s*([\s\S]*)$/)
  return match ? match[1].trim() : text
}

function parseQqLevel(data) {
  const raw = data?.qqLevel ?? data?.qq_level ?? data?.level
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

function normalizeMember(raw) {
  const qq = normalizeQq(raw?.user_id ?? raw?.userId ?? raw?.uin)
  const nickname = String(raw?.nickname ?? raw?.nick ?? '').trim()
  const card = String(raw?.card ?? raw?.memberName ?? '').trim()
  const level = Number(raw?.level ?? raw?.memberRealLevel ?? 0) || 0
  return {
    qq,
    nickname,
    card,
    display: card || nickname || qq,
    role: ['owner', 'admin', 'member'].includes(raw?.role) ? raw.role : 'member',
    title: String(raw?.title ?? raw?.memberSpecialTitle ?? raw?.special_title ?? '').trim(),
    level,
    qq_level: Number(raw?.qq_level ?? raw?.qqLevel ?? 0) || 0,
    join_time: Number(raw?.join_time ?? raw?.joinTime ?? 0) || 0,
    last_sent_time: Number(raw?.last_sent_time ?? raw?.lastSpeakTime ?? 0) || 0,
    is_robot: raw?.is_robot === true || raw?.isRobot === true,
  }
}

function publicMember(member) {
  return {
    qq: member.qq,
    nickname: member.nickname,
    card: member.card,
    display: member.display,
    role: member.role,
    group_level: member.level || undefined,
    qq_level: member.qq_level || undefined,
    join_time: fmtTime(member.join_time) || undefined,
    last_sent_time: fmtTime(member.last_sent_time) || undefined,
    is_robot: member.is_robot || undefined,
  }
}

/**
 * 有没有可用的浏览器 Canvas 渲染器。
 * 桌面 / 网页 WebUI 里为 true；服务端代聊 headless worker 用的是 Node DOM 垫片，
 * createElement('canvas') 没有 2d context，因此改用后端服务端渲染
 * （PowerShell + System.Drawing，失败自动降级为纯 Node PNG）。
 *
 * 无论当前实例有没有 Canvas，request / notice / 清理事件都由
 * “谁先拿到后端租约谁处理”，不再要求 WebUI 页面常驻。
 */
export function canRenderDossier() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__NIANFENG_SERVER_AGENT__ === true) return false
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
    const canvas = document.createElement('canvas')
    return typeof canvas?.getContext === 'function' && !!canvas.getContext('2d')
  } catch (_) {
    return false
  }
}

/* ================================================================== */
/* 插件主体                                                            */
/* ================================================================== */

export function apply(ctx) {
  const tools = ctx.inject('tool-registry')
  const registry = ctx.inject('channel-registry')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const napcat = ctx.inject('napcat-channel?')
  const manager = ctx.inject('plugin-manager?')
  const logger = ctx.logger

  /* ---------------- 配置读取 ---------------- */

  const pref = key => `napcat.groupGuard.${key}`

  const enabled = () => toBool(config.get(pref('enabled'), true), true)
  const allowManage = () => enabled() && toBool(config.get(pref('allowManage'), true), true)
  const dryRun = () => enabled() && toBool(config.get(pref('dryRun'), false), false)
  const autoReviewEnabled = () => toBool(config.get(pref('autoReview'), false), false)
  /**
   * 兼容旧行为的全局开关：默认 false，只处理「群规则」里显式配置过的群。
   * 打开后 NapCat 里所有群都会套用全局默认（旧版本行为）。未配置的群不响应，
   * 避免机器人在别的群收到事件时误欢迎 / 误审核 / 误踢人。
   */
  const allGroupsEnabled = () => toBool(config.get(pref('allGroups'), false), false)
  const autoKickBlacklisted = () => toBool(config.get(pref('autoKickBlacklisted'), true), true)
  const enforceOnStartup = () => toBool(config.get(pref('enforceOnStartup'), true), true)
  const autoBlacklistOnKick = () => toBool(config.get(pref('autoBlacklistOnKick'), true), true)
  const autoBlacklistOnLeave = () => toBool(config.get(pref('autoBlacklistOnLeave'), true), true)
  const kickRejectAdd = () => toBool(config.get(pref('kickRejectAdd'), true), true)
  const notifyOnRequest = () => toBool(config.get(pref('notifyOnRequest'), true), true)
  const notifyDecrease = () => toBool(config.get(pref('notifyDecrease'), true), true)
  const notifyBlacklist = () => toBool(config.get(pref('notifyBlacklist'), true), true)
  const notifyJoinSuccess = () => toBool(config.get(pref('notifyJoinSuccess'), true), true)
  const dossierImageEnabled = () => toBool(config.get(pref('openBoxImage'), true), true)
  const protectedUsers = () => parseWords(config.get(pref('protectedUsers'), ''))
  const getText = (key, fallback) => {
    const value = config.get(pref(key), fallback)
    return String(value ?? fallback)
  }

  const disabledResult = () => ({ ok: false, code: 'GG_DISABLED', error: '群管助手已禁用（可在插件设置中开启）。' })
  const manageDenied = () => ({ ok: false, code: 'GG_MANAGE_DENIED', error: '管理操作已关闭（可在插件设置中开启「允许管理操作」）。' })

  const rendererReady = canRenderDossier()

  const emitAction = (action, payload = {}) => {
    try {
      events.emit('napcat-group-guard:action', { action, at: Date.now(), ...payload })
    } catch (_) {
      /* 监听方出错不影响主流程 */
    }
  }

  /* ---------------- 多页面执行租约（由 bridge.mjs 后端桥仲裁） ---------------- */
  //
  // 群管助手同时运行在 WebUI 页面和 headless 代聊 worker 里，NapCat 的
  // request / notice 会通过 SSE 广播给所有实例。只靠实例内 Set 去重时，
  // 桌面端 + 手机网页 + headless 同时在线就会各处理一遍，表现为重复提示 /
  // 重复踢人。bridge.mjs 提供一个进程内租约路由，让第一个实例拿到 key，
  // 其余实例直接跳过；后端桥未安装或尚未重启时回退到实例内去重，不影响可用性。

  const api = ctx.inject('api?')
  let sharedLeaseUnavailable = false

  const sharedLeaseUsable = () => !sharedLeaseUnavailable && typeof api?.post === 'function'

  const leaseKey = (prefix, ...parts) => {
    const raw = parts.map(part => String(part ?? '').trim()).join(':').replace(/[\r\n]+/g, ' ')
    if (!raw) return prefix
    return raw.length <= 180 ? `${prefix}:${raw}` : `${prefix}:h${profileHash(raw)}`
  }

  async function claimSharedLease(key, ttlMs) {
    if (!key || !sharedLeaseUsable()) return { supported: false, claimed: true, key }
    if (typeof api.configured === 'function' && api.configured() === false) return { supported: false, claimed: true, key }
    try {
      const data = await api.post('/group-guard/claim', { key, ttlMs }, { timeoutMs: 3000 })
      if (data?.ok === true) {
        return { supported: true, claimed: data.claimed === true, key, expiresAt: Number(data.expiresAt) || 0 }
      }
      // 没有挂载后端桥时，单端口部署可能把未知 POST 回退成 SPA HTML（200）。
      // 这不算失败，但说明当前进程没有租约路由，标记为不可用，避免每条事件都白请求。
      sharedLeaseUnavailable = true
      return { supported: false, claimed: true, key }
    } catch (err) {
      const status = Number(err?.status) || 0
      if (status === 400 || status === 401 || status === 404 || status === 405) sharedLeaseUnavailable = true
      logger.debug(`[napcat-group-guard] 多页面租约不可用，回退到页面内去重：${err?.message || err}`)
      return { supported: false, claimed: true, key }
    }
  }

  async function releaseSharedLease(key) {
    if (!key || !sharedLeaseUsable()) return
    try {
      await api.post('/group-guard/claim/release', { key }, { timeoutMs: 2000 })
    } catch (_) {
      /* 释放失败不影响主流程，租约会自然过期 */
    }
  }

  async function hasSharedLease(key) {
    if (!key || !sharedLeaseUsable()) return false
    if (typeof api.configured === 'function' && api.configured() === false) return false
    try {
      const data = await api.get(`/group-guard/claim?key=${encodeURIComponent(key)}`, { timeoutMs: 2500 })
      if (data?.ok === true) return data.active === true
      sharedLeaseUnavailable = true
      return false
    } catch (err) {
      const status = Number(err?.status) || 0
      if (status === 400 || status === 401 || status === 404 || status === 405) sharedLeaseUnavailable = true
      return false
    }
  }

  /* ---------------- 持久化状态（拒绝计数 / 已处理申请 / 清理锚点） ---------------- */

  function readState() {
    const raw = config.get(pref('state'), '{}')
    const obj = parseJsonObject(raw, {})
    return obj && typeof obj === 'object' ? obj : {}
  }

  function writeState(patch = {}) {
    const next = { ...readState(), ...patch }
    config.set(pref('state'), safeJsonStringify(next))
    return next
  }

  function isFlagProcessed(flag) {
    const value = normalizeQq(flag)
    if (!value) return false
    return (readState().processedFlags || []).includes(value)
  }

  function markFlagProcessed(flag) {
    const value = normalizeQq(flag)
    if (!value) return
    const flags = [value, ...(readState().processedFlags || []).filter(item => item !== value)].slice(0, PROCESSED_FLAG_LIMIT)
    writeState({ processedFlags: flags })
  }

  /**
   * 入群欢迎的持久化幂等键：实例 + 群号 + 成员 QQ + 入群时间（秒）。
   * 同一次入群被重复投递（SSE 重连 / 多页面广播 / NapCat 补发）时只会欢迎一次；
   * 成员真的退群再进时 join_time 会变化，仍会按新事件正常欢迎。
   */
  function greetedJoinKey(instanceId, groupId, qq, joinAt) {
    return `${normalizeQq(instanceId)}:${normalizeQq(groupId)}:${normalizeQq(qq)}:${epochSeconds(joinAt)}`
  }

  function readGreetedJoins() {
    const raw = readState().greetedJoins
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  }

  function isJoinGreeted(instanceId, groupId, qq, joinAt) {
    if (!(epochSeconds(joinAt) > 0)) return false
    return Number(readGreetedJoins()[greetedJoinKey(instanceId, groupId, qq, joinAt)]) > 0
  }

  function markJoinGreeted(instanceId, groupId, qq, joinAt) {
    if (!(epochSeconds(joinAt) > 0)) return
    const key = greetedJoinKey(instanceId, groupId, qq, joinAt)
    const entries = Object.entries({ ...readGreetedJoins(), [key]: Date.now() })
      .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
      .slice(0, GREETED_JOIN_LIMIT)
    writeState({ greetedJoins: Object.fromEntries(entries) })
  }

  function recordRejection(groupId, qq) {
    const key = `${normalizeQq(groupId)}:${normalizeQq(qq)}`
    const counts = { ...(readState().rejectCounts || {}) }
    const count = (Number(counts[key]?.count) || 0) + 1
    counts[key] = { count, at: Date.now() }
    const entries = Object.entries(counts)
      .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
      .slice(0, REJECT_COUNT_LIMIT)
    writeState({ rejectCounts: Object.fromEntries(entries) })
    return count
  }

  function rejectionCount(groupId, qq) {
    return Number(readState().rejectCounts?.[`${normalizeQq(groupId)}:${normalizeQq(qq)}`]?.count) || 0
  }

  function clearRejection(groupId, qq) {
    const counts = { ...(readState().rejectCounts || {}) }
    delete counts[`${normalizeQq(groupId)}:${normalizeQq(qq)}`]
    writeState({ rejectCounts: counts })
  }

  /* ---------------- 黑名单存取（config 持久化，可随偏好同步多端） ---------------- */

  function readBlacklists() {
    const raw = config.get(pref('blacklists'), '{}')
    const obj = parseJsonObject(raw, {})
    const out = {}
    for (const [listId, value] of Object.entries(obj)) {
      const id = String(listId ?? '').trim()
      if (!id) continue
      let qqs = []
      if (Array.isArray(value)) qqs = value
      else if (value && typeof value === 'object') {
        qqs = Array.isArray(value.qqs) ? value.qqs : Array.isArray(value.members) ? value.members : []
      }
      out[id] = [...new Set(qqs.map(item => normalizeQq(typeof item === 'object' ? item?.qq : item)).filter(Boolean))]
    }
    return out
  }

  function writeBlacklists(lists) {
    config.set(pref('blacklists'), safeJsonStringify(lists))
  }

  function ensureBlacklist(listId) {
    const id = String(listId || DEFAULT_BLACKLIST).trim() || DEFAULT_BLACKLIST
    const lists = readBlacklists()
    if (!lists[id]) {
      lists[id] = []
      writeBlacklists(lists)
    }
    return id
  }

  function blacklistMembers(listId) {
    const id = String(listId || DEFAULT_BLACKLIST).trim() || DEFAULT_BLACKLIST
    return [...(readBlacklists()[id] || [])]
  }

  function isBlacklisted(qq, listId = DEFAULT_BLACKLIST) {
    const target = normalizeQq(qq)
    if (!target) return false
    return blacklistMembers(listId).includes(target)
  }

  function addBlacklistEntry(qq, listId = DEFAULT_BLACKLIST, reason = '') {
    const target = normalizeQq(qq)
    if (!target) return { ok: false, error: '缺少有效 QQ 号。' }
    const id = ensureBlacklist(listId)
    const lists = readBlacklists()
    const current = lists[id] || []
    if (current.includes(target)) return { ok: true, added: false, already: true, list: id, qq: target }
    lists[id] = [...current, target]
    writeBlacklists(lists)
    ctx.logger.info(`[napcat-group-guard] 黑名单「${id}」加入 ${target}（${reason || '未注明原因'}）`)
    emitAction('blacklist_add', { qq: target, list: id, reason })
    return { ok: true, added: true, already: false, list: id, qq: target }
  }

  function removeBlacklistEntry(qq, listId = DEFAULT_BLACKLIST) {
    const target = normalizeQq(qq)
    if (!target) return { ok: false, error: '缺少有效 QQ 号。' }
    const id = String(listId || DEFAULT_BLACKLIST).trim() || DEFAULT_BLACKLIST
    const lists = readBlacklists()
    const current = lists[id] || []
    if (!current.includes(target)) return { ok: true, removed: false, missing: true, list: id, qq: target }
    lists[id] = current.filter(item => item !== target)
    writeBlacklists(lists)
    ctx.logger.info(`[napcat-group-guard] 黑名单「${id}」移除 ${target}`)
    emitAction('blacklist_remove', { qq: target, list: id })
    return { ok: true, removed: true, missing: false, list: id, qq: target }
  }

  /* ---------------- 群规则：全局默认 + 每个群覆盖 ---------------- */

  function groupsConfig() {
    return parseJsonObject(config.get(pref('groups'), '{}'), {})
  }

  function writeGroups(map) {
    config.set(pref('groups'), safeJsonStringify(map && typeof map === 'object' ? map : {}))
  }

  /** 工具返回用的精简规则，不暴露内部辅助字段。 */
  function publicRule(rule) {
    return {
      group_id: rule.groupId,
      group_name: rule.groupName,
      configured: rule.configured,
      managed: rule.managed,
      enabled: rule.enabled,
      auto_review: rule.autoReview,
      min_level: rule.minLevel,
      require_visible_level: rule.requireVisibleLevel,
      whitelist: rule.whitelistWords,
      blacklist: rule.blacklistWords,
      blacklist_id: rule.blacklistId,
      max_reject: rule.maxReject,
      notify_on_request: rule.notifyOnRequest,
      notify_template: rule.notifyTemplate,
      notify_join_success: rule.notifyJoinSuccess,
      join_template: rule.joinTemplate,
      notify_decrease: rule.notifyDecrease,
      leave_template: rule.leaveTemplate,
      kick_template: rule.kickTemplate,
      notify_blacklist: rule.notifyBlacklist,
      blacklist_template: rule.blacklistTemplate,
      open_box_image: rule.openBoxImage,
      auto_blacklist_on_kick: rule.autoBlacklistOnKick,
      auto_blacklist_on_leave: rule.autoBlacklistOnLeave,
      auto_kick_blacklisted: rule.autoKickBlacklisted,
      kick_reject_add: rule.kickRejectAdd,
      protected_users: rule.protectedUsers,
      answer_reject_reason: rule.answerRejectReason,
      blackword_reject_reason: rule.blackwordRejectReason,
      cleanup: { ...rule.cleanup },
    }
  }

  function explicitRule(groupId) {
    const map = groupsConfig()
    const value = map?.[normalizeQq(groupId)]
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  }

  /**
   * 解析某个群最终生效的规则：全局默认 + `napcat.groupGuard.groups[群号]` 覆盖。
   *
   * 群规则 JSON 支持覆盖的键（未写的键继承全局）：
   *   enabled / autoReview / minLevel / requireVisibleLevel
   *   whitelist / blacklist / blacklistId
   *   maxReject / notify / notifyTemplate
   *   autoBlacklistOnKick / autoBlacklistOnLeave / autoKickBlacklisted / kickRejectAdd
   *   notifyDecrease / leaveTemplate / kickTemplate
   *   notifyBlacklist / blacklistTemplate / protectedUsers
   *   cleanup: {
   *     enabled, intervalMinutes, warnMinutes, inactiveDays,
   *     skipAdmins, blacklistKicked, notifyResult, message
   *   }
   *   扁平别名：cleanupEnabled / cleanupIntervalMinutes / cleanupWarnMinutes /
   *             cleanupInactiveDays / cleanupSkipAdmins / cleanupBlacklistKicked /
   *             cleanupNotifyResult / cleanupMessage
   */
  function resolveRule(groupId, groupName = '') {
    const id = normalizeQq(groupId)
    const override = explicitRule(id)
    const rule = {
      groupId: id,
      groupName: groupName || id,
      /** 该群是否在「群规则」JSON 里有显式配置；未配置的群默认完全不响应。 */
      configured: !!override,
      enabled: true,
      autoReview: autoReviewEnabled(),
      minLevel: clampNumber(config.get(pref('minLevel'), 0), 0, 999, 0, { integer: true }),
      requireVisibleLevel: toBool(config.get(pref('requireVisibleLevel'), true), true),
      whitelistWords: parseWords(config.get(pref('answerWhitelist'), '')),
      blacklistWords: parseWords(config.get(pref('answerBlacklist'), '')),
      blacklistId: DEFAULT_BLACKLIST,
      maxReject: clampNumber(config.get(pref('maxReject'), 2), 0, 100, 2, { integer: true }),
      notifyOnRequest: notifyOnRequest(),
      notifyTemplate: getText('notifyTemplate', DEFAULT_NOTIFY_TEMPLATE),
      notifyJoinSuccess: notifyJoinSuccess(),
      joinTemplate: getText('joinTemplate', DEFAULT_JOIN_TEMPLATE),
      openBoxImage: dossierImageEnabled(),
      autoBlacklistOnKick: autoBlacklistOnKick(),
      autoBlacklistOnLeave: autoBlacklistOnLeave(),
      autoKickBlacklisted: autoKickBlacklisted(),
      kickRejectAdd: kickRejectAdd(),
      notifyDecrease: notifyDecrease(),
      leaveTemplate: getText('leaveTemplate', DEFAULT_LEAVE_TEMPLATE),
      kickTemplate: getText('kickTemplate', DEFAULT_KICK_TEMPLATE),
      blacklistKickTemplate: getText('blacklistKickTemplate', DEFAULT_BLACKLIST_KICK_TEMPLATE),
      cleanupKickTemplate: getText('cleanupKickTemplate', DEFAULT_CLEANUP_KICK_TEMPLATE),
      notifyBlacklist: notifyBlacklist(),
      blacklistTemplate: getText('blacklistTemplate', DEFAULT_BLACKLIST_TEMPLATE),
      protectedUsers: protectedUsers(),
      answerRejectReason: getText('answerRejectReason', DEFAULT_ANSWER_REJECT_REASON),
      blackwordRejectReason: getText('blackwordRejectReason', DEFAULT_BLACKWORD_REJECT_REASON),
      cleanup: {
        enabled: toBool(config.get(pref('cleanup.enabled'), false), false),
        intervalMinutes: clampNumber(config.get(pref('cleanup.intervalMinutes'), 10080), 1, 525600, 10080),
        warnMinutes: clampNumber(config.get(pref('cleanup.warnMinutes'), 10), 0, 1440, 10),
        inactiveDays: clampNumber(config.get(pref('cleanup.inactiveDays'), 30), 0.01, 3650, 30),
        skipAdmins: toBool(config.get(pref('cleanup.skipAdmins'), true), true),
        blacklistKicked: toBool(config.get(pref('cleanup.blacklistKicked'), false), false),
        notifyResult: toBool(config.get(pref('cleanup.notifyResult'), false), false),
        message: getText('cleanup.message', DEFAULT_CLEANUP_MESSAGE),
        // 每天 20:00 左右播报下一轮清人时间；默认开启，可按群关掉。
        dailyBroadcast: toBool(config.get(pref('cleanup.dailyBroadcast'), true), true),
        dailyBroadcastHour: clampNumber(config.get(pref('cleanup.dailyBroadcastHour'), 20), 0, 23, 20, { integer: true }),
        dailyBroadcastMinute: clampNumber(config.get(pref('cleanup.dailyBroadcastMinute'), 0), 0, 59, 0, { integer: true }),
        dailyMessage: getText('cleanup.dailyMessage', DEFAULT_CLEANUP_DAILY_MESSAGE),
        // 每轮清理踢完后播报下一轮时间；默认开启。
        nextMessage: getText('cleanup.nextMessage', DEFAULT_CLEANUP_NEXT_MESSAGE),
      },
    }

    if (override) {
      if (override.enabled !== undefined) rule.enabled = toBool(override.enabled, true)
      if (override.autoReview !== undefined) rule.autoReview = toBool(override.autoReview, rule.autoReview)
      else if (override.enabled !== undefined && !rule.enabled) rule.autoReview = false
      if (override.minLevel !== undefined) rule.minLevel = clampNumber(override.minLevel, 0, 999, rule.minLevel, { integer: true })
      if (override.requireVisibleLevel !== undefined) rule.requireVisibleLevel = toBool(override.requireVisibleLevel, rule.requireVisibleLevel)
      const whitelist = override.whitelistWords ?? override.whitelist ?? override.answerWhitelist
      if (whitelist !== undefined) rule.whitelistWords = parseWords(whitelist)
      const blacklist = override.blacklistWords ?? override.blacklist ?? override.answerBlacklist
      if (blacklist !== undefined) rule.blacklistWords = parseWords(blacklist)
      const listId = override.blacklistId ?? override.list
      if (listId !== undefined) rule.blacklistId = String(listId ?? '').trim() || DEFAULT_BLACKLIST
      if (override.maxReject !== undefined) rule.maxReject = clampNumber(override.maxReject, 0, 100, rule.maxReject, { integer: true })
      if (override.notify !== undefined || override.notifyOnRequest !== undefined) {
        rule.notifyOnRequest = toBool(override.notify ?? override.notifyOnRequest, rule.notifyOnRequest)
      }
      if (override.notifyTemplate !== undefined) rule.notifyTemplate = String(override.notifyTemplate ?? rule.notifyTemplate)
      if (override.notifyJoinSuccess !== undefined || override.notifyJoin !== undefined) {
        rule.notifyJoinSuccess = toBool(override.notifyJoinSuccess ?? override.notifyJoin, rule.notifyJoinSuccess)
      }
      if (override.joinTemplate !== undefined || override.welcomeTemplate !== undefined) {
        rule.joinTemplate = String(override.joinTemplate ?? override.welcomeTemplate ?? rule.joinTemplate)
      }
      if (override.openBoxImage !== undefined || override.dossierImage !== undefined || override.profileImage !== undefined) {
        rule.openBoxImage = toBool(override.openBoxImage ?? override.dossierImage ?? override.profileImage, rule.openBoxImage)
      }
      if (override.autoBlacklistOnKick !== undefined) rule.autoBlacklistOnKick = toBool(override.autoBlacklistOnKick, rule.autoBlacklistOnKick)
      if (override.autoBlacklistOnLeave !== undefined) rule.autoBlacklistOnLeave = toBool(override.autoBlacklistOnLeave, rule.autoBlacklistOnLeave)
      if (override.autoKickBlacklisted !== undefined) rule.autoKickBlacklisted = toBool(override.autoKickBlacklisted, rule.autoKickBlacklisted)
      if (override.kickRejectAdd !== undefined) rule.kickRejectAdd = toBool(override.kickRejectAdd, rule.kickRejectAdd)
      if (override.notifyDecrease !== undefined) rule.notifyDecrease = toBool(override.notifyDecrease, rule.notifyDecrease)
      if (override.leaveTemplate !== undefined) rule.leaveTemplate = String(override.leaveTemplate ?? rule.leaveTemplate)
      if (override.kickTemplate !== undefined) rule.kickTemplate = String(override.kickTemplate ?? rule.kickTemplate)
      if (override.blacklistKickTemplate !== undefined) rule.blacklistKickTemplate = String(override.blacklistKickTemplate ?? rule.blacklistKickTemplate)
      if (override.cleanupKickTemplate !== undefined) rule.cleanupKickTemplate = String(override.cleanupKickTemplate ?? rule.cleanupKickTemplate)
      if (override.notifyBlacklist !== undefined) rule.notifyBlacklist = toBool(override.notifyBlacklist, rule.notifyBlacklist)
      if (override.blacklistTemplate !== undefined) rule.blacklistTemplate = String(override.blacklistTemplate ?? rule.blacklistTemplate)
      if (override.protectedUsers !== undefined) rule.protectedUsers = parseWords(override.protectedUsers)

      const cleanupOverride = override.cleanup
      if (typeof cleanupOverride === 'boolean') {
        rule.cleanup.enabled = cleanupOverride
      } else if (cleanupOverride && typeof cleanupOverride === 'object' && !Array.isArray(cleanupOverride)) {
        if (cleanupOverride.enabled !== undefined) rule.cleanup.enabled = toBool(cleanupOverride.enabled, rule.cleanup.enabled)
        if (cleanupOverride.intervalMinutes !== undefined) rule.cleanup.intervalMinutes = clampNumber(cleanupOverride.intervalMinutes, 1, 525600, rule.cleanup.intervalMinutes)
        if (cleanupOverride.warnMinutes !== undefined) rule.cleanup.warnMinutes = clampNumber(cleanupOverride.warnMinutes, 0, 1440, rule.cleanup.warnMinutes)
        if (cleanupOverride.inactiveDays !== undefined) rule.cleanup.inactiveDays = clampNumber(cleanupOverride.inactiveDays, 0.01, 3650, rule.cleanup.inactiveDays)
        if (cleanupOverride.skipAdmins !== undefined) rule.cleanup.skipAdmins = toBool(cleanupOverride.skipAdmins, rule.cleanup.skipAdmins)
        if (cleanupOverride.blacklistKicked !== undefined) rule.cleanup.blacklistKicked = toBool(cleanupOverride.blacklistKicked, rule.cleanup.blacklistKicked)
        if (cleanupOverride.notifyResult !== undefined) rule.cleanup.notifyResult = toBool(cleanupOverride.notifyResult, rule.cleanup.notifyResult)
        if (cleanupOverride.message !== undefined) rule.cleanup.message = String(cleanupOverride.message ?? rule.cleanup.message)
        if (cleanupOverride.dailyBroadcast !== undefined) rule.cleanup.dailyBroadcast = toBool(cleanupOverride.dailyBroadcast, rule.cleanup.dailyBroadcast)
        if (cleanupOverride.dailyBroadcastHour !== undefined) rule.cleanup.dailyBroadcastHour = clampNumber(cleanupOverride.dailyBroadcastHour, 0, 23, rule.cleanup.dailyBroadcastHour, { integer: true })
        if (cleanupOverride.dailyBroadcastMinute !== undefined) rule.cleanup.dailyBroadcastMinute = clampNumber(cleanupOverride.dailyBroadcastMinute, 0, 59, rule.cleanup.dailyBroadcastMinute, { integer: true })
        if (cleanupOverride.dailyMessage !== undefined) rule.cleanup.dailyMessage = String(cleanupOverride.dailyMessage ?? rule.cleanup.dailyMessage)
        if (cleanupOverride.nextMessage !== undefined) rule.cleanup.nextMessage = String(cleanupOverride.nextMessage ?? rule.cleanup.nextMessage)
        if (cleanupOverride.rejectAdd !== undefined) rule.kickRejectAdd = toBool(cleanupOverride.rejectAdd, rule.kickRejectAdd)
      }

      const flatCleanup = {
        cleanupEnabled: 'enabled',
        cleanupIntervalMinutes: 'intervalMinutes',
        cleanupWarnMinutes: 'warnMinutes',
        cleanupInactiveDays: 'inactiveDays',
        cleanupSkipAdmins: 'skipAdmins',
        cleanupBlacklistKicked: 'blacklistKicked',
        cleanupNotifyResult: 'notifyResult',
        cleanupMessage: 'message',
        cleanupDailyBroadcast: 'dailyBroadcast',
        cleanupDailyBroadcastHour: 'dailyBroadcastHour',
        cleanupDailyBroadcastMinute: 'dailyBroadcastMinute',
        cleanupDailyMessage: 'dailyMessage',
        cleanupNextMessage: 'nextMessage',
      }
      for (const [flatKey, field] of Object.entries(flatCleanup)) {
        if (override[flatKey] === undefined) continue
        if (field === 'enabled' || field === 'skipAdmins' || field === 'blacklistKicked' || field === 'notifyResult' || field === 'dailyBroadcast') {
          rule.cleanup[field] = toBool(override[flatKey], rule.cleanup[field])
        } else if (field === 'message' || field === 'dailyMessage' || field === 'nextMessage') {
          rule.cleanup[field] = String(override[flatKey] ?? rule.cleanup[field])
        } else {
          const limits =
            field === 'inactiveDays'
              ? [0.01, 3650]
              : field === 'warnMinutes'
                ? [0, 1440]
                : field === 'dailyBroadcastHour'
                  ? [0, 23]
                  : field === 'dailyBroadcastMinute'
                    ? [0, 59]
                    : [1, 525600]
          rule.cleanup[field] = clampNumber(override[flatKey], limits[0], limits[1], rule.cleanup[field])
        }
      }

      if (!rule.enabled) {
        rule.autoReview = false
        rule.cleanup.enabled = false
      }
    }

    // 保持向后兼容：老代码里 rule.notify 等价于 notifyOnRequest。
    rule.notify = rule.notifyOnRequest
    // 只对显式配置过的群产生响应；allGroups=true 时恢复旧版“全局默认套所有群”。
    rule.managed = rule.enabled !== false && (!!override || allGroupsEnabled())
    return rule
  }

  /* ---------------- 定时器与缓存 ---------------- */

  /** `${instanceId}:${groupId}` -> { at, members } */
  const MEMBER_CACHE = new Map()
  /** `${groupId}:${qq}` -> 最近一次由本插件清理踢出的时间（用于避免重复拉黑） */
  const CLEANUP_RECENT = new Map()
  /** notice 事件指纹 -> 最近处理时间（同一事件重复投递时只执行一次） */
  const RECENT_NOTICES = new Map()

  function isRecentCleanupKick(groupId, qq) {
    const key = `${normalizeQq(groupId)}:${normalizeQq(qq)}`
    const entry = CLEANUP_RECENT.get(key)
    if (!entry) return false
    if (Date.now() - entry.at > CLEANUP_RECENT_MS) {
      CLEANUP_RECENT.delete(key)
      return false
    }
    return true
  }

  function markCleanupKick(groupId, qq) {
    CLEANUP_RECENT.set(`${normalizeQq(groupId)}:${normalizeQq(qq)}`, { at: Date.now() })
  }

  /** notice 指纹：只包含同一事件的稳定字段，不包含传输时间 / 序号。 */
  function noticeFingerprint(payload = {}, raw = {}) {
    const type = String(raw.notice_type || payload?.noticeType || '').trim()
    const subType = String(raw.sub_type || '').trim()
    return [
      type,
      subType,
      normalizeQq(raw.group_id),
      normalizeQq(raw.user_id),
      normalizeQq(raw.operator_id),
    ].join(':')
  }

  function isRecentNotice(instanceId, fingerprint) {
    const key = leaseKey('notice-local', instanceId, fingerprint)
    const at = Number(RECENT_NOTICES.get(key)) || 0
    if (!at) return false
    if (Date.now() - at > NOTICE_DEDUPE_MS) {
      RECENT_NOTICES.delete(key)
      return false
    }
    return true
  }

  function markRecentNotice(instanceId, fingerprint) {
    const key = leaseKey('notice-local', instanceId, fingerprint)
    RECENT_NOTICES.set(key, Date.now())
    if (RECENT_NOTICES.size > NOTICE_DEDUPE_LIMIT) {
      const now = Date.now()
      for (const [item, at] of RECENT_NOTICES) {
        if (now - Number(at || 0) > NOTICE_DEDUPE_MS) RECENT_NOTICES.delete(item)
        if (RECENT_NOTICES.size <= NOTICE_DEDUPE_LIMIT) break
      }
    }
  }

  function cleanupKickMarkerKey(instanceId, groupId, qq) {
    return leaseKey('cleanup-kick', instanceId, normalizeQq(groupId), normalizeQq(qq))
  }

  async function markSharedCleanupKick(instanceId, groupId, qq) {
    const key = cleanupKickMarkerKey(instanceId, groupId, qq)
    if (!key) return
    await claimSharedLease(key, CLEANUP_RECENT_MS)
  }

  async function isSharedCleanupKick(instanceId, groupId, qq) {
    return hasSharedLease(cleanupKickMarkerKey(instanceId, groupId, qq))
  }

  /**
   * 黑名单成员入群时我们会“先发档案卡提示，再踢出”。NapCat 随后还会补一条
   * group_decrease(kick)，这里做一个短标记，避免同一个人的档案卡发两遍。
   */
  const KICK_NOTICE_RECENT = new Map()
  function kickNoticeMarkerKey(instanceId, groupId, qq) {
    return leaseKey('kick-notice-sent', instanceId, normalizeQq(groupId), normalizeQq(qq))
  }
  async function markKickNoticeSent(instanceId, groupId, qq) {
    const key = `${normalizeQq(instanceId)}:${normalizeQq(groupId)}:${normalizeQq(qq)}`
    KICK_NOTICE_RECENT.set(key, Date.now())
    if (KICK_NOTICE_RECENT.size > NOTICE_DEDUPE_LIMIT) {
      const now = Date.now()
      for (const [item, at] of KICK_NOTICE_RECENT) {
        if (now - Number(at || 0) > CLEANUP_RECENT_MS) KICK_NOTICE_RECENT.delete(item)
        if (KICK_NOTICE_RECENT.size <= NOTICE_DEDUPE_LIMIT) break
      }
    }
    try {
      await claimSharedLease(kickNoticeMarkerKey(instanceId, groupId, qq), CLEANUP_RECENT_MS)
    } catch (_) {
      /* 无后端桥时只靠本地标记去重 */
    }
  }
  async function consumeKickNoticeSent(instanceId, groupId, qq) {
    const key = `${normalizeQq(instanceId)}:${normalizeQq(groupId)}:${normalizeQq(qq)}`
    const at = Number(KICK_NOTICE_RECENT.get(key)) || 0
    if (at && Date.now() - at <= CLEANUP_RECENT_MS) {
      KICK_NOTICE_RECENT.delete(key)
      await releaseSharedLease(kickNoticeMarkerKey(instanceId, groupId, qq)).catch(() => {})
      return true
    }
    KICK_NOTICE_RECENT.delete(key)
    const shared = await hasSharedLease(kickNoticeMarkerKey(instanceId, groupId, qq))
    if (shared) {
      await releaseSharedLease(kickNoticeMarkerKey(instanceId, groupId, qq)).catch(() => {})
      return true
    }
    return false
  }

  /* ---------------- 渠道与群目标 ---------------- */

  const allChannels = () => {
    const out = []
    for (const tab of registry.tabs()) out.push(...registry.channels(tab))
    return out
  }
  const isGroupChannel = channel =>
    channel?.type === 'napcat' && (channel?.meta?.targetType === 'group' || channel?.meta?.category === 'group')
  const groupChannels = () => allChannels().filter(isGroupChannel)
  const currentChannel = context => {
    const conversationId = String(context?.conversationId || '')
    if (!conversationId) return null
    return allChannels().find(channel => String(channel?.meta?.conversationId || '') === conversationId) || null
  }
  const instanceIdOf = channel => String(channel?.meta?.instanceId || '').trim()
  const groupIdOf = channel => String(channel?.meta?.targetId || '').trim()
  const channelNameOf = channel => String(channel?.meta?.targetName || channel?.name || '').trim() || groupIdOf(channel) || '群聊'
  const targetOf = channel => ({
    channel,
    instanceId: instanceIdOf(channel),
    groupId: groupIdOf(channel),
    name: channelNameOf(channel),
  })
  const findChannelByGroupId = groupId =>
    groupChannels().find(channel => groupIdOf(channel) === normalizeQq(groupId)) || null

  /**
   * 把工具参数里的 group（群号 / 群名 / 当前群）解析成群标识。
   * 这里只做渠道查找，不做权限判断：黑名单本身是插件配置，工具默认只服务当前群。
   */
  async function resolveRuleRef(ref, context) {
    const wanted = String(ref ?? '').trim()
    const current = currentChannel(context)
    if (!wanted || wanted === 'current' || wanted === '本群' || wanted === '当前群') {
      if (isGroupChannel(current)) {
        const target = targetOf(current)
        return { ok: true, groupId: target.groupId, channel: current, name: target.name }
      }
      return { ok: false, code: 'NO_TARGET_GROUP', error: '当前会话不是 NapCat 群聊渠道；请在 group 参数里指定群号或群名。' }
    }
    if (isQqId(wanted)) {
      const channel = findChannelByGroupId(wanted)
      return {
        ok: true,
        groupId: normalizeQq(wanted),
        channel: channel || null,
        name: channel ? channelNameOf(channel) : normalizeQq(wanted),
      }
    }
    const key = normalizeKey(wanted)
    const channels = groupChannels()
    const namesOf = channel => [channelNameOf(channel), channel?.name, groupIdOf(channel)].filter(Boolean).map(normalizeKey)
    const exact = channels.filter(channel => namesOf(channel).includes(key))
    const pool = exact.length ? exact : channels.filter(channel => namesOf(channel).some(name => name && (name.includes(key) || key.includes(name))))
    if (pool.length === 1) {
      const target = targetOf(pool[0])
      return { ok: true, groupId: target.groupId, channel: pool[0], name: target.name }
    }
    if (pool.length > 1) {
      return {
        ok: false,
        code: 'GROUP_AMBIGUOUS',
        error: `「${wanted}」匹配到多个群，请改用群号：${pool.map(channel => groupIdOf(channel)).join('、')}`,
        candidates: pool.map(channel => ({ group_id: groupIdOf(channel), name: channelNameOf(channel) })),
      }
    }
    const available = groupChannels().map(channel => `${channelNameOf(channel)}(${groupIdOf(channel)})`).join('、')
    return { ok: false, code: 'GROUP_NOT_FOUND', error: `没有找到群「${wanted}」。已配置的群聊渠道：${available || '（无）'}` }
  }

  /* ---------------- OneBot 调用 ---------------- */

  async function callOneBot(instanceId, action, params = {}, options = {}) {
    if (!napcat) return { ok: false, code: 'NO_NAPCAT', error: 'NapCat 渠道服务不可用（napcat 插件未启用）。' }
    const id = String(instanceId || '').trim()
    if (!id) return { ok: false, code: 'NO_INSTANCE', error: '缺少 NapCat 实例 ID。' }
    try {
      const result = await napcat.action(id, String(action || ''), params || {})
      if (!result || result.ok !== true) {
        return {
          ok: false,
          code: result?.code || 'ACTION_FAILED',
          error: String(result?.error || result?.message || `NapCat ${action} 执行失败`),
          data: result?.data ?? null,
        }
      }
      if (!options.silent) ctx.logger.debug(`[napcat-group-guard] ${action} 执行成功`)
      return { ok: true, data: result.data ?? null }
    } catch (err) {
      return { ok: false, code: 'ACTION_ERROR', error: `NapCat ${action} 调用失败：${err?.message || err}` }
    }
  }

  const instanceOf = instanceId => {
    const id = String(instanceId || '').trim()
    if (!id) return null
    return napcat?.instance?.(id) || (napcat?.listInstances?.() || []).find(item => String(item?.id || '') === id) || null
  }
  const botQqOf = instanceId => normalizeQq(instanceOf(instanceId)?.login?.userId)

  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])
  const hostOfInstanceUrl = value => {
    const text = String(value || '').trim()
    if (!text) return ''
    try {
      return new URL(text).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    } catch (_) {
      return text.toLowerCase().replace(/^\[|\]$/g, '')
    }
  }

  /**
   * 判断 NapCat 实例是否与念风后端在同一台机器。
   * 只有本机实例才尝试 file:/// 图片发送；远程 NapCat 读不到本机路径，
   * 强发会出现“消息发出去但图片空白”的情况。
   */
  const isInstanceLocal = instanceId => {
    const instance = instanceOf(instanceId)
    if (!instance) return false
    if (instance.mode === 'reverse') {
      const host = String(instance.host || instance.url || '127.0.0.1').toLowerCase().replace(/^\[|\]$/g, '')
      return LOCAL_HOSTS.has(host) || host === '127.0.0.1'
    }
    const host = hostOfInstanceUrl(instance.url)
    return LOCAL_HOSTS.has(host)
  }

  /* ---------------- 群成员 ---------------- */

  async function fetchGroupMembers(instanceId, groupId, { refresh = false } = {}) {
    const cacheKey = `${instanceId}:${groupId}`
    const cached = MEMBER_CACHE.get(cacheKey)
    if (!refresh && cached && Date.now() - cached.at < MEMBER_CACHE_MS) {
      return { ok: true, members: cached.members, cached: true }
    }
    const result = await callOneBot(instanceId, 'get_group_member_list', {
      group_id: String(groupId),
      no_cache: refresh === true,
    })
    if (!result.ok) return { ok: false, code: result.code, error: result.error }
    const rows = Array.isArray(result.data) ? result.data : []
    const members = rows.map(normalizeMember).filter(member => member.qq)
    MEMBER_CACHE.set(cacheKey, { at: Date.now(), members })
    return { ok: true, members, cached: false }
  }

  /* ---------------- 踢人与黑名单联动 ---------------- */

  const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

  /**
   * 踢一个群成员。会做硬性保护：自己、群主、保护名单；并自动携带
   * reject_add_request（是否把对方加入 QQ 自己的「拒绝再次加群」名单）。
   */
  async function kickMember(instanceId, groupId, qq, { rule = null, reason = '', source = 'manual' } = {}) {
    const target = normalizeQq(qq)
    const gid = normalizeQq(groupId)
    if (!instanceId || !gid || !target) return { ok: false, error: '缺少 instanceId / groupId / qq。' }
    const botQq = botQqOf(instanceId)
    if (botQq && target === botQq) return { ok: false, skipped: true, qq: target, groupId: gid, error: '不能对机器人自己执行踢人。' }
    const guardList = Array.isArray(rule?.protectedUsers) ? rule.protectedUsers : protectedUsers()
    if (guardList.includes(target)) return { ok: false, skipped: true, qq: target, groupId: gid, error: `${target} 在保护名单中，已跳过。` }

    const info = await callOneBot(instanceId, 'get_group_member_info', { group_id: gid, user_id: target, no_cache: true })
    if (!info.ok) return { ok: false, skipped: true, qq: target, groupId: gid, error: `目标不在群内或无法查询：${info.error}` }
    const member = normalizeMember(info.data)
    if (member.role === 'owner') return { ok: false, skipped: true, qq: target, groupId: gid, error: '目标是群主，无法踢出。' }

    const rejectAdd = rule?.kickRejectAdd !== undefined ? toBool(rule.kickRejectAdd, kickRejectAdd()) : kickRejectAdd()
    // 清理踢人要在 action 前打标记，避免 NapCat 的 group_decrease 事件比响应先到而被当成“被踢自动拉黑”。
    // 标记同时写入后端租约：多页面同时在线时，处理 group_decrease 的那个页面也能识别出这是清理踢人。
    if (source === 'cleanup') {
      markCleanupKick(gid, target)
      await markSharedCleanupKick(instanceId, gid, target)
    }
    const result = await callOneBot(instanceId, 'set_group_kick', {
      group_id: gid,
      user_id: target,
      reject_add_request: rejectAdd,
    })
    if (!result.ok) {
      if (source === 'cleanup') {
        CLEANUP_RECENT.delete(`${gid}:${target}`)
        await releaseSharedLease(cleanupKickMarkerKey(instanceId, gid, target))
      }
      return { ok: false, qq: target, groupId: gid, error: result.error }
    }

    ctx.logger.info(`[napcat-group-guard] 踢出 ${member.display}(${target}) @ ${gid}${rejectAdd ? '，拒绝再次加群' : ''}（${reason || source}）`)
    emitAction('kick', { groupId: gid, qq: target, rejectAdd, source, reason })
    return { ok: true, qq: target, groupId: gid, rejectAdd, source, reason }
  }

  /** 把某个黑名单里的人从所有关联群里踢出去。 */
  async function enforceBlacklist(qq, listId = DEFAULT_BLACKLIST) {
    const target = normalizeQq(qq)
    if (!target) return []
    const id = String(listId || DEFAULT_BLACKLIST).trim() || DEFAULT_BLACKLIST
    const results = []
    for (const channel of groupChannels()) {
      const groupId = groupIdOf(channel)
      if (!groupId) continue
      const rule = resolveRule(groupId, channelNameOf(channel))
      if (!rule.managed || !rule.enabled || !rule.autoKickBlacklisted || rule.blacklistId !== id) continue
      const outcome = await kickMember(instanceIdOf(channel), groupId, target, {
        rule,
        reason: `黑名单「${id}」联动踢出`,
        source: 'blacklist',
      })
      results.push({ group_id: groupId, group_name: channelNameOf(channel), ...outcome })
    }
    return results
  }

  /**
   * 加入黑名单并按规则联动：
   *   - kick：是否尝试把仍在关联群里的人踢出（每个群还会看自己的 autoKickBlacklisted）；
   *   - notifyTargets：拉黑后要把「黑名单提示」发到哪些群（每个群可单独关 notifyBlacklist）；
   *   - nickname：调用方已经知道的昵称，避免重复查询。
   */
  async function addBlacklistAndEnforce(qq, listId, reason, { kick = true, notifyTargets = [], nickname = '' } = {}) {
    const added = addBlacklistEntry(qq, listId, reason)
    if (!added.ok) return added

    let kicked = []
    if (kick) kicked = await enforceBlacklist(added.qq, added.list)

    const notices = []
    if (added.added && Array.isArray(notifyTargets) && notifyTargets.length) {
      for (const item of notifyTargets) {
        const groupId = normalizeQq(item?.groupId)
        const instanceId = String(item?.instanceId || '').trim()
        if (!groupId || !instanceId) continue
        const rule = item.rule || resolveRule(groupId, item.groupName || groupDisplayName(groupId))
        const pushed = await sendBlacklistNotice(instanceId, groupId, {
          qq: added.qq,
          nickname: item.nickname || nickname,
          reason: reason || '未注明原因',
          listId: added.list,
          rule,
        })
        notices.push({ group_id: groupId, ok: pushed.ok, skipped: pushed.skipped === true, error: pushed.error })
      }
    }
    return { ...added, kicked, notices }
  }

  /** 黑名单新增后需要提示的目标群：所有使用该黑名单的已配置群渠道。 */
  function notifyTargetsForList(listId) {
    const id = String(listId || DEFAULT_BLACKLIST).trim() || DEFAULT_BLACKLIST
    const targets = []
    for (const channel of groupChannels()) {
      const groupId = groupIdOf(channel)
      if (!groupId) continue
      const rule = resolveRule(groupId, channelNameOf(channel))
      if (!rule.managed || !rule.enabled || rule.blacklistId !== id) continue
      targets.push({ instanceId: instanceIdOf(channel), groupId, groupName: channelNameOf(channel), rule })
    }
    return targets
  }

  /** 每个群拉一次成员列表，把当前生效黑名单里仍在群里的人清出去（启动补扫用）。 */
  async function enforceBlacklistScan() {
    if (!enabled()) return []
    const lists = readBlacklists()
    const kicked = []
    for (const channel of groupChannels()) {
      const groupId = groupIdOf(channel)
      if (!groupId) continue
      const rule = resolveRule(groupId, channelNameOf(channel))
      if (!rule.managed || !rule.enabled || !rule.autoKickBlacklisted) continue
      const qqs = lists[rule.blacklistId] || []
      if (!qqs.length) continue
      const fetched = await fetchGroupMembers(instanceIdOf(channel), groupId, { refresh: true })
      if (!fetched.ok) continue
      const wanted = new Set(qqs)
      for (const member of fetched.members) {
        if (!wanted.has(member.qq)) continue
        const result = await kickMember(instanceIdOf(channel), groupId, member.qq, {
          rule,
          reason: '启动补踢黑名单成员',
          source: 'startup-scan',
        })
        if (result.ok) kicked.push({ group_id: groupId, group_name: channelNameOf(channel), qq: member.qq })
      }
    }
    return kicked
  }

  /** 黑名单里仍在群内的成员，执行一次批量踢出。 */
  async function kickBlacklistedMembers(listId = '') {
    const id = String(listId || '').trim()
    const lists = id ? { [ensureBlacklist(id)]: blacklistMembers(id) } : readBlacklists()
    const results = []
    for (const [name, qqs] of Object.entries(lists)) {
      for (const qq of qqs) {
        const kicked = await enforceBlacklist(qq, name)
        results.push({ list: name, qq, groups: kicked })
      }
    }
    return results
  }

  /* ---------------- 群名与消息 ---------------- */

  function groupDisplayName(groupId) {
    const channel = findChannelByGroupId(groupId)
    return channel ? channelNameOf(channel) : normalizeQq(groupId)
  }

  async function sendGroupText(instanceId, groupId, text, { atAll = false, action = 'notice' } = {}) {
    let value = String(text ?? '')
    if (!value.trim()) return { ok: false, error: '消息内容为空。' }
    const segments = []
    if (atAll) {
      // 文案模板默认自带「@全体成员」，而 atAll 还会插入一个真实 at segment；
      // 不去掉文字里的前缀就会渲染成「@全体成员 @全体成员」，所以这里只保留一个。
      value = value.replace(/^[ \t\u3000]*@全体成员[ \t\u3000]*/, '')
      segments.push({ type: 'at', data: { qq: 'all' } })
      if (value.trim()) segments.push({ type: 'text', data: { text: ` ${value}` } })
    } else {
      segments.push({ type: 'text', data: { text: value } })
    }
    const result = await callOneBot(instanceId, 'send_group_msg', { group_id: String(groupId), message: segments })
    if (result.ok) emitAction(action, { groupId: String(groupId), atAll })
    return result
  }

  /* ---------------- 入群审核判定 ---------------- */

  /**
   * 纯函数判定：
   *   1. 已在黑名单 -> 拒绝；
   *   2. 命中黑词 -> 拒绝并拉黑；
   *   3. 需要等级但查不到（隐藏）-> 按约定拒绝；
   *   4. 等级低于限制 -> 拒绝；
   *   5. 配置了白词但回答不包含任何白词 -> 拒绝。
   * 除黑名单 / 黑词外的拒绝会累计「连续被拒绝」次数，达到上限自动拉黑。
   */
  function decideJoin(rule, { level = null, answer = '', isBlacklisted = false } = {}) {
    if (isBlacklisted) {
      return { approve: false, reason: '黑名单用户', countRejection: false, autoBlacklist: false, blacklistReason: '' }
    }

    const blackHit = matchWords(answer, rule.blacklistWords)
    if (blackHit) {
      return {
        approve: false,
        reason: formatTemplate(rule.blackwordRejectReason, { word: blackHit }),
        countRejection: false,
        autoBlacklist: true,
        blacklistReason: `命中进群黑词：${blackHit}`,
        blackword: blackHit,
      }
    }

    const needLevel = rule.minLevel > 0 || rule.requireVisibleLevel
    if (needLevel && level === null) {
      return { approve: false, reason: DEFAULT_LEVEL_FAIL_REASON, countRejection: true, autoBlacklist: false, blacklistReason: '' }
    }
    if (rule.minLevel > 0 && level !== null && level < rule.minLevel) {
      return { approve: false, reason: `等级低于${rule.minLevel}`, countRejection: true, autoBlacklist: false, blacklistReason: '' }
    }
    if (rule.whitelistWords.length) {
      const whiteHit = matchWords(answer, rule.whitelistWords)
      if (!whiteHit) {
        return { approve: false, reason: rule.answerRejectReason, countRejection: true, autoBlacklist: false, blacklistReason: '' }
      }
    }
    return { approve: true, reason: '', countRejection: false, autoBlacklist: false, blacklistReason: '', matched: true }
  }

  async function fetchApplicantInfo(instanceId, qq) {
    const result = await callOneBot(instanceId, 'get_stranger_info', { user_id: normalizeQq(qq), no_cache: true })
    if (!result.ok) return { ok: false, error: result.error, nickname: '', level: null, raw: null }
    const data = result.data && typeof result.data === 'object' ? result.data : {}
    return {
      ok: true,
      nickname: String(data.nickname ?? data.nick ?? '').trim(),
      level: parseQqLevel(data),
      raw: data,
    }
  }

  async function resolveNickname(instanceId, qq, fallback = '') {
    if (fallback) return fallback
    const info = await fetchApplicantInfo(instanceId, qq)
    return info.nickname || normalizeQq(qq)
  }

  async function sendGroupSegments(instanceId, groupId, segments, action = 'notice') {
    const list = Array.isArray(segments) ? segments.filter(Boolean) : []
    if (!list.length) return { ok: false, error: '消息内容为空。' }
    const result = await callOneBot(instanceId, 'send_group_msg', { group_id: String(groupId), message: list })
    if (result.ok) emitAction(action, { groupId: String(groupId) })
    return result
  }

  /** 拉取 QQ 资料 + 群成员资料，供提示文本和档案图使用。 */
  async function fetchProfileSnapshot(instanceId, groupId, qq) {
    const id = normalizeQq(qq)
    const [strangerRes, memberRes] = await Promise.all([
      callOneBot(instanceId, 'get_stranger_info', { user_id: id, no_cache: true }, { silent: true }),
      groupId
        ? callOneBot(instanceId, 'get_group_member_info', { group_id: normalizeQq(groupId), user_id: id, no_cache: true }, { silent: true })
        : Promise.resolve({ ok: false }),
    ])
    const s = strangerRes.ok && strangerRes.data && typeof strangerRes.data === 'object' ? strangerRes.data : {}
    const m = memberRes.ok && memberRes.data ? normalizeMember(memberRes.data) : null
    return {
      qq: id,
      nickname: String(s.nickname ?? s.nick ?? m?.nickname ?? '').trim() || id,
      level: parseQqLevel(s),
      signature: String(s.long_nick ?? s.longNick ?? '').trim(),
      sex: String(s.sex ?? '').trim(),
      age: Number(s.age) || 0,
      qid: String(s.qid ?? '').trim(),
      vip: toBool(s.is_vip ?? s.isVip, false),
      vipYears: toBool(s.is_years_vip ?? s.isYearsVip, false),
      vipLevel: Number(s.vip_level ?? s.vipLevel) || 0,
      regTime: Number(s.reg_time ?? s.regTime) || 0,
      avatar: `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(id)}&s=640`,
      member: m && m.qq ? m : null,
    }
  }

  function fetchWithTimeout(url, timeoutMs = 6000, options = {}) {
    if (typeof fetch !== 'function') return Promise.resolve(null)
    if (typeof AbortController !== 'function') return fetch(url, options)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
  }

  async function blobToDrawableImage(blob) {
    if (!blob || !blob.size) return null
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(blob)
      } catch (_) {
        /* fall through */
      }
    }
    if (typeof Image === 'undefined') return null
    return new Promise(resolve => {
      const objectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : ''
      if (!objectUrl) return resolve(null)
      const image = new Image()
      const finish = value => {
        try {
          URL.revokeObjectURL(objectUrl)
        } catch (_) {
          /* ignore */
        }
        resolve(value)
      }
      image.onload = () => finish(image)
      image.onerror = () => finish(null)
      image.src = objectUrl
    })
  }

  function loadImageElement(url, { crossOrigin = true, timeoutMs = 3500 } = {}) {
    if (typeof Image === 'undefined') return Promise.resolve(null)
    return new Promise(resolve => {
      const image = new Image()
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      image.onload = () => finish(image)
      image.onerror = () => finish(null)
      try {
        if (crossOrigin) image.crossOrigin = 'anonymous'
        image.src = url
      } catch (_) {
        finish(null)
      }
    })
  }

  /**
   * 头像加载顺序：本机后端代理（不受 CORS 限制）→ QQ 头像 CDN fetch → CORS Image。
   * 代理路由由本插件的 bridge.mjs 提供；没装后端桥或旧进程未重启时，退回直接 CDN。
   */
  async function loadAvatarImage(qq) {
    // Node / 无浏览器图片能力的测试环境直接跳过，避免无意义的网络等待；
    // 真实浏览器一定有 Image，走下面的后端代理 / CDN 加载。
    if (typeof Image === 'undefined' && typeof createImageBitmap === 'undefined') return null
    const id = normalizeQq(qq)
    if (!id) return null
    const origin = typeof location !== 'undefined' ? String(location.origin || '') : ''
    const base = origin && origin !== 'null' ? origin : ''
    const proxyUrl = `${base}/api/group-guard/avatar?qq=${encodeURIComponent(id)}`
    const candidates = [
      proxyUrl,
      `https://q4.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(id)}&spec=640`,
      `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(id)}&spec=640&img_type=jpg`,
      `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(id)}&s=640`,
    ]

    // 优先走后端桥的 JSON data URL：Node 侧下载头像，浏览器只加载 data URL，
    // 不经过 CORS / Blob / createImageBitmap，和 AstrBot 服务端取头像的思路一致。
    try {
      const response = await fetchWithTimeout(`${base}/api/group-guard/avatar?qq=${encodeURIComponent(id)}&format=json`, 8000, {
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (response?.ok) {
        const data = await response.json().catch(() => null)
        if (data?.dataUrl) {
          const image = await loadImageElement(data.dataUrl, { crossOrigin: false, timeoutMs: 4000 })
          if (image) return image
        }
      }
    } catch (_) {
      /* 旧后端 / 桥未加载时继续走下面的候选 */
    }

    for (const url of candidates) {
      const isProxy = url === proxyUrl
      if (isProxy || typeof fetch === 'function') {
        try {
          const response = await fetchWithTimeout(url, isProxy ? 8000 : 5000, {
            mode: isProxy ? 'same-origin' : 'cors',
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (response?.ok) {
            const contentType = String(response.headers?.get?.('content-type') || 'image/jpeg').toLowerCase()
            const blob = await response.blob()
            if (contentType.startsWith('image/') || String(blob?.type || '').startsWith('image/')) {
              const image = await blobToDrawableImage(blob)
              if (image) return image
            }
          }
        } catch (_) {
          /* 尝试下一种加载方式 */
        }
      }
      const image = await loadImageElement(url, { crossOrigin: !isProxy, timeoutMs: 4000 })
      if (image) return image
    }
    return null
  }

  function canvasRoundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2)
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + width, y, x + width, y + height, r)
    ctx.arcTo(x + width, y + height, x, y + height, r)
    ctx.arcTo(x, y + height, x, y, r)
    ctx.arcTo(x, y, x + width, y, r)
    ctx.closePath()
  }

  function canvasTextLines(ctx, text, maxWidth, maxLines = 2) {
    const source = String(text ?? '').trim()
    if (!source) return []
    const lines = []
    let line = ''
    for (const char of source) {
      const next = line + char
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line)
        line = char
        if (lines.length >= maxLines) break
      } else {
        line = next
      }
    }
    if (lines.length < maxLines && line) lines.push(line)
    if (lines.length >= maxLines && source.length > lines.join('').length) {
      lines[maxLines - 1] = lines[maxLines - 1].slice(0, Math.max(1, lines[maxLines - 1].length - 1)) + '…'
    }
    return lines
  }

  function profileHash(text) {
    let hash = 2166136261
    for (const char of String(text ?? '')) {
      hash ^= char.charCodeAt(0)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0')
  }

  const actionLabelOf = eventType => {
    if (eventType === 'request') return { text: '进群申请', color: '#38bdf8' }
    if (eventType === 'join') return { text: '入群', color: '#4ade80' }
    if (eventType === 'leave') return { text: '退群', color: '#fbbf24' }
    return { text: '移出群聊', color: '#fb7185' }
  }

  /**
   * 把 Canvas 导出成 base64。档案图如果太大，后端 action 路由的 2MB JSON
   * 上限会把整条 send_group_msg 打回，连文字一起丢失；这里逐级降质，
   * 仍然超限时再整体缩小，尽量让图片成功发出去。
   */
  function exportDossierCanvas(canvas) {
    let lastUrl = ''
    let lastError = null
    for (const quality of DOSSIER_JPEG_QUALITIES) {
      try {
        const url = canvas.toDataURL('image/jpeg', quality)
        if (!url || !url.includes(',')) continue
        lastUrl = url
        const base64 = url.split(',')[1] || ''
        if (base64.length <= MAX_DOSSIER_BASE64_CHARS) return { dataUrl: url, base64, quality }
      } catch (err) {
        lastError = err
      }
    }
    // 低质量仍超限：整体缩到约 70%，再导一次 JPEG。
    try {
      const scaled = document.createElement('canvas')
      scaled.width = Math.max(320, Math.round(canvas.width * 0.7))
      scaled.height = Math.max(200, Math.round(canvas.height * 0.7))
      const scaledCtx = scaled.getContext('2d')
      if (scaledCtx) {
        scaledCtx.drawImage(canvas, 0, 0, scaled.width, scaled.height)
        const url = scaled.toDataURL('image/jpeg', 0.72)
        if (url && url.includes(',')) {
          const base64 = url.split(',')[1] || ''
          if (base64.length <= MAX_DOSSIER_BASE64_CHARS) return { dataUrl: url, base64, quality: 0.72, scaled: true }
          lastUrl = url
        }
      }
    } catch (err) {
      lastError = lastError || err
    }
    if (lastUrl) {
      // 实在压不下去也返回，让上层照发并记日志；可能是 NapCat 端支持更大 body。
      const base64 = lastUrl.split(',')[1] || ''
      logger.warn(`[napcat-group-guard] 档案图偏大（base64 ${base64.length} 字符，建议上限 ${MAX_DOSSIER_BASE64_CHARS}），仍尝试发送。`)
      return { dataUrl: lastUrl, base64, quality: 0, oversized: true }
    }
    if (lastError) logger.warn(`[napcat-group-guard] 档案图导出失败：${lastError?.message || lastError}`)
    return null
  }

  /**
   * 画一张原创风格的「QQ 档案」卡片（暗色终端 / 情报档案风，和参考项目无关联）。
   * 只使用 Canvas，生成失败时返回 null，调用方退化为纯文字提示。
   *
   * 头像来自 QQ 头像代理 / CDN：如果头像把 Canvas 弄脏导致 toDataURL 失败，
   * 会立刻用“不带头像”的纯绘制方式重试一次，保证至少能发出档案图。
   */
  async function buildOpenBoxImage(profile, options = {}) {
    try {
      const image = await buildOpenBoxImageOnce(profile, options)
      if (image || options.skipAvatar) return image
      logger.warn(`[napcat-group-guard] 档案图首次导出为空，改为不带头像重试（QQ ${profile?.qq || '未知'}）。`)
      return await buildOpenBoxImageOnce(profile, { ...options, skipAvatar: true })
    } catch (err) {
      if (!options.skipAvatar) {
        logger.warn(`[napcat-group-guard] 档案图绘制失败，改为不带头像重试：${err?.message || err}`)
        try {
          return await buildOpenBoxImageOnce(profile, { ...options, skipAvatar: true })
        } catch (retryErr) {
          logger.warn(`[napcat-group-guard] 档案图不带头像重试仍失败：${retryErr?.message || retryErr}`)
          return null
        }
      }
      logger.warn(`[napcat-group-guard] 档案图绘制失败：${err?.message || err}`)
      return null
    }
  }

  async function buildOpenBoxImageOnce(profile, { eventType = 'join', groupName = '', skipAvatar = false } = {}) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
    let canvas
    try {
      canvas = document.createElement('canvas')
    } catch (_) {
      return null
    }
    if (typeof canvas?.getContext !== 'function') return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    const width = 860
    const height = 550
    // 输出尺寸适当缩小，显著降低 base64 体积，避免图片在 NapCat / QQ 通道上
    // 因为载荷过大被拒；绘制坐标仍按 860x550 的逻辑尺寸写，统一由 scale 缩放。
    canvas.width = 760
    canvas.height = 486
    ctx.scale(canvas.width / width, canvas.height / height)

    const accent = actionLabelOf(eventType)
    const gradient = ctx.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, '#071019')
    gradient.addColorStop(0.55, '#0b1a24')
    gradient.addColorStop(1, '#10121c')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)

    // 网格 + 斜向条纹：终端情报面板风格
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.07)'
    ctx.lineWidth = 1
    for (let x = 0; x < width; x += 34) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
    }
    for (let y = 0; y < height; y += 34) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
    ctx.save()
    ctx.translate(width - 250, 0)
    ctx.rotate(-0.35)
    ctx.fillStyle = 'rgba(56, 189, 248, 0.045)'
    for (let i = 0; i < 8; i += 1) ctx.fillRect(i * 44, -120, 18, height + 240)
    ctx.restore()

    // 左上角与右下角框线
    ctx.strokeStyle = accent.color
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(22, 56)
    ctx.lineTo(22, 22)
    ctx.lineTo(78, 22)
    ctx.moveTo(width - 78, height - 22)
    ctx.lineTo(width - 22, height - 22)
    ctx.lineTo(width - 22, height - 56)
    ctx.stroke()

    // 顶部条
    ctx.fillStyle = 'rgba(2, 10, 18, 0.72)'
    ctx.fillRect(22, 22, width - 44, 46)
    ctx.fillStyle = '#5eead4'
    ctx.font = 'bold 17px "Microsoft YaHei", "PingFang SC", sans-serif'
    ctx.fillText('QQ 资料档案 · PROFILE DOSSIER', 40, 52)
    const badgeWidth = ctx.measureText(accent.text).width + 34
    const badgeX = width - 38 - badgeWidth
    ctx.fillStyle = accent.color
    canvasRoundRect(ctx, badgeX, 32, badgeWidth, 26, 6)
    ctx.fill()
    ctx.fillStyle = '#041018'
    ctx.font = 'bold 14px "Microsoft YaHei", "PingFang SC", sans-serif'
    ctx.fillText(accent.text, badgeX + 17, 50)

    // 头像框
    const avatarX = 46
    const avatarY = 100
    const avatarSize = 148
    const avatar = skipAvatar ? null : await loadAvatarImage(profile.qq)
    ctx.save()
    canvasRoundRect(ctx, avatarX, avatarY, avatarSize, avatarSize, 16)
    ctx.clip()
    if (avatar) {
      const scale = Math.max(avatarSize / avatar.width, avatarSize / avatar.height)
      const dw = avatar.width * scale
      const dh = avatar.height * scale
      ctx.drawImage(avatar, avatarX + (avatarSize - dw) / 2, avatarY + (avatarSize - dh) / 2, dw, dh)
    } else {
      const avatarBg = ctx.createLinearGradient(avatarX, avatarY, avatarX + avatarSize, avatarY + avatarSize)
      avatarBg.addColorStop(0, '#0f766e')
      avatarBg.addColorStop(1, '#1e293b')
      ctx.fillStyle = avatarBg
      ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize)
      ctx.fillStyle = 'rgba(226, 232, 240, 0.92)'
      ctx.font = 'bold 58px "Microsoft YaHei", "PingFang SC", sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(String(profile.nickname || profile.qq || '?').slice(0, 1), avatarX + avatarSize / 2, avatarY + avatarSize / 2 + 20)
      ctx.textAlign = 'left'
    }
    ctx.restore()
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.75)'
    ctx.lineWidth = 2
    canvasRoundRect(ctx, avatarX, avatarY, avatarSize, avatarSize, 16)
    ctx.stroke()

    // 主信息
    ctx.textAlign = 'left'
    ctx.fillStyle = '#e2e8f0'
    ctx.font = 'bold 30px "Microsoft YaHei", "PingFang SC", sans-serif'
    ctx.fillText(String(profile.nickname || profile.qq).slice(0, 18), 226, 136)
    ctx.fillStyle = '#5eead4'
    ctx.font = 'bold 19px "Consolas", "Microsoft YaHei", monospace'
    ctx.fillText(`QQ ${profile.qq}`, 228, 168)

    ctx.fillStyle = '#94a3b8'
    ctx.font = '14px "Microsoft YaHei", "PingFang SC", sans-serif'
    const signatureLines = canvasTextLines(ctx, profile.signature || '这个人很神秘，什么都没有写。', 560, 2)
    signatureLines.forEach((line, index) => ctx.fillText(line, 228, 198 + index * 21))

    // 数据徽章
    const chips = [
      ['等级', profile.level === null ? '隐藏' : profile.level],
      ['性别 / 年龄', `${profile.sex && profile.sex !== 'unknown' ? profile.sex : '未知'} / ${profile.age || '—'}`],
      ['VIP', profile.vip ? `Lv.${profile.vipLevel || 1}${profile.vipYears ? ' 年费' : ''}` : '无'],
      ['QID', profile.qid || '—'],
    ]
    let chipX = 226
    const chipY = 254
    ctx.font = '13px "Microsoft YaHei", "PingFang SC", sans-serif'
    for (const [label, value] of chips) {
      const valueText = String(value)
      const chipWidth = ctx.measureText(`${label} ${valueText}`).width + 26
      ctx.fillStyle = 'rgba(15, 118, 110, 0.26)'
      canvasRoundRect(ctx, chipX, chipY, chipWidth, 30, 8)
      ctx.fill()
      ctx.strokeStyle = 'rgba(94, 234, 212, 0.35)'
      ctx.stroke()
      ctx.fillStyle = '#cbd5e1'
      ctx.fillText(`${label} `, chipX + 12, chipY + 20)
      ctx.fillStyle = '#f8fafc'
      ctx.fillText(valueText, chipX + 12 + ctx.measureText(`${label} `).width, chipY + 20)
      chipX += chipWidth + 10
    }

    // 群成员资料区：两列各 3 行，留出足够高度，避免文字溢出到页脚
    const member = profile.member
    const memberCardX = 46
    const memberCardY = 318
    const memberCardWidth = width - 92
    const memberCardHeight = 118
    ctx.fillStyle = 'rgba(2, 10, 18, 0.55)'
    canvasRoundRect(ctx, memberCardX, memberCardY, memberCardWidth, memberCardHeight, 12)
    ctx.fill()
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)'
    ctx.stroke()
    ctx.fillStyle = '#5eead4'
    ctx.font = 'bold 14px "Microsoft YaHei", "PingFang SC", sans-serif'
    ctx.fillText('群成员资料', memberCardX + 18, memberCardY + 28)
    ctx.font = '13px "Microsoft YaHei", "PingFang SC", sans-serif'
    ctx.fillStyle = '#cbd5e1'
    if (member) {
      const leftParts = [
        `群名片：${member.card || '—'}`,
        `角色：${member.role === 'owner' ? '群主' : member.role === 'admin' ? '管理员' : '成员'}`,
        `群等级：${member.level || '—'}`,
      ]
      const rightParts = [
        `头衔：${member.title || member.specialTitle || '无'}`,
        `入群：${fmtTime(member.join_time) || '未知'}`,
        `最后发言：${fmtTime(member.last_sent_time) || '未发言'}`,
      ]
      leftParts.forEach((line, index) => ctx.fillText(line, memberCardX + 18, memberCardY + 56 + index * 22))
      rightParts.forEach((line, index) => ctx.fillText(line, memberCardX + 424, memberCardY + 56 + index * 22))
    } else {
      ctx.fillText('未读取到群成员资料（可能已不在群内，或 NapCat 未返回）。', memberCardX + 18, memberCardY + 60)
    }

    // 底部：档案编号 / 时间 / 条码
    const dossierId = `${profileHash(`${profile.qq}:${eventType}`)}-${String(Date.now()).slice(-6)}`
    ctx.fillStyle = '#64748b'
    ctx.font = '12px "Consolas", monospace'
    ctx.fillText(`档案编号 ${dossierId}`, 46, 496)
    ctx.fillText(`${groupName || '群聊'} · ${fmtTime(Date.now())}`, 46, 518)
    ctx.textAlign = 'right'
    ctx.fillText('由 念风 · 群管助手 生成', width - 46, 518)
    ctx.textAlign = 'left'

    // 用 QQ 号画一个装饰条码
    const barX = width - 300
    for (let i = 0; i < 44; i += 1) {
      const digit = Number(String(profile.qq).charCodeAt(i % String(profile.qq).length) || 0) % 4
      ctx.fillStyle = i % 3 === 0 ? accent.color : 'rgba(226, 232, 240, 0.55)'
      ctx.fillRect(barX + i * 5, 486, digit ? 3 : 1.5, digit ? 26 : 14)
    }

    return exportDossierCanvas(canvas)
  }

  /** 提取图片 segment 的 data URL；只有 base64:// / data: 可以转换。 */
  function imageDataUrlOf(segment) {
    const file = String(segment?.data?.file || '')
    if (!file) return ''
    if (file.startsWith('data:image/')) return file
    if (file.startsWith('base64://')) {
      const mime = String(segment?.data?.mime || 'image/jpeg').trim() || 'image/jpeg'
      return `data:${mime};base64,${file.slice('base64://'.length)}`
    }
    return ''
  }

  /** 把 base64:// 图片转成 data:image/...;base64,... 形式，兼容不同 NapCat 版本。 */
  function imageSegmentAsDataUrl(segment) {
    const dataUrl = imageDataUrlOf(segment)
    if (!dataUrl) return null
    return { ...segment, data: { ...segment.data, file: dataUrl } }
  }

  /** 把图片交给插件后端桥落盘，换取 NapCat 可以直接读取的 file:/// 本地路径。 */
  async function imageSegmentAsFileUrl(segment) {
    const dataUrl = imageDataUrlOf(segment)
    if (!dataUrl) return null
    const client = ctx.registry.get('api')
    if (!client?.post) return null
    try {
      const result = await client.post('/group-guard/image', { dataUrl }, { timeoutMs: 60000 })
      if (result?.ok && result.fileUrl) {
        return {
          ...segment,
          data: {
            ...segment.data,
            file: result.fileUrl,
            mime: result.mime || segment.data?.mime || 'image/jpeg',
            path: result.path,
          },
        }
      }
    } catch (err) {
      ctx.logger.debug?.(`[napcat-group-guard] 档案图落盘失败：${err?.message || err}`)
    }
    return null
  }

  // 图片是硬要求：base64 / data URL / file:// 都失败时进入补发队列，绝不退化为纯文字。
  const PENDING_IMAGE_SENDS = new Map()
  const MAX_PENDING_IMAGE_SENDS = 50
  const MAX_PENDING_IMAGE_ATTEMPTS = 60
  const PENDING_IMAGE_FLUSH_MS = 10000
  let pendingImageTimer = null

  function ensurePendingImageTimer() {
    if (pendingImageTimer) return
    pendingImageTimer = setInterval(() => {
      flushPendingImageSends().catch(err => ctx.logger.debug?.(`[napcat-group-guard] 档案图补发队列执行失败：${err?.message || err}`))
    }, PENDING_IMAGE_FLUSH_MS)
    pendingImageTimer?.unref?.()
  }

  function queuePendingImageSend(instanceId, groupId, segments, { action = 'notice', label = '提示', error = '' } = {}) {
    if (PENDING_IMAGE_SENDS.size >= MAX_PENDING_IMAGE_SENDS) {
      const oldest = [...PENDING_IMAGE_SENDS.entries()].sort((a, b) => (a[1].queuedAt || 0) - (b[1].queuedAt || 0))[0]
      if (oldest) PENDING_IMAGE_SENDS.delete(oldest[0])
    }
    const key = `${instanceId}:${groupId}:${action}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    PENDING_IMAGE_SENDS.set(key, {
      instanceId,
      groupId,
      segments,
      action,
      label,
      attempts: 0,
      error,
      queuedAt: Date.now(),
      nextAt: Date.now() + 5000,
    })
    ensurePendingImageTimer()
    ctx.logger.warn(`[napcat-group-guard] ${label}发送失败，已进入图片补发队列（不会退化为纯文字）：${error}`)
  }

  async function flushPendingImageSends() {
    const now = Date.now()
    for (const [key, entry] of [...PENDING_IMAGE_SENDS]) {
      if (entry.nextAt > now) continue
      const outcome = await trySendImageVariants(entry.instanceId, entry.groupId, entry.segments, entry.action, entry.label)
      if (outcome.ok) {
        PENDING_IMAGE_SENDS.delete(key)
        ctx.logger.info(`[napcat-group-guard] ${entry.label}档案图补发成功。`)
        continue
      }
      entry.attempts += 1
      entry.error = outcome.error || entry.error
      if (entry.attempts >= MAX_PENDING_IMAGE_ATTEMPTS) {
        PENDING_IMAGE_SENDS.delete(key)
        ctx.logger.warn(`[napcat-group-guard] ${entry.label}连续补发 ${entry.attempts} 次仍失败，已放弃：${entry.error}`)
      } else {
        entry.nextAt = Date.now() + Math.min(60000, 5000 * entry.attempts)
      }
    }
    if (!PENDING_IMAGE_SENDS.size && pendingImageTimer) {
      clearInterval(pendingImageTimer)
      pendingImageTimer = null
    }
  }

  /** 依次尝试 base64 / data URL / file:// 三种图片载荷；图片失败时试图片单独发送，绝不发纯文字。 */
  async function trySendImageVariants(instanceId, groupId, segments, action = 'notice', label = '提示') {
    const list = Array.isArray(segments) ? segments.filter(Boolean) : []
    const imageSegments = list.filter(segment => segment?.type === 'image')
    const textSegments = list.filter(segment => segment?.type !== 'image')
    if (!imageSegments.length) {
      const only = await sendGroupSegments(instanceId, groupId, textSegments, `${action}_text`)
      return only.ok ? { ok: true, result: only } : { ok: false, error: only.error }
    }

    const variants = []
    const localInstance = isInstanceLocal(instanceId)
    const uploadCache = new Map()
    const fileSegmentOf = async image => {
      const dataUrl = imageDataUrlOf(image)
      if (!dataUrl) return null
      if (uploadCache.has(dataUrl)) return uploadCache.get(dataUrl)
      const fileSegment = await imageSegmentAsFileUrl(image)
      uploadCache.set(dataUrl, fileSegment)
      return fileSegment
    }
    const push = (items, tag) => {
      if (Array.isArray(items) && items.length && items.every(Boolean)) variants.push({ segments: items, tag })
    }
    // 1) 整条消息：base64:// / 原样
    push(list, 'base64')
    // 2) 整条消息：data URL 图片
    push(list.map(segment => (segment?.type === 'image' ? imageSegmentAsDataUrl(segment) : segment)), 'data')
    // 3) 整条消息：file:// 本地路径（仅本机 NapCat；远程实例读不到本机文件）
    if (localInstance) {
      for (const image of imageSegments) {
        const fileSegment = await fileSegmentOf(image)
        if (!fileSegment) continue
        push(list.map(segment => (segment === image ? fileSegment : segment)), 'file')
        break
      }
    } else if (imageSegments.length) {
      ctx.logger.debug?.(`[napcat-group-guard] NapCat 实例 ${instanceId} 非本机，跳过 file:// 图片方案。`)
    }
    let lastError = ''
    for (const variant of variants) {
      const result = await sendGroupSegments(instanceId, groupId, variant.segments, `${action}_${variant.tag}`)
      if (result.ok) {
        if (variant.tag !== 'base64') {
          ctx.logger.info(`[napcat-group-guard] ${label}已改用 ${variant.tag} 形式发送成功。`)
        }
        return { ok: true, result }
      }
      lastError = result.error || lastError
      ctx.logger.debug?.(`[napcat-group-guard] ${label} ${variant.tag} 发送失败：${lastError}`)
    }
    return { ok: false, error: lastError || '图片发送失败' }
  }

  /**
   * 发送带图消息的统一入口：
   *   - 有图：base64 → data URL → 本机 file://（远程实例自动跳过）；整条消息仍然失败则进补发队列，绝不拆成另一条图片消息；
   *   - 无图（openBoxImage 关闭的纯文字通知）：按原逻辑发送。
   */
  async function sendGroupSegmentsWithImageFallback(instanceId, groupId, segments, { action = 'notice', label = '提示' } = {}) {
    const list = Array.isArray(segments) ? segments.filter(Boolean) : []
    const hasImage = list.some(segment => segment?.type === 'image')
    if (!hasImage) {
      const result = await sendGroupSegments(instanceId, groupId, list, action)
      if (!result.ok) ctx.logger.warn(`[napcat-group-guard] ${label}发送失败：${result.error}`)
      return result
    }
    const outcome = await trySendImageVariants(instanceId, groupId, list, action, label)
    if (outcome.ok) return outcome.result
    // 队列前尽量把图片落盘（仅本机 NapCat）：减少内存占用，也保留 file:// 路径。
    const retrySegments = []
    for (const segment of list) {
      if (segment?.type === 'image' && isInstanceLocal(instanceId)) {
        const fileSegment = await imageSegmentAsFileUrl(segment)
        if (fileSegment) {
          retrySegments.push(fileSegment)
          continue
        }
      }
      retrySegments.push(segment)
    }
    queuePendingImageSend(instanceId, groupId, retrySegments, { action, label, error: outcome.error })
    return { ok: false, code: 'IMAGE_SEND_PENDING', error: outcome.error, pending: true }
  }

  /**
   * 极简降级档案图：不加载任何网络资源，只用纯色矩形 + 文字。
   * 正常档案图连“不带头像重试”都失败时用它兜底；它仍然是一张带昵称/QQ
   * 的卡片，而不是空白色块。
   */
  async function buildFallbackDossierImage(profile, { eventType = 'join', groupName = '' } = {}) {
    try {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
      const canvas = document.createElement('canvas')
      canvas.width = 760
      canvas.height = 486
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      const accent = actionLabelOf(eventType)
      ctx.fillStyle = '#0b1220'
      ctx.fillRect(0, 0, 760, 486)
      ctx.fillStyle = '#111c31'
      ctx.fillRect(22, 22, 716, 442)
      ctx.strokeStyle = accent.color
      ctx.lineWidth = 3
      ctx.strokeRect(22, 22, 716, 442)
      ctx.fillStyle = '#5eead4'
      ctx.font = 'bold 28px "Microsoft YaHei", "PingFang SC", sans-serif'
      ctx.fillText('QQ 资料档案 · PROFILE DOSSIER', 54, 88)
      ctx.fillStyle = accent.color
      ctx.font = 'bold 22px "Microsoft YaHei", "PingFang SC", sans-serif'
      ctx.fillText(accent.text, 54, 132)
      ctx.fillStyle = '#e2e8f0'
      ctx.font = 'bold 38px "Microsoft YaHei", "PingFang SC", sans-serif'
      ctx.fillText(String(profile?.nickname || profile?.qq || '未知').slice(0, 18), 54, 220)
      ctx.fillStyle = '#94a3b8'
      ctx.font = '24px "Consolas", "Microsoft YaHei", monospace'
      ctx.fillText(`QQ ${profile?.qq || ''}`, 56, 268)
      ctx.fillStyle = '#cbd5e1'
      ctx.font = '20px "Microsoft YaHei", "PingFang SC", sans-serif'
      ctx.fillText(`群聊：${groupName || '群聊'}`, 54, 330)
      ctx.fillStyle = '#64748b'
      ctx.font = '16px "Microsoft YaHei", "PingFang SC", sans-serif'
      ctx.fillText('档案图降级模式（无头像 / 无网络资源）', 54, 384)
      ctx.fillText(fmtTime(Date.now()), 54, 414)
      return exportDossierCanvas(canvas)
    } catch (err) {
      ctx.logger.warn(`[napcat-group-guard] 极简档案图也生成失败：${err?.message || err}`)
      return null
    }
  }

  /** 调用后端桥在服务端渲染档案图（headless / 无 Canvas 实例的主路径）。 */
  async function buildDossierOnServer(profile, { eventType = 'join', groupName = '', label = '档案图' } = {}) {
    const client = ctx.registry.get('api')
    if (!client?.post) return null
    try {
      const result = await client.post('/group-guard/render', { profile, eventType, groupName }, { timeoutMs: 30000 })
      if (result?.ok && result.base64) {
        if (result.warning) ctx.logger.warn(`[napcat-group-guard] ${label}服务端渲染降级：${result.warning}`)
        ctx.logger.debug?.(`[napcat-group-guard] ${label}使用服务端渲染成功（${result.renderer || 'server'}，${result.bytes || 0} 字节）。`)
        return { base64: result.base64, dataUrl: result.dataUrl, mime: result.mime || 'image/png' }
      }
      if (result?.error) ctx.logger.warn(`[napcat-group-guard] ${label}服务端渲染失败：${result.error}`)
    } catch (err) {
      ctx.logger.warn(`[napcat-group-guard] ${label}服务端渲染请求失败：${err?.message || err}`)
    }
    return null
  }

  /** 生成档案图 segment；失败时写警告日志并返回 null（调用方不允许退化为纯文字）。 */
  async function buildDossierSegment(profile, { eventType = 'join', groupName = '', label = '档案图' } = {}) {
    let image = null
    // 有浏览器 Canvas 时优先本地生成（更快、样式更完整）。
    if (canRenderDossier()) image = await buildOpenBoxImage(profile, { eventType, groupName })
    if (!image?.base64) {
      // 无 Canvas（服务端代聊 headless）或本地生成失败：走后端服务端渲染
      // （PowerShell + System.Drawing，失败会自动降级为纯 Node PNG）。
      image = await buildDossierOnServer(profile, { eventType, groupName, label })
    }
    if (!image?.base64 && canRenderDossier()) {
      ctx.logger.warn(`[napcat-group-guard] ${label}本地与服务端渲染都失败，改用极简档案图（事件 ${eventType}，QQ ${profile?.qq || '未知'}）。`)
      image = await buildFallbackDossierImage(profile, { eventType, groupName })
    }
    if (!image?.base64) {
      ctx.logger.warn(`[napcat-group-guard] ${label}生成失败，且所有渲染器都不可用；按“必须有图”要求，本次不发送纯文字。`)
      return null
    }
    const mime = String(image.dataUrl || '').match(/^data:([^;,]+)/i)?.[1] || 'image/png'
    return { type: 'image', data: { file: `base64://${image.base64}`, mime } }
  }

  /**
   * 进群提示：欢迎文本与档案图合并发送成同一条消息。
   * 档案图开关与欢迎文本开关相互独立——即使欢迎语关了，只要档案图开着，
   * 正常入群 / 被拉进群 / 审批入群都会带上一张资料卡。
   */
  async function sendJoinWelcome(instanceId, groupId, qq, rule, { profile: prefetchedProfile = null } = {}) {
    const effective = rule || resolveRule(groupId, groupDisplayName(groupId))
    if (!effective.enabled) return { ok: true, skipped: true }
    const sendText = !!effective.notifyJoinSuccess
    const sendImage = !!effective.openBoxImage
    if (!sendText && !sendImage) return { ok: true, skipped: true }
    const profile = prefetchedProfile || (await fetchProfileSnapshot(instanceId, groupId, qq))
    const segments = []
    if (sendImage) {
      const segment = await buildDossierSegment(profile, { eventType: 'join', groupName: effective.groupName, label: '进群欢迎' })
      if (!segment) return { ok: false, code: 'IMAGE_REQUIRED', error: '进群欢迎档案图生成失败，按配置不发送纯文字。' }
      segments.push(segment)
    }
    if (sendText) {
      const text = formatTemplate(effective.joinTemplate, {
        nickname: profile.nickname,
        qq: profile.qq,
        level: profile.level === null ? '隐藏' : profile.level,
        group: effective.groupName || groupDisplayName(groupId),
        group_id: normalizeQq(groupId),
        time: fmtTime(Date.now()),
      })
      // 不用真正的 at 消息段：部分 NapCat / QQ 版本在「at + 图片」同条发送时
      // 容易把图片弄丢或显示空白；改成文字 @，视觉几乎一致，图片发送更稳。
      const mention = `@${profile.nickname || normalizeQq(qq)} `
      segments.unshift({ type: 'text', data: { text: `${mention}${text}` } })
    }
    if (!segments.length) return { ok: true, skipped: true }
    return sendGroupSegmentsWithImageFallback(instanceId, groupId, segments, { action: 'join_notice', label: '进群欢迎' })
  }

  /**
   * 退群 / 被踢 / 黑名单拦截 / 清理踢出提示：文本与档案图永远在同一条
   * send_group_msg 里；文本开关关闭时只要档案图开启，也会单独发送资料卡。
   */
  async function sendDecreaseNotice(instanceId, groupId, { subType = 'leave', qq = '', operator = '', nickname = '', rule = null, mergeBlacklist = null, profile: prefetchedProfile = null } = {}) {
    const effective = rule || resolveRule(groupId, groupDisplayName(groupId))
    if (!effective.enabled) return { ok: true, skipped: true }
    const sendText = !!effective.notifyDecrease
    const sendImage = !!effective.openBoxImage
    if (!sendText && !sendImage) return { ok: true, skipped: true }
    const profile = prefetchedProfile || (await fetchProfileSnapshot(instanceId, groupId, qq))
    const name = nickname || profile.nickname || normalizeQq(qq)
    const segments = []
    let imageSegment = null
    if (sendImage) {
      imageSegment = await buildDossierSegment(profile, {
        eventType: subType === 'leave' ? 'leave' : 'kick',
        groupName: effective.groupName,
        label: subType === 'leave' ? '退群提示' : '移出群提示',
      })
      if (!imageSegment) return { ok: false, code: 'IMAGE_REQUIRED', error: `${subType === 'leave' ? '退群提示' : '移出群提示'}档案图生成失败，按配置不发送纯文字。` }
    }
    if (sendText) {
      const template =
        subType === 'leave'
          ? effective.leaveTemplate
          : subType === 'blacklist'
            ? effective.blacklistKickTemplate
            : subType === 'cleanup'
              ? effective.cleanupKickTemplate
              : effective.kickTemplate
      let text = formatTemplate(template, {
        nickname: name,
        qq: normalizeQq(qq),
        operator: operator ? normalizeQq(operator) : '管理员',
        group: effective.groupName || groupDisplayName(groupId),
        group_id: normalizeQq(groupId),
        action: subType === 'leave' ? '主动退群' : subType === 'cleanup' ? '被清理移出' : subType === 'blacklist' ? '被安全拦截' : '被移出群聊',
        level: profile.level === null ? '隐藏' : profile.level,
        time: fmtTime(Date.now()),
      })
      // 主动退群 / 被踢同时触发自动拉黑时，把黑名单提示合并进同一条消息，
      // 避免一个事件在群里出现两条重复的文本提示。
      if (mergeBlacklist && effective.notifyBlacklist) {
        const blacklistText = formatTemplate(effective.blacklistTemplate || DEFAULT_BLACKLIST_TEMPLATE, {
          nickname: name,
          qq: normalizeQq(qq),
          reason: mergeBlacklist.reason || '未注明原因',
          list: mergeBlacklist.listId || DEFAULT_BLACKLIST,
          group: effective.groupName || groupDisplayName(groupId),
          group_id: normalizeQq(groupId),
          time: fmtTime(Date.now()),
        })
        text = `${text}\n\n${blacklistText}`
      }
      segments.push({ type: 'text', data: { text } })
    }
    if (imageSegment) segments.push(imageSegment)
    if (!segments.length) return { ok: true, skipped: true }
    return sendGroupSegmentsWithImageFallback(instanceId, groupId, segments, { action: 'decrease_notice', label: subType === 'leave' ? '退群提示' : '移出群提示' })
  }

  /** 拉黑提示：按群规则决定开关和模板（不发档案图，避免刷屏）。 */
  async function sendBlacklistNotice(instanceId, groupId, { qq = '', nickname = '', reason = '', listId = DEFAULT_BLACKLIST, rule = null } = {}) {
    const effective = rule || resolveRule(groupId, groupDisplayName(groupId))
    if (!effective.notifyBlacklist || !effective.enabled) return { ok: true, skipped: true }
    const name = await resolveNickname(instanceId, qq, nickname)
    const text = formatTemplate(effective.blacklistTemplate, {
      nickname: name,
      qq: normalizeQq(qq),
      reason: reason || '未注明原因',
      list: listId || DEFAULT_BLACKLIST,
      group: effective.groupName || groupDisplayName(groupId),
      group_id: normalizeQq(groupId),
      time: fmtTime(Date.now()),
    })
    const result = await sendGroupText(instanceId, groupId, text, { action: 'blacklist_notice' })
    if (!result.ok) ctx.logger.warn(`[napcat-group-guard] 拉黑提示发送失败：${result.error}`)
    return result
  }

  const processingFlags = new Set()

  /**
   * 处理一条入群申请：查资料 -> 判定 -> 同意 / 拒绝 -> 黑名单联动 -> 群内提示。
   * 由 napcat:request 事件与定时补偿轮询共用，纯代码，不经过 LLM。
   * flag 在同一页面内加锁；只有处理完成（或演练）后才持久化已处理标记，
   * NapCat action 失败时保留标记不写，下一轮补偿轮询会重试。
   */
  async function reviewJoinRequest({ instanceId, raw = {} } = {}) {
    if (!enabled()) return { ok: false, code: 'GG_DISABLED', error: '群管助手已禁用。' }
    // headless 实例同样参与抢申请租约；图片走服务端渲染，不再等浏览器 WebUI。
    const iid = String(instanceId || '').trim()
    const groupId = normalizeQq(raw.group_id)
    const qq = normalizeQq(raw.user_id ?? raw.requester_uin)
    const flag = normalizeQq(raw.flag ?? raw.request_id)
    const answer = extractAnswer(raw.comment ?? raw.message)
    if (!iid || !groupId || !qq || !flag) {
      return { ok: false, code: 'BAD_REQUEST', error: '入群申请缺少 instanceId / group_id / user_id / flag。' }
    }

    const rule = resolveRule(groupId, groupDisplayName(groupId))
    if (!rule.managed) return { ok: true, skipped: true, reason: '该群未配置在群管助手中，已忽略。' }
    if (!rule.autoReview) return { ok: true, skipped: true, reason: '该群未开启自动审核。' }
    if (isFlagProcessed(flag) || processingFlags.has(flag)) return { ok: true, skipped: true, reason: '该申请已处理过。' }
    processingFlags.add(flag)

    const sharedKey = leaseKey('request', iid, groupId, qq, flag)
    const inflightKey = leaseKey('request-inflight', iid, groupId, qq)
    let inflightHeld = false
    try {
      // 事件 flag 与补偿轮询 request_id 在某些 NapCat 版本里可能不同；
      // 再加一把「同一群同一申请人正在处理中」的短租约，兜住这种差异。
      const inflight = await claimSharedLease(inflightKey, 60 * 1000)
      if (!inflight.claimed) return { ok: true, skipped: true, reason: '同一申请正在由其他页面处理。' }
      inflightHeld = true
      const lease = await claimSharedLease(sharedKey, 2 * 60 * 1000)
      if (!lease.claimed) return { ok: true, skipped: true, reason: '该申请正在由其他页面处理。' }
      // 抢到租约后再看一次本地已处理标记：另一个页面可能刚处理完并通过配置同步过来。
      if (isFlagProcessed(flag)) {
        await releaseSharedLease(sharedKey)
        return { ok: true, skipped: true, reason: '该申请已处理过。' }
      }
      const result = await reviewJoinRequestLocked({ iid, groupId, qq, flag, answer, raw, rule })
      // 处理失败时释放租约，让补偿轮询 / 其它页面立即重试；演练模式也不长期占坑。
      if (!result.ok || result.dry_run) await releaseSharedLease(sharedKey)
      return result
    } catch (err) {
      await releaseSharedLease(sharedKey)
      throw err
    } finally {
      if (inflightHeld) await releaseSharedLease(inflightKey)
      processingFlags.delete(flag)
    }
  }

  async function reviewJoinRequestLocked({ iid, groupId, qq, flag, answer, raw, rule }) {
    // 一次把 QQ 资料 + 群成员资料取齐，审核文案和“进群申请档案图”共用。
    const profile = await fetchProfileSnapshot(iid, groupId, qq)
    const nickname = (profile.nickname && profile.nickname !== qq ? profile.nickname : '') || String(raw.nickname ?? raw.requester_nick ?? '').trim() || qq
    const level = profile.level
    const blacklisted = isBlacklisted(qq, rule.blacklistId)
    const decision = decideJoin(rule, { level, answer, isBlacklisted: blacklisted })

    const isDryRun = dryRun()
    // 提前把「这次会被拉黑」写进拒绝理由，让申请人一眼看到；真正计数/拉黑仍以 action 成功为准。
    const willReachBlacklist =
      !isDryRun &&
      !decision.approve &&
      !decision.blackword &&
      decision.countRejection &&
      rule.maxReject > 0 &&
      rejectionCount(groupId, qq) + 1 >= rule.maxReject
    if (willReachBlacklist && !String(decision.reason).includes('已加入黑名单')) {
      decision.reason = `${decision.reason}（已加入黑名单）`
    }

    let actionResult = { ok: true, suppressed: true, error: '' }
    if (!isDryRun) {
      actionResult = await callOneBot(iid, 'set_group_add_request', {
        flag,
        sub_type: 'add',
        approve: decision.approve,
        reason: decision.approve ? ' ' : String(decision.reason || ' ').slice(0, 200),
      })
    }

    // 只有真正处理成功才计入「连续拒绝」；演练模式只提示、不计数、不拉黑；
    // OneBot action 失败时不写已处理标记，下一轮补偿轮询会重试。
    const actionEffective = !isDryRun && actionResult.ok
    let rejectCount = rejectionCount(groupId, qq)
    if (actionEffective) {
      if (decision.approve) {
        clearRejection(groupId, qq)
      } else if (decision.countRejection) {
        rejectCount = recordRejection(groupId, qq)
        if (rule.maxReject > 0 && rejectCount >= rule.maxReject) {
          decision.autoBlacklist = true
          decision.blacklistReason = `连续进群被拒绝${rule.maxReject}次`
          if (!String(decision.reason).includes('已加入黑名单')) decision.reason = `${decision.reason}（已加入黑名单）`
        }
      }
    } else if (!decision.blackword) {
      // 演练 / action 失败时不因为「连续拒绝次数」拉黑，等真正拒绝成功后再计数。
      decision.autoBlacklist = false
    }

    let blacklistResult = null
    if (decision.autoBlacklist && !isDryRun) {
      blacklistResult = await addBlacklistAndEnforce(qq, rule.blacklistId, decision.blacklistReason || decision.reason || '入群审核自动拉黑', {
        kick: true,
      })
    }

    if (isDryRun || actionResult.ok) markFlagProcessed(flag)

    const resultText = isDryRun
      ? `演练：${decision.approve ? '将同意' : `将拒绝（${decision.reason}）`}`
      : decision.approve
        ? actionResult.ok
          ? '已同意'
          : `自动处理失败：${actionResult.error}（原决定：同意）`
        : actionResult.ok
          ? `已拒绝：${decision.reason}`
          : `自动处理失败：${actionResult.error}（原决定：拒绝，${decision.reason}）`

    // 已在黑名单的人反复申请时，静默处理，不再往群里推进群提示，避免刷屏。
    // 进群申请提示固定纯文字：申请卡片信息已经足够，图片只留给欢迎 / 退群通知。
    if (!blacklisted && rule.notifyOnRequest && rule.enabled) {
      const text = formatTemplate(rule.notifyTemplate || DEFAULT_NOTIFY_TEMPLATE, {
        nickname,
        qq,
        level: level === null ? '查询失败 / 已隐藏' : level,
        answer: answer || '（未填写）',
        result: resultText,
        reason: decision.reason || '',
        group: rule.groupName || groupDisplayName(groupId),
        group_id: groupId,
        time: fmtTime(Date.now()),
      })
      const pushed = await sendGroupText(iid, groupId, text, { action: 'request_notice' })
      if (!pushed.ok) ctx.logger.warn(`[napcat-group-guard] 入群申请提示发送失败：${pushed.error}`)
    }

    emitAction(decision.approve ? 'request_approved' : 'request_rejected', {
      groupId,
      qq,
      flag,
      nickname,
      level,
      answer,
      reason: decision.reason,
      rejectCount,
      autoBlacklist: !!decision.autoBlacklist,
      dryRun: isDryRun,
      actionOk: actionResult.ok,
    })

    return {
      ok: actionResult.ok || isDryRun,
      approve: decision.approve,
      reason: decision.reason,
      reject_count: rejectCount,
      auto_blacklist: !!decision.autoBlacklist,
      blacklist: blacklistResult,
      nickname,
      qq,
      level,
      answer,
      action_error: actionResult.ok ? undefined : actionResult.error,
      dry_run: isDryRun,
    }
  }

  /* ---------------- notice：被踢 / 退群 / 黑名单成员入群 ---------------- */

  async function handleNotice(payload = {}) {
    if (!enabled()) return
    // headless 实例同样参与抢 notice 租约；服务端渲染失败会自动降级纯 Node 图。
    const raw = payload?.raw && typeof payload.raw === 'object' ? payload.raw : {}
    const instanceId = String(payload?.instanceId || '').trim()
    const type = String(raw.notice_type || payload?.noticeType || '').trim()
    const groupId = normalizeQq(raw.group_id)
    const qq = normalizeQq(raw.user_id)
    if (!instanceId || !groupId || !qq) return
    if (type !== 'group_decrease' && type !== 'group_increase') return

    const rule = resolveRule(groupId, groupDisplayName(groupId))
    if (!rule.managed) return

    const botQq = botQqOf(instanceId)
    if (botQq && qq === botQq) return

    // NapCat / SSE 重连时同一个 notice 可能被投递多次；多页面同时在线时每个
    // 页面也都会收到同一份。先用页面内指纹去重，再用后端租约让全网只处理一次。
    const fingerprint = noticeFingerprint(payload, raw)
    if (isRecentNotice(instanceId, fingerprint)) return
    markRecentNotice(instanceId, fingerprint)
    const noticeLease = await claimSharedLease(leaseKey('notice', instanceId, fingerprint), 60 * 1000)
    if (!noticeLease.claimed) return

    if (type === 'group_increase') {
      // 黑名单用户被邀请 / 被管理员放进来时，照样触发踢出；入群成功也重置连续拒绝计数。
      if (rejectionCount(groupId, qq) > 0) clearRejection(groupId, qq)

      // 先取一次成员资料：既用于欢迎文案 / 档案图，也拿 join_time 判断这条 notice
      // 到底是不是刚发生的新入群。NapCat 断线重连 / 事件积压后会补发旧 notice，
      // 只靠 15s / 60s 的短去重完全挡不住几小时后的重放，所以这里再做两层防线：
      //   1) 同一次入群（实例 + 群 + QQ + join_time）持久化记忆，成功处理过就不再欢迎；
      //   2) 入群时间距现在过久时直接跳过，避免升级/清空状态后旧事件又补一遍欢迎。
      let profile = null
      try {
        profile = await fetchProfileSnapshot(instanceId, groupId, qq)
      } catch (err) {
        logger.debug(`[napcat-group-guard] 读取入群成员资料失败，跳过入群时间校验：${err?.message || err}`)
      }
      const joinAt = epochSeconds(profile?.member?.join_time) || epochSeconds(raw.time) || 0
      const alreadyGreeted = isJoinGreeted(instanceId, groupId, qq, joinAt)
      const stale = joinAt > 0 && Date.now() - joinAt * 1000 > JOIN_NOTICE_FRESH_MS

      if (rule.autoKickBlacklisted && isBlacklisted(qq, rule.blacklistId)) {
        // 旧事件重放时不再重复发档案卡 / 拦截提示，但仍尝试踢出，保证黑名单最终生效。
        if (alreadyGreeted || stale) {
          await markKickNoticeSent(instanceId, groupId, qq)
          const result = await kickMember(instanceId, groupId, qq, { rule, reason: '黑名单成员入群', source: 'notice-increase' })
          if (!result.ok && !result.skipped) ctx.logger.warn(`[napcat-group-guard] 黑名单入群自动踢出失败：${result.error}`)
          return
        }
        markJoinGreeted(instanceId, groupId, qq, joinAt)
        // 先发同一条消息里的档案卡 + 拦截提示，再执行踢出；这样无论 NapCat 之后
        // 是否补发 group_decrease，用户都能看到完整资料卡。
        await markKickNoticeSent(instanceId, groupId, qq)
        await sendDecreaseNotice(instanceId, groupId, { subType: 'blacklist', qq, rule, profile }).catch(err =>
          logger.warn(`[napcat-group-guard] 黑名单入群档案卡发送失败：${err?.message || err}`),
        )
        const result = await kickMember(instanceId, groupId, qq, { rule, reason: '黑名单成员入群', source: 'notice-increase' })
        if (!result.ok && !result.skipped) ctx.logger.warn(`[napcat-group-guard] 黑名单入群自动踢出失败：${result.error}`)
        return
      }

      if (alreadyGreeted) {
        logger.debug(`[napcat-group-guard] 群 ${groupId} 成员 ${qq} 的同一次入群已处理过，忽略重复 notice。`)
        return
      }
      if (stale) {
        ctx.logger.warn(
          `[napcat-group-guard] 忽略过期的入群 notice：群 ${groupId} 成员 ${qq}（入群时间 ${fmtTime(joinAt)}），` +
            `疑似 NapCat 断线重连 / 事件积压后补发，已跳过欢迎以免和历史通知重复。`,
        )
        return
      }
      markJoinGreeted(instanceId, groupId, qq, joinAt)
      // 正常入群 / 被拉进群：文本和档案图是否发送由 sendJoinWelcome 内部按
      // notifyJoinSuccess / openBoxImage 分别判断，始终合并为一条消息。
      await sendJoinWelcome(instanceId, groupId, qq, rule, { profile }).catch(err => logger.warn(`[napcat-group-guard] 进群欢迎失败：${err?.message || err}`))
      return
    }

    const subType = String(raw.sub_type || '').trim()
    if (subType === 'kick_me') {
      ctx.logger.warn(`[napcat-group-guard] 机器人被移出群 ${groupId}，该群自动管理已暂停能力等待重新入群。`)
      return
    }
    if (!subType) return

    // 黑名单成员入群时已经发过“档案卡 + 拦截提示”并执行了踢出；
    // NapCat 随后补发的 group_decrease(kick) 只消费标记，不重复发第二条。
    if (subType === 'kick' && (await consumeKickNoticeSent(instanceId, groupId, qq))) return

    // 本插件清理批次踢的人：标记消费掉后直接返回，不再逐人补发“文本 + 档案图”。
    // 执行清理的页面会在批次结束后统一发一条文本摘要，避免档案图刷屏。
    if (subType === 'kick' && (isRecentCleanupKick(groupId, qq) || (await isSharedCleanupKick(instanceId, groupId, qq)))) {
      CLEANUP_RECENT.delete(`${normalizeQq(groupId)}:${normalizeQq(qq)}`)
      logger.debug?.(`[napcat-group-guard] 群 ${groupId} 清理踢出 ${qq}，等待批次汇总，不逐人发档案图。`)
      return
    }

    if (subType === 'kick') {
      const operator = normalizeQq(raw.operator_id)
      // 机器人自己动作踢出的成员（清理、黑名单联动）不再触发「被踢自动拉黑」：
      // 清理是否拉黑由 cleanup.blacklistKicked 决定；黑名单联动在踢人前已经写入。
      // 后端租约不可用时，这条兜底也能防止其它页面把清理踢人误判成管理员踢人。
      const kickedByBot = operator && botQq && operator === botQq
      const skipAutoBlacklist = kickedByBot && (rule.cleanup?.enabled || isBlacklisted(qq, rule.blacklistId))
      const willBlacklist = rule.autoBlacklistOnKick && !skipAutoBlacklist
      const reason = operator && operator !== botQq ? `被管理员 ${operator} 移出群` : '被踢出群'
      const mergeBlacklist = willBlacklist && rule.notifyDecrease && rule.notifyBlacklist
      await sendDecreaseNotice(instanceId, groupId, {
        subType: 'kick',
        qq,
        operator,
        rule,
        mergeBlacklist: mergeBlacklist ? { reason, listId: rule.blacklistId } : null,
      })
      if (!willBlacklist) return
      await addBlacklistAndEnforce(qq, rule.blacklistId, reason, {
        kick: false,
        // 已经合并进退群提示时不再单独发第二条黑名单文本；关闭黑名单提示时也不发。
        notifyTargets:
          rule.notifyBlacklist && !mergeBlacklist
            ? [{ instanceId, groupId, groupName: rule.groupName, rule }]
            : [],
      })
      return
    }
    if (subType === 'leave') {
      const willBlacklist = !!rule.autoBlacklistOnLeave
      const mergeBlacklist = willBlacklist && rule.notifyDecrease && rule.notifyBlacklist
      await sendDecreaseNotice(instanceId, groupId, {
        subType: 'leave',
        qq,
        rule,
        mergeBlacklist: mergeBlacklist ? { reason: '主动退群', listId: rule.blacklistId } : null,
      })
      if (!willBlacklist) return
      await addBlacklistAndEnforce(qq, rule.blacklistId, '主动退群', {
        kick: false,
        notifyTargets:
          rule.notifyBlacklist && !mergeBlacklist
            ? [{ instanceId, groupId, groupName: rule.groupName, rule }]
            : [],
      })
    }
  }

  /* ---------------- napcat:request 事件与补偿轮询 ---------------- */

  const processingRequests = new Set()

  async function handleRequestEvent(payload = {}) {
    const raw = payload?.raw && typeof payload.raw === 'object' ? payload.raw : {}
    if (String(raw.request_type || payload?.requestType || '').trim() !== 'group') return
    if (String(raw.sub_type || 'add').trim() !== 'add') return
    const instanceId = String(payload?.instanceId || '').trim()
    const groupId = normalizeQq(raw.group_id)
    const qq = normalizeQq(raw.user_id)
    const key = `${instanceId}:${groupId}:${qq}`
    if (processingRequests.has(key)) return
    processingRequests.add(key)
    try {
      await reviewJoinRequest({ instanceId, raw })
    } finally {
      processingRequests.delete(key)
    }
  }

  /** 补偿轮询：App 重启 / SSE 漏事件时，主动从 get_group_system_msg 捞未处理申请。 */
  async function pollPendingRequests() {
    if (!enabled()) return
    // 只轮询真正配置过的群，避免全局开关打开后把 NapCat 里所有群都补审一遍。
    const groups = groupChannels().filter(channel => {
      const rule = resolveRule(groupIdOf(channel), channelNameOf(channel))
      return rule.managed && rule.autoReview
    })
    if (!groups.length) return
    const allowedGroupIds = new Set(groups.map(channel => groupIdOf(channel)).filter(Boolean))
    const instanceIds = [...new Set(groups.map(instanceIdOf).filter(Boolean))]
    for (const instanceId of instanceIds) {
      const result = await callOneBot(instanceId, 'get_group_system_msg', { count: 50 }, { silent: true })
      if (!result.ok) continue
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      const joinRequests = Array.isArray(data.join_requests) ? data.join_requests : []
      for (const item of joinRequests) {
        if (toBool(item?.checked, false)) continue
        const itemGroupId = normalizeQq(item?.group_id)
        if (!allowedGroupIds.has(itemGroupId)) continue
        const raw = {
          request_type: 'group',
          sub_type: 'add',
          group_id: item?.group_id,
          user_id: item?.requester_uin ?? item?.user_id,
          comment: item?.message ?? item?.comment ?? '',
          flag: item?.request_id ?? item?.flag,
          nickname: item?.requester_nick,
        }
        await reviewJoinRequest({ instanceId, raw })
      }
    }
  }

  /* ---------------- 定时清理不活跃成员 ---------------- */

  let cleanupTimer = null
  let nextCleanupAt = 0
  let cleanupRunning = false
  let cleanupPerforming = false
  const cleanupKickTimers = new Map()
  let lastCleanupReport = null
  let cleanupDailyTickBusy = false

  const cleanupKey = (instanceId, groupId) => `${normalizeQq(instanceId)}:${normalizeQq(groupId)}`

  function cleanupScopeGroups() {
    return parseWords(config.get(pref('cleanup.groups'), ''))
  }

  function readCleanupRuns() {
    const runs = readState().cleanupRuns
    return runs && typeof runs === 'object' && !Array.isArray(runs) ? runs : {}
  }

  function readPendingCleanups() {
    const pending = readState().pendingCleanups
    return pending && typeof pending === 'object' && !Array.isArray(pending) ? pending : {}
  }

  function writePendingCleanups(pending) {
    writeState({ pendingCleanups: pending && typeof pending === 'object' ? pending : {} })
  }

  function ensureCleanupBaseline() {
    const state = readState()
    if (!Number(state.cleanupStartedAt)) writeState({ cleanupStartedAt: Date.now() })
  }

  function cleanupLastAt(key) {
    const value = readCleanupRuns()[key]
    return Number(typeof value === 'object' ? value?.at : value) || 0
  }

  function cleanupRunSeq(key) {
    const value = readCleanupRuns()[key]
    return Number(typeof value === 'object' ? value?.seq : 0) || 0
  }

  /** 工具手动触发的一次性「立即清理」：状态里写入 immediateAt，触发后随本轮状态覆盖清除。 */
  function immediateCleanupAt(target) {
    const run = readCleanupRuns()[target.key]
    const at = Number(typeof run === 'object' ? run?.immediateAt : 0) || 0
    if (!at) return 0
    if (Math.abs(Date.now() - at) > 10 * 60 * 1000) return 0
    return at
  }

  /** 自动清理的「踢人时刻」：周期锚点 + interval，再强制对齐到每天 18:00。 */
  function nextCleanupKickAtFor(target) {
    const last = cleanupLastAt(target.key) || Number(readState().cleanupStartedAt) || Date.now()
    const intervalMs = Math.max(1, Number(target.cfg.intervalMinutes) || 10080) * 60000
    return alignCleanupKickAt(last + intervalMs)
  }

  /** 调度器的「预告触发时刻」：踢人时刻 - warnMinutes；手动立即触发例外。 */
  function nextRunAtFor(target) {
    const immediateAt = immediateCleanupAt(target)
    if (immediateAt) return immediateAt
    const warnMs = Math.max(0, Number(target.cfg.warnMinutes) || 0) * 60000
    return nextCleanupKickAtFor(target) - warnMs
  }

  function kickIntervalMsOf(target) {
    return clampNumber(config.get(pref('cleanup.kickIntervalMs'), 300), 0, 10000, 300, { integer: true })
  }

  /**
   * 定时清理的目标群：默认全部已配置的 NapCat 群渠道，可用全局 cleanup.groups 缩小范围；
   * 每个群是否启用清理、周期 / 等待 / 天数 / 模板都由 resolveRule() 的群级覆盖决定。
   */
  function resolveCleanupTargets() {
    const scope = cleanupScopeGroups()
    const channels = groupChannels()
    let picked = []

    if (scope.length) {
      for (const ref of scope) {
        const wanted = String(ref).trim()
        const key = normalizeKey(wanted)
        const hit = isQqId(wanted)
          ? channels.find(channel => groupIdOf(channel) === normalizeQq(wanted))
          : channels.find(channel => normalizeKey(channelNameOf(channel)) === key || normalizeKey(groupIdOf(channel)) === key)
        if (hit) picked.push(hit)
        else ctx.logger.warn(`[napcat-group-guard] 清理目标「${wanted}」没有对应的群聊渠道，已跳过。`)
      }
    } else {
      picked = [...channels]
    }

    const seen = new Set()
    const targets = []
    for (const channel of picked) {
      const groupId = groupIdOf(channel)
      const instanceId = instanceIdOf(channel)
      if (!groupId || !instanceId) continue
      const rule = resolveRule(groupId, channelNameOf(channel))
      if (!rule.managed || !rule.enabled || !rule.cleanup.enabled) continue
      const key = cleanupKey(instanceId, groupId)
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({ channel, key, instanceId, groupId, name: channelNameOf(channel), rule, cfg: rule.cleanup })
    }
    return targets
  }

  function findCleanupTarget(key) {
    return resolveCleanupTargets().find(target => target.key === key) || null
  }

  function targetsDueNow(targets, force = false) {
    if (force) return targets
    const now = Date.now()
    return targets.filter(target => now >= nextRunAtFor(target) - 1000)
  }

  function cleanupNextInfo(target) {
    // at 现在表示「实际踢人时刻」，强制对齐到每天 18:00；
    // warnAt 是提前发 @全体预告的时刻（kickAt - warnMinutes）。
    const kickAt = nextCleanupKickAtFor(target)
    const warnAt = nextRunAtFor(target)
    const remainMs = Math.max(0, kickAt - Date.now())
    const days = Math.max(0, Math.ceil(remainMs / 86400000))
    return {
      at: kickAt,
      kickAt,
      warnAt,
      date: fmtShortTime(kickAt),
      days,
      daysText: days <= 0 ? '即将开始' : `${days} 天后`,
      intervalDays: Math.max(1, Math.round((Number(target?.cfg?.intervalMinutes) || 10080) / 1440)),
    }
  }

  /** 播报下一轮清理时间。daily=true 用每日播报模板，否则用“本轮清理结束”模板。 */
  async function sendCleanupNextNotice(target, { daily = false, inactiveCount = null } = {}) {
    const cfg = target?.cfg
    if (!cfg?.enabled) return { ok: false, code: 'CLEANUP_DISABLED', error: '该群未启用定时清理。' }
    const info = cleanupNextInfo(target)
    const template = daily ? cfg.dailyMessage : cfg.nextMessage
    if (!template || !info.at) return { ok: false, code: 'NO_MESSAGE', error: '没有可播报的下一轮清理时间或文案。' }
    const countText = inactiveCount === null || inactiveCount === undefined ? '未知' : String(Math.max(0, Number(inactiveCount) || 0))
    const text = formatTemplate(template, {
      next_date: info.date,
      next_time: info.date,
      next_kick_at: info.date,
      days: info.days,
      days_text: info.daysText,
      interval_days: info.intervalDays,
      count: countText,
      inactive_count: countText,
      pending: countText,
      group: target.name,
      group_id: target.groupId,
    })
    const sent = await sendGroupText(target.instanceId, target.groupId, text, { action: daily ? 'cleanup_daily' : 'cleanup_next' })
    if (!sent.ok) {
      ctx.logger.warn(`[napcat-group-guard] 群 ${target.groupId} ${daily ? '每日' : '清理结束'}播报发送失败：${sent.error}`)
    }
    return { ...sent, text, next_run_at: info.date, next_kick_at: info.date, count: countText, days: info.days }
  }

  /**
   * 每天约 20:00 播报下一轮清人时间。前端插件可能多页面同时在线，
   * 用后端租约保证同一天同一个群只播一次；页面在 20:00 后才打开也会补播。
   */
  async function maybeBroadcastDailyCleanup() {
    if (!enabled() || cleanupDailyTickBusy) return { ok: false, skipped: true }
    if (cleanupRunning || cleanupPerforming) return { ok: false, skipped: true, reason: '正在执行清理。' }
    cleanupDailyTickBusy = true
    try {
      const targets = resolveCleanupTargets()
      if (!targets.length) return { ok: true, sent: 0, reason: '没有启用清理的群。' }
      const now = new Date()
      const hour = clampNumber(config.get(pref('cleanup.dailyBroadcastHour'), 20), 0, 23, 20, { integer: true })
      const minute = clampNumber(config.get(pref('cleanup.dailyBroadcastMinute'), 0), 0, 59, 0, { integer: true })
      const start = new Date(now)
      start.setHours(hour, minute, 0, 0)
      if (now.getTime() < start.getTime()) return { ok: true, sent: 0, reason: '未到今天的播报时间。' }
      ensureCleanupBaseline()
      const dateKey = localDateKey(now)
      const state = readState()
      const previousMap = state.dailyCleanupBroadcast && typeof state.dailyCleanupBroadcast === 'object' ? state.dailyCleanupBroadcast : {}
      const nextMap = { ...previousMap }
      let sent = 0
      let changed = false
      for (const target of targets) {
        if (target.cfg.dailyBroadcast === false) continue
        if (nextMap[target.key] === dateKey) continue
        const lease = await claimSharedLease(leaseKey('cleanup-daily', target.key, dateKey), 23 * 60 * 60 * 1000)
        if (!lease.claimed) {
          // 其它页面已经接手。本地也记为已处理，避免一分钟轮询里反复抢租约。
          nextMap[target.key] = dateKey
          changed = true
          continue
        }
        // 每晚约 20:00 的播报里带上「按当前不活跃天数预计会清多少人」。
        let inactiveCount = null
        try {
          const fetched = await fetchGroupMembers(target.instanceId, target.groupId, { refresh: true })
          if (fetched.ok) inactiveCount = filterInactiveMembers(fetched.members, target.cfg, target).length
        } catch (err) {
          ctx.logger.debug?.(`[napcat-group-guard] 群 ${target.groupId} 每日播报统计不活跃人数失败：${err?.message || err}`)
        }
        const result = await sendCleanupNextNotice(target, { daily: true, inactiveCount })
        nextMap[target.key] = dateKey
        changed = true
        if (result.ok) sent += 1
      }
      for (const key of Object.keys(nextMap)) {
        if (nextMap[key] !== dateKey) delete nextMap[key]
      }
      if (changed) writeState({ dailyCleanupBroadcast: nextMap })
      return { ok: true, sent, date: dateKey, groups: targets.length }
    } finally {
      cleanupDailyTickBusy = false
    }
  }

  /**
   * 把指定群（默认当前群）的下一轮清理倒计时直接归零。
   * 写入一次性 immediateAt，让原有定时调度器照常触发；后续仍然先发
   * @全体预告、等待 warnMinutes、批量踢人、播报下一轮时间。
   * 工具手动触发属于用户主动操作，不受「固定 18:00」对齐限制。
   */
  async function triggerCleanupNow({ groupRef = '', context = null } = {}) {
    if (!enabled()) return { ok: false, code: 'GG_DISABLED', error: '群管助手已禁用。' }
    if (cleanupRunning || cleanupPerforming) return { ok: false, code: 'CLEANUP_BUSY', error: '正在执行另一轮清理，请稍后再触发。' }
    const resolved = await resolveRuleRef(groupRef, context)
    if (!resolved.ok) return resolved
    const channel = resolved.channel
    if (!channel || !isGroupChannel(channel) || !instanceIdOf(channel)) {
      return { ok: false, code: 'GROUP_NOT_CONFIGURED', error: `群 ${resolved.groupId} 没有对应的 NapCat 群聊渠道，无法触发清理。` }
    }
    const target = resolveCleanupTargets().find(item => item.key === cleanupKey(instanceIdOf(channel), resolved.groupId))
    if (!target) {
      return {
        ok: false,
        code: 'CLEANUP_DISABLED',
        error: `群 ${resolved.groupId} 没有启用定时清理，无法提前触发。请先在群管设置里开启本群清理。`,
      }
    }
    ensureCleanupBaseline()
    const runs = { ...readCleanupRuns() }
    const previous = runs[target.key]
    runs[target.key] = {
      ...(previous && typeof previous === 'object' ? previous : {}),
      at: Number(previous?.at) || Number(readState().cleanupStartedAt) || Date.now(),
      // 一次性「立即触发」标记；runCleanupCycle 处理完这一轮后会写入新的 at，该标记自然消失。
      immediateAt: Date.now() + 500,
      seq: Number(previous?.seq) || 0,
      advancedAt: Date.now(),
      advancedBy: 'tool',
    }
    writeState({ cleanupRuns: runs })
    scheduleNextCleanup(500)
    return {
      ok: true,
      action: 'cleanup_trigger',
      group: { id: target.groupId, name: target.name },
      warn_minutes: target.cfg.warnMinutes,
      inactive_days: target.cfg.inactiveDays,
      message: `已把「${target.name}」的下一轮清理倒计时缩减为立即触发；几秒后会按正常流程发送 @全体预告，等待 ${target.cfg.warnMinutes} 分钟后开始批量踢人。`,
    }
  }

  /**
   * 直接执行「已发过预告、正在等待踢人」的待办，不再补发 @全体预告。
   * 用于用户明确知道预告已经发过、只想让本次清理继续走完的场景。
   */
  async function kickPendingCleanupNow({ groupRef = '', context = null } = {}) {
    if (!enabled()) return { ok: false, code: 'GG_DISABLED', error: '群管助手已禁用。' }
    if (cleanupRunning || cleanupPerforming) return { ok: false, code: 'CLEANUP_BUSY', error: '正在执行另一轮清理，请稍后再试。' }
    const resolved = await resolveRuleRef(groupRef, context)
    if (!resolved.ok) return resolved
    const channel = resolved.channel
    if (!channel || !isGroupChannel(channel) || !instanceIdOf(channel)) {
      return { ok: false, code: 'GROUP_NOT_CONFIGURED', error: `群 ${resolved.groupId} 没有对应的 NapCat 群聊渠道，无法执行清理。` }
    }
    const key = cleanupKey(instanceIdOf(channel), resolved.groupId)
    const target = resolveCleanupTargets().find(item => item.key === key)
    if (!target) {
      return {
        ok: false,
        code: 'CLEANUP_DISABLED',
        error: `群 ${resolved.groupId} 当前没有启用清理，无法执行清理踢人。`,
      }
    }
    const pending = readPendingCleanups()
    if (!pending[key]) {
      return { ok: false, code: 'NO_PENDING', error: `群 ${resolved.groupId} 当前没有「已发预告、等待踢人」的清理待办，请使用 cleanup_trigger 或 cleanup_run 走完整流程。` }
    }
    // 把待办直接归零后交给正常踢人阶段：executePendingKick 不会再发 @全体预告，
    // 只读取成员列表、执行批量踢人并播报结果 / 下一轮时间。
    pending[key] = {
      ...pending[key],
      // 换一个 run seq 避免复用之前可能已被其它页面占用的租约。
      seq: (Number(pending[key].seq) || 0) + 1,
      kickAt: Date.now() - 1,
    }
    writePendingCleanups(pending)
    const timer = cleanupKickTimers.get(key)
    if (timer) {
      ctx.clearTimeout(timer)
      cleanupKickTimers.delete(key)
    }
    await executePendingKick(key)
    return {
      ok: true,
      action: 'cleanup_kick',
      group: { id: target.groupId, name: target.name },
      inactive_days: target.cfg.inactiveDays,
      message: `已立即执行「${target.name}」的清理踢人阶段（不再重新发送预告）。`,
    }
  }


  function filterInactiveMembers(members, cfg, target) {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const thresholdSeconds = Math.max(0.01, Number(cfg.inactiveDays) || 30) * 86400
    const protectedList = Array.isArray(target?.rule?.protectedUsers) ? target.rule.protectedUsers : protectedUsers()
    const botQq = botQqOf(target.instanceId)
    const rows = []
    for (const member of members || []) {
      if (!member?.qq) continue
      if (botQq && member.qq === botQq) continue
      if (member.role === 'owner') continue
      if (cfg.skipAdmins && member.role === 'admin') continue
      if (member.is_robot) continue
      if (protectedList.includes(member.qq)) continue
      const lastActive = Math.max(Number(member.last_sent_time) || 0, Number(member.join_time) || 0)
      if (lastActive <= 0) continue
      const inactiveSeconds = nowSeconds - lastActive
      if (inactiveSeconds < thresholdSeconds) continue
      rows.push({ ...member, inactive_seconds: inactiveSeconds, last_active_timestamp: lastActive })
    }
    return rows.sort((a, b) => b.inactive_seconds - a.inactive_seconds)
  }

  async function sendCleanupWarning(target) {
    const cfg = target.cfg
    const text = formatTemplate(cfg.message, {
      minutes: cfg.warnMinutes,
      days: cfg.inactiveDays,
      group: target.name,
      group_id: target.groupId,
    })
    const remain = await callOneBot(target.instanceId, 'get_group_at_all_remain', { group_id: target.groupId }, { silent: true })
    const canAtAll = remain.ok ? remain.data?.can_at_all !== false : true
    let sent = await sendGroupText(target.instanceId, target.groupId, text, { atAll: canAtAll, action: 'cleanup_warning' })
    if (!sent.ok && canAtAll) {
      sent = await sendGroupText(target.instanceId, target.groupId, text, { atAll: false, action: 'cleanup_warning' })
    }
    if (!sent.ok) ctx.logger.warn(`[napcat-group-guard] 群 ${target.groupId} 清理预告发送失败：${sent.error}`)
    return sent
  }

  function schedulePendingKick(key, kickAt) {
    const existing = cleanupKickTimers.get(key)
    if (existing) ctx.clearTimeout(existing)
    const timer = ctx.setTimeout(() => {
      cleanupKickTimers.delete(key)
      executePendingKick(key).catch(err => ctx.logger.error(`[napcat-group-guard] 群 ${key} 清理踢人失败：${err?.message || err}`))
    }, Math.max(1000, Number(kickAt) - Date.now()))
    cleanupKickTimers.set(key, timer)
  }

  function removePendingCleanup(key) {
    const pending = readPendingCleanups()
    if (!(key in pending)) return
    delete pending[key]
    writePendingCleanups(pending)
  }

  async function executePendingKick(key) {
    const pending = readPendingCleanups()[key]
    if (!pending) return
    const runMarker = Number(pending.seq) || Math.floor((Number(pending.kickAt) || Date.now()) / 1000)
    const lease = await claimSharedLease(leaseKey('cleanup-kick-run', key, runMarker), 5 * 60 * 1000)
    if (!lease.claimed) {
      ctx.logger.debug(`[napcat-group-guard] 群 ${key} 的清理踢人阶段已由其它页面执行，稍后再确认。`)
      // 承接方可能中途关闭页面；释放后本页再接手，避免 pending 永远悬空。
      if (lease.supported === true) schedulePendingKick(key, Date.now() + 60000)
      return
    }
    const target = findCleanupTarget(key)
    cleanupPerforming = true
    try {
      if (target) {
        const report = await performCleanupTarget(target)
        lastCleanupReport = { at: Date.now(), phase: 'kick', reports: [report] }
        emitAction('cleanup_done', { reports: [{ group_id: report.group_id, inactive: report.inactive_count, kicked: report.kicked?.length || 0 }] })
      } else {
        ctx.logger.warn(`[napcat-group-guard] 清理目标已不存在或已关闭，跳过：${key}`)
      }
    } finally {
      cleanupPerforming = false
      removePendingCleanup(key)
      scheduleNextCleanup()
    }
  }

  /**
   * 页面刷新 / 重开后恢复未完成的踢人阶段。
   * 同时兼容旧版单对象 `pendingCleanup`，会自动迁移为按群的 `pendingCleanups`。
   */
  async function resumePendingCleanup() {
    if (!enabled()) return { ok: false, skipped: true, reason: '插件未启用。' }
    const state = readState()
    const pending = readPendingCleanups()
    const legacy = state.pendingCleanup
    if (legacy && typeof legacy === 'object' && Array.isArray(legacy.groups)) {
      for (const item of legacy.groups) {
        const key = cleanupKey(item.instanceId, item.groupId)
        pending[key] = {
          key,
          instanceId: String(item.instanceId || ''),
          groupId: normalizeQq(item.groupId),
          name: item.name || '',
          startedAt: Number(legacy.startedAt) || Date.now(),
          kickAt: Number(legacy.kickAt) || Date.now() + 1500,
        }
      }
      writeState({ pendingCleanup: null })
      writePendingCleanups(pending)
    }

    const entries = Object.values(pending)
    if (!entries.length) return { ok: true, skipped: true, reason: '没有未完成的清理阶段。' }
    const scheduled = []
    const repaired = []
    const runs = readCleanupRuns()
    let runsChanged = false
    for (const item of entries) {
      const key = item.key || cleanupKey(item.instanceId, item.groupId)
      const target = findCleanupTarget(key)
      if (!target) {
        delete pending[key]
        continue
      }
      const kickAt = Number(item.kickAt) || Date.now() + 1500
      const startedAt = Number(item.startedAt) || 0
      const warnMs = Math.max(0, Number(target.cfg.warnMinutes) || 0) * 60000
      // 正常待办只可能比开始时间晚「warnMinutes + 调度误差」；旧版 bug 会把它推迟到
      // 下一个完整周期，间隔远大于此。检测到这种异常待办时不能傻等到下一周期，
      // 清掉旧待办并写入 immediateAt，让正常流程立即补发新一轮预告，等待
      // warnMinutes 后执行踢人。
      const gapLimit = Math.max(warnMs + 30 * 60000, 2 * 60 * 60000)
      const stale =
        (startedAt > 0 && kickAt - startedAt > gapLimit) ||
        kickAt > Date.now() + Math.max(24 * 60 * 60000, warnMs + 6 * 60 * 60000)
      if (stale) {
        delete pending[key]
        runs[key] = {
          ...(runs[key] && typeof runs[key] === 'object' ? runs[key] : {}),
          immediateAt: Date.now() + 500,
          advancedAt: Date.now(),
          advancedBy: 'resume-stale',
        }
        runsChanged = true
        repaired.push({ group_id: target.groupId, name: target.name, stale_kick_at: fmtTime(kickAt) || null })
        continue
      }
      const fireAt = kickAt > Date.now() ? kickAt : Date.now() + 1500
      schedulePendingKick(key, fireAt)
      scheduled.push({ group_id: target.groupId, name: target.name, kick_at: new Date(fireAt).toISOString() })
    }
    if (runsChanged) writeState({ cleanupRuns: runs })
    writePendingCleanups(pending)
    if (repaired.length) {
      ctx.logger.warn(
        `[napcat-group-guard] 检测到 ${repaired.length} 个异常清理待办（踢人时间被顺延到下一周期），已改为立即重新发预告，等待各自 warnMinutes 后执行。`,
      )
      refreshCleanupSchedule()
    }
    if (!scheduled.length && !repaired.length) return { ok: true, skipped: true, reason: '原清理目标已不存在或已排除。' }
    if (scheduled.length) ctx.logger.info(`[napcat-group-guard] 已恢复未完成的清理踢人阶段（${scheduled.length} 个群）。`)
    return { ok: true, resumed: true, targets: scheduled.length, pending: scheduled, repaired }
  }

  async function performCleanupTarget(target) {
    const cfg = target.cfg
    const fetched = await fetchGroupMembers(target.instanceId, target.groupId, { refresh: true })
    if (!fetched.ok) {
      // 读取成员失败也必须给群里一个反应，否则用户只会看到“到点后无事发生”。
      try {
        await sendGroupText(
          target.instanceId,
          target.groupId,
          `本次清理未能执行：读取群成员列表失败（${fetched.error || '未知原因'}），下一轮会继续尝试。`,
          { action: 'cleanup_failed' },
        )
      } catch (err) {
        ctx.logger.warn(`[napcat-group-guard] 群 ${target.groupId} 清理失败提示发送失败：${err?.message || err}`)
      }
      try {
        await sendCleanupNextNotice(target)
      } catch (err) {
        ctx.logger.warn(`[napcat-group-guard] 群 ${target.groupId} 下一轮清理播报失败：${err?.message || err}`)
      }
      return { group_id: target.groupId, group_name: target.name, ok: false, error: fetched.error, inactive_count: 0, kicked: [], failed: [] }
    }
    const inactive = filterInactiveMembers(fetched.members, cfg, target)
    const kicked = []
    const failed = []
    const kickIntervalMs = kickIntervalMsOf(target)

    for (const member of inactive) {
      if (cfg.blacklistKicked) addBlacklistEntry(member.qq, target.rule.blacklistId, '清理不活跃成员')
      const result = await kickMember(target.instanceId, target.groupId, member.qq, {
        rule: target.rule,
        reason: '清理不活跃成员',
        source: 'cleanup',
      })
      if (result.ok) kicked.push(publicMember(member))
      else failed.push({ qq: member.qq, display: member.display, error: result.error })
      if (kickIntervalMs > 0 && inactive.length > 1) await sleep(kickIntervalMs)
    }

    // 清理结果统一合并为一条文本消息，不逐人发送档案图，避免群里刷屏。
    // 勾选结果播报时，0 人也会明确回应；没勾选时只要踢了人也发一条摘要，
    // 至少让群里知道本轮发生了什么。下一轮时间由下面的 nextNotice 单独播报。
    const summaryLines = []
    if (kicked.length || failed.length) {
      summaryLines.push(`本次清理完成：移出 ${kicked.length} 位长期未活跃成员。`)
      if (kicked.length) {
        const names = kicked.slice(0, 50).map(item => `${item.display}(${item.qq})`).join('、')
        summaryLines.push(`已移出：${names}${kicked.length > 50 ? ` 等 ${kicked.length} 人` : ''}`)
      }
      if (failed.length) summaryLines.push(`未能移出 ${failed.length} 位（可能是管理员 / 权限不足）。`)
    } else if (cfg.notifyResult) {
      summaryLines.push('本次清理完成：没有发现需要移出的长期未活跃成员。')
    }
    if (summaryLines.length) {
      await sendGroupText(target.instanceId, target.groupId, summaryLines.join('\n'), { action: 'cleanup_result' })
    }

    // 无论是否开启结果摘要，踢完后都播报下一轮清理时间与剩余天数。
    try {
      await sendCleanupNextNotice(target)
    } catch (err) {
      ctx.logger.warn(`[napcat-group-guard] 群 ${target.groupId} 下一轮清理播报失败：${err?.message || err}`)
    }

    return {
      group_id: target.groupId,
      group_name: target.name,
      ok: true,
      member_count: fetched.members.length,
      inactive_count: inactive.length,
      kicked,
      failed,
    }
  }

  async function performCleanupTargets(targets) {
    const list = Array.isArray(targets) ? targets : []
    if (!list.length) return []
    cleanupPerforming = true
    const reports = []
    try {
      for (const target of list) reports.push(await performCleanupTarget(target))
    } finally {
      cleanupPerforming = false
    }
    lastCleanupReport = { at: Date.now(), phase: 'kick', reports }
    emitAction('cleanup_done', {
      reports: reports.map(item => ({ group_id: item.group_id, inactive: item.inactive_count, kicked: item.kicked?.length || 0 })),
    })
    return reports
  }

  /**
   * 启动一轮清理：对每个到期的群发 @全体预告，等待该群自己的 warnMinutes
   * 后进入踢人阶段。force=true 用于工具手动触发，会把所有启用清理的群都跑一遍。
   */
  async function runCleanupCycle({ force = false, source = 'auto' } = {}) {
    if (!enabled()) return { ok: false, code: 'GG_DISABLED', error: '群管助手已禁用。' }
    if (cleanupRunning) {
      ensureCleanupScheduled(60000)
      return { ok: false, code: 'CLEANUP_BUSY', error: '已有一轮清理预告正在进行。' }
    }
    if (cleanupPerforming) {
      ensureCleanupScheduled(5 * 60000)
      return { ok: false, code: 'CLEANUP_BUSY', error: '正在批量踢人，稍后会自动继续下一轮。' }
    }

    const targets = resolveCleanupTargets()
    if (!targets.length) {
      scheduleNextCleanup(5 * 60000)
      return { ok: true, targets: 0, message: '没有启用清理的群渠道。' }
    }

    ensureCleanupBaseline()
    const due = targetsDueNow(targets, force)
    if (!due.length) {
      scheduleNextCleanup()
      return {
        ok: true,
        targets: 0,
        next_run_at: fmtTime(nextCleanupAt) || null,
        message: '还没有到清理时间。',
      }
    }

    cleanupRunning = true
    let scheduleDelay
    try {
      // 多页面在线时同一轮清理可能被每个页面各触发一次。以后端租约为准，
      // 只让一个页面负责发预告 / 后续踢人，避免重复 @全体和重复踢人。
      const activeDue = []
      const seqByKey = new Map()
      for (const target of due) {
        const nextSeq = cleanupRunSeq(target.key) + 1
        const lease = await claimSharedLease(leaseKey('cleanup-warning', target.key, nextSeq), 2 * 60 * 1000)
        if (lease.claimed) {
          activeDue.push(target)
          seqByKey.set(target.key, nextSeq)
        } else {
          ctx.logger.debug(`[napcat-group-guard] 群 ${target.groupId} 的本轮清理已由其它页面接手，跳过。`)
        }
      }
      if (!activeDue.length) {
        scheduleDelay = 60000
        return { ok: true, source, targets: 0, message: '本轮清理预告已由其它页面处理。' }
      }

      // 工具 cleanup_run / cleanup_trigger 的立即清理不受固定 18:00 限制；
      // 自动周期则在发出预告后把实际踢人时刻对齐到当天 18:00。
      const manualKeys = new Set()
      for (const target of activeDue) {
        if (force || immediateCleanupAt(target) > 0) manualKeys.add(target.key)
      }
      const startedAt = Date.now()
      // 必须在写入新锚点之前计算本轮的 18:00 踢人时刻。若先写 at=startedAt，
      // 再调用 nextCleanupKickAtFor 就会把踢人时间推到“下一个周期”，表现为发完
      // 预告后 10 分钟什么也不发生，待办一直被顺延。
      const alignedKickAtByKey = new Map()
      for (const target of activeDue) {
        alignedKickAtByKey.set(target.key, manualKeys.has(target.key) ? 0 : nextCleanupKickAtFor(target))
      }
      const runs = { ...readCleanupRuns() }
      for (const target of activeDue) runs[target.key] = { at: startedAt, seq: seqByKey.get(target.key) || 1 }
      writeState({ cleanupRuns: runs })
      const groups = []
      const immediate = []
      for (const target of activeDue) {
        const sent = await sendCleanupWarning(target)
        const warnMinutes = Math.max(0, Number(target.cfg.warnMinutes) || 0)
        let kickAt = startedAt + warnMinutes * 60000
        if (!manualKeys.has(target.key)) {
          const alignedKickAt = alignedKickAtByKey.get(target.key) || 0
          // 仍在本轮预告之后：按固定 18:00 执行；若已错过（离线补跑），
          // 退回到“发预告后等待 warnMinutes”，避免把踢人时间设到过去。
          if (alignedKickAt > startedAt) kickAt = alignedKickAt
        }
        if (warnMinutes <= 0) {
          immediate.push(target)
          continue
        }
        const pending = readPendingCleanups()
        pending[target.key] = {
          key: target.key,
          instanceId: target.instanceId,
          groupId: target.groupId,
          name: target.name,
          seq: seqByKey.get(target.key) || 1,
          startedAt,
          kickAt,
        }
        writePendingCleanups(pending)
        schedulePendingKick(target.key, kickAt)
        groups.push({
          group_id: target.groupId,
          name: target.name,
          warn_minutes: warnMinutes,
          inactive_days: target.cfg.inactiveDays,
          kick_at: new Date(kickAt).toISOString(),
          warning_ok: sent.ok,
        })
      }

      if (immediate.length) {
        const immediateWinners = []
        for (const target of immediate) {
          const lease = await claimSharedLease(leaseKey('cleanup-kick-run', target.key, seqByKey.get(target.key) || 1), 5 * 60 * 1000)
          if (lease.claimed) immediateWinners.push(target)
        }
        const reports = await performCleanupTargets(immediateWinners)
        for (const report of reports) {
          groups.push({
            group_id: report.group_id,
            name: report.group_name,
            warn_minutes: 0,
            kicked: report.kicked?.length || 0,
            immediate: true,
          })
        }
      }

      return {
        ok: true,
        source,
        targets: activeDue.length,
        groups,
        message: `已处理 ${activeDue.length} 个群的清理周期。`,
      }
    } finally {
      cleanupRunning = false
      scheduleNextCleanup(scheduleDelay)
    }
  }

  /** 忙碌导致这轮没启动时，保证至少还有一个后续定时器，避免启动恢复和慢清理把调度链断掉。 */
  function ensureCleanupScheduled(fallbackDelayMs = 5 * 60000) {
    if (cleanupTimer) return
    if (!resolveCleanupTargets().length) {
      nextCleanupAt = 0
      return
    }
    scheduleNextCleanup(fallbackDelayMs)
  }

  function scheduleNextCleanup(delayMs) {
    if (cleanupTimer) {
      ctx.clearTimeout(cleanupTimer)
      cleanupTimer = null
    }
    const targets = resolveCleanupTargets()
    if (!targets.length) {
      nextCleanupAt = 0
      return
    }
    ensureCleanupBaseline()
    let fireAt
    if (delayMs !== undefined) {
      fireAt = Date.now() + Math.max(1000, Number(delayMs) || 0)
    } else {
      fireAt = Math.min(...targets.map(target => nextRunAtFor(target)))
      if (fireAt <= Date.now()) fireAt = Date.now() + 5000
    }
    nextCleanupAt = fireAt
    cleanupTimer = ctx.setTimeout(() => {
      cleanupTimer = null
      runCleanupCycle({ source: 'auto' }).catch(err => ctx.logger.error(`[napcat-group-guard] 定时清理执行失败：${err?.message || err}`))
    }, Math.max(1000, fireAt - Date.now()))
  }

  function refreshCleanupSchedule() {
    if (cleanupRunning) return
    scheduleNextCleanup()
  }

  async function previewCleanup({ groupRef = '', context = null, limit = 30 } = {}) {
    let targets = resolveCleanupTargets()
    if (groupRef) {
      const resolved = await resolveRuleRef(groupRef, context)
      if (!resolved.ok) return resolved
      if (!resolved.channel || !instanceIdOf(resolved.channel) || !isGroupChannel(resolved.channel)) {
        return {
          ok: false,
          code: 'GROUP_NOT_CONFIGURED',
          error: `群 ${resolved.groupId} 没有对应的 NapCat 群聊渠道，无法读取成员列表。`,
        }
      }
      const rule = resolveRule(resolved.groupId, channelNameOf(resolved.channel))
      targets = [{
        channel: resolved.channel,
        key: cleanupKey(instanceIdOf(resolved.channel), resolved.groupId),
        instanceId: instanceIdOf(resolved.channel),
        groupId: resolved.groupId,
        name: channelNameOf(resolved.channel),
        rule,
        cfg: rule.cleanup,
      }]
    }

    const groups = []
    for (const target of targets) {
      const fetched = await fetchGroupMembers(target.instanceId, target.groupId, { refresh: true })
      if (!fetched.ok) {
        groups.push({ group_id: target.groupId, group_name: target.name, ok: false, error: fetched.error })
        continue
      }
      const inactive = filterInactiveMembers(fetched.members, target.cfg, target)
      groups.push({
        group_id: target.groupId,
        group_name: target.name,
        ok: true,
        cleanup_enabled: target.cfg.enabled,
        interval_minutes: target.cfg.intervalMinutes,
        warn_minutes: target.cfg.warnMinutes,
        inactive_days: target.cfg.inactiveDays,
        next_run_at: fmtTime(nextRunAtFor(target)) || null,
        next_warn_at: fmtTime(nextRunAtFor(target)) || null,
        next_kick_at: fmtTime(nextCleanupKickAtFor(target)) || null,
        member_count: fetched.members.length,
        inactive_count: inactive.length,
        inactive: inactive.slice(0, Math.max(1, Math.min(100, Number(limit) || 30))).map(member => ({
          ...publicMember(member),
          inactive_days: Math.floor(member.inactive_seconds / 86400),
          last_active: fmtTime(member.last_active_timestamp) || undefined,
        })),
        note: '只统计群成员列表里的 last_sent_time（没有则用 join_time）超过阈值的成员。',
      })
    }

    return { ok: true, groups }
  }

  function cleanupStatus() {
    let targets = []
    try {
      targets = resolveCleanupTargets()
    } catch (_) {
      targets = []
    }
    const pending = readPendingCleanups()
    return {
      enabled: targets.length > 0,
      group_count: targets.length,
      pending_kicks: Object.values(pending).map(item => ({
        group_id: item.groupId,
        name: item.name,
        kick_at: fmtTime(item.kickAt) || null,
      })),
      next_run_at: fmtTime(nextCleanupAt) || null,
      groups: targets.map(target => ({
        group_id: target.groupId,
        name: target.name,
        interval_minutes: target.cfg.intervalMinutes,
        warn_minutes: target.cfg.warnMinutes,
        inactive_days: target.cfg.inactiveDays,
        next_run_at: fmtTime(nextRunAtFor(target)) || null,
        next_warn_at: fmtTime(nextRunAtFor(target)) || null,
        next_kick_at: fmtTime(nextCleanupKickAtFor(target)) || null,
      })),
      last_report: lastCleanupReport,
    }
  }

  /* ---------------- 给角色的函数工具 ---------------- */

  function guardStatus() {
    const blacklists = readBlacklists()
    const groups = groupChannels().map(channel => {
      const groupId = groupIdOf(channel)
      const rule = resolveRule(groupId, channelNameOf(channel))
      return {
        group_id: groupId,
        group_name: channelNameOf(channel),
        configured: rule.configured,
        managed: rule.managed,
        auto_review: rule.autoReview,
        min_level: rule.minLevel,
        require_visible_level: rule.requireVisibleLevel,
        whitelist: rule.whitelistWords,
        blacklist_words: rule.blacklistWords,
        blacklist_id: rule.blacklistId,
        max_reject: rule.maxReject,
        notify_on_request: rule.notifyOnRequest,
        notify_join_success: rule.notifyJoinSuccess,
        notify_decrease: rule.notifyDecrease,
        notify_blacklist: rule.notifyBlacklist,
        open_box_image: rule.openBoxImage,
        auto_kick_blacklisted: rule.autoKickBlacklisted,
        cleanup: rule.cleanup,
      }
    })
    return {
      ok: true,
      enabled: enabled(),
      auto_review: autoReviewEnabled(),
      all_groups: allGroupsEnabled(),
      dry_run: dryRun(),
      allow_manage: allowManage(),
      auto_blacklist_on_kick: autoBlacklistOnKick(),
      auto_blacklist_on_leave: autoBlacklistOnLeave(),
      auto_kick_blacklisted: autoKickBlacklisted(),
      kick_reject_add: kickRejectAdd(),
      default_min_level: clampNumber(config.get(pref('minLevel'), 0), 0, 999, 0, { integer: true }),
      default_require_visible_level: toBool(config.get(pref('requireVisibleLevel'), true), true),
      default_whitelist: parseWords(config.get(pref('answerWhitelist'), '')),
      default_blacklist_words: parseWords(config.get(pref('answerBlacklist'), '')),
      max_reject: clampNumber(config.get(pref('maxReject'), 2), 0, 100, 2, { integer: true }),
      protected_users: protectedUsers(),
      notify_join_success: notifyJoinSuccess(),
      notify_decrease: notifyDecrease(),
      notify_blacklist: notifyBlacklist(),
      open_box_image: dossierImageEnabled(),
      blacklists: Object.fromEntries(Object.entries(blacklists).map(([id, qqs]) => [id, { count: qqs.length, qqs: qqs.slice(0, 100) }])),
      groups,
      cleanup: cleanupStatus(),
    }
  }

  async function resolveListId(args, context) {
    const explicit = String(args?.list ?? '').trim()
    if (explicit) return { ok: true, listId: explicit, source: 'explicit' }
    const groupRef = String(args?.group ?? '').trim()
    const resolved = await resolveRuleRef(groupRef, context)
    if (resolved.ok) {
      const rule = resolveRule(resolved.groupId, resolved.name)
      return { ok: true, listId: rule.blacklistId, source: 'group', groupId: resolved.groupId, groupName: resolved.name }
    }
    if (groupRef) return resolved
    return { ok: true, listId: DEFAULT_BLACKLIST, source: 'default' }
  }

  async function toolGuard(args = {}, context = {}) {
    if (!enabled()) return disabledResult()
    const action = String(args?.action || 'status').trim() || 'status'
    const mutating = ['blacklist_add', 'blacklist_remove', 'blacklist_kick', 'cleanup_run', 'cleanup_trigger', 'cleanup_kick', 'group_config_set', 'group_config_reset'].includes(action)
    if (mutating && !allowManage()) return manageDenied()

    if (action === 'status') return guardStatus()

    if (action === 'blacklist_list') {
      const blacklists = readBlacklists()
      const wanted = String(args?.list ?? '').trim()
      const entries = Object.entries(blacklists)
        .filter(([id]) => !wanted || id === wanted)
        .map(([id, qqs]) => ({ list: id, count: qqs.length, qqs: qqs.slice(0, 200) }))
      if (wanted && !entries.length) return { ok: false, error: `黑名单「${wanted}」不存在。` }
      return { ok: true, count: entries.length, blacklists: entries }
    }

    if (action === 'blacklist_add') {
      const qq = normalizeQq(args?.qq)
      if (!isQqId(qq)) return { ok: false, error: 'blacklist_add 需要精确的 qq（纯数字 QQ 号）。' }
      const resolvedList = await resolveListId(args, context)
      if (!resolvedList.ok) return resolvedList
      const kick = args?.kick !== false && args?.kick !== 'false'
      const notify = args?.notify !== false && args?.notify !== 'false'
      const result = await addBlacklistAndEnforce(qq, resolvedList.listId, String(args?.reason ?? '').trim() || '角色手动加入黑名单', {
        kick,
        notifyTargets: notify ? notifyTargetsForList(resolvedList.listId) : [],
      })
      return {
        ok: true,
        action,
        qq,
        list: resolvedList.listId,
        list_source: resolvedList.source,
        added: result.added,
        already: result.already,
        kicked_groups: result.kicked?.filter(item => item.ok) || [],
        skipped_groups: result.kicked?.filter(item => !item.ok && item.skipped) || [],
        failed_groups: result.kicked?.filter(item => !item.ok && !item.skipped) || [],
        blacklist_notices: result.notices || [],
      }
    }

    if (action === 'blacklist_remove') {
      const qq = normalizeQq(args?.qq)
      if (!isQqId(qq)) return { ok: false, error: 'blacklist_remove 需要精确的 qq（纯数字 QQ 号）。' }
      const resolvedList = await resolveListId(args, context)
      if (!resolvedList.ok) return resolvedList
      const result = removeBlacklistEntry(qq, resolvedList.listId)
      return { ok: true, action, list: resolvedList.listId, ...result }
    }

    if (action === 'blacklist_kick') {
      const listId = String(args?.list ?? '').trim()
      if (listId && !readBlacklists()[listId]) return { ok: false, error: `黑名单「${listId}」不存在。` }
      const results = await kickBlacklistedMembers(listId)
      const kicked = results.flatMap(item => item.groups.filter(group => group.ok))
      return { ok: true, action, lists: results.length, kicked_count: kicked.length, results }
    }

    if (action === 'cleanup_preview') {
      const result = await previewCleanup({
        groupRef: String(args?.group ?? '').trim(),
        context,
        limit: clampNumber(args?.limit, 1, 100, 30, { integer: true }),
      })
      return result
    }

    if (action === 'cleanup_run') {
      const result = await runCleanupCycle({ force: true, source: 'tool' })
      return result
    }

    if (action === 'cleanup_trigger') {
      return triggerCleanupNow({
        groupRef: String(args?.group ?? '').trim(),
        context,
      })
    }

    if (action === 'cleanup_kick') {
      return kickPendingCleanupNow({
        groupRef: String(args?.group ?? '').trim(),
        context,
      })
    }


    if (action === 'group_config_get' || action === 'group_config_set' || action === 'group_config_reset') {
      const resolved = await resolveRuleRef(String(args?.group ?? '').trim(), context)
      if (!resolved.ok) return resolved
      const groupId = resolved.groupId
      const map = groupsConfig()
      if (action === 'group_config_get') {
        return {
          ok: true,
          action,
          group: { id: groupId, name: resolved.name },
          override: map[groupId] || null,
          rule: publicRule(resolveRule(groupId, resolved.name)),
        }
      }
      if (action === 'group_config_reset') {
        delete map[groupId]
        writeGroups(map)
        refreshCleanupSchedule()
        return { ok: true, action, group_id: groupId, message: `已清除群 ${groupId} 的独立规则，恢复继承全局默认。`, rule: publicRule(resolveRule(groupId, resolved.name)) }
      }
      let override = args?.config
      if (typeof override === 'string') {
        try {
          override = JSON.parse(override)
        } catch (err) {
          return { ok: false, error: `config 不是合法 JSON：${err.message}` }
        }
      }
      if (!override || typeof override !== 'object' || Array.isArray(override)) {
        return { ok: false, error: 'group_config_set 需要 config 对象（可用 JSON 字符串）。' }
      }
      map[groupId] = { ...(map[groupId] && typeof map[groupId] === 'object' ? map[groupId] : {}), ...override }
      writeGroups(map)
      refreshCleanupSchedule()
      return {
        ok: true,
        action,
        group_id: groupId,
        override: map[groupId],
        rule: publicRule(resolveRule(groupId, resolved.name)),
      }
    }

    return {
      ok: false,
      error: 'action 只支持 status / blacklist_list / blacklist_add / blacklist_remove / blacklist_kick / cleanup_preview / cleanup_run / cleanup_trigger / group_config_get / group_config_set / group_config_reset。',
    }
  }

  const guardToolDefinition = {
    description:
      'NapCat 群管助手。status 查看当前配置与黑名单概况；blacklist_add / blacklist_remove / blacklist_list / blacklist_kick 管理共享黑名单（按 QQ 号精确匹配，加入后会自动踢出仍在群里的成员，并向关联群发拉黑提示）；group_config_get / group_config_set / group_config_reset 查看或按群覆盖独立规则（等级 / 白词 / 黑词 / 黑名单 / 进出群提示 / 清理参数等）；cleanup_preview 预览长期未活跃成员；cleanup_trigger 把当前群（或 group 指定群）的下一轮清理倒计时直接缩减为立即触发，随后插件按正常流程先 @全体预告、等待配置分钟数、再批量踢人，踢完播报下一轮时间；cleanup_kick 直接执行“已发过预告、等待踢人”的待办，不再补发预告；cleanup_run 兼容旧行为，手动强制所有启用清理的群立即走一轮。默认作用于当前群。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'blacklist_list', 'blacklist_add', 'blacklist_remove', 'blacklist_kick', 'group_config_get', 'group_config_set', 'group_config_reset', 'cleanup_preview', 'cleanup_run', 'cleanup_trigger', 'cleanup_kick'],
          description: '要执行的动作，默认 status。',
        },
        qq: { type: 'string', description: 'blacklist_add / blacklist_remove：精确 QQ 号。' },
        list: { type: 'string', description: '黑名单名称；不传时按 group 对应规则或 default 处理。' },
        group: { type: 'string', description: '群号或群名，默认当前群；group_config_* 用它指定要修改哪个群的规则，cleanup_trigger / cleanup_kick 用它指定目标群。' },
        reason: { type: 'string', description: 'blacklist_add：加入黑名单的原因，会写入运行日志与群内拉黑提示。' },
        kick: { type: 'boolean', description: 'blacklist_add 是否立刻踢出仍在群里的该成员，默认 true。' },
        notify: { type: 'boolean', description: 'blacklist_add 是否向使用该黑名单的群发送拉黑提示，默认 true。' },
        config: {
          type: 'string',
          description:
            'group_config_set：要覆盖的群规则 JSON 字符串，例如 {"minLevel":16,"openBoxImage":true}；字段省略表示继承全局。',
        },
        limit: { type: 'number', description: 'cleanup_preview 单群最多返回多少个不活跃成员，默认 30。' },
      },
      required: ['action'],
    },
  }

  /* ---------------- 插件设置面板 ---------------- */

  const escapeHtml = value =>
    String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const settingsSection = (title, content) => `<div class="settings-section">${title ? `<div class="settings-section-title">${title}</div>` : ''}${content}</div>`
  const settingsCard = rows => `<div class="settings-card">${rows}</div>`
  const settingsRow = (title, help, control) =>
    `<div class="setting-row"><div class="setting-main"><div class="setting-name">${title}</div>${help ? `<div class="setting-help">${help}</div>` : ''}</div><div class="setting-control">${control}</div></div>`
  const settingsToggle = (key, on) => `<button class="switch ${on ? 'on' : ''}" data-gg-toggle="${escapeHtml(key)}"></button>`
  const settingsInput = (key, value, { type = 'text', width = 150, placeholder = '' } = {}) =>
    `<input class="setting-input" type="${type}" data-gg-input="${escapeHtml(key)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" style="width:${width}px" />`
  const settingsTextarea = (key, value, { rows = 4, width = 340, placeholder = '' } = {}) =>
    `<textarea class="setting-input" data-gg-textarea="${escapeHtml(key)}" rows="${rows}" placeholder="${escapeHtml(placeholder)}" style="width:${width}px;resize:vertical">${escapeHtml(value)}</textarea>`

  /* ---------------- 按群配置编辑器 ---------------- */

  function groupChannelChoices() {
    const seen = new Set()
    const out = []
    for (const channel of groupChannels()) {
      const id = groupIdOf(channel)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push({ id, name: channelNameOf(channel) })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }

  function pathValue(source, path) {
    return String(path || '')
      .split('.')
      .reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), source)
  }

  function pruneEmptyObjects(target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return target
    for (const [key, value] of Object.entries(target)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        pruneEmptyObjects(value)
        if (!Object.keys(value).length) delete target[key]
      }
    }
    return target
  }

  function setGroupOverrideValue(groupId, path, rawValue, kind = 'text') {
    const map = groupsConfig()
    const current = map[groupId] && typeof map[groupId] === 'object' && !Array.isArray(map[groupId]) ? { ...map[groupId] } : {}
    const parts = String(path || '').split('.').filter(Boolean)
    if (!parts.length) return
    let cursor = current
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index]
      const next = cursor[key] && typeof cursor[key] === 'object' && !Array.isArray(cursor[key]) ? { ...cursor[key] } : {}
      cursor[key] = next
      cursor = next
    }
    const last = parts[parts.length - 1]
    const text = String(rawValue ?? '')
    if (kind === 'bool') {
      if (text === '') delete cursor[last]
      else cursor[last] = text === 'true'
    } else if (kind === 'number') {
      const number = Number(text)
      if (!text.trim() || !Number.isFinite(number)) delete cursor[last]
      else cursor[last] = number
    } else if (kind === 'empty') {
      cursor[last] = ''
    } else if (!text.trim()) {
      delete cursor[last]
    } else {
      cursor[last] = text
    }
    pruneEmptyObjects(current)
    if (Object.keys(current).length) map[groupId] = current
    else delete map[groupId]
    writeGroups(map)
    refreshCleanupSchedule()
  }

  function groupOverrideValue(groupId, path) {
    const override = explicitRule(groupId) || {}
    if (path === 'whitelist') return pathValue(override, 'whitelist') ?? pathValue(override, 'whitelistWords') ?? pathValue(override, 'answerWhitelist')
    if (path === 'blacklist') return pathValue(override, 'blacklist') ?? pathValue(override, 'blacklistWords') ?? pathValue(override, 'answerBlacklist')
    if (path === 'notifyOnRequest') return pathValue(override, 'notifyOnRequest') ?? pathValue(override, 'notify')
    if (path === 'openBoxImage') return pathValue(override, 'openBoxImage') ?? pathValue(override, 'dossierImage') ?? pathValue(override, 'profileImage')
    return pathValue(override, path)
  }

  function effectiveGroupValue(rule, path) {
    if (path === 'whitelist') return rule.whitelistWords || []
    if (path === 'blacklist') return rule.blacklistWords || []
    if (path === 'protectedUsers') return rule.protectedUsers || []
    return pathValue(rule, path)
  }

  function groupBoolControl(path, overrideValue, effectiveValue) {
    const hasOverride = overrideValue !== undefined && overrideValue !== null
    const current = hasOverride ? toBool(overrideValue, !!effectiveValue) : null
    return `<select class="setting-input" data-gg-group-field="${escapeHtml(path)}" data-gg-group-kind="bool" data-gg-group-value="${hasOverride ? String(current) : ''}" style="width:170px">
      <option value="">继承全局（${effectiveValue ? '开' : '关'}）</option>
      <option value="true">开</option>
      <option value="false">关</option>
    </select>`
  }

  function groupTextControl(path, overrideValue, effectiveValue, { type = 'text', width = 220, rows = 0, emptyButton = false } = {}) {
    const hasOverride = overrideValue !== undefined && overrideValue !== null
    const value = hasOverride ? String(overrideValue) : ''
    const effectiveText = Array.isArray(effectiveValue)
      ? effectiveValue.join(' / ') || '（空）'
      : effectiveValue === undefined || effectiveValue === null || effectiveValue === ''
        ? '（空）'
        : String(effectiveValue)
    const placeholder = hasOverride && value === '' ? '当前：空覆盖（不继承）' : `继承全局：${effectiveText}`
    const attrs = `data-gg-group-field="${escapeHtml(path)}" data-gg-group-kind="${type === 'number' ? 'number' : 'text'}"`
    const control = rows > 0
      ? `<textarea class="setting-input" ${attrs} rows="${rows}" placeholder="${escapeHtml(placeholder)}" style="width:${width}px;resize:vertical">${escapeHtml(value)}</textarea>`
      : `<input class="setting-input" type="${type}" ${attrs} value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" style="width:${width}px" />`
    if (!emptyButton) return control
    return `<span style="display:inline-flex;gap:6px;align-items:center;justify-content:flex-end">${control}<button class="outline-btn" data-gg-group-empty="${escapeHtml(path)}" title="显式覆盖为空">空</button></span>`
  }

  function renderGroupEditor(container) {
    const select = container.querySelector('[data-gg-group-select]')
    const host = container.querySelector('[data-gg-group-editor]')
    if (!select || !host) return
    const groupId = String(select.value || '').trim()
    const choice = groupChannelChoices().find(item => item.id === groupId)
    if (!groupId || !choice) {
      host.innerHTML = '<div class="settings-note">先在上方下拉选择一个已配置的群，再编辑该群的独立规则。</div>'
      return
    }

    const rule = resolveRule(groupId, choice.name)
    const bool = (path, label, help) => settingsRow(label, help, groupBoolControl(path, groupOverrideValue(groupId, path), toBool(effectiveGroupValue(rule, path), false)))
    const text = (path, label, help, options = {}) => settingsRow(label, help, groupTextControl(path, groupOverrideValue(groupId, path), effectiveGroupValue(rule, path), options))

    host.innerHTML = `
      <div class="settings-note">正在编辑：<b>${escapeHtml(choice.name)}（${escapeHtml(groupId)}）</b>。下拉选“继承全局”或输入留空 = 使用全局默认；点“空”= 显式覆盖为空；所有修改即时保存。</div>
      ${settingsSection('基础与入群审核', settingsCard(
        bool('enabled', '启用本群管理', '关闭后本群不审核、不联动拉黑、不清理') +
        bool('autoReview', '自动审核入群申请', '覆盖全局的自动审核开关') +
        text('minLevel', '最低 QQ 等级', '数字；留空继承全局', { type: 'number', width: 90 }) +
        bool('requireVisibleLevel', '隐藏等级必须拒绝', '查不到 qqLevel 时按约定拒绝') +
        text('whitelist', '进群白词', '用 / 、 逗号或换行分隔；留空继承全局', { emptyButton: true, width: 260 }) +
        text('blacklist', '进群黑词', '命中任意一个直接拒绝并拉黑', { emptyButton: true, width: 260 }) +
        text('blacklistId', '绑定的黑名单名称', '多个群填同一个名字即可共用', { width: 160 }) +
        text('maxReject', '连续拒绝拉黑次数', '0 = 不自动拉黑；留空继承全局', { type: 'number', width: 90 }) +
        bool('notifyOnRequest', '申请处理提示', '黑名单用户反复申请时始终静默'),
      ))}
      ${settingsSection('进出群与拉黑提示', settingsCard(
        bool('notifyJoinSuccess', '进群成功欢迎', 'group_increase 时发送欢迎语') +
        text('joinTemplate', '进群欢迎模板', '支持 {nickname} {qq} {level} {group}', { rows: 3, width: 340 }) +
        bool('notifyDecrease', '退群 / 被踢提示', 'group_decrease 时发送提示') +
        text('leaveTemplate', '主动退群模板', '支持 {nickname} {qq} {group}', { rows: 3, width: 340 }) +
        text('kickTemplate', '被踢模板', '支持 {nickname} {qq} {operator}', { rows: 3, width: 340 }) +
        bool('notifyBlacklist', '拉黑提示', '新加入黑名单后向相关群发送原因') +
        text('blacklistTemplate', '拉黑模板', '支持 {nickname} {qq} {reason} {list}', { rows: 3, width: 340 }) +
        bool('openBoxImage', '进群申请 / 进群 / 退群档案图', '按 QQ 资料生成原创档案卡，附在申请提示 / 欢迎 / 退群提示后；提示关闭时仍会单独发送'),
      ))}
      ${settingsSection('黑名单联动', settingsCard(
        bool('autoBlacklistOnKick', '被踢自动拉黑', '监听到 group_decrease(kick) 时拉黑') +
        bool('autoBlacklistOnLeave', '主动退群自动拉黑', '监听到 group_decrease(leave) 时拉黑') +
        bool('autoKickBlacklisted', '拉黑后自动踢出', '加入黑名单时仍在群里则踢出') +
        bool('kickRejectAdd', '踢人时拒绝再次加群', '同时勾选 QQ 的 reject_add_request') +
        text('protectedUsers', '保护名单', '逗号分隔 QQ；留空继承全局', { emptyButton: true, width: 240 }),
      ))}
      ${settingsSection('不活跃清理（按群覆盖）', settingsCard(
        bool('cleanup.enabled', '启用本群清理', '按本群周期发送 @全体预告并踢人') +
        text('cleanup.intervalMinutes', '清理周期（分钟）', '留空继承全局，默认 10080 = 7 天；实际清人固定在该日 18:00', { type: 'number', width: 110 }) +
        text('cleanup.warnMinutes', '预告等待（分钟）', '留空继承全局，默认 10 分钟；用于计算 18:00 前多久发预告', { type: 'number', width: 110 }) +
        text('cleanup.inactiveDays', '不活跃天数', '超过该天数视为不活跃', { type: 'number', width: 110 }) +
        bool('cleanup.skipAdmins', '跳过管理员', '群主始终跳过') +
        bool('cleanup.blacklistKicked', '清理对象加入黑名单', '默认关闭') +
        bool('cleanup.notifyResult', '清理完成后播报', '结果为 0 人时也发送摘要；实际移出时始终合并为一条文本，不逐人发档案图') +
        bool('cleanup.dailyBroadcast', '每天播报下一轮', '约 20:00 播报下一次清人日期、剩余天数与预计清理人数') +
        text('cleanup.dailyBroadcastHour', '每日播报小时', '0-23；留空继承全局，默认 20', { type: 'number', width: 90 }) +
        text('cleanup.dailyBroadcastMinute', '每日播报分钟', '0-59；留空继承全局，默认 0', { type: 'number', width: 90 }) +
        text('cleanup.message', '预告文案', '支持 {minutes} {days} {group}', { rows: 3, width: 340, emptyButton: true }) +
        text('cleanup.dailyMessage', '每日播报文案', '支持 {next_date} {days} {days_text} {count}', { rows: 3, width: 340, emptyButton: true }) +
        text('cleanup.nextMessage', '清理结束播报文案', '支持 {next_date} {days} {days_text}', { rows: 3, width: 340, emptyButton: true }),
      ))}
      ${settingsCard(settingsRow('清除本群覆盖', `删除 ${escapeHtml(groupId)} 的全部独立规则，恢复完全继承全局默认。`, '<button class="outline-btn" data-gg-group-reset>清除本群覆盖</button>'))}
    `

    for (const field of host.querySelectorAll('[data-gg-group-kind="bool"]')) {
      field.value = field.dataset.ggGroupValue || ''
    }

    for (const field of host.querySelectorAll('[data-gg-group-field]')) {
      field.addEventListener('change', () => {
        setGroupOverrideValue(groupId, field.dataset.ggGroupField, field.value, field.dataset.ggGroupKind || 'text')
        renderGroupEditor(container)
      })
    }

    for (const button of host.querySelectorAll('[data-gg-group-empty]')) {
      button.addEventListener('click', () => {
        setGroupOverrideValue(groupId, button.dataset.ggGroupEmpty, '', 'empty')
        renderGroupEditor(container)
      })
    }

    const resetButton = host.querySelector('[data-gg-group-reset]')
    resetButton?.addEventListener('click', () => {
      const map = groupsConfig()
      delete map[groupId]
      writeGroups(map)
      refreshCleanupSchedule()
      renderGroupEditor(container)
    })
  }

  function bindSettings(container) {
    const offs = []
    for (const element of container.querySelectorAll('[data-gg-toggle]')) {
      const key = element.dataset.ggToggle
      let value = toBool(config.get(key, element.classList.contains('on')), element.classList.contains('on'))
      element.classList.toggle('on', value)
      const onClick = () => {
        value = !value
        element.classList.toggle('on', value)
        config.set(key, value)
        ctx.logger.info(`[napcat-group-guard] ${key} = ${value}`)
      }
      element.addEventListener('click', onClick)
      offs.push(() => element.removeEventListener('click', onClick))
      offs.push(config.watch(key, next => element.classList.toggle('on', toBool(next, value))))
    }

    for (const element of container.querySelectorAll('[data-gg-input]')) {
      const key = element.dataset.ggInput
      const original = element.type === 'number' ? element.value : String(element.value ?? '')
      element.value = String(config.get(key, original))
      const onChange = () => {
        if (element.type === 'number') {
          const number = Number(element.value)
          if (Number.isFinite(number)) config.set(key, number)
        } else {
          config.set(key, element.value)
        }
        ctx.logger.info(`[napcat-group-guard] ${key} = ${element.value}`)
      }
      element.addEventListener('change', onChange)
      offs.push(() => element.removeEventListener('change', onChange))
      offs.push(
        config.watch(key, next => {
          if (typeof document === 'undefined' || document.activeElement !== element) element.value = String(next ?? '')
        }),
      )
    }

    for (const element of container.querySelectorAll('[data-gg-textarea]')) {
      const key = element.dataset.ggTextarea
      element.value = String(config.get(key, element.value ?? ''))
      const onChange = () => {
        config.set(key, element.value)
        ctx.logger.info(`[napcat-group-guard] ${key} 已更新（${element.value.length} 字符）`)
      }
      element.addEventListener('change', onChange)
      offs.push(() => element.removeEventListener('change', onChange))
      offs.push(
        config.watch(key, next => {
          if (typeof document === 'undefined' || document.activeElement !== element) element.value = String(next ?? '')
        }),
      )
    }

    const groupSelect = container.querySelector('[data-gg-group-select]')
    if (groupSelect) {
      const onGroupSelect = () => renderGroupEditor(container)
      groupSelect.addEventListener('change', onGroupSelect)
      offs.push(() => groupSelect.removeEventListener('change', onGroupSelect))
    }
    // JSON 编辑区 / 其它页面同步过来的群规则变化，也刷新当前表单
    offs.push(config.watch('napcat.groupGuard.groups', () => renderGroupEditor(container)))

    renderGroupEditor(container)

    return () => offs.forEach(off => {
      try {
        off()
      } catch (_) {
        /* ignore */
      }
    })
  }

  if (manager?.registerSettings) {
    const disposeSettings = manager.registerSettings({
      id: name,
      title: '群管助手',
      description: '自动审核入群申请、共享黑名单联动踢人、定期清理不活跃成员；全部由代码执行，不经过 LLM。',
      render(container) {
        container.innerHTML = `
          <div class="settings-title-row">
            <div>
              <div class="settings-title">群管助手</div>
              <div class="settings-desc">自动审核入群申请、共享黑名单联动踢人、定期清理不活跃成员；全部由代码执行，不经过 LLM。</div>
            </div>
          </div>
          ${settingsSection('总开关', settingsCard(
            settingsRow('启用群管助手', '关闭后入群审核、黑名单联动、定时清理全部暂停', settingsToggle('napcat.groupGuard.enabled', toBool(config.get('napcat.groupGuard.enabled'), true))) +
            settingsRow('响应所有群（兼容旧行为）', '关闭（默认）时只有「群规则」里显式配置过的群会处理入群申请、欢迎、退群和清理，未配置的群完全忽略；开启后恢复旧版行为：全局默认套用到 NapCat 里所有群', settingsToggle('napcat.groupGuard.allGroups', allGroupsEnabled())) +
            settingsRow('自动审核入群申请', '已配置群继承的全局默认开关；某个群可单独设置 autoReview', settingsToggle('napcat.groupGuard.autoReview', toBool(config.get('napcat.groupGuard.autoReview'), false))) +
            settingsRow('允许管理操作', '允许角色调用黑名单 / 清理工具；关闭后只保留查询', settingsToggle('napcat.groupGuard.allowManage', toBool(config.get('napcat.groupGuard.allowManage'), true))) +
            settingsRow('演练模式', '只判定并推送结果，不真正同意 / 拒绝 / 踢人，适合先观察规则', settingsToggle('napcat.groupGuard.dryRun', toBool(config.get('napcat.groupGuard.dryRun'), false))) +
            settingsRow('推送申请提示', '已配置群每条申请处理后向群里发送昵称 / QQ / 等级 / 回答 / 结果；开启档案图时还会附带申请人资料卡', settingsToggle('napcat.groupGuard.notifyOnRequest', toBool(config.get('napcat.groupGuard.notifyOnRequest'), true))),
          ))}
          ${settingsSection('按群配置', settingsCard(
            settingsRow(
              '选择群',
              '先在顶层下拉选择一个已配置的 NapCat 群；下面的表单只覆盖这个群，没改的项自动继承上面的全局默认。',
              `<select class="setting-input" data-gg-group-select style="width:280px"><option value="">— 请选择群 —</option>${groupChannelChoices()
                .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}（${escapeHtml(item.id)}）</option>`)
                .join('')}</select>`,
            ),
          ) + '<div data-gg-group-editor><div class="settings-note">先在上方下拉选择一个已配置的群，再编辑该群的独立规则。</div></div>')}
          ${settingsSection('入群审核规则', settingsCard(
            settingsRow('最低 QQ 等级', '低于该等级拒绝，原因写「等级低于xx」；0 表示不限制等级', settingsInput('napcat.groupGuard.minLevel', config.get('napcat.groupGuard.minLevel', 0), { type: 'number', width: 90 })) +
            settingsRow('隐藏等级必须拒绝', '查不到 qqLevel（隐藏 / 未返回）时拒绝，原因固定为「qq等级查询失败请打开后重试」', settingsToggle('napcat.groupGuard.requireVisibleLevel', toBool(config.get('napcat.groupGuard.requireVisibleLevel'), true))) +
            settingsRow('连续拒绝拉黑次数', '连续被自动拒绝达到该次数后加入黑名单；0 表示不自动拉黑', settingsInput('napcat.groupGuard.maxReject', config.get('napcat.groupGuard.maxReject', 2), { type: 'number', width: 90 })) +
            settingsRow('进群白词', '回答必须包含任意一个词才放行（用 / 、 逗号或换行分隔）；留空则不校验回答', settingsInput('napcat.groupGuard.answerWhitelist', config.get('napcat.groupGuard.answerWhitelist', ''), { width: 260, placeholder: 'b站/抖音/github' })) +
            settingsRow('进群黑词', '回答命中任意一个词直接拒绝并拉黑', settingsInput('napcat.groupGuard.answerBlacklist', config.get('napcat.groupGuard.answerBlacklist', ''), { width: 260, placeholder: '广告/代练/加群' })) +
            settingsRow('白词未命中原因', '回答不包含白词时的拒绝理由', settingsInput('napcat.groupGuard.answerRejectReason', config.get('napcat.groupGuard.answerRejectReason', DEFAULT_ANSWER_REJECT_REASON), { width: 280, placeholder: DEFAULT_ANSWER_REJECT_REASON })) +
            settingsRow('黑词拒绝原因', '支持 {word} 占位符', settingsInput('napcat.groupGuard.blackwordRejectReason', config.get('napcat.groupGuard.blackwordRejectReason', DEFAULT_BLACKWORD_REJECT_REASON), { width: 280, placeholder: DEFAULT_BLACKWORD_REJECT_REASON })) +
            settingsRow('申请提示模板', '支持 {nickname} {qq} {level} {answer} {result} {reason} {group} {group_id} {time}', settingsTextarea('napcat.groupGuard.notifyTemplate', config.get('napcat.groupGuard.notifyTemplate', DEFAULT_NOTIFY_TEMPLATE), { rows: 5, width: 340 })),
          ))}
          ${settingsSection('黑名单联动', settingsCard(
            settingsRow('被踢自动拉黑', '监听到 group_decrease(kick) 时把 QQ 加入该群绑定的黑名单', settingsToggle('napcat.groupGuard.autoBlacklistOnKick', toBool(config.get('napcat.groupGuard.autoBlacklistOnKick'), true))) +
            settingsRow('主动退群自动拉黑', '监听到 group_decrease(leave) 时把 QQ 加入该群绑定的黑名单', settingsToggle('napcat.groupGuard.autoBlacklistOnLeave', toBool(config.get('napcat.groupGuard.autoBlacklistOnLeave'), true))) +
            settingsRow('拉黑后自动踢出', '加入黑名单时如果对方还在关联群里，则自动触发踢出', settingsToggle('napcat.groupGuard.autoKickBlacklisted', toBool(config.get('napcat.groupGuard.autoKickBlacklisted'), true))) +
            settingsRow('启动时补踢黑名单', '页面启动后扫描一次各群成员列表，把仍在群里的黑名单成员踢出', settingsToggle('napcat.groupGuard.enforceOnStartup', toBool(config.get('napcat.groupGuard.enforceOnStartup'), true))) +
            settingsRow('踢人时拒绝再次加群', '本插件自动踢人时同时勾选 QQ 的 reject_add_request（加入 QQ 自己的黑名单）', settingsToggle('napcat.groupGuard.kickRejectAdd', toBool(config.get('napcat.groupGuard.kickRejectAdd'), true))) +
            settingsRow('黑名单', 'JSON：{"default":["123","456"],"联合组":["789"]}；多个群可在群规则里填同一个名字共用', settingsTextarea('napcat.groupGuard.blacklists', config.get('napcat.groupGuard.blacklists', '{}'), { rows: 4, width: 340, placeholder: '{"default":["123456"]}' })) +
            settingsRow('群规则', 'JSON，可按群覆盖所有规则。示例：{"123456":{"autoReview":true,"minLevel":16,"whitelist":"b站/抖音","blacklist":"广告","blacklistId":"default","cleanup":{"enabled":true,"intervalMinutes":10080,"inactiveDays":30}}}', settingsTextarea('napcat.groupGuard.groups', config.get('napcat.groupGuard.groups', '{}'), { rows: 5, width: 340, placeholder: '{"123456":{"autoReview":true,"minLevel":16}}' })) +
            settingsRow('保护名单', '逗号分隔 QQ 号：不踢、不拉黑、不清理', settingsInput('napcat.groupGuard.protectedUsers', config.get('napcat.groupGuard.protectedUsers', ''), { width: 260, placeholder: '例如 10001,10002' })),
          ))}
          ${settingsSection('进群 / 退群提示与档案图', settingsCard(
            settingsRow('进群成功欢迎', 'group_increase 时发送欢迎语（默认 @ 新成员）', settingsToggle('napcat.groupGuard.notifyJoinSuccess', toBool(config.get('napcat.groupGuard.notifyJoinSuccess'), true))) +
            settingsRow('进群欢迎模板', '支持 {nickname} {qq} {level} {group} {group_id} {time}', settingsTextarea('napcat.groupGuard.joinTemplate', config.get('napcat.groupGuard.joinTemplate', DEFAULT_JOIN_TEMPLATE), { rows: 3, width: 340 })) +
            settingsRow('退群 / 被踢提示', 'group_decrease 时发送退群 / 被移出提示', settingsToggle('napcat.groupGuard.notifyDecrease', toBool(config.get('napcat.groupGuard.notifyDecrease'), true))) +
            settingsRow('主动退群模板', '支持 {nickname} {qq} {group} {group_id} {time}', settingsTextarea('napcat.groupGuard.leaveTemplate', config.get('napcat.groupGuard.leaveTemplate', DEFAULT_LEAVE_TEMPLATE), { rows: 3, width: 340 })) +
            settingsRow('被踢模板', '支持 {nickname} {qq} {operator} {group} {group_id} {time}', settingsTextarea('napcat.groupGuard.kickTemplate', config.get('napcat.groupGuard.kickTemplate', DEFAULT_KICK_TEMPLATE), { rows: 3, width: 340 })) +
            settingsRow('拉黑提示', '加入黑名单后在该群发送提示', settingsToggle('napcat.groupGuard.notifyBlacklist', toBool(config.get('napcat.groupGuard.notifyBlacklist'), true))) +
            settingsRow('拉黑模板', '支持 {nickname} {qq} {reason} {list} {group} {group_id} {time}', settingsTextarea('napcat.groupGuard.blacklistTemplate', config.get('napcat.groupGuard.blacklistTemplate', DEFAULT_BLACKLIST_TEMPLATE), { rows: 3, width: 340 })) +
            settingsRow('进群申请 / 进群 / 退群档案图', '根据 QQ 资料生成原创档案卡：申请提示、进群欢迎、退群提示都会附带；对应文字提示关闭时档案图仍会单独发送。图片过大自动降质，发送失败自动退化为纯文字', settingsToggle('napcat.groupGuard.openBoxImage', toBool(config.get('napcat.groupGuard.openBoxImage'), true))),
          ))}
          ${settingsSection('定时清理不活跃成员', settingsCard(
            settingsRow('启用定时清理', '按周期预排，实际清人固定在每天 18:00；提前 warnMinutes 发 @全体预告并批量踢出长期不活跃成员', settingsToggle('napcat.groupGuard.cleanup.enabled', toBool(config.get('napcat.groupGuard.cleanup.enabled'), false))) +
            settingsRow('清理周期（分钟）', '默认 10080 分钟 = 7 天；周期只决定哪一天，实际清人固定在该日 18:00', settingsInput('napcat.groupGuard.cleanup.intervalMinutes', config.get('napcat.groupGuard.cleanup.intervalMinutes', 10080), { type: 'number', width: 110 })) +
            settingsRow('预告等待（分钟）', '默认 10 分钟；用于计算 18:00 前多久发预告，实际清人固定在 18:00', settingsInput('napcat.groupGuard.cleanup.warnMinutes', config.get('napcat.groupGuard.cleanup.warnMinutes', 10), { type: 'number', width: 110 })) +
            settingsRow('不活跃天数', '群成员列表 last_sent_time（兜底 join_time）超过该天数视为不活跃', settingsInput('napcat.groupGuard.cleanup.inactiveDays', config.get('napcat.groupGuard.cleanup.inactiveDays', 30), { type: 'number', width: 110 })) +
            settingsRow('跳过管理员', '不清理群主（永远跳过）与管理员', settingsToggle('napcat.groupGuard.cleanup.skipAdmins', toBool(config.get('napcat.groupGuard.cleanup.skipAdmins'), true))) +
            settingsRow('清理对象加入黑名单', '关闭时清理踢出的人不会自动拉黑（默认关闭）', settingsToggle('napcat.groupGuard.cleanup.blacklistKicked', toBool(config.get('napcat.groupGuard.cleanup.blacklistKicked'), false))) +
            settingsRow('清理完成后播报', '结果为 0 人时也发送摘要；实际移出时始终合并为一条文本，不逐人发档案图', settingsToggle('napcat.groupGuard.cleanup.notifyResult', toBool(config.get('napcat.groupGuard.cleanup.notifyResult'), false))) +
            settingsRow('限定群', '留空 = 所有已配置的群聊渠道；也可填群号 / 群名（逗号或换行分隔）', settingsInput('napcat.groupGuard.cleanup.groups', config.get('napcat.groupGuard.cleanup.groups', ''), { width: 260, placeholder: '123456,789012' })) +
            settingsRow('预告文案', '支持 {minutes} {days} {group} {group_id}', settingsTextarea('napcat.groupGuard.cleanup.message', config.get('napcat.groupGuard.cleanup.message', DEFAULT_CLEANUP_MESSAGE), { rows: 3, width: 340 })) +
            settingsRow('每天晚上播报下一轮', '默认开启；约 20:00 播报下一次清人日期、剩余天数与当前预计清理人数，服务端代聊常驻即可补播一次', settingsToggle('napcat.groupGuard.cleanup.dailyBroadcast', toBool(config.get('napcat.groupGuard.cleanup.dailyBroadcast'), true))) +
            settingsRow('每日播报时间', '小时 / 分钟，默认 20:00', settingsInput('napcat.groupGuard.cleanup.dailyBroadcastHour', config.get('napcat.groupGuard.cleanup.dailyBroadcastHour', 20), { type: 'number', width: 80 }) + settingsInput('napcat.groupGuard.cleanup.dailyBroadcastMinute', config.get('napcat.groupGuard.cleanup.dailyBroadcastMinute', 0), { type: 'number', width: 80 })) +
            settingsRow('每日播报文案', '支持 {next_date} {next_time} {days} {days_text} {interval_days} {count} {group} {group_id}', settingsTextarea('napcat.groupGuard.cleanup.dailyMessage', config.get('napcat.groupGuard.cleanup.dailyMessage', DEFAULT_CLEANUP_DAILY_MESSAGE), { rows: 3, width: 340 })) +
            settingsRow('清理结束播报文案', '每轮批量踢完后播报下一轮清人时间；支持 {next_date} {days} {days_text}', settingsTextarea('napcat.groupGuard.cleanup.nextMessage', config.get('napcat.groupGuard.cleanup.nextMessage', DEFAULT_CLEANUP_NEXT_MESSAGE), { rows: 3, width: 340 })),
          ))}
          <div class="settings-note">默认只响应「群规则」里显式配置过的群；机器人所在的其它群不会审核、欢迎、拉黑或清理。需要旧版“全局默认套所有群”行为时，打开上面的「响应所有群（兼容旧行为）」。机器人的实际群体权限决定动作能否成功（踢人需要管理员 / 群主）。定时清理由服务端代聊 headless worker 常驻执行，关闭 WebUI 页面后仍会继续；自动清人固定为周期落点当天的 18:00（提前 warnMinutes 发预告），重新打开只会恢复未完成的踢人阶段并自动补上到期周期。模型可调用工具 cleanup_trigger，把某个群的下一轮清理倒计时直接缩减为立即触发；清理踢完后会自动播报下一轮时间和剩余天数。上面的所有规则都可以在「群规则」JSON 里按群覆盖：autoReview / minLevel / requireVisibleLevel / whitelist / blacklist / blacklistId / maxReject / notify / notifyTemplate / notifyJoinSuccess / joinTemplate / notifyDecrease / leaveTemplate / kickTemplate / notifyBlacklist / blacklistTemplate / openBoxImage / protectedUsers / cleanup{enabled,intervalMinutes,warnMinutes,inactiveDays,skipAdmins,blacklistKicked,notifyResult,message,dailyBroadcast,dailyBroadcastHour,dailyBroadcastMinute,dailyMessage,nextMessage}。</div>
        `
        return bindSettings(container)
      },
    })
    ctx.effect(() => () => disposeSettings?.())
  }

  /* ---------------- 服务与事件注册 ---------------- */

  const disposeGuardTool = tools.register('napcat_group_guard', guardToolDefinition, toolGuard)
  ctx.effect(() => () => {
    try {
      disposeGuardTool?.()
    } catch (_) {
      /* ignore */
    }
  })

  ctx.provide(
    'napcat-group-guard',
    {
      name,
      version,
      status: guardStatus,
      blacklists: readBlacklists,
      isBlacklisted,
      addBlacklist: addBlacklistAndEnforce,
      removeBlacklist: removeBlacklistEntry,
      kickBlacklisted: kickBlacklistedMembers,
      enforceBlacklistScan,
      previewCleanup,
      runCleanupCycle,
      triggerCleanup: triggerCleanupNow,
      kickPendingCleanup: kickPendingCleanupNow,
      broadcastDailyCleanup: maybeBroadcastDailyCleanup,
      pollRequests: pollPendingRequests,
      resumePending: resumePendingCleanup,
      resolveRule,
      reloadSchedule: refreshCleanupSchedule,
    },
    { type: 'singleton' },
  )

  const offRequest = events.on('napcat:request', payload => {
    handleRequestEvent(payload || {}).catch(err => ctx.logger.warn(`[napcat-group-guard] 处理入群申请失败：${err?.message || err}`))
  })
  ctx.effect(offRequest)

  const offNotice = events.on('napcat:notice', payload => {
    handleNotice(payload || {}).catch(err => ctx.logger.warn(`[napcat-group-guard] 处理群事件失败：${err?.message || err}`))
  })
  ctx.effect(offNotice)

  const offCleanupWatch = config.watch(pref('cleanup'), () => {
    // 某个群关掉清理时，到点后的 executePendingKick 会发现目标已排除并自动丢弃；
    // 这里只需要重新评估下一个到期时间。
    refreshCleanupSchedule()
  })
  ctx.effect(offCleanupWatch)

  // 新增 / 更新群渠道后重新评估清理目标；如果上一轮已过期，会让它尽快补跑。
  const offChannelWatch = events.on('channel:add', () => refreshCleanupSchedule())
  ctx.effect(offChannelWatch)
  const offChannelUpdateWatch = events.on('channel:updated', () => refreshCleanupSchedule())
  ctx.effect(offChannelUpdateWatch)
  const offEnabledWatch = config.watch(pref('enabled'), value => {
    if (toBool(value, true)) {
      resumePendingCleanup().catch(() => {})
      refreshCleanupSchedule()
    } else {
      for (const timer of cleanupKickTimers.values()) ctx.clearTimeout(timer)
      cleanupKickTimers.clear()
      writePendingCleanups({})
      writeState({ pendingCleanup: null })
      scheduleNextCleanup(0)
    }
  })
  ctx.effect(offEnabledWatch)

  // 事件补偿轮询：SSE 漏事件 / 重启期间积压的申请，由 get_group_system_msg 兜底处理。
  const pollSeconds = clampNumber(config.get(pref('pollIntervalSeconds'), 30), 5, 3600, 30, { integer: true })
  const pollTimer = ctx.setInterval(() => {
    pollPendingRequests().catch(err => ctx.logger.debug(`[napcat-group-guard] 申请轮询失败：${err?.message || err}`))
  }, pollSeconds * 1000)
  ctx.effect(() => () => ctx.clearInterval(pollTimer))

  // 每天约 20:00 播报下一轮清人时间；60s 检查一次是为了兼容页面在 20:00 后才打开、
  // 或者浏览器定时器被节流的情况，实际发送由“本地日期 + 后端租约”保证每天每群一次。
  const dailyBroadcastTimer = ctx.setInterval(() => {
    maybeBroadcastDailyCleanup().catch(err => ctx.logger.debug(`[napcat-group-guard] 每日清理播报检查失败：${err?.message || err}`))
  }, 60 * 1000)
  ctx.effect(() => () => ctx.clearInterval(dailyBroadcastTimer))
  ctx.setTimeout(() => {
    maybeBroadcastDailyCleanup().catch(() => {})
  }, 12000)

  // 启动后恢复未完成的清理踢人阶段，再安排下一轮；如果 lastCleanupAt 已经过期，会在几秒后补跑。
  ctx.setTimeout(() => {
    resumePendingCleanup().catch(() => {})
    refreshCleanupSchedule()
  }, 2500)

  // 启动补扫：黑名单里仍在群内的人直接踢掉（可通过设置关闭）。
  ctx.setTimeout(() => {
    if (!enforceOnStartup()) return
    enforceBlacklistScan()
      .then(kicked => {
        if (kicked.length) ctx.logger.info(`[napcat-group-guard] 启动补扫踢出黑名单成员 ${kicked.length} 人。`)
      })
      .catch(err => ctx.logger.debug(`[napcat-group-guard] 启动黑名单补扫失败：${err?.message || err}`))
  }, 8000)

  ctx.effect(() => () => {
    MEMBER_CACHE.clear()
    CLEANUP_RECENT.clear()
    RECENT_NOTICES.clear()
    PENDING_IMAGE_SENDS.clear()
    if (pendingImageTimer) {
      clearInterval(pendingImageTimer)
      pendingImageTimer = null
    }
  })

  ctx.logger.info(
    `[napcat-group-guard] 群管助手已加载：档案图=${dossierImageEnabled() ? '开' : '关'}，` +
      `响应范围=${allGroupsEnabled() ? 'NapCat 所有群（兼容旧行为）' : '仅群规则中配置过的群'}，` +
      `总开关=${enabled() ? '开' : '关'}，` +
      `渲染器=${rendererReady ? '浏览器 Canvas（本地）' : '服务端渲染（PowerShell，失败自动纯 Node PNG）'}。`,
  )
  if (!rendererReady) {
    ctx.logger.info(
      '[napcat-group-guard] 当前实例没有浏览器 Canvas，将调用后端桥 /api/group-guard/render 在服务端生成档案图；' +
        'PowerShell 不可用时自动降级为纯 Node PNG，不再要求 WebUI 页面常驻。',
    )
  }
  ctx.logger.debug('群管助手就绪（入群自动审核 + 共享黑名单联动 + 定时清理不活跃成员）')
}
