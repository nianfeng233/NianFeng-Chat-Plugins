/*
 * bilibili · 协议客户端（只被后端 bridge / lib 使用）
 *
 * 非官方接口封装：登录态 Cookie + WBI 签名 + 私信 / 消息中心 / 评论。
 * 所有端点集中放在 URLS 里，B站接口调整时只需要改这里。
 */
import { createHash } from 'node:crypto'
import { libUrl } from './rev.mjs'

const { safeJsonParse, randomToken } = await import(libUrl('util.mjs'))
const { parseTarget } = await import(libUrl('normalize.mjs'))

export const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

export const URLS = {
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  spi: 'https://api.bilibili.com/x/frontend/finger/spi',
  qrGenerate: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
  qrPoll: 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll',
  dmSessions: 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions',
  // 新版网页 IM 的消息记录入口，旧版 session_svr 端点已逐步 404，运行时会在候选里自动探测并缓存可用者。
  dmMessages: 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs',
  dmMessagesFallbacks: [
    'https://api.vc.bilibili.com/session_svr/v1/session_svr/sync_fetch_session_msgs',
    'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_session_msgs',
  ],
  dmSend: 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg',
  msgfeedReply: 'https://api.bilibili.com/x/msgfeed/reply',
  msgfeedAt: 'https://api.bilibili.com/x/msgfeed/at',
  msgfeedLike: 'https://api.bilibili.com/x/msgfeed/like',
  msgfeedSystem: 'https://api.bilibili.com/x/msgfeed/system',
  msgfeedUnread: 'https://api.bilibili.com/x/msgfeed/unread',
  videoView: 'https://api.bilibili.com/x/web-interface/view',
  replyMain: 'https://api.bilibili.com/x/v2/reply',
  replyWbiMain: 'https://api.bilibili.com/x/v2/reply/wbi/main',
  replyAdd: 'https://api.bilibili.com/x/v2/reply/add',
  commentReplies: 'https://api.bilibili.com/x/v2/reply/reply',
  userCard: 'https://api.bilibili.com/x/web-interface/card',
  spaceArcSearch: 'https://api.bilibili.com/x/space/wbi/arc/search',
  videoLike: 'https://api.bilibili.com/x/web-interface/archive/like',
  videoCoin: 'https://api.bilibili.com/x/web-interface/coin/add',
  favFolderList: 'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
  favFolderAdd: 'https://api.bilibili.com/x/v3/fav/folder/add',
  favDeal: 'https://api.bilibili.com/x/v3/fav/resource/deal',
}

export const RISK_CODES = [-352, -412, -509, -799]
export const NEED_LOGIN_CODES = [-101, -400]

export class BiliApiError extends Error {
  constructor(message, { code = 0, risk = false, needLogin = false, status = 0, endpoint = '' } = {}) {
    super(message)
    this.name = 'BiliApiError'
    this.biliCode = Number(code) || 0
    this.risk = !!risk
    this.needLogin = !!needLogin
    this.status = Number(status) || 0
    this.endpoint = endpoint
  }
}

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

export function signWbi(params, imgKey, subKey, wts = Math.floor(Date.now() / 1000)) {
  const mixin = MIXIN_KEY_ENC_TAB.map(index => `${imgKey || ''}${subKey || ''}`[index] || '').join('').slice(0, 32)
  const all = { ...params, wts }
  const query = Object.keys(all)
    .sort()
    .map(key => {
      const value = String(all[key] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const wRid = createHash('md5').update(query + mixin).digest('hex')
  return { ...all, w_rid: wRid }
}

function matchDomain(host, domain) {
  const target = String(host || '').toLowerCase()
  const rule = String(domain || '').toLowerCase().replace(/^\./, '')
  if (!target || !rule) return false
  return target === rule || target.endsWith(`.${rule}`)
}

export function parseSetCookieLines(lines, defaultDomain = '') {
  const out = []
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    const text = String(line || '').trim()
    if (!text) continue
    const parts = text.split(';')
    const first = parts.shift() || ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const cookie = {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
      domain: defaultDomain,
      path: '/',
      expires: 0,
      secure: false,
      httpOnly: false,
    }
    for (const part of parts) {
      const index = part.indexOf('=')
      const key = (index >= 0 ? part.slice(0, index) : part).trim().toLowerCase()
      const value = index >= 0 ? part.slice(index + 1).trim() : ''
      if (key === 'domain' && value) cookie.domain = value.replace(/^\./, '')
      else if (key === 'path' && value) cookie.path = value
      else if (key === 'expires' && value) cookie.expires = Date.parse(value) || 0
      else if (key === 'max-age' && value) cookie.expires = Date.now() + (Number(value) || 0) * 1000
      else if (key === 'secure') cookie.secure = true
      else if (key === 'httponly') cookie.httpOnly = true
    }
    if (cookie.name && cookie.domain) out.push(cookie)
  }
  return out
}

export class CookieJar {
  constructor(list = []) {
    this.map = new Map()
    this.upsert(list)
  }

  keyOf(cookie) {
    return `${String(cookie.domain || '').toLowerCase()}|${cookie.path || '/'}|${cookie.name}`
  }

  upsert(list) {
    let changed = false
    for (const cookie of Array.isArray(list) ? list : []) {
      if (!cookie?.name || cookie.value === undefined || cookie.value === null) continue
      const next = {
        name: String(cookie.name),
        value: String(cookie.value),
        domain: String(cookie.domain || 'bilibili.com').replace(/^\./, ''),
        path: String(cookie.path || '/'),
        expires: Number(cookie.expires) || 0,
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly === true,
      }
      const key = this.keyOf(next)
      const before = this.map.get(key)
      if (!before || before.value !== next.value || before.expires !== next.expires) {
        this.map.set(key, next)
        changed = true
      }
    }
    return changed
  }

  get(name) {
    for (const cookie of this.map.values()) if (cookie.name === name) return cookie.value
    return ''
  }

  get csrf() {
    return this.get('bili_jct')
  }

  get selfUid() {
    return Number(this.get('DedeUserID')) || 0
  }

  get loginExpired() {
    return !this.get('SESSDATA')
  }

  header(url) {
    let host = ''
    let secure = false
    let path = '/'
    try {
      const parsed = url instanceof URL ? url : new URL(String(url))
      host = parsed.hostname
      secure = parsed.protocol === 'https:'
      path = parsed.pathname || '/'
    } catch (_) {
      return ''
    }
    const now = Date.now()
    const pairs = []
    for (const cookie of this.map.values()) {
      if (!matchDomain(host, cookie.domain)) continue
      if (cookie.secure && !secure) continue
      if (cookie.expires && cookie.expires < now) continue
      const cookiePath = cookie.path || '/'
      if (!path.startsWith(cookiePath) && !(cookiePath.endsWith('/') && path === cookiePath.slice(0, -1))) continue
      pairs.push(`${cookie.name}=${cookie.value}`)
    }
    return pairs.join('; ')
  }

  /** passport 登录成功后把登录 Cookie 归一到 .bilibili.com，保证 api / message 子域都能带上。 */
  rehome(domain = 'bilibili.com') {
    const next = []
    for (const cookie of [...this.map.values()]) {
      if (!String(cookie.domain || '').includes('bilibili')) continue
      this.map.delete(this.keyOf(cookie))
      next.push({ ...cookie, domain })
    }
    return this.upsert(next)
  }

  toJSON() {
    return [...this.map.values()]
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

export class BiliClient {
  constructor({ cookies = [], logger = null, userAgent = BILI_UA, timeoutMs = 20000, devId = '', fetchImpl = null } = {}) {
    this.jar = new CookieJar(cookies)
    this.logger = logger
    this.userAgent = userAgent
    this.timeoutMs = Math.max(3000, Number(timeoutMs) || 20000)
    this.devId = String(devId || '').trim()
    this.fetchImpl = fetchImpl || globalThis.fetch
    this.wbi = { keys: null, at: 0 }
    this.buvidChecked = false
    // 探测成功后缓存私信记录端点，后续不再逐个试。
    this.dmMessagesEndpoint = ''
  }

  get selfUid() {
    return this.jar.selfUid
  }

  get csrf() {
    return this.jar.csrf
  }

  get cookies() {
    return this.jar.toJSON()
  }

  setDevId(value) {
    const text = String(value || '').trim()
    if (text) this.devId = text
  }

  async request(url, { method = 'GET', params, form, json, headers = {}, referer = 'https://www.bilibili.com/', timeoutMs, raw = false, sign = false, skipBuvid = false } = {}) {
    if (!skipBuvid) await this.ensureBuvid()
    let target = url instanceof URL ? new URL(url.href) : new URL(String(url))
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue
        target.searchParams.set(key, String(value))
      }
    }
    if (sign) {
      const keys = await this.ensureWbi()
      if (keys) {
        const signed = signWbi(Object.fromEntries(target.searchParams.entries()), keys.imgKey, keys.subKey)
        target = new URL(target.origin + target.pathname)
        for (const [key, value] of Object.entries(signed)) target.searchParams.set(key, String(value))
      }
    }
    const upper = String(method || 'GET').toUpperCase()
    const body = json !== undefined ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), Math.max(3000, Number(timeoutMs) || this.timeoutMs))
    let response
    try {
      response = await this.fetchImpl(target.href, {
        method: upper,
        body,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: referer,
          ...(upper === 'POST' ? { Origin: new URL(referer).origin } : {}),
          ...(json !== undefined
            ? { 'Content-Type': 'application/json; charset=UTF-8' }
            : body
              ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
              : {}),
          'Cookie': this.jar.header(target),
          ...headers,
        },
        redirect: 'follow',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
    if (setCookies.length) this.jar.upsert(parseSetCookieLines(setCookies, target.hostname))
    const text = await response.text()
    if (raw) return { status: response.status, text, url: response.url, data: safeJsonParse(text, null) }
    const data = safeJsonParse(text, null)
    if (response.status === 412) {
      throw new BiliApiError(`B站请求被拦截（HTTP 412，${target.pathname}）`, { status: 412, risk: true, endpoint: target.pathname })
    }
    if (!data || typeof data !== 'object' || typeof data.code !== 'number') {
      throw new BiliApiError(`B站接口返回了无法解析的数据（HTTP ${response.status}，${target.pathname}）`, {
        status: response.status,
        endpoint: target.pathname,
      })
    }
    if (Number(data.code) !== 0) {
      const code = Number(data.code)
      throw new BiliApiError(`B站接口 code=${code}：${data.message || data.msg || '未知错误'}（${target.pathname}）`, {
        code,
        status: response.status,
        risk: RISK_CODES.includes(code),
        needLogin: NEED_LOGIN_CODES.includes(code),
        endpoint: target.pathname,
      })
    }
    return data.data
  }

  async ensureBuvid(force = false) {
    if (!force && this.buvidChecked && this.jar.get('buvid3')) return true
    this.buvidChecked = true
    try {
      const data = await this.request(URLS.spi, { raw: false, referer: 'https://www.bilibili.com/', skipBuvid: true })
      const b3 = String(data?.b_3 || '')
      const b4 = String(data?.b_4 || '')
      const list = []
      if (b3) list.push({ name: 'buvid3', value: b3, domain: 'bilibili.com', path: '/', secure: true, expires: Date.now() + 365 * 86400000 })
      if (b4) list.push({ name: 'buvid4', value: b4, domain: 'bilibili.com', path: '/', secure: true, expires: Date.now() + 365 * 86400000 })
      if (!b3) list.push({ name: 'buvid3', value: `${String(Math.random()).slice(2)}infoc`, domain: 'bilibili.com', path: '/', secure: true, expires: Date.now() + 86400000 })
      list.push({ name: 'b_nut', value: String(Math.floor(Date.now() / 1000)), domain: 'bilibili.com', path: '/', secure: true, expires: Date.now() + 365 * 86400000 })
      this.jar.upsert(list)
      return true
    } catch (err) {
      this.logger?.debug?.(`[bilibili] 获取 buvid 失败：${err?.message || err}`)
      return false
    }
  }

  async ensureWbi(force = false) {
    if (!force && this.wbi.keys && Date.now() - this.wbi.at < 30 * 60 * 1000) return this.wbi.keys
    try {
      const data = await this.request(URLS.nav, { referer: 'https://www.bilibili.com/' })
      const pick = value => String(value || '').split('/').pop()?.split('.')[0] || ''
      const keys = { imgKey: pick(data?.wbi_img?.img_url), subKey: pick(data?.wbi_img?.sub_url) }
      if (keys.imgKey && keys.subKey) {
        this.wbi = { keys, at: Date.now() }
        return keys
      }
    } catch (err) {
      this.logger?.debug?.(`[bilibili] 获取 WBI 密钥失败：${err?.message || err}`)
    }
    return null
  }

  /* ---------------- 登录 ---------------- */

  async nav() {
    return this.request(URLS.nav, { referer: 'https://www.bilibili.com/' })
  }

  async accountProfile() {
    const data = await this.nav()
    const uid = String(data?.mid || this.selfUid || '')
    return {
      uid,
      nickname: String(data?.uname || '').trim(),
      avatar: String(data?.face || '').trim(),
      isLogin: data?.isLogin !== false && !!uid,
    }
  }

  async qrGenerate() {
    const data = await this.request(URLS.qrGenerate, { referer: 'https://passport.bilibili.com/login' })
    const url = String(data?.url || '')
    const key = String(data?.qrcode_key || '')
    if (!url || !key) throw new BiliApiError('B站没有返回登录二维码')
    return { url, qrcodeKey: key, expiresIn: 180 }
  }

  /** code: 0 成功；86038 过期；86090 已扫码待确认；86101 未扫码。 */
  async qrPoll(qrcodeKey) {
    const data = await this.request(URLS.qrPoll, {
      params: { qrcode_key: qrcodeKey, source: 'main-fe-header' },
      referer: 'https://passport.bilibili.com/login',
      raw: false,
    })
    if (Number(data?.code) === 0) this.jar.rehome('bilibili.com')
    return {
      code: Number(data?.code ?? -1),
      message: String(data?.message || ''),
      url: String(data?.url || ''),
      refreshToken: String(data?.refresh_token || ''),
      cookies: this.jar.toJSON(),
    }
  }

  /* ---------------- 私信 ---------------- */

  async dmSessions() {
    return this.request(URLS.dmSessions, {
      params: {
        session_type: 1,
        group_fold: 1,
        unfollow_fold: 0,
        sort_rule: 2,
        build: 0,
        mobi_app: 'web',
        web_location: '333.1387',
      },
      referer: 'https://message.bilibili.com/',
    })
  }

  async dmMessages(peerUid, { size = 20, sessionId = 0 } = {}) {
    const params = {
      session_type: 1,
      talker_id: peerUid,
      session_id: sessionId,
      size: Math.max(1, Math.min(50, Number(size) || 20)),
      build: 0,
      mobi_app: 'web',
      // 新版 /svr_sync 需要，旧版会忽略多余参数。
      sender_device_id: 1,
      web_location: '333.1387',
    }
    const candidates = [...new Set([
      ...(this.dmMessagesEndpoint ? [this.dmMessagesEndpoint] : []),
      URLS.dmMessages,
      ...(URLS.dmMessagesFallbacks || []),
    ])]
    const attempts = []
    for (const url of candidates) {
      const path = new URL(url).pathname
      try {
        const data = await this.request(url, { params, referer: 'https://message.bilibili.com/' })
        if (data && (Array.isArray(data.messages) || Array.isArray(data.msgs) || data.session_id !== undefined)) {
          if (this.dmMessagesEndpoint !== url) {
            this.dmMessagesEndpoint = url
            this.logger?.info?.(`[bilibili] 私信记录端点已启用：${path}`)
          }
          return data
        }
        attempts.push(`${path}（没有返回消息列表）`)
      } catch (err) {
        if (err?.risk || err?.needLogin) throw err
        attempts.push(`${path}（${String(err?.message || err).replace(/^B站接口/, '')}）`)
      }
    }
    throw new BiliApiError(`B站私信记录接口全部不可用：${attempts.join('；')}`, { endpoint: new URL(candidates[0]).pathname })
  }

  async dmSend(peerUid, text) {
    const content = String(text ?? '').trim()
    if (!content) throw new BiliApiError('私信内容为空')
    const common = {
      csrf: this.csrf,
      csrf_token: this.csrf,
      mobi_app: 'web',
      platform: 'web',
      build: 0,
    }
    const payload = {
      sender_uid: String(this.selfUid),
      receiver_id: String(peerUid),
      receiver_type: 1,
      msg_type: 1,
      content: JSON.stringify({ content }),
      timestamp: Math.floor(Date.now() / 1000),
      dev_id: this.devId || this.jar.get('buvid3') || randomToken(16),
    }
    const form = { ...common }
    for (const [key, value] of Object.entries(payload)) form[`msg[${key}]`] = value
    try {
      return await this.request(URLS.dmSend, { method: 'POST', form, referer: 'https://message.bilibili.com/' })
    } catch (err) {
      if (!err || err.risk || err.needLogin) throw err
      try {
        // 部分版本接受表单里的 msg JSON 字符串。
        return await this.request(URLS.dmSend, {
          method: 'POST',
          form: { ...common, msg: JSON.stringify(payload) },
          referer: 'https://message.bilibili.com/',
        })
      } catch (second) {
        if (!second || second.risk || second.needLogin) throw second
        // 最后再尝试 application/json body（{msg:{...}, csrf}）。
        return this.request(URLS.dmSend, {
          method: 'POST',
          json: { ...common, msg: payload },
          referer: 'https://message.bilibili.com/',
        })
      }
    }
  }

  /* ---------------- 消息中心 ---------------- */

  async msgfeed(kind) {
    const url = { reply: URLS.msgfeedReply, at: URLS.msgfeedAt, like: URLS.msgfeedLike, system: URLS.msgfeedSystem }[kind]
    if (!url) throw new BiliApiError(`不支持的消息中心类型：${kind}`)
    return this.request(url, {
      params: { platform: 'web', build: 0, mobi_app: 'web' },
      referer: 'https://www.bilibili.com/',
    })
  }

  async msgfeedUnread() {
    return this.request(URLS.msgfeedUnread, { referer: 'https://www.bilibili.com/' })
  }

  /* ---------------- 评论 ---------------- */

  async videoInfo(target = {}) {
    const params = target.bvid ? { bvid: target.bvid } : target.aid || target.oid ? { aid: target.aid || target.oid } : null
    if (!params) throw new BiliApiError('缺少视频 BV 号 / aid')
    return this.request(URLS.videoView, { params, referer: 'https://www.bilibili.com/' })
  }

  /** 把 b23.tv / 各种链接 / BV / av / aid 规格化成 { bvid, aid, oid, type }。 */
  async resolveTarget(value) {
    let parsed = parseTarget(value)
    if (!parsed) throw new BiliApiError('没有识别出视频 / 动态目标')
    if (parsed.short) {
      const res = await this.request(parsed.short, { raw: true, referer: 'https://www.bilibili.com/' })
      const next = parseTarget(String(res.url || ''))
      if (next && (next.bvid || next.aid || next.oid)) parsed = next
      else throw new BiliApiError(`短链接没有跳转到视频页：${parsed.short}`)
    }
    if (parsed.bvid || parsed.aid) {
      const info = await this.videoInfo(parsed)
      const bvid = String(info?.bvid || parsed.bvid || '')
      const aid = String(info?.aid || parsed.aid || '')
      return {
        bvid,
        aid,
        oid: String(info?.aid || parsed.aid || parsed.bvid || ''),
        type: 1,
        title: String(info?.title || '').trim(),
        desc: String(info?.desc || '').trim(),
        pic: String(info?.pic || '').trim(),
        url: bvid ? `https://www.bilibili.com/video/${bvid}` : aid ? `https://www.bilibili.com/video/av${aid}` : '',
        duration: Number(info?.duration) || 0,
        owner: String(info?.owner?.name || '').trim(),
      }
    }
    if (parsed.oid) return { ...parsed, aid: parsed.type === 1 ? parsed.oid : '', title: '', desc: '', url: '' }
    throw new BiliApiError('目标里没有可用的视频 / 动态参数')
  }

  async comments({ oid, type = 1, pn = 1, ps = 20, sort = 0, wbi = false } = {}) {
    if (!oid) throw new BiliApiError('缺少评论 oid')
    if (wbi) {
      return this.request(URLS.replyWbiMain, {
        params: { oid, type, mode: 2, pn, ps, plat: 1, web_location: '1315875' },
        referer: 'https://www.bilibili.com/',
        sign: true,
      })
    }
    return this.request(URLS.replyMain, {
      params: { oid, type, sort, pn, ps, nohot: 0 },
      referer: 'https://www.bilibili.com/',
    }).catch(async err => {
      if (err?.risk) throw err
      return this.request(URLS.replyWbiMain, {
        params: { oid, type, mode: 2, pn, ps, plat: 1, web_location: '1315875' },
        referer: 'https://www.bilibili.com/',
        sign: true,
      })
    })
  }

  async commentAdd({ oid, type = 1, message, root = '', parent = '' } = {}) {
    const text = String(message ?? '').trim()
    if (!oid) throw new BiliApiError('缺少评论 oid')
    if (!text) throw new BiliApiError('评论内容为空')
    const form = {
      oid,
      type,
      message: text.slice(0, 1000),
      plat: 1,
      csrf: this.csrf,
    }
    if (root && root !== '0') form.root = root
    if (parent && parent !== '0') form.parent = parent
    return this.request(URLS.replyAdd, { method: 'POST', form, referer: 'https://www.bilibili.com/' })
  }

  /* ---------------- 视频互动（点赞 / 投币 / 收藏） ---------------- */

  videoPostForm(target, info) {
    const referer = info?.url || (info?.bvid ? `https://www.bilibili.com/video/${info.bvid}` : 'https://www.bilibili.com/')
    const form = { csrf: this.csrf }
    if (info?.bvid) form.bvid = info.bvid
    else if (info?.aid || info?.oid) form.aid = info.aid || info.oid
    if (!form.bvid && !form.aid) throw new BiliApiError('没有解析出视频 BV / aid')
    return { form, referer }
  }

  async videoLike(target, { like = true } = {}) {
    const info = await this.resolveTarget(target)
    const { form, referer } = this.videoPostForm(target, info)
    form.like = like === false ? 2 : 1
    return this.request(URLS.videoLike, { method: 'POST', form, referer })
  }

  async videoCoin(target, { count = 1, alsoLike = false } = {}) {
    const info = await this.resolveTarget(target)
    const { form, referer } = this.videoPostForm(target, info)
    form.multiply = Number(count) >= 2 ? 2 : 1
    form.select_like = alsoLike ? 1 : 0
    return this.request(URLS.videoCoin, { method: 'POST', form, referer })
  }

  async favoriteFolders(mid) {
    const data = await this.request(URLS.favFolderList, {
      params: { up_mid: String(mid || this.selfUid), web_location: '333.1387' },
      referer: `https://space.bilibili.com/${mid || this.selfUid}/favlist`,
    })
    return Array.isArray(data?.list) ? data.list : []
  }

  async favoriteEnsureFolder(mid, title = '念风收藏') {
    const list = await this.favoriteFolders(mid)
    if (list.length) return list[0]
    const data = await this.request(URLS.favFolderAdd, {
      method: 'POST',
      form: { title: String(title || '念风收藏').slice(0, 20), privacy: 0, csrf: this.csrf },
      referer: `https://space.bilibili.com/${mid || this.selfUid}/favlist`,
    })
    const id = data?.id || data?.folder_id
    if (!id) throw new BiliApiError('创建收藏夹失败：接口没有返回 id')
    return { id, title }
  }

  async videoFavorite(target, { folderId = '' } = {}) {
    const info = await this.resolveTarget(target)
    const referer = info?.url || (info?.bvid ? `https://www.bilibili.com/video/${info.bvid}` : 'https://www.bilibili.com/')
    const rid = info?.aid || info?.oid
    if (!rid) throw new BiliApiError('没有解析出视频 aid，无法收藏')
    let mediaId = String(folderId || '')
    if (!mediaId) {
      const folder = await this.favoriteEnsureFolder(this.selfUid)
      mediaId = String(folder?.id || '')
    }
    if (!mediaId) throw new BiliApiError('没有可用的收藏夹')
    return this.request(URLS.favDeal, {
      method: 'POST',
      form: { rid: String(rid), type: 2, add_media_ids: mediaId, csrf: this.csrf },
      referer,
    })
  }

  /** 查询某条根评论下的楼中楼，用于确认刚发出去的回复是否已经公开可见。 */
  async commentReplies({ oid, type = 1, root, ps = 20, pn = 1 } = {}) {
    if (!oid || !root) throw new BiliApiError('缺少 oid 或 root')
    return this.request(URLS.commentReplies, {
      params: { oid, type, root, ps, pn },
      referer: 'https://www.bilibili.com/',
    })
  }

  async userCard(uid) {
    const data = await this.request(URLS.userCard, { params: { mid: uid, photo: false }, referer: 'https://www.bilibili.com/' })
    return {
      uid: String(data?.card?.mid || uid),
      nickname: String(data?.card?.name || '').trim(),
      avatar: String(data?.card?.face || '').trim(),
    }
  }

  async ownVideos(mid, { ps = 10 } = {}) {
    const data = await this.request(URLS.spaceArcSearch, {
      params: {
        mid,
        ps: Math.max(1, Math.min(30, Number(ps) || 10)),
        pn: 1,
        order: 'pubdate',
        platform: 'web',
        web_location: '1550101',
        dm_img_list: '[]',
        dm_img_str: 'V2ViR0wgMS',
        dm_cover_img_str: 'V2ViR0wgMS',
      },
      referer: `https://space.bilibili.com/${mid}/video`,
      sign: true,
    })
    const list = data?.list?.vlist || []
    return list.map(item => ({ bvid: String(item.bvid || ''), aid: String(item.aid || ''), title: String(item.title || '') }))
  }
}

export function createBiliClient(options) {
  return new BiliClient(options)
}

export { sleep }
