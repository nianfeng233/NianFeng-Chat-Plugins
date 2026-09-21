/*
 * 念风chat · 扩展插件 · napcat-like
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * NapCat 点赞助手（外部插件，不随本体打包）。
 *
 * 功能：
 *   1. 每日 00:00 自动赞：
 *      - 配置 QQ 列表、每次点赞次数、使用的 NapCat 连接；
 *      - 到点后逐一调用 OneBot send_like；
 *      - 没跑到点（服务当时没开）时，默认当天启动后补赞一次，可关闭；
 *      - 所有实例通过后端桥租约 + 插件状态去重，避免 WebUI / headless 重复点赞。
 *   2. 群内「赞我」：
 *      - 只有配置在「启用群列表」里的群才会响应；
 *      - 支持多个触发词（默认「赞我」）；
 *      - 可配置群等级门槛、查不到等级时的行为、赞失败 / 等级不足 / 已赞 / 成功等回复文案；
 *      - 可对单个群做规则覆盖；回复时默认 @ 本人。
 *   3. chat_send 定向发送（不改本体源码）：
 *      - 插件在运行时扩展 tool-registry 里已有的 chat_send 定义，增加 qq / group / instance_id 参数；
 *      - 传 qq 或 group 时直接通过 NapCat 发送到指定账号，不要求目标已有渠道；
 *      - 不传时仍走本体原来的 chat_send 逻辑。
 *
 * 安装：把本目录复制到 <数据目录>/plugins/napcat-like/（或用 install.ps1），
 * 重新扫描插件即可；依赖内置 napcat 渠道插件。bridge.mjs 需要后端重启或
 * 插件安装触发的桥热加载才会提供多实例租约，没有租约时会回退到实例内去重。
 */

export const name = 'napcat-like'
export const version = '2.0.0'
export const scope = 'both'
export const displayName = 'NapCat 点赞助手'
export const description =
  '扩展 · NapCat 点赞：每日 00:00 自动赞列表、群内「赞我」指令（群等级门槛 / 回复文案可配）；并给 chat_send 扩展 qq / group 参数，可直接向指定 QQ 或群号发送消息。'
export const author = '念风扩展'
export const icon = '👍'
export const core = false
export const enabled = true
export const depends = {
  'channel-registry': '^1.0.0',
  config: '>=1.1.0',
  'event-bus': '*',
  napcat: '^1.0.0',
  'tool-registry': '^1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'plugin-manager': '>=1.0.0',
  'toast-host': '>=1.0.0',
}
export const inject = [
  'tool-registry',
  'channel-registry',
  'config',
  'event-bus',
  'napcat-channel?',
  'api?',
  'toast?',
  'plugin-manager?',
]
export const provides = [{ name: 'napcat-like', type: 'singleton' }]
export const permissions = ['network']

/* ================================================================== */
/* 模块级常量与小工具                                                   */
/* ================================================================== */

const DEFAULT_TRIGGERS = ['赞我']
const DEFAULT_SUCCESS_TEXT = '赞啦！已经给你点了 {times} 个赞，记得查收～'
const DEFAULT_REJECT_TEXT = '你的群等级是 {level}，需要达到 {minLevel} 才能使用「赞我」哦。'
const DEFAULT_LEVEL_UNKNOWN_TEXT = '暂时查询不到你的群等级，稍后再试吧。'
const DEFAULT_FAIL_TEXT = '这次点赞没成功：{error}'
const DEFAULT_ALREADY_TEXT = '今天已经给你点过赞啦，明天再来吧～'
const DEFAULT_SELF_TEXT = '不能给自己点赞啦。'
const DEFAULT_EMPTY_TARGET_TEXT = '没有可用的 NapCat 连接。'
const MAX_LOCAL_HANDLED = 800
const MAX_LIKED_DAYS = 7
const MAX_AUTO_RESULTS = 80
const MAX_REPLY_TEMPLATE_LENGTH = 1000
const DAILY_CHECK_MS = 60 * 1000
const DAILY_WINDOW_MINUTES = 10
const COMMAND_CLAIM_TTL_MS = 10 * 60 * 1000
const AUTO_CLAIM_TTL_MS = 30 * 60 * 1000
const SEND_PATCH_MARK = Symbol('napcat-like.chat-send-patch')

function normalizeId(value) {
  return String(value ?? '').replace(/[^\d]/g, '').trim()
}

function isQqId(value) {
  return /^\d{3,20}$/.test(normalizeId(value))
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

/** 把配置里的列表解析成数组：支持数组 / 中英文逗号、顿号、分号、竖线、斜杠、换行。 */
function parseWords(value) {
  if (Array.isArray(value)) return [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))]
  return [...new Set(String(value ?? '').split(/[,，、;；|/\\\n\r\t ]+/).map(item => item.trim()).filter(Boolean))]
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

/** 群名匹配用的归一化：全角转半角、去零宽 / 空白、去前导 @、小写。 */
function normalizeKey(value) {
  return String(value ?? '')
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u200b-\u200d\ufeff\s\u00a0]+/g, '')
    .toLowerCase()
    .replace(/^@+/, '')
}

/** 指令匹配用的归一化：去 @、去空白、去尾部标点，兼容「@机器人 赞我！」。 */
function normalizeCommandText(value) {
  return String(value ?? '')
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, '')
    .replace(/^@[^\s@]{1,40}/, '')
    .replace(/[。．.!！?？,，、~～]+$/g, '')
    .toLowerCase()
}

function formatTemplate(template, vars = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (_match, key) => {
    const value = vars[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

function localDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(Number(value) || Date.now())
  const pad = v => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatTime(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '尚未执行'
  const date = new Date(n)
  const pad = v => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

function parseMemberLevel(data) {
  if (!data || typeof data !== 'object') return null
  for (const key of ['level', 'member_level', 'memberLevel', 'memberRealLevel', 'member_real_level']) {
    const raw = data[key]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const n = Number(raw)
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n))
  }
  return null
}

function normalizeLikedUsers(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const keys = Object.keys(source)
    .filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort()
    .slice(-MAX_LIKED_DAYS)
  const out = {}
  for (const key of keys) {
    const day = source[key]
    if (!day || typeof day !== 'object' || Array.isArray(day)) continue
    const entries = Object.entries(day)
      .filter(([qq]) => isQqId(qq))
      .slice(-1000)
    out[key] = Object.fromEntries(entries)
  }
  return out
}

function messageIdsOf(result) {
  const raw = result?.messageIds ?? result?.message_ids ?? result?.messageId ?? result?.message_id ?? null
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  return list.map(item => String(item)).filter(Boolean)
}

function targetTextOf(target) {
  return target?.targetType === 'group' ? `群 ${target.targetId}` : `QQ ${target.targetId}`
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
  const api = ctx.inject('api?')
  const toast = ctx.inject('toast?')
  const manager = ctx.inject('plugin-manager?')
  const logger = ctx.logger

  const pref = key => `napcat.like.${key}`

  /* ---------------- 配置读取 ---------------- */

  const enabled = () => toBool(config.get(pref('enabled'), true), true)
  const autoEnabled = () => enabled() && toBool(config.get(pref('autoEnabled'), true), true)
  const commandEnabled = () => enabled() && toBool(config.get(pref('commandEnabled'), true), true)
  const directSendEnabled = () => enabled() && toBool(config.get(pref('directSendEnabled'), true), true)
  const catchUpEnabled = () => toBool(config.get(pref('catchUp'), true), true)
  const autoList = () =>
    parseWords(config.get(pref('autoList'), ''))
      .map(item => normalizeId(item))
      .filter(item => isQqId(item))
  const autoTimes = () => clampNumber(config.get(pref('autoTimes'), 10), 1, 20, 10, { integer: true })
  const autoIntervalMs = () => clampNumber(config.get(pref('autoIntervalMs'), 1200), 0, 60000, 1200, { integer: true })
  const autoInstance = () => String(config.get(pref('autoInstance'), '') || '').trim()
  const directInstance = () => String(config.get(pref('directInstance'), '') || '').trim()
  const groupList = () => parseWords(config.get(pref('groups'), ''))
  const triggerList = () => {
    const list = parseWords(config.get(pref('triggers'), DEFAULT_TRIGGERS.join('、')))
    return list.length ? list : [...DEFAULT_TRIGGERS]
  }
  const groupOverrides = () => parseJsonObject(config.get(pref('groupRules'), '{}'), {})
  const textConfig = (key, fallback) => {
    const value = config.get(pref(key), fallback)
    const text = String(value ?? fallback)
    return text.length > MAX_REPLY_TEMPLATE_LENGTH ? text.slice(0, MAX_REPLY_TEMPLATE_LENGTH) : text
  }

  const globalRule = () => ({
    enabled: true,
    minGroupLevel: clampNumber(config.get(pref('minGroupLevel'), 0), 0, 999, 0, { integer: true }),
    requireVisibleLevel: toBool(config.get(pref('requireVisibleLevel'), true), true),
    times: clampNumber(config.get(pref('commandTimes'), autoTimes()), 1, 20, autoTimes(), { integer: true }),
    oncePerDay: toBool(config.get(pref('oncePerDay'), true), true),
    mentionSender: toBool(config.get(pref('mentionSender'), true), true),
    successText: textConfig('successText', DEFAULT_SUCCESS_TEXT),
    rejectText: textConfig('rejectText', DEFAULT_REJECT_TEXT),
    levelUnknownText: textConfig('levelUnknownText', DEFAULT_LEVEL_UNKNOWN_TEXT),
    failText: textConfig('failText', DEFAULT_FAIL_TEXT),
    alreadyText: textConfig('alreadyText', DEFAULT_ALREADY_TEXT),
    selfText: textConfig('selfText', DEFAULT_SELF_TEXT),
  })

  function ruleFor(groupId) {
    const global = globalRule()
    const overrides = groupOverrides()
    const override = overrides?.[String(groupId ?? '').trim()] || overrides?.[normalizeId(groupId)]
    if (!override || typeof override !== 'object') return global
    const has = key => Object.prototype.hasOwnProperty.call(override, key)
    const numberOr = (key, fallback, min, max) => (has(key) ? clampNumber(override[key], min, max, fallback, { integer: true }) : fallback)
    const boolOr = (key, fallback) => (has(key) ? toBool(override[key], fallback) : fallback)
    const textOr = (key, fallback) => {
      if (!has(key)) return fallback
      const text = String(override[key] ?? '')
      return text.length > MAX_REPLY_TEMPLATE_LENGTH ? text.slice(0, MAX_REPLY_TEMPLATE_LENGTH) : text
    }
    return {
      enabled: boolOr('enabled', global.enabled),
      minGroupLevel: numberOr('minGroupLevel', global.minGroupLevel, 0, 999),
      requireVisibleLevel: boolOr('requireVisibleLevel', global.requireVisibleLevel),
      times: numberOr('times', global.times, 1, 20),
      oncePerDay: boolOr('oncePerDay', global.oncePerDay),
      mentionSender: boolOr('mentionSender', global.mentionSender),
      successText: textOr('successText', global.successText),
      rejectText: textOr('rejectText', global.rejectText),
      levelUnknownText: textOr('levelUnknownText', global.levelUnknownText),
      failText: textOr('failText', global.failText),
      alreadyText: textOr('alreadyText', global.alreadyText),
      selfText: textOr('selfText', global.selfText),
    }
  }

  /* ---------------- 持久化状态（config 同步 + 后端租约） ---------------- */

  function readState() {
    return parseJsonObject(config.get(pref('state'), '{}'), {})
  }

  function writeState(patch = {}) {
    const current = readState()
    const next = { ...current, ...patch }
    if (next.likedUsers !== undefined) next.likedUsers = normalizeLikedUsers(next.likedUsers)
    if (Array.isArray(next.autoLikeResults)) next.autoLikeResults = next.autoLikeResults.slice(-MAX_AUTO_RESULTS)
    config.set(pref('state'), safeJsonStringify(next))
    return next
  }

  function wasLiked(dateKey, qq) {
    const id = normalizeId(qq)
    if (!id) return false
    return !!readState().likedUsers?.[dateKey]?.[id]
  }

  function markLiked(dateKey, qq) {
    const id = normalizeId(qq)
    if (!id) return
    const state = readState()
    const liked = normalizeLikedUsers(state.likedUsers)
    const day = { ...(liked[dateKey] || {}) }
    day[id] = Date.now()
    liked[dateKey] = day
    writeState({ likedUsers: liked })
  }

  /* ---------------- 多实例租约（由 bridge.mjs 仲裁） ---------------- */

  let sharedLeaseUnavailable = false
  const sharedLeaseUsable = () => !sharedLeaseUnavailable && typeof api?.post === 'function'
  const leaseKey = (prefix, ...parts) => {
    const raw = parts.map(part => String(part ?? '').trim()).join(':').replace(/[\r\n]+/g, ' ')
    if (!raw) return prefix
    return raw.length <= 180 ? `${prefix}:${raw}` : `${prefix}:h${raw.slice(-170)}`
  }

  async function claimSharedLease(key, ttlMs) {
    if (!key || !sharedLeaseUsable()) return { supported: false, claimed: true, key }
    if (typeof api.configured === 'function' && api.configured() === false) return { supported: false, claimed: true, key }
    try {
      const data = await api.post('/napcat-like/claim', { key, ttlMs }, { timeoutMs: 3000 })
      if (data?.ok === true) return { supported: true, claimed: data.claimed === true, key, expiresAt: Number(data.expiresAt) || 0 }
      sharedLeaseUnavailable = true
      return { supported: false, claimed: true, key }
    } catch (err) {
      const status = Number(err?.status) || 0
      if (status === 400 || status === 401 || status === 404 || status === 405) sharedLeaseUnavailable = true
      logger.debug(`[napcat-like] 多实例租约不可用，回退到实例内去重：${err?.message || err}`)
      return { supported: false, claimed: true, key }
    }
  }

  async function releaseSharedLease(key) {
    if (!key || !sharedLeaseUsable()) return
    try {
      await api.post('/napcat-like/claim/release', { key }, { timeoutMs: 2000 })
    } catch (_) {
      /* 租约会自然过期 */
    }
  }

  /* ---------------- 渠道与实例 ---------------- */

  const allChannels = () => {
    const out = []
    for (const tab of registry.tabs()) out.push(...registry.channels(tab))
    return out
  }
  const isNapcatChannel = channel => channel?.type === 'napcat'
  const isGroupChannel = channel =>
    isNapcatChannel(channel) && (channel?.meta?.targetType === 'group' || channel?.meta?.category === 'group')
  const instanceIdOf = channel => String(channel?.meta?.instanceId || '').trim()
  const targetTypeOf = channel => (channel?.meta?.targetType === 'group' || channel?.meta?.category === 'group' ? 'group' : 'private')
  const targetIdOf = channel => normalizeId(channel?.meta?.targetId)
  const channelNameOf = channel => String(channel?.meta?.targetName || channel?.name || '').trim()

  function listInstances() {
    try {
      const list = napcat?.listInstances?.()
      return Array.isArray(list) ? list : []
    } catch (_) {
      return []
    }
  }

  function instanceOf(instanceId) {
    const id = String(instanceId || '').trim()
    if (!id) return null
    try {
      const direct = napcat?.instance?.(id)
      if (direct) return direct
    } catch (_) {
      /* ignore */
    }
    return listInstances().find(item => String(item?.id || '') === id) || null
  }

  function isInstanceOnline(item) {
    const status = String(item?.status || '').toLowerCase()
    if (status === 'online') return true
    return item?.online === true || item?.connected === true || item?.isOnline === true
  }

  function resolveOnlineInstance(preferred = '') {
    const wanted = String(preferred || '').trim()
    const list = listInstances()
    if (wanted) {
      const record = list.find(item => String(item?.id || '') === wanted)
      if (!record) return { ok: false, code: 'NO_INSTANCE', error: `找不到指定的 NapCat 连接：${wanted}` }
      if (!isInstanceOnline(record)) {
        return { ok: false, code: 'INSTANCE_OFFLINE', error: `NapCat 连接 ${wanted} 当前状态：${record.status || '未知'}` }
      }
      return { ok: true, instanceId: wanted, record }
    }
    const online = list.filter(isInstanceOnline)
    if (online.length === 1) return { ok: true, instanceId: String(online[0].id || ''), record: online[0] }
    if (online.length > 1) {
      return {
        ok: false,
        code: 'INSTANCE_AMBIGUOUS',
        error: `当前有多个 NapCat 连接在线，请在设置中选择默认连接或调用时传 instance_id：${online
          .map(item => `${item.id}${item.login?.userId ? `(QQ ${item.login.userId})` : ''}`)
          .join('、')}`,
      }
    }
    return { ok: false, code: 'NO_INSTANCE', error: DEFAULT_EMPTY_TARGET_TEXT }
  }

  function botQqOf(instanceId) {
    const record = instanceOf(instanceId)
    return normalizeId(record?.login?.userId || record?.login?.user_id || record?.login?.uin || '')
  }

  function findChannelForTarget(targetType, targetId, instanceId = '') {
    const type = targetType === 'group' ? 'group' : 'private'
    const id = normalizeId(targetId)
    if (!id) return null
    return (
      allChannels().find(channel => {
        if (!isNapcatChannel(channel)) return false
        if (instanceId && instanceIdOf(channel) !== String(instanceId)) return false
        return targetTypeOf(channel) === type && targetIdOf(channel) === id
      }) || null
    )
  }

  function findGroupChannelByName(name) {
    const key = normalizeKey(name)
    if (!key) return null
    const matches = allChannels().filter(channel => {
      if (!isGroupChannel(channel)) return false
      return normalizeKey(channelNameOf(channel)) === key
    })
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) return { ambiguous: matches }
    return null
  }

  async function callOneBot(instanceId, action, params = {}, options = {}) {
    if (!napcat?.action) return { ok: false, code: 'NO_NAPCAT', error: 'NapCat 渠道服务不可用（napcat-channel 未启用）。' }
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
      if (!options.silent) logger.debug(`[napcat-like] ${action} 成功`)
      return { ok: true, data: result.data ?? null }
    } catch (err) {
      return { ok: false, code: 'ACTION_ERROR', error: `NapCat ${action} 调用失败：${err?.message || err}` }
    }
  }

  /* ---------------- 回复 / 点赞 ---------------- */

  async function replyToGroup(instanceId, groupId, text, { atQq = '', vars = {} } = {}) {
    const content = formatTemplate(text, vars).trim()
    if (!content) return { ok: false, code: 'EMPTY_REPLY', error: '回复内容为空。' }
    const message = []
    if (isQqId(atQq)) {
      message.push({ type: 'at', data: { qq: normalizeId(atQq) } })
      message.push({ type: 'text', data: { text: ` ${content}` } })
    } else {
      message.push({ type: 'text', data: { text: content } })
    }
    return callOneBot(instanceId, 'send_group_msg', { group_id: normalizeId(groupId), message }, { silent: true })
  }

  async function likeUser(instanceId, qq, times) {
    const id = normalizeId(qq)
    if (!isQqId(id)) return { ok: false, code: 'BAD_TARGET', error: 'QQ 号不合法。' }
    return callOneBot(instanceId, 'send_like', { user_id: id, times: clampNumber(times, 1, 20, 10, { integer: true }) }, { silent: true })
  }

  /* ---------------- 每日 00:00 自动赞 ---------------- */

  let dailyRunning = false

  async function runDailyLikeInternal({ force = false, reason = 'schedule' } = {}) {
    const list = autoList()
    if (!autoEnabled() && !force) return { ok: true, skipped: 'disabled' }
    if (!list.length) return { ok: true, skipped: 'empty' }

    const now = new Date()
    const dateKey = localDateKey(now)
    const state = readState()
    if (!force && state.autoLikeDate === dateKey) return { ok: true, skipped: 'done', date: dateKey }
    if (!force && state.autoLikeSkippedDate === dateKey) return { ok: true, skipped: 'missed', date: dateKey }

    const minutes = now.getHours() * 60 + now.getMinutes()
    const inMidnightWindow = minutes <= DAILY_WINDOW_MINUTES
    if (!force && !inMidnightWindow && !catchUpEnabled()) {
      writeState({ autoLikeSkippedDate: dateKey })
      return { ok: false, code: 'MISSED', skipped: 'outside-window', date: dateKey, error: '已错过 00:00，补赞功能未开启。' }
    }

    if (dailyRunning && !force) return { ok: true, skipped: 'running' }

    const resolved = resolveOnlineInstance(autoInstance())
    if (!resolved.ok) {
      logger.debug(`[napcat-like] 自动赞暂不可用：${resolved.error}`)
      return { ...resolved, date: dateKey, skipped: 'no-instance' }
    }
    const instanceId = resolved.instanceId
    const botQq = botQqOf(instanceId)
    const claimKey = leaseKey('napcat-like:auto', dateKey)
    // 列表长 / 间隔大时，租约要覆盖整个执行过程，避免执行到一半被另一个实例抢占。
    const claimTtl = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(AUTO_CLAIM_TTL_MS, list.length * (autoIntervalMs() + 3000)),
    )
    let claim = { supported: false, claimed: true, key: claimKey }
    if (!force) {
      claim = await claimSharedLease(claimKey, claimTtl)
      if (!claim.claimed) return { ok: true, duplicate: true, date: dateKey }
    }

    dailyRunning = true
    const results = []
    try {
      for (const qq of list) {
        if (botQq && normalizeId(qq) === botQq) {
          results.push({ qq, ok: false, skipped: 'self', at: Date.now() })
          continue
        }
        const result = await likeUser(instanceId, qq, autoTimes())
        results.push({
          qq,
          ok: result.ok === true,
          code: result.code || undefined,
          error: result.error || undefined,
          at: Date.now(),
        })
        if (result.ok) markLiked(dateKey, qq)
        const gap = autoIntervalMs()
        if (gap > 0 && qq !== list[list.length - 1]) await sleep(gap)
      }
      const successCount = results.filter(item => item.ok).length
      writeState({
        autoLikeDate: dateKey,
        autoLikeAt: Date.now(),
        autoLikeResults: results,
        autoLikeInstance: instanceId,
        autoLikeReason: reason,
      })
      logger.info(
        `[napcat-like] 每日自动赞完成（${dateKey}）：${successCount}/${results.length} 个成功，连接 ${instanceId}。`,
      )
      return {
        ok: true,
        date: dateKey,
        instanceId,
        list,
        results,
        successCount,
        failedCount: results.length - successCount,
        note: successCount === results.length ? '全部成功。' : '部分或全部失败，可在插件设置里查看结果并手动重试。',
      }
    } catch (err) {
      if (!force) await releaseSharedLease(claimKey)
      logger.warn(`[napcat-like] 每日自动赞执行失败：${err?.message || err}`)
      return { ok: false, code: 'RUN_FAILED', error: String(err?.message || err), date: dateKey }
    } finally {
      dailyRunning = false
    }
  }

  /* ---------------- 群内「赞我」 ---------------- */

  function groupMatches(groupId, channel) {
    const entries = groupList()
    if (!entries.length) return false
    const id = normalizeId(groupId)
    const nameKey = normalizeKey(channelNameOf(channel) || channel?.name || '')
    return entries.some(entry => {
      const entryId = normalizeId(entry)
      if (isQqId(entryId) && entryId === id) return true
      if (!isQqId(entryId) && nameKey && normalizeKey(entry) === nameKey) return true
      return false
    })
  }

  function matchLikeCommand(channel, message) {
    if (!enabled() || !commandEnabled()) return null
    const messageType = String(message?.messageType || '').trim()
    const groupId = normalizeId(message?.groupId || channel?.meta?.targetId)
    if (!groupId) return null
    if (messageType && messageType !== 'group' && !isGroupChannel(channel)) return null
    if (!groupMatches(groupId, channel)) return null
    const rule = ruleFor(groupId)
    if (!rule.enabled) return null
    const text = normalizeCommandText(message?.text)
    if (!text) return null
    const hit = triggerList()
      .map(trigger => normalizeCommandText(trigger))
      .find(trigger => trigger && text === trigger)
    if (!hit) return null
    return { groupId, trigger: hit, rule, channel }
  }

  const handledCommands = new Set()
  function rememberCommand(key) {
    handledCommands.add(key)
    if (handledCommands.size > MAX_LOCAL_HANDLED) {
      const first = handledCommands.values().next().value
      handledCommands.delete(first)
    }
  }

  async function handleLikeCommandInternal(payload = {}, matched = null, options = {}) {
    const channel = payload.channel || null
    const message = payload.message || {}
    const hit = matched || matchLikeCommand(channel, message)
    if (!hit) return { ok: false, code: 'NOT_COMMAND', error: '不是已启用的「赞我」指令。' }
    if (!napcat?.action) return { ok: false, code: 'NO_NAPCAT', error: 'NapCat 渠道服务不可用。' }

    const instanceId = instanceIdOf(channel)
    const groupId = hit.groupId
    const senderQq = normalizeId(message.senderId || message.userId)
    const messageId = String(message.messageId || message.id || `${groupId}:${senderQq}:${message.receivedAt || message.time || ''}`)
    const dedupeKey = leaseKey(instanceId || 'no-instance', groupId, messageId)
    if (!options.force && handledCommands.has(dedupeKey)) return { ok: true, duplicate: true }
    if (!options.force) {
      const claim = await claimSharedLease(leaseKey('napcat-like:cmd', dedupeKey), COMMAND_CLAIM_TTL_MS)
      if (!claim.claimed) {
        rememberCommand(dedupeKey)
        return { ok: true, duplicate: true, shared: claim.supported === true }
      }
    }
    rememberCommand(dedupeKey)

    if (!instanceId) {
      logger.warn('[napcat-like] 群聊渠道没有绑定 NapCat 连接，无法响应「赞我」。')
      return { ok: false, code: 'NO_INSTANCE', error: '群聊渠道没有绑定 NapCat 连接。' }
    }
    if (!isQqId(senderQq)) return { ok: false, code: 'BAD_SENDER', error: '消息里没有可用的发送者 QQ 号。' }

    const rule = hit.rule
    const dateKey = localDateKey()
    const botQq = botQqOf(instanceId)
    const baseVars = {
      qq: senderQq,
      nickname: String(message.senderName || message.senderNickname || message.senderCard || senderQq),
      group: channelNameOf(channel) || groupId,
      groupId,
      times: rule.times,
      minLevel: rule.minGroupLevel,
      level: '',
    }

    if (botQq && senderQq === botQq) {
      await replyToGroup(instanceId, groupId, rule.selfText, { atQq: rule.mentionSender ? senderQq : '', vars: baseVars })
      return { ok: true, replied: 'self', qq: senderQq, groupId }
    }

    if (rule.oncePerDay && wasLiked(dateKey, senderQq)) {
      await replyToGroup(instanceId, groupId, rule.alreadyText, { atQq: rule.mentionSender ? senderQq : '', vars: baseVars })
      return { ok: true, replied: 'already', qq: senderQq, groupId }
    }

    if (rule.minGroupLevel > 0) {
      const memberResult = await callOneBot(
        instanceId,
        'get_group_member_info',
        { group_id: groupId, user_id: senderQq, no_cache: true },
        { silent: true },
      )
      const level = memberResult.ok ? parseMemberLevel(memberResult.data) : null
      if (level === null) {
        if (rule.requireVisibleLevel) {
          await replyToGroup(instanceId, groupId, rule.levelUnknownText, {
            atQq: rule.mentionSender ? senderQq : '',
            vars: { ...baseVars, error: memberResult.error || '群等级不可见' },
          })
          return { ok: true, replied: 'level-unknown', qq: senderQq, groupId }
        }
      } else {
        baseVars.level = level
        if (level < rule.minGroupLevel) {
          await replyToGroup(instanceId, groupId, rule.rejectText, { atQq: rule.mentionSender ? senderQq : '', vars: baseVars })
          return { ok: true, replied: 'rejected', qq: senderQq, groupId, level, minLevel: rule.minGroupLevel }
        }
      }
    }

    const likeResult = await likeUser(instanceId, senderQq, rule.times)
    if (!likeResult.ok) {
      await replyToGroup(instanceId, groupId, rule.failText, {
        atQq: rule.mentionSender ? senderQq : '',
        vars: { ...baseVars, error: likeResult.error || likeResult.code || '点赞失败' },
      })
      return { ok: false, code: likeResult.code || 'LIKE_FAILED', error: likeResult.error, qq: senderQq, groupId }
    }

    markLiked(dateKey, senderQq)
    await replyToGroup(instanceId, groupId, rule.successText, { atQq: rule.mentionSender ? senderQq : '', vars: baseVars })
    logger.info(`[napcat-like] 已响应群 ${groupId} 的「赞我」：QQ ${senderQq}，${rule.times} 次。`)
    return { ok: true, replied: 'success', qq: senderQq, groupId, times: rule.times }
  }

  const onTriggerDecision = payload => {
    try {
      const hit = matchLikeCommand(payload?.channel, payload?.message)
      if (!hit) return payload
      return {
        ...payload,
        trigger: false,
        ignore: false,
        reason: 'napcat-like-command',
      }
    } catch (err) {
      logger.debug(`[napcat-like] 处理 trigger-decision 失败：${err?.message || err}`)
      return payload
    }
  }

  const onInbound = payload => {
    const hit = matchLikeCommand(payload?.channel, payload?.message)
    if (!hit) return
    handleLikeCommandInternal(payload, hit).catch(err => {
      logger.warn(`[napcat-like] 处理「赞我」失败：${err?.message || err}`)
    })
  }

  /* ---------------- chat_send 运行时扩展（不改本体源码） ---------------- */

  function parseDirectRequest(args = {}) {
    const qqRaw = args.qq ?? args.qq_number ?? args.qq号 ?? args.user_id ?? ''
    const groupRaw = args.group ?? args.group_id ?? args.group_number ?? args.group号 ?? ''
    const qq = String(qqRaw ?? '').trim()
    const group = String(groupRaw ?? '').trim()
    if (!qq && !group) return null
    if (qq && group) return { ok: false, code: 'BAD_TARGET', error: 'qq 与 group 只能填写一个。' }
    const instanceId = String(args.instance_id ?? args.instanceId ?? '').trim()
    if (qq) {
      const id = normalizeId(qq)
      if (!isQqId(id)) return { ok: false, code: 'BAD_TARGET', error: 'qq 必须是 3-20 位数字 QQ 号。' }
      return { ok: true, targetType: 'private', targetId: id, instanceId }
    }
    const id = normalizeId(group)
    if (isQqId(id)) return { ok: true, targetType: 'group', targetId: id, instanceId }
    const named = findGroupChannelByName(group)
    if (named?.ambiguous) {
      return {
        ok: false,
        code: 'GROUP_AMBIGUOUS',
        error: `群名「${group}」匹配到多个渠道，请改用群号：${named.ambiguous.map(channel => targetIdOf(channel)).join('、')}`,
      }
    }
    if (named) return { ok: true, targetType: 'group', targetId: targetIdOf(named), instanceId: instanceId || instanceIdOf(named) }
    return { ok: false, code: 'BAD_TARGET', error: `群号不合法，且没有找到名为「${group}」的群聊渠道。` }
  }

  async function resolveDirectTarget(request) {
    const targetType = request.targetType === 'group' ? 'group' : 'private'
    const targetId = normalizeId(request.targetId)
    if (!isQqId(targetId)) return { ok: false, code: 'BAD_TARGET', error: '目标号码不合法。' }

    let preferred = String(request.instanceId || '').trim()
    if (!preferred) {
      const bound = findChannelForTarget(targetType, targetId)
      const boundInstance = bound ? instanceIdOf(bound) : ''
      if (boundInstance) {
        const record = listInstances().find(item => String(item?.id || '') === boundInstance)
        // 目标渠道绑定连接在线时优先用它；绑定的连接已经离线时，允许回退到
        // 默认连接 / 唯一在线连接，避免“渠道在但连接掉了”完全发不出去。
        if (!record || isInstanceOnline(record)) preferred = boundInstance
      }
    }
    if (!preferred) preferred = directInstance()
    const resolved = resolveOnlineInstance(preferred)
    if (!resolved.ok) return resolved
    return { ok: true, targetType, targetId, instanceId: resolved.instanceId }
  }

  function normalizeImages(value) {
    const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]
    return list
      .map(item => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') return String(item.url || item.image_url || item.file || '').trim()
        return ''
      })
      .filter(Boolean)
      .slice(0, 4)
  }

  function normalizeDirectMessages(args = {}) {
    const messageInput = args.messages ?? args.message ?? args.content
    const rawList = Array.isArray(messageInput) ? messageInput : messageInput === undefined || messageInput === null ? [] : [messageInput]
    const list = []
    for (const raw of rawList) {
      const item = typeof raw === 'string' ? { content: raw } : raw && typeof raw === 'object' ? raw : {}
      const content = String(item.content ?? item.text ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '')
      const images = normalizeImages(item.images)
      if (typeof raw === 'string') {
        for (const part of raw.split(/\r?\n+/)) {
          const text = part.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
          if (text) list.push({ content: text, images: [] })
        }
      } else if (content.trim() || images.length) {
        list.push({ content, images })
      }
    }
    const topImages = normalizeImages(args.images ?? args.image)
    if (topImages.length) {
      if (list.length) list[0].images = [...list[0].images, ...topImages].slice(0, 4)
      else list.push({ content: '', images: topImages })
    }
    return list.filter(item => String(item.content || '').trim() || item.images.length)
  }

  async function sendOneToTarget(instanceId, targetType, targetId, item) {
    const text = String(item.content || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    const images = Array.isArray(item.images) ? item.images.slice(0, 4) : []
    if (!text && !images.length) return { ok: false, code: 'EMPTY_MESSAGE', error: '消息内容为空。' }
    try {
      if (typeof napcat?.send === 'function') {
        const result = await napcat.send({ instanceId, targetType, targetId, text, images })
        if (!result || result.ok === false) {
          return {
            ok: false,
            code: result?.code || 'SEND_FAILED',
            error: String(result?.error || result?.message || 'NapCat 发送失败'),
          }
        }
        return { ok: true, messageIds: messageIdsOf(result) }
      }
      const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg'
      const segments = []
      if (text) segments.push({ type: 'text', data: { text } })
      for (const image of images) {
        if (/^(https?|data|base64):/i.test(image)) segments.push({ type: 'image', data: { file: image } })
      }
      if (!segments.length) return { ok: false, code: 'EMPTY_MESSAGE', error: '消息内容为空或不支持的图片格式。' }
      const params = targetType === 'group' ? { group_id: targetId, message: segments } : { user_id: targetId, message: segments }
      const result = await callOneBot(instanceId, action, params, { silent: true })
      if (!result.ok) return result
      return { ok: true, messageIds: messageIdsOf(result.data) }
    } catch (err) {
      return { ok: false, code: 'SEND_ERROR', error: `发送失败：${err?.message || err}` }
    }
  }

  async function sendToDirectTarget(args, context = {}, request) {
    if (!directSendEnabled()) {
      return { ok: false, code: 'DIRECT_SEND_DISABLED', error: '定向发送已在插件设置中关闭。' }
    }
    const resolved = await resolveDirectTarget(request)
    if (!resolved.ok) return resolved
    const list = normalizeDirectMessages(args)
    if (!list.length) {
      return { ok: false, code: 'EMPTY_MESSAGE', error: 'messages 不能为空：请传入要发送的文本（可多条），并设置 end 表示是否结束本轮。' }
    }
    const messageIds = []
    for (const item of list) {
      if (context.entry?.cancelled === true) return { ok: false, code: 'CHAT_ABORTED', error: '请求已取消' }
      const result = await sendOneToTarget(resolved.instanceId, resolved.targetType, resolved.targetId, item)
      if (!result.ok) {
        return {
          ok: false,
          code: result.code || 'SEND_FAILED',
          error: result.error || '定向发送失败',
          target: { type: resolved.targetType, id: resolved.targetId, instance_id: resolved.instanceId },
        }
      }
      messageIds.push(...(result.messageIds || []))
    }
    logger.info(`[napcat-like] chat_send 定向发送到 ${targetTextOf(resolved)}（连接 ${resolved.instanceId}）成功。`)
    return {
      ok: true,
      channel: `napcat:${resolved.targetType}:${resolved.targetId}`,
      target: { type: resolved.targetType, id: resolved.targetId, instance_id: resolved.instanceId },
      message_ids: messageIds,
      sent_at: new Date().toISOString(),
      end: args.end === true || args.end === 'true',
      note: `已通过 NapCat 直接发送到${targetTextOf(resolved)}。`,
    }
  }

  function patchChatSendRecord() {
    try {
      const record = tools?.get?.('chat_send')
      if (!record || record[SEND_PATCH_MARK]) return false
      const definition = record.definition?.function
      const properties = definition?.parameters?.properties
      if (!definition || !properties) return false
      const addedKeys = []
      const extra = {
        qq: {
          type: 'string',
          description: '可选：直接发送到指定 QQ 号（私聊）。填写后会忽略 channel 参数；与 group 二选一。',
        },
        group: {
          type: 'string',
          description: '可选：直接发送到指定群号（也支持已有群聊渠道的群名）。填写后会忽略 channel 参数；与 qq 二选一。',
        },
        instance_id: {
          type: 'string',
          description: '可选：指定 NapCat 连接 id；省略时自动匹配目标已绑定的渠道、默认连接或唯一在线连接。',
        },
      }
      for (const [key, value] of Object.entries(extra)) {
        if (properties[key] === undefined) {
          properties[key] = value
          addedKeys.push(key)
        }
      }
      const originalDescription = String(definition.description || '')
      definition.description = `${originalDescription}\n【定向发送扩展】传入 qq 或 group 时，通过 NapCat 直接向指定 QQ / 群发送消息，不需要目标已有渠道；两个参数只能填一个。`
      const originalHandler = record.handler
      record.handler = async (args = {}, context = {}) => {
        const request = parseDirectRequest(args)
        if (!request) return originalHandler(args, context)
        if (request.ok === false) return request
        return sendToDirectTarget(args, context, request)
      }
      Object.defineProperty(record, SEND_PATCH_MARK, {
        value: { addedKeys, originalDescription, originalHandler },
        configurable: true,
        enumerable: false,
      })
      logger.debug('[napcat-like] 已为 chat_send 增加 qq / group / instance_id 参数。')
      return true
    } catch (err) {
      logger.warn(`[napcat-like] 扩展 chat_send 失败：${err?.message || err}`)
      return false
    }
  }

  function restoreChatSendRecord() {
    try {
      const record = tools?.get?.('chat_send')
      const patch = record?.[SEND_PATCH_MARK]
      if (!record || !patch) return
      record.handler = patch.originalHandler
      if (record.definition?.function) {
        record.definition.function.description = patch.originalDescription
        const properties = record.definition.function.parameters?.properties
        if (properties) {
          for (const key of patch.addedKeys || []) {
            if (properties[key] !== undefined) delete properties[key]
          }
        }
      }
      delete record[SEND_PATCH_MARK]
    } catch (_) {
      /* ignore */
    }
  }

  /* ---------------- 插件服务（给设置面板 / 测试 / 其它插件） ---------------- */

  const service = {
    name: 'napcat-like',
    version,
    status() {
      const state = readState()
      const instances = listInstances().map(item => ({
        id: String(item?.id || ''),
        status: String(item?.status || ''),
        qq: normalizeId(item?.login?.userId || item?.login?.user_id || ''),
      }))
      const results = Array.isArray(state.autoLikeResults) ? state.autoLikeResults : []
      return {
        enabled: enabled(),
        autoEnabled: autoEnabled(),
        commandEnabled: commandEnabled(),
        directSendEnabled: directSendEnabled(),
        autoLikeList: autoList(),
        autoTimes: autoTimes(),
        autoInstance: autoInstance(),
        directInstance: directInstance(),
        groups: groupList(),
        triggers: triggerList(),
        autoLikeDate: String(state.autoLikeDate || ''),
        autoLikeAt: Number(state.autoLikeAt) || 0,
        autoLikeResults: results,
        likedToday: Object.keys(state.likedUsers?.[localDateKey()] || {}),
        instances,
      }
    },
    runDailyLike: options => runDailyLikeInternal(options || {}),
    handleLikeCommand: (payload, options) => handleLikeCommandInternal(payload || {}, null, options || {}),
    matchLikeCommand: (channel, message) => matchLikeCommand(channel, message),
  }
  ctx.provide('napcat-like', service, { type: 'singleton' })

  /* ---------------- 设置面板 ---------------- */

  const escapeHtml = value =>
    String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const settingsSection = (title, content) =>
    `<div class="settings-section">${title ? `<div class="settings-section-title">${title}</div>` : ''}${content}</div>`
  const settingsCard = rows => `<div class="settings-card">${rows}</div>`
  const settingsRow = (title, help, control) =>
    `<div class="setting-row"><div class="setting-main"><div class="setting-name">${title}</div>${
      help ? `<div class="setting-help">${help}</div>` : ''
    }</div><div class="setting-control">${control}</div></div>`
  const settingsToggle = (key, on) => `<button class="switch ${on ? 'on' : ''}" data-nl-toggle="${escapeHtml(key)}"></button>`
  const settingsInput = (key, value, { type = 'text', width = 150, placeholder = '' } = {}) =>
    `<input class="setting-input" type="${type}" data-nl-input="${escapeHtml(key)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(
      placeholder,
    )}" style="width:${width}px" />`
  const settingsTextarea = (key, value, { rows = 4, width = 360, placeholder = '' } = {}) =>
    `<textarea class="setting-input" data-nl-textarea="${escapeHtml(key)}" rows="${rows}" placeholder="${escapeHtml(
      placeholder,
    )}" style="width:${width}px;resize:vertical">${escapeHtml(value)}</textarea>`
  const settingsSelect = (key, value, options) =>
    `<select class="setting-input" data-nl-select="${escapeHtml(key)}" style="width:220px">${options
      .map(
        option =>
          `<option value="${escapeHtml(option.value)}"${String(value) === String(option.value) ? ' selected' : ''}>${escapeHtml(
            option.label,
          )}</option>`,
      )
      .join('')}</select>`

  function notify(kind, message) {
    try {
      if (kind === 'error') toast?.warn?.(message)
      else toast?.[kind]?.(message)
    } catch (_) {
      /* ignore */
    }
  }

  function renderSettings(container) {
    let cleanup = null
    let disposed = false

    const bind = () => {
      const offs = []
      for (const element of container.querySelectorAll('[data-nl-toggle]')) {
        const key = element.dataset.nlToggle
        let value = toBool(config.get(key, element.classList.contains('on')), element.classList.contains('on'))
        element.classList.toggle('on', value)
        const onClick = () => {
          value = !value
          element.classList.toggle('on', value)
          config.set(key, value)
        }
        element.addEventListener('click', onClick)
        offs.push(() => element.removeEventListener('click', onClick))
        offs.push(config.watch(key, next => element.classList.toggle('on', toBool(next, value))))
      }
      for (const element of container.querySelectorAll('[data-nl-input]')) {
        const key = element.dataset.nlInput
        const value = config.get(key, element.value)
        element.value = element.type === 'number' ? String(Number(value) || 0) : String(value ?? '')
        const onChange = () => {
          let next = element.value
          if (element.type === 'number') {
            next = Number(element.value)
            if (!Number.isFinite(next)) next = Number(config.get(key, 0)) || 0
          }
          config.set(key, next)
        }
        element.addEventListener('change', onChange)
        offs.push(() => element.removeEventListener('change', onChange))
        offs.push(
          config.watch(key, next => {
            if (typeof document === 'undefined' || document.activeElement !== element) {
              element.value = element.type === 'number' ? String(Number(next) || 0) : String(next ?? '')
            }
          }),
        )
      }
      for (const element of container.querySelectorAll('[data-nl-textarea]')) {
        const key = element.dataset.nlTextarea
        element.value = String(config.get(key, element.value) ?? '')
        const onChange = () => config.set(key, element.value)
        element.addEventListener('change', onChange)
        offs.push(() => element.removeEventListener('change', onChange))
        offs.push(
          config.watch(key, next => {
            if (typeof document === 'undefined' || document.activeElement !== element) element.value = String(next ?? '')
          }),
        )
      }
      for (const element of container.querySelectorAll('[data-nl-select]')) {
        const key = element.dataset.nlSelect
        element.value = String(config.get(key, element.value) ?? '')
        const onChange = () => config.set(key, element.value)
        element.addEventListener('change', onChange)
        offs.push(() => element.removeEventListener('change', onChange))
        offs.push(
          config.watch(key, next => {
            if (typeof document === 'undefined' || document.activeElement !== element) element.value = String(next ?? '')
          }),
        )
      }
      const onClick = async event => {
        const button = event.target.closest?.('[data-nl-action]')
        if (!button) return
        const action = button.dataset.nlAction
        if (action === 'runDaily') {
          const confirmed =
            typeof globalThis.confirm !== 'function' ||
            globalThis.confirm('这会立即向自动赞列表里的 QQ 发起真实点赞，确定继续吗？')
          if (!confirmed) return
          button.disabled = true
          try {
            const result = await service.runDailyLike({ force: true, reason: 'settings' })
            if (result?.ok && result.results) notify('success', `自动赞执行完成：成功 ${result.successCount ?? '-'} / ${result.results.length}`)
            else if (result?.ok && result.skipped) notify('warn', `未执行：${result.skipped}`)
            else notify('warn', result?.error || `未执行：${result?.code || result?.skipped || '未知原因'}`)
            if (!disposed) paint()
          } catch (err) {
            notify('error', err?.message || String(err))
          } finally {
            button.disabled = false
          }
          return
        }
        if (action === 'resetState') {
          const confirmed = typeof globalThis.confirm !== 'function' || globalThis.confirm('确定清空记录、上次执行时间等状态吗？')
          if (!confirmed) return
          config.set(pref('state'), '{}')
          notify('success', '状态已清空')
          if (!disposed) paint()
        }
      }
      container.addEventListener('click', onClick)
      offs.push(() => container.removeEventListener('click', onClick))
      return () => {
        for (const off of offs) {
          try {
            off?.()
          } catch (_) {
            /* ignore */
          }
        }
      }
    }

    const paint = () => {
      cleanup?.()
      const status = service.status()
      const state = readState()
      const autoListValue = String(config.get(pref('autoList'), ''))
      const groupValue = String(config.get(pref('groups'), ''))
      const triggersValue = String(config.get(pref('triggers'), DEFAULT_TRIGGERS.join('、')))
      const results = Array.isArray(state.autoLikeResults) ? state.autoLikeResults : []
      const instanceOptions = [
        { value: '', label: '自动选择（仅一个在线连接时）' },
        ...status.instances.map(item => ({
          value: item.id,
          label: `${item.id}${item.qq ? ` · QQ ${item.qq}` : ''}${item.status ? ` · ${item.status}` : ''}`,
        })),
      ]
      const resultsText = results.length
        ? results
            .slice(-12)
            .map(item => `${item.qq}：${item.ok ? '成功' : item.skipped === 'self' ? '跳过（自己）' : item.error || item.code || '失败'}`)
            .join('；')
        : '暂无执行结果'
      container.innerHTML = `
        <div class="settings-title-row">
          <div>
            <div class="settings-title">NapCat 点赞助手</div>
            <div class="settings-desc">每日自动赞、群内「赞我」指令，以及 chat_send 的 qq / group 定向发送扩展。所有规则由代码执行，不经过模型；</div>
          </div>
        </div>
        ${settingsSection(
          '总开关',
          settingsCard(
            settingsRow('启用点赞助手', '关闭后自动赞、群内「赞我」、定向发送全部暂停', settingsToggle(pref('enabled'), enabled())) +
              settingsRow('每日自动赞', '每天 00:00 自动给列表里的 QQ 点赞', settingsToggle(pref('autoEnabled'), autoEnabled())) +
              settingsRow('群内「赞我」', '只响应下方启用群列表中的群', settingsToggle(pref('commandEnabled'), commandEnabled())) +
              settingsRow('开启 chat_send 定向发送', '为原 chat_send 增加 qq / group 参数；关闭后模型传这两个参数会被拒绝', settingsToggle(pref('directSendEnabled'), directSendEnabled())),
          ),
        )}
        ${settingsSection(
          '每日 00:00 自动赞',
          settingsCard(
            settingsRow(
              '自动赞 QQ 列表',
              '逗号 / 换行分隔。每天 00:00 逐个调用 NapCat send_like；默认每人 10 次。机器人自己的 QQ 会自动跳过。',
              settingsTextarea(pref('autoList'), autoListValue, { rows: 4, width: 360, placeholder: '123456789\\n987654321' }),
            ) +
              settingsRow('每次点赞次数', '1-20，默认 10；一般 QQ 每天最多 10 次', settingsInput(pref('autoTimes'), config.get(pref('autoTimes'), 10), { type: 'number', width: 90 })) +
              settingsRow('使用的 NapCat 连接', '留空时只有恰好一个在线连接才会执行', settingsSelect(pref('autoInstance'), autoInstance(), instanceOptions)) +
              settingsRow('点赞间隔（毫秒）', '每个 QQ 之间的等待时间，避免刷太快；默认 1200', settingsInput(pref('autoIntervalMs'), config.get(pref('autoIntervalMs'), 1200), { type: 'number', width: 110 })) +
              settingsRow('错过 00:00 补赞', '打开时：服务重启 / 页面后开，当天也会补执行一次；关闭时只认 00:00 后 10 分钟窗口', settingsToggle(pref('catchUp'), catchUpEnabled())),
          ),
        )}
        ${settingsSection(
          '群内「赞我」',
          settingsCard(
            settingsRow('启用「赞我」的群', '群号或群名，逗号 / 换行分隔；未列出的群完全忽略该指令', settingsTextarea(pref('groups'), groupValue, { rows: 4, width: 360, placeholder: '123456789\\n测试群' })) +
              settingsRow('触发词', '默认「赞我」，多个用逗号 / 换行分隔；会去掉 @、空白和尾部标点后精确匹配', settingsInput(pref('triggers'), triggersValue, { width: 240, placeholder: '赞我,给我点赞' })) +
              settingsRow('最低群等级', '成员在本群的群等级低于该值就按「等级不足」回复；0 表示不限制', settingsInput(pref('minGroupLevel'), config.get(pref('minGroupLevel'), 0), { type: 'number', width: 90 })) +
              settingsRow('查不到等级时拒绝', '开启后：查不到群等级按等级未知文案拒绝；关闭则继续尝试点赞', settingsToggle(pref('requireVisibleLevel'), toBool(config.get(pref('requireVisibleLevel'), true), true))) +
              settingsRow('每次点赞次数', '默认跟随每日自动赞设置；范围 1-20', settingsInput(pref('commandTimes'), config.get(pref('commandTimes'), autoTimes()), { type: 'number', width: 90 })) +
              settingsRow('每人每天只赞一次', '同一天内重复「赞我」直接回复已赞过，不再调用 send_like', settingsToggle(pref('oncePerDay'), toBool(config.get(pref('oncePerDay'), true), true))) +
              settingsRow('回复时 @ 本人', '关闭后只发文字，不插入 at 段', settingsToggle(pref('mentionSender'), toBool(config.get(pref('mentionSender'), true), true))),
          ),
        )}
        ${settingsSection(
          '回复文案',
          settingsCard(
            settingsRow('等级不足回复', '支持变量：{qq} {nickname} {group} {groupId} {level} {minLevel} {times}', settingsInput(pref('rejectText'), textConfig('rejectText', DEFAULT_REJECT_TEXT), { width: 360 })) +
              settingsRow('等级未知回复', '查不到群等级且「查不到等级时拒绝」开启时使用', settingsInput(pref('levelUnknownText'), textConfig('levelUnknownText', DEFAULT_LEVEL_UNKNOWN_TEXT), { width: 360 })) +
              settingsRow('点赞成功回复', '支持变量同上', settingsInput(pref('successText'), textConfig('successText', DEFAULT_SUCCESS_TEXT), { width: 360 })) +
              settingsRow('点赞失败回复', '额外支持 {error}', settingsInput(pref('failText'), textConfig('failText', DEFAULT_FAIL_TEXT), { width: 360 })) +
              settingsRow('今天已赞回复', '开启「每人每天只赞一次」后重复触发时使用', settingsInput(pref('alreadyText'), textConfig('alreadyText', DEFAULT_ALREADY_TEXT), { width: 360 })) +
              settingsRow('不能给自己赞回复', '发送者恰好是机器人登录 QQ 时使用', settingsInput(pref('selfText'), textConfig('selfText', DEFAULT_SELF_TEXT), { width: 360 })),
          ),
        )}
        ${settingsSection(
          '按群规则覆盖（高级）',
          settingsCard(
            settingsRow(
              'JSON 覆盖',
              '可选。格式：{"123456":{"minGroupLevel":10,"successText":"..."}}；支持 enabled / minGroupLevel / requireVisibleLevel / times / oncePerDay / mentionSender 和各回复文案。',
              settingsTextarea(pref('groupRules'), config.get(pref('groupRules'), '{}'), { rows: 5, width: 420, placeholder: '{"123456":{"minGroupLevel":10}}' }),
            ),
          ),
        )}
        ${settingsSection(
          '定向发送默认连接',
          settingsCard(
            settingsRow('默认 NapCat 连接', 'chat_send 传 qq / group 且目标没有绑定渠道时使用；留空只有唯一在线连接时才发送', settingsSelect(pref('directInstance'), directInstance(), instanceOptions)),
          ),
        )}
        ${settingsSection(
          '运行状态',
          settingsCard(
            settingsRow('上次自动赞', `${formatTime(state.autoLikeAt)}${state.autoLikeDate ? `（${state.autoLikeDate}）` : ''}`, '<span></span>') +
              settingsRow('最近结果', escapeHtml(resultsText), '<span></span>') +
              settingsRow('今日已赞', escapeHtml(status.likedToday.join('、') || '暂无'), '<span></span>') +
              settingsRow('在线连接', escapeHtml(status.instances.map(item => `${item.id}${item.status ? `(${item.status})` : ''}`).join('、') || '无'), '<span></span>') +
              settingsRow(
                '维护操作',
                '可手动立即执行一次真实自动赞，或清空插件状态（不会清空 QQ / 群配置）',
                '<button class="outline-btn" data-nl-action="runDaily">立即执行自动赞</button> <button class="outline-btn" data-nl-action="resetState">清空状态</button>',
              ),
          ),
        )}
        <div class="settings-note" style="padding:8px 15px 14px;font-size:12px;line-height:1.6;color:var(--text-3)">
          提示：定向发送会绕过渠道的跨渠道发送权限，让模型可以直接向任意 QQ / 群发消息；只建议在可信模型与可信环境里开启。
        </div>`
      cleanup = bind()
    }

    paint()
    return () => {
      disposed = true
      cleanup?.()
    }
  }

  if (manager?.registerSettings) {
    try {
      const dispose = manager.registerSettings({
        id: name,
        title: 'NapCat 点赞助手',
        description: '每日自动赞、群内「赞我」指令、chat_send 的 qq / group 定向发送扩展。',
        render: container => renderSettings(container),
      })
      ctx.effect(() => () => dispose?.())
    } catch (err) {
      logger.warn(`[napcat-like] 注册插件设置面板失败：${err?.message || err}`)
    }
  }

  /* ---------------- 事件订阅与定时器 ---------------- */

  const onToolRegistered = event => {
    const toolName = typeof event === 'string' ? event : event?.name
    if (toolName === 'chat_send') patchChatSendRecord()
  }
  const offToolRegistered = events.on('tool:registered', onToolRegistered)
  ctx.effect(offToolRegistered)
  patchChatSendRecord()

  const offTriggerDecision = events.on('napcat:trigger-decision', onTriggerDecision, { interceptor: true })
  ctx.effect(offTriggerDecision)

  const offInbound = events.on('napcat:inbound', onInbound)
  ctx.effect(offInbound)

  const dailyTimer = ctx.setInterval(() => {
    runDailyLikeInternal({ reason: 'timer' }).catch(err => logger.debug(`[napcat-like] 自动赞检查失败：${err?.message || err}`))
  }, DAILY_CHECK_MS)
  ctx.effect(() => () => ctx.clearInterval(dailyTimer))

  ctx.setTimeout(() => {
    runDailyLikeInternal({ reason: 'startup' }).catch(err => logger.debug(`[napcat-like] 启动补赞检查失败：${err?.message || err}`))
  }, 6000)

  const offEnabledWatch = config.watch(pref('enabled'), value => {
    if (toBool(value, true)) {
      patchChatSendRecord()
      ctx.setTimeout(() => {
        runDailyLikeInternal({ reason: 'enabled' }).catch(() => {})
      }, 500)
    }
  })
  ctx.effect(offEnabledWatch)

  ctx.effect(() => () => {
    handledCommands.clear()
    restoreChatSendRecord()
  })

  logger.info(
    `[napcat-like] 点赞助手已加载：每日自动赞=${autoEnabled() ? '开' : '关'}（${autoList().length} 个 QQ），` +
      `群内「赞我」=${commandEnabled() ? '开' : '关'}（${groupList().length} 个群），` +
      `chat_send 定向发送=${directSendEnabled() ? '开' : '关'}。`,
  )
  if (!api?.post) {
    logger.info('[napcat-like] 后端 api 服务不可用，多实例租约将回退到实例内去重；请确认后端承载插件桥。')
  }
}
