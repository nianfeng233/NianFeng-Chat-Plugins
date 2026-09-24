/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * web-access · 站点读取器（自包含扩展版本）。
 *
 * 读取策略（自动降级，尽量像真人浏览器一样拿到动态数据）：
 *   B 站视频：官方 API（buvid + WBI 签名）→ 浏览器 DOM → 页面内嵌 JSON → Tavily 提取
 *   抖音：浏览器渲染（点赞 / 评论 / 搜索结果）→ HTTP 内嵌 ROUTER_DATA / RENDER_DATA
 *   通用网页：HTTP 直连 → 浏览器渲染（SPA / 反爬时）→ Tavily 提取
 * 站内搜索：B站 API / 浏览器搜索页；抖音浏览器搜索页。
 */
import { createHash } from 'node:crypto'

/*
 * 热更新缓存穿透：bridge.mjs 热重载时带 ?v= revision，lib 依赖链继续复用同一
 * revision，避免更新插件后仍命中旧 ESM 模块缓存导致新导出缺失、后端桥 404。
 */
const __revision = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || ''
  } catch (_) {
    return ''
  }
})()
const libUrl = file => `./${String(file).replace(/^\.\//, '')}${__revision ? `?v=${encodeURIComponent(__revision)}` : ''}`

const { clampNumber, normalizeUrl, safeJsonParse, stripHtml, truncateText } = await import(libUrl('util.mjs'))
const { extractHtml } = await import(libUrl('http.mjs'))

const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

function fail(code, error, hint = '') {
  return { ok: false, code, error, ...(hint ? { hint } : {}) }
}

function success(data) {
  return { ok: true, ...data }
}

/* ------------------------------------------------------------------ */
/* URL / 站点识别                                                      */
/* ------------------------------------------------------------------ */

export function detectSiteKind(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch (_) {
    return { site: 'generic', kind: 'page', url: String(rawUrl || '') }
  }
  const host = url.hostname.toLowerCase()
  const path = url.pathname || '/'

  if (host === 'b23.tv' || host.endsWith('.b23.tv')) return { site: 'bilibili', kind: 'short', url: url.href }

  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
    const video = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(path)
    if (video) return { site: 'bilibili', kind: 'video', id: video[1], url: url.href }
    if (host.startsWith('search.') || path.startsWith('/search')) {
      const query = url.searchParams.get('keyword') || url.searchParams.get('q') || ''
      return { site: 'bilibili', kind: 'search', query, url: url.href }
    }
    const article = /\/read\/cv(\d+)/i.exec(path)
    if (article) return { site: 'bilibili', kind: 'article', id: `cv${article[1]}`, url: url.href }
    if (/^\/\d+\/?$/.test(path)) return { site: 'bilibili', kind: 'user', id: path.replace(/\//g, ''), url: url.href }
    return { site: 'bilibili', kind: 'page', url: url.href }
  }

  if (host === 'douyin.com' || host.endsWith('.douyin.com')) {
    if (host === 'v.douyin.com' || host.endsWith('.v.douyin.com') || host.endsWith('.iesdouyin.com')) {
      return { site: 'douyin', kind: 'short', url: url.href }
    }
    const video = /\/video\/(\d+)/.exec(path)
    if (video) return { site: 'douyin', kind: 'video', id: video[1], url: url.href }
    const note = /\/note\/(\d+)/.exec(path)
    if (note) return { site: 'douyin', kind: 'note', id: note[1], url: url.href }
    if (path.startsWith('/search')) {
      const query = url.searchParams.get('keyword') || url.searchParams.get('q') || decodeURIComponent(path.split('/')[2] || '')
      return { site: 'douyin', kind: 'search', query, url: url.href }
    }
    if (/\/user\//.test(path) || /^\/@/.test(path)) return { site: 'douyin', kind: 'user', url: url.href }
    return { site: 'douyin', kind: 'page', url: url.href }
  }

  return { site: 'generic', kind: 'page', url: url.href }
}

/** 从各种抖音链接里抠出 aweme_id（含 modal_id / note / share 短链形态）。 */
export function extractDouyinAwemeId(rawUrl) {
  const text = String(rawUrl || '')
  try {
    const url = new URL(text)
    const modal = new URLSearchParams(url.search).get('modal_id') || new URLSearchParams(url.search).get('aweme_id') || ''
    if (/^\d{15,25}$/.test(modal)) return modal
    const match =
      /\/(?:video|note|share\/video|share\/note)\/(\d{15,25})/i.exec(url.pathname) ||
      /\/(\d{15,25})(?:\/|$)/.exec(url.pathname)
    if (match) return match[1]
  } catch (_) {
    /* 不是合法 URL 时退回正则 */
  }
  const match = /\/(?:video|note|share\/video|share\/note)\/(\d{15,25})/i.exec(text) || /(?:modal_id|aweme_id)=(\d{15,25})/i.exec(text)
  return match ? match[1] : ''
}

/** 在文本里做“Ctrl+F 式”关键词检索，返回上下文片段。 */
export function findTextMatches(text, query, { limit = 10, context = 70 } = {}) {
  const source = String(text || '')
  const needle = String(query || '').trim()
  if (!needle) return { count: 0, matches: [] }
  const haystack = source.toLowerCase()
  const lower = needle.toLowerCase()
  const matches = []
  let index = 0
  let count = 0
  while (index < haystack.length) {
    const found = haystack.indexOf(lower, index)
    if (found < 0) break
    count += 1
    if (matches.length < limit) {
      const start = Math.max(0, found - context)
      const end = Math.min(source.length, found + needle.length + context)
      matches.push({
        index: found,
        snippet: `${start > 0 ? '…' : ''}${source.slice(start, end).replace(/\s+/g, ' ')}${end < source.length ? '…' : ''}`,
      })
    }
    index = found + Math.max(1, lower.length)
  }
  return { count, matches }
}

/* ------------------------------------------------------------------ */
/* B 站                                                                */
/* ------------------------------------------------------------------ */

function mixinKey(original) {
  return MIXIN_KEY_ENC_TAB.map(index => original[index]).join('').slice(0, 32)
}

/** 纯函数：B 站 WBI 签名，便于单测。 */
export function signWbi(params, imgKey, subKey, wts = Math.floor(Date.now() / 1000)) {
  const mixin = mixinKey(`${imgKey || ''}${subKey || ''}`)
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

function biliHeaders() {
  return {
    'User-Agent': BILI_UA,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
  }
}

async function ensureBuvid(deps, { force = false } = {}) {
  if (!force && deps.jar.getForUrl('https://api.bilibili.com/').some(cookie => cookie.name === 'buvid3')) return true
  try {
    const response = await deps.http('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { ...biliHeaders(), Referer: 'https://www.bilibili.com/' },
      timeoutMs: 12000,
      cookieSource: 'bilibili',
    })
    const data = safeJsonParse(response.text, null)
    const now = Date.now()
    const list = []
    if (data?.data?.b_3) list.push({ domain: 'bilibili.com', name: 'buvid3', value: String(data.data.b_3), path: '/', secure: true, expires: now + 365 * 24 * 3600 * 1000, source: 'bilibili' })
    if (data?.data?.b_4) list.push({ domain: 'bilibili.com', name: 'buvid4', value: String(data.data.b_4), path: '/', secure: true, expires: now + 365 * 24 * 3600 * 1000, source: 'bilibili' })
    if (!list.some(cookie => cookie.name === 'buvid3')) list.push({ domain: 'bilibili.com', name: 'buvid3', value: `${String(Math.random()).slice(2)}infoc`, path: '/', secure: true, expires: now + 86400 * 1000, source: 'bilibili' })
    list.push({ domain: 'bilibili.com', name: 'b_nut', value: String(Math.floor(now / 1000)), path: '/', secure: true, expires: now + 365 * 24 * 3600 * 1000, source: 'bilibili' })
    deps.jar.merge(list, { source: 'bilibili' })
    deps.persist?.()
    return true
  } catch (_) {
    return false
  }
}

let wbiCache = { keys: null, at: 0 }

async function getWbiKeys(deps, { force = false } = {}) {
  if (!force && wbiCache.keys && Date.now() - wbiCache.at < 30 * 60 * 1000) return wbiCache.keys
  try {
    const response = await deps.http('https://api.bilibili.com/x/web-interface/nav', {
      headers: biliHeaders(),
      timeoutMs: 12000,
      cookieSource: 'bilibili',
    })
    const data = safeJsonParse(response.text, null)
    const imgUrl = data?.data?.wbi_img?.img_url || ''
    const subUrl = data?.data?.wbi_img?.sub_url || ''
    const pick = value => String(value).split('/').pop()?.split('.')[0] || ''
    const keys = { imgKey: pick(imgUrl), subKey: pick(subUrl) }
    if (keys.imgKey && keys.subKey) {
      wbiCache = { keys, at: Date.now() }
      return keys
    }
  } catch (_) {
    /* ignore */
  }
  return null
}

async function biliGet(path, params, deps, { sign = true, retry = true, maxBytes = 4 * 1024 * 1024 } = {}) {
  await ensureBuvid(deps)
  let query = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }
  if (sign) {
    const keys = await getWbiKeys(deps)
    if (keys) {
      const signed = signWbi(Object.fromEntries(query.entries()), keys.imgKey, keys.subKey)
      query = new URLSearchParams()
      for (const [key, value] of Object.entries(signed)) query.set(key, String(value))
    }
  }
  const url = `https://api.bilibili.com${path}${query.toString() ? `?${query.toString()}` : ''}`
  let response
  try {
    response = await deps.http(url, { headers: biliHeaders(), timeoutMs: deps.config().timeoutMs, maxBytes, cookieSource: 'bilibili' })
  } catch (error) {
    const wrapped = new Error(`B站接口请求失败：${error.message}`)
    wrapped.code = 'BILIBILI_REQUEST_FAILED'
    throw wrapped
  }
  const data = safeJsonParse(response.text, null)
  if (!data || typeof data.code !== 'number') {
    const error = new Error(`B站接口返回了无法解析的数据（HTTP ${response.status}）`)
    error.code = 'BILIBILI_BAD_RESPONSE'
    throw error
  }
  if (data.code !== 0) {
    const code = Number(data.code)
    if (retry && [-352, -412, -509].includes(code)) {
      await ensureBuvid(deps, { force: true })
      wbiCache = { keys: null, at: 0 }
      return biliGet(path, params, deps, { sign, retry: false, maxBytes })
    }
    const error = new Error(`B站接口返回 code=${code}：${data.message || data.msg || '未知错误'}`)
    error.code = code === -412 || code === -352 ? 'BILIBILI_RISK' : 'BILIBILI_API_ERROR'
    error.biliCode = code
    throw error
  }
  return data.data
}

function biliStat(data) {
  const stat = data?.stat || {}
  return {
    view: Number(stat.view) || 0,
    danmaku: Number(stat.danmaku) || 0,
    reply: Number(stat.reply) || 0,
    like: Number(stat.like) || 0,
    coin: Number(stat.coin) || 0,
    favorite: Number(stat.favorite) || 0,
    share: Number(stat.share) || 0,
  }
}

function normalizeBiliComments(data, limit) {
  const replies = Array.isArray(data?.replies) ? data.replies : Array.isArray(data?.top_replies) ? data.top_replies : []
  const comments = []
  for (const item of replies) {
    const content = stripHtml(item?.content?.message || '')
    if (!content) continue
    comments.push({
      user: String(item?.member?.uname || '').slice(0, 80),
      content: content.slice(0, 1000),
      likes: Number(item?.like) || 0,
      replies: Number(item?.rcount) || 0,
      time: item?.ctime ? new Date(item.ctime * 1000).toISOString() : '',
    })
    if (comments.length >= limit) break
  }
  return comments
}

/** B 站视频详情：官方 API（标题 / UP 主 / 播放 / 点赞 / 投币 / 收藏 / 评论）。 */
export async function readBilibiliVideo(info, { comments = true, commentLimit = 12, maxChars = 12000 } = {}, deps) {
  const id = String(info.id || '')
  const params = /^BV/i.test(id) ? { bvid: id } : { aid: id.replace(/^av/i, '') }
  let data
  try {
    data = await biliGet('/x/web-interface/view', params, deps)
  } catch (error) {
    return fail(error.code || 'BILIBILI_API_ERROR', error.message, '可尝试 action=open 用浏览器打开该页面，或在设置页确认 Cookie / 登录状态。')
  }
  const bvid = String(data.bvid || '')
  const result = {
    engine: 'bilibili-api',
    site: 'bilibili',
    kind: 'video',
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : info.url,
    title: String(data.title || '').slice(0, 300),
    author: { name: String(data.owner?.name || ''), mid: String(data.owner?.mid || '') },
    publish_time: data.pubdate ? new Date(data.pubdate * 1000).toISOString() : '',
    duration_seconds: Number(data.duration) || 0,
    description: truncateText(String(data.desc || '').replace(/\s+/g, ' ').trim(), Math.min(maxChars, 4000)),
    stats: biliStat(data),
    bvid,
    aid: String(data.aid || ''),
    comments: [],
    comments_total: Number(data.stat?.reply) || 0,
  }

  if (comments && data.aid) {
    try {
      const commentData = await biliGet(
        '/x/v2/reply/wbi/main',
        { oid: data.aid, type: 1, mode: 3, ps: commentLimit, pn: 1, plat: 1, web_location: 1315875 },
        deps,
      )
      result.comments = normalizeBiliComments(commentData, commentLimit)
      result.comments_total = Number(commentData?.cursor?.all_count ?? commentData?.page?.count ?? result.comments_total) || result.comments_total
    } catch (_) {
      try {
        const fallback = await biliGet('/x/v2/reply', { oid: data.aid, type: 1, sort: 2, ps: commentLimit, pn: 1 }, deps)
        result.comments = normalizeBiliComments(fallback, commentLimit)
        result.comments_total = Number(fallback?.page?.count ?? result.comments_total) || result.comments_total
      } catch (error) {
        result.comments_error = error.message
      }
    }
  }
  result.comments_more = result.comments.length > 0 && result.comments_total > result.comments.length
  return success(result)
}

function normalizeBiliSearch(data, limit) {
  const list = Array.isArray(data?.result) ? data.result : []
  return list.slice(0, limit).map(item => ({
    title: stripHtml(String(item.title || '')).slice(0, 200),
    url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : String(item.arcurl || ''),
    author: String(item.author || ''),
    play: Number(item.play) || 0,
    favorites: Number(item.favorites) || 0,
    duration: String(item.duration || ''),
    pubdate: item.pubdate ? new Date(item.pubdate * 1000).toISOString() : '',
    description: stripHtml(String(item.description || '')).slice(0, 300),
  }))
}

/** B 站站内搜索：优先 API，失败时用浏览器搜索页。 */
export async function searchBilibili(query, { page = 1, limit = 10 } = {}, deps) {
  const keyword = String(query || '').trim()
  if (!keyword) return fail('INVALID_ARGS', '缺少搜索关键词 query。')
  const count = clampNumber(limit, 1, 30, 10)
  try {
    const data = await biliGet('/x/web-interface/search/type', { search_type: 'video', keyword, page: Math.max(1, Number(page) || 1), page_size: count }, deps)
    const results = normalizeBiliSearch(data, count)
    if (results.length) {
      return success({ engine: 'bilibili-api', site: 'bilibili', kind: 'search', query: keyword, results, total: Number(data?.numResults) || results.length })
    }
    throw Object.assign(new Error('B站搜索接口没有返回结果'), { code: 'BILIBILI_EMPTY' })
  } catch (error) {
    const browserResult = await searchBilibiliViaBrowser(keyword, count, deps).catch(browserError => ({ ok: false, code: browserError.code || 'BROWSER_SEARCH_FAILED', error: browserError.message }))
    if (browserResult.ok) return browserResult
    return fail(error.code || 'BILIBILI_SEARCH_FAILED', `B站搜索失败：${error.message}`, browserResult.error ? `浏览器搜索也失败：${browserResult.error}` : '')
  }
}

async function searchBilibiliViaBrowser(query, limit, deps) {
  const browser = await deps.getBrowser()
  const beforeTabs = new Set((await browser.tabs()).map(tab => tab.id))
  await browser.navigate(`https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`, { timeoutMs: 30000, waitMs: 2200 })
  await browser.switchToNewPage(beforeTabs).catch(() => false)
  const results = await browser.evaluate(
    `(() => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const cards = [...document.querySelectorAll('.bili-video-card, .video-list-item, .search-video-item, [class*="video-card"]')];
      const out = [];
      for (const card of cards) {
        const link = card.querySelector('a[href*="/video/"]') || card.querySelector('a[href]');
        if (!link) continue;
        const href = link.href || '';
        if (!/\\/video\\//.test(href)) continue;
        const title = norm(
          card.querySelector('[class*="title"], h3, .bili-video-card__info--tit')?.innerText ||
          link.getAttribute('title') || link.innerText,
        );
        if (!title) continue;
        out.push({
          title,
          url: href.split('?')[0],
          author: norm(card.querySelector('[class*="up-name"], [class*="author"], .bili-video-card__info--author')?.innerText),
          play: norm(card.querySelector('[class*="play"], [class*="view"]')?.innerText),
          duration: norm(card.querySelector('[class*="duration"]')?.innerText),
        });
        if (out.length >= ${limit}) break;
      }
      return out;
    })()`,
    { timeoutMs: 10000 },
  )
  if (!Array.isArray(results) || !results.length) throw Object.assign(new Error('B站搜索页没有解析到结果（可能需要登录或页面结构已变化）'), { code: 'NO_RESULTS' })
  return success({ engine: 'browser', site: 'bilibili', kind: 'search', query, results: results.slice(0, limit) })
}

/* ------------------------------------------------------------------ */
/* 抖音                                                                */
/* ------------------------------------------------------------------ */

async function readDouyinViaBrowser(url, { comments = true, commentLimit = 12, maxChars = 12000 } = {}, deps) {
  const browser = await deps.getBrowser()
  const beforeTabs = new Set((await browser.tabs()).map(tab => tab.id))
  await browser.navigate(url, { timeoutMs: 35000, waitMs: 3000 })
  await browser.switchToNewPage(beforeTabs).catch(() => false)
  await browser.waitFor({ ms: 800 })
  const finalUrl = await browser.currentUrl()
  const data = await browser.evaluate(
    `(() => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const pick = selectors => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && norm(el.innerText)) return norm(el.innerText);
        }
        return '';
      };
      const comments = [];
      if (${comments ? 'true' : 'false'}) {
        for (const el of [...document.querySelectorAll('[data-e2e="comment-item"], [class*="comment-item"]')]) {
          const content = norm((el.querySelector('[data-e2e="comment-item-content"], p, [class*="comment-content"]') || {}).innerText);
          if (!content) continue;
          comments.push({
            user: norm((el.querySelector('[data-e2e="comment-item-user"], a[href*="/user/"]') || {}).innerText),
            content: content.slice(0, 800),
            likes: norm((el.querySelector('[data-e2e="comment-item-like-count"], [class*="like"]') || {}).innerText),
          });
          if (comments.length >= ${commentLimit}) break;
        }
      }
      const bodyText = document.body ? (document.body.innerText || '') : '';
      const likeMatch = bodyText.match(/点赞[^\\d]{0,4}([\\d.]+\\s*[万亿wW]?)/);
      const commentMatch = bodyText.match(/评论[^\\d]{0,4}([\\d.]+\\s*[万亿wW]?)/);
      const collectMatch = bodyText.match(/收藏[^\\d]{0,4}([\\d.]+\\s*[万亿wW]?)/);
      const shareMatch = bodyText.match(/分享[^\\d]{0,4}([\\d.]+\\s*[万亿wW]?)/);
      return {
        title: document.title,
        description: pick(['[data-e2e="video-desc"]', '[class*="video-desc"]', 'h1']),
        author: pick(['[data-e2e="video-author-name"]', '[class*="author"] a[href*="/user/"]', 'a[href*="/user/"]']),
        likes: pick(['[data-e2e="video-like-count"]']) || (likeMatch ? likeMatch[1].trim() : ''),
        commentsCount: pick(['[data-e2e="video-comment-count"]']) || (commentMatch ? commentMatch[1].trim() : ''),
        collect: pick(['[data-e2e="video-collect-count"]']) || (collectMatch ? collectMatch[1].trim() : ''),
        share: pick(['[data-e2e="video-share-count"]']) || (shareMatch ? shareMatch[1].trim() : ''),
        comments,
        bodyText: bodyText.slice(0, 200000),
        hasLoginModal: !!document.querySelector('#login-panel-new, [data-e2e="login-modal"], [class*="login-modal"]'),
        bodyHasLoginWords: /登录后(?:查看|才能)|请先登录|立即登录/.test(bodyText),
      };
    })()`,
    { timeoutMs: 15000 },
  )
  let kind = 'page'
  try {
    const parsed = new URL(finalUrl)
    if (/\/video\/\d+/.test(parsed.pathname)) kind = 'video'
    else if (parsed.pathname.startsWith('/search')) kind = 'search'
  } catch (_) {
    /* ignore */
  }
  const needLogin = !!(data.hasLoginModal || (data.bodyHasLoginWords && !data.comments?.length))
  const note = needLogin
    ? '页面提示需要登录。可以让用户在本插件浏览器里登录（browser(action="login", url=..., interactive=true)），或向用户索要 Cookie 后 browser(action="cookies", url=..., cookie=...) 填入。'
    : ''
  return success({
    engine: 'browser',
    site: 'douyin',
    kind,
    url: finalUrl,
    title: String(data.title || '').slice(0, 300),
    description: String(data.description || '').slice(0, 3000),
    author: String(data.author || ''),
    stats: { like: data.likes || '', comment: data.commentsCount || '', collect: data.collect || '', share: data.share || '' },
    comments: Array.isArray(data.comments) ? data.comments : [],
    comments_more: Array.isArray(data.comments) && data.comments.length >= commentLimit,
    text: truncateText(String(data.bodyText || ''), maxChars),
    truncated: String(data.bodyText || '').length > maxChars,
    need_login: needLogin,
    note,
  })
}

/** 从抖音 HTML 的内嵌 ROUTER_DATA 中提取视频信息（无浏览器时的降级）。 */
export function extractJsonAssignment(html, marker) {
  const source = String(html || '')
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) return null
  const start = source.indexOf('{', markerIndex + marker.length)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let quote = ''
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
    } else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const raw = source.slice(start, i + 1)
        const parsed = safeJsonParse(raw, null)
        if (parsed !== null) return parsed
        // 部分站点用 JS 字面量 undefined / NaN，JSON.parse 会失败；仅在这种兜底场景里替换。
        return safeJsonParse(raw.replace(/\bundefined\b/g, 'null').replace(/\bNaN\b/g, 'null'), null)
      }
    }
  }
  return null
}

/** 从 <script id="RENDER_DATA" type="application/json">%7B...%7D</script> 这类标签里取 JSON。 */
export function extractScriptJson(html, marker) {
  const source = String(html || '')
  const pattern = new RegExp(`<script[^>]+(?:id|data-name)=["'][^"']*${marker}[^"']*["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i')
  const match = pattern.exec(source)
  if (!match) return null
  const raw = match[1].trim()
  const direct = safeJsonParse(raw, null)
  if (direct !== null) return direct
  try {
    return safeJsonParse(decodeURIComponent(raw), null)
  } catch (_) {
    return null
  }
}

export function deepFind(object, predicate, { maxDepth = 8, maxNodes = 20000 } = {}) {
  const queue = [{ value: object, depth: 0 }]
  let visited = 0
  while (queue.length && visited < maxNodes) {
    const { value, depth } = queue.shift()
    visited += 1
    if (predicate(value)) return value
    if (depth >= maxDepth || !value || typeof value !== 'object') continue
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 })
    }
  }
  return null
}

function douyinStatsToObject(statistics) {
  const stat = statistics || {}
  return {
    like: Number(stat.digg_count ?? stat.diggCount ?? 0),
    comment: Number(stat.comment_count ?? stat.commentCount ?? 0),
    collect: Number(stat.collect_count ?? stat.collectCount ?? 0),
    share: Number(stat.share_count ?? stat.shareCount ?? 0),
    play: Number(stat.play_count ?? stat.playCount ?? 0),
  }
}

async function readDouyinViaHttp(url, { maxChars = 12000 } = {}, deps) {
  let response
  try {
    response = await deps.http(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      timeoutMs: deps.config().timeoutMs,
      maxBytes: 3 * 1024 * 1024,
      cookieSource: 'douyin',
    })
  } catch (error) {
    return { ok: false, code: 'HTTP_FAILED', error: `HTTP 读取失败：${error.message}` }
  }
  if (!response.ok) return { ok: false, code: `HTTP_${response.status}`, error: `抖音返回 HTTP ${response.status}`, status: response.status, text: truncateText(response.text, 600) }

  const routerData =
    extractJsonAssignment(response.text, '_ROUTER_DATA') ||
    extractJsonAssignment(response.text, 'RENDER_DATA') ||
    extractScriptJson(response.text, 'RENDER_DATA') ||
    extractScriptJson(response.text, 'router-data')
  if (!routerData) {
    const extracted = extractHtml(response.text, response.url || url, { textLimit: maxChars, linkLimit: 30 })
    if (extracted.text) {
      return success({
        engine: 'http',
        site: 'douyin',
        kind: 'page',
        url: response.url || url,
        title: extracted.title,
        description: extracted.description,
        text: extracted.text,
        textLength: extracted.textLength,
        truncated: extracted.truncated,
        links: extracted.links,
        comments: [],
        note: '抖音没有返回可解析的结构化数据，以上是 HTTP 抓到的页面正文；点赞 / 评论等动态数据需要浏览器。',
      })
    }
    return { ok: false, code: 'NO_ROUTER_DATA', error: '抖音页面没有可解析的内嵌数据（可能需要浏览器渲染或登录）。' }
  }

  const detail = deepFind(routerData, value => value && typeof value === 'object' && (value.aweme_detail || value.awemeDetail || value.videoInfoRes))
  const item =
    detail?.aweme_detail ||
    detail?.awemeDetail ||
    detail?.videoInfoRes?.item_list?.[0] ||
    deepFind(routerData, value => value && typeof value === 'object' && (value.desc !== undefined && (value.statistics || value.author)))
  if (!item) {
    const extracted = extractHtml(response.text, response.url || url, { textLimit: maxChars, linkLimit: 30 })
    if (extracted.text) {
      return success({
        engine: 'http',
        site: 'douyin',
        kind: 'page',
        url: response.url || url,
        title: extracted.title,
        description: extracted.description,
        text: extracted.text,
        comments: [],
        note: '没有在抖音内嵌数据里找到视频详情，已退化为页面正文。',
      })
    }
    return { ok: false, code: 'NO_VIDEO_DATA', error: '抖音内嵌数据里没有找到视频详情。' }
  }

  const comments = (item.comment_list || item.comments || []).slice(0, 12).map(comment => ({
    user: String(comment?.user?.nickname || comment?.nickname || ''),
    content: String(comment?.text || comment?.content || '').slice(0, 800),
    likes: Number(comment?.digg_count || comment?.like_count || 0),
  })).filter(comment => comment.content)

  return success({
    engine: 'http',
    site: 'douyin',
    kind: 'video',
    url: response.url || url,
    title: String(item.desc || item.title || '').slice(0, 300),
    description: String(item.desc || '').slice(0, 3000),
    author: String(item.author?.nickname || item.nickname || ''),
    stats: douyinStatsToObject(item.statistics),
    comments,
    text: truncateText(String(response.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')), maxChars),
    note: '当前是 HTTP 降级读取，评论 / 点赞等动态数据可能不完整；需要完整体验请确保本机 Edge / Chrome 可用。',
  })
}

/* ------------------------------------------------------------------ */
/* 抖音「官方详情接口」：带登录 Cookie 时最完整（文案 / 图文图片 / 视频直链） */
/* ------------------------------------------------------------------ */

const DOUYIN_API_FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0'

function pickDouyinImageUrl(urls = []) {
  const list = (Array.isArray(urls) ? urls : []).map(item => String(item || '')).filter(url => /^https?:\/\//i.test(url))
  if (!list.length) return ''
  // 优先 jpeg（兼容性最好），其次 webp；都没有就用第一个。
  return list.find(url => /\.jpe?g(\?|$)/i.test(url)) || list.find(url => /\.webp(\?|$)/i.test(url)) || list[0]
}

function douyinMediaUrls(node) {
  const source = node && typeof node === 'object' ? node : {}
  const keys = ['url_list', 'urlList', 'play_url', 'playUrl', 'download_url_list', 'downloadUrlList']
  const out = []
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value)) out.push(...value.map(item => (typeof item === 'string' ? item : item?.url || item?.src || '')))
    else if (typeof value === 'string' && value) out.push(value)
  }
  return [...new Set(out.map(url => String(url || '').trim()).filter(url => /^https?:\/\//i.test(url)))]
}

function douyinTagsOf(text) {
  return [...String(text || '').matchAll(/#([^\s#]{1,40})/g)].map(match => match[1]).slice(0, 20)
}

/**
 * 抖音官方详情接口（web detail）：需要「新鲜浏览器 Cookie」（登录 / 未登录均可，但必须是真实浏览器会话）。
 * 返回视频 / 图文统一的归一化结构：
 *   - 视频：title / 文案 / 作者 / 时长 / 点赞收藏转发 / 视频直链 / 封面 / 背景音乐
 *   - 图文：额外带 images[]（原图 URL、尺寸）与 image_count，供工具把图片带回给模型查看
 */
export async function readDouyinDetail(rawUrl, options = {}, deps) {
  let url = normalizeUrl(rawUrl || '')
  if (!url) return fail('INVALID_ARGS', '缺少抖音网址 url。')

  let awemeId = extractDouyinAwemeId(url)
  if (!awemeId) {
    // 短链：先用 HTTP 跟随一次重定向拿到视频 ID
    try {
      const resolved = await deps.http(url, { timeoutMs: 15000, maxBytes: 512 * 1024, cookieSource: 'douyin' })
      url = resolved.url || url
      awemeId = extractDouyinAwemeId(url)
    } catch (_) {
      /* 下面统一报错 */
    }
  }
  if (!awemeId) return fail('DOUYIN_NO_ID', '没能从链接里解析出抖音视频 / 图文的 aweme_id。', '请确认是抖音分享链接（v.douyin.com/... 或 douyin.com/video/...）。')

  const maxChars = clampNumber(options.maxChars ?? options.max_chars, 400, 20000, 6000)
  const imageLimit = clampNumber(options.imageLimit ?? options.image_limit, 1, 18, 9)
  const config = typeof deps.config === 'function' ? deps.config() || {} : {}
  const userAgent = (typeof deps.userAgent === 'function' ? deps.userAgent() : '') || config.userAgent || DOUYIN_API_FALLBACK_UA

  const params = new URLSearchParams({
    aweme_id: awemeId,
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    platform: 'PC',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: /edg/i.test(userAgent) ? 'Edge' : 'Chrome',
    browser_version: (String(userAgent).match(/(?:Edg|Chrome)\/([\d.]+)/) || [])[1] || '153.0.0.0',
  })

  let response
  try {
    response = await deps.http(`https://www.douyin.com/aweme/v1/web/aweme/detail/?${params.toString()}`, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.douyin.com/',
      },
      timeoutMs: Math.max(8000, Number(config.timeoutMs) || 20000),
      maxBytes: 12 * 1024 * 1024,
      cookieSource: 'douyin',
    })
  } catch (error) {
    return fail('DOUYIN_REQUEST_FAILED', `抖音详情接口请求失败：${error.message}`, '请先在 设置 → 联网访问 的浏览器里登录一次抖音（交互式登录），再重试。')
  }

  const data = safeJsonParse(response.text, null)
  const item = data?.aweme_detail
  if (!item) {
    const cookieHint = '需要真实浏览器会话 Cookie：请用 browser(action="login", interactive=true) 打开抖音登录窗口，登录后 cookies(sync=true) 保存。'
    if (/verify|captcha|登录/i.test(response.text || '')) return fail('DOUYIN_VERIFY_REQUIRED', '抖音返回了验证页，当前 Cookie 不是新鲜浏览器会话。', cookieHint)
    return fail('DOUYIN_NO_DETAIL', `抖音详情接口没有返回 aweme_detail（HTTP ${response.status}）。`, cookieHint)
  }

  const desc = String(item.desc || item.title || '').trim()
  const author = item.author || {}
  const statistics = item.statistics || {}
  const stats = douyinStatsToObject(statistics)
  const video = item.video || {}
  const durationMs = Number(video.duration ?? item.duration) || 0

  const rawImages = Array.isArray(item.images) ? item.images : []
  const images = rawImages
    .map((image, index) => {
      const urls = douyinMediaUrls(image)
      return {
        index,
        url: pickDouyinImageUrl(urls),
        url_list: urls.slice(0, 4),
        width: Number(image.width) || 0,
        height: Number(image.height) || 0,
      }
    })
    .filter(image => image.url)

  const videoUrls = douyinMediaUrls(video.play_addr || video.playAddr)
  const downloadUrls = douyinMediaUrls(video.download_addr || video.downloadAddr)
  const coverUrls = douyinMediaUrls(video.cover || video.origin_cover || video.dynamic_cover)
  const music = item.music || {}
  // 清晰度列表：供媒体插件在没有 yt-dlp 时挑一个合适码率的直链，避免默认拉满 1080P。
  const qualities = (Array.isArray(video.bit_rate) ? video.bit_rate : [])
    .map(entry => {
      const listed = douyinMediaUrls(entry?.play_addr || entry?.playAddr)
      const gear = String(entry?.gear_name || entry?.gearName || '')
      const heightMatch = /(\d{3,4})/.exec(gear)
      return {
        gear,
        bitrate: Number(entry?.bit_rate ?? entry?.bitRate ?? 0) || 0,
        height: heightMatch ? Number(heightMatch[1]) : 0,
        is_h265: entry?.is_h265 === true || entry?.isH265 === true,
        url: listed[0] || '',
      }
    })
    .filter(quality => quality.url)
    .slice(0, 16)

  const result = {
    engine: 'douyin-api',
    site: 'douyin',
    kind: images.length ? 'note' : 'video',
    url: `https://www.douyin.com/${images.length ? 'note' : 'video'}/${awemeId}`,
    id: awemeId,
    aweme_type: Number(item.aweme_type ?? item.awemeType) || 0,
    title: desc.slice(0, 300),
    description: desc.slice(0, Math.max(400, maxChars)),
    tags: douyinTagsOf(desc),
    author: {
      name: String(author.nickname || '').slice(0, 120),
      unique_id: String(author.unique_id || ''),
      sec_uid: String(author.sec_uid || ''),
      avatar: pickDouyinImageUrl(douyinMediaUrls(author.avatar_larger || author.avatar_thumb || author.avatar_168x168)),
    },
    duration_seconds: durationMs ? Math.round(durationMs / 1000) : 0,
    create_time: Number(item.create_time) ? new Date(Number(item.create_time) * 1000).toISOString() : '',
    stats,
    images: images.slice(0, imageLimit),
    image_count: images.length,
    image_urls: images.slice(0, imageLimit).map(image => image.url),
    video: videoUrls.length
      ? {
          url: videoUrls[0],
          url_list: videoUrls.slice(0, 3),
          qualities,
          download_url_list: downloadUrls.slice(0, 3),
          cover: coverUrls[0] || '',
          width: Number(video.width) || 0,
          height: Number(video.height) || 0,
          has_watermark: video.has_watermark === true || video.hasWatermark === true,
        }
      : null,
    music: {
      title: String(music.title || '').slice(0, 200),
      author: String(music.author || '').slice(0, 120),
      play_url: douyinMediaUrls(music.play_url || music.playUrl)[0] || '',
    },
    comments: [],
    comments_total: stats.comment,
  }

  if (images.length) {
    result.note = `这是抖音图文：共 ${images.length} 张图片，已返回前 ${Math.min(images.length, imageLimit)} 张的地址（image_urls）；图片会随工具结果一起提供给模型查看。`
  } else {
    result.note = '已读取抖音视频详情；需要下载 / 发群时把 video.url 或页面链接交给媒体插件处理。'
  }
  return success(result)
}

export async function searchDouyin(query, { limit = 10 } = {}, deps) {
  const keyword = String(query || '').trim()
  if (!keyword) return fail('INVALID_ARGS', '缺少搜索关键词 query。')
  const browser = deps.runningBrowser()
  if (!browser?.running && !deps.browserAvailable?.()) {
    return fail('BROWSER_REQUIRED', '抖音站内搜索需要浏览器自动化（请在 设置 → 联网访问 中确认已检测到 Edge / Chrome）。', '也可以改用 web_search 搜索“抖音 + 关键词”的公开资料。')
  }
  try {
    const controller = await deps.getBrowser()
    const beforeTabs = new Set((await controller.tabs()).map(tab => tab.id))
    await controller.navigate(`https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`, { timeoutMs: 35000, waitMs: 3500 })
    await controller.switchToNewPage(beforeTabs).catch(() => false)
    const results = await controller.evaluate(
      `(() => {
        const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
        const out = [];
        const seen = new Set();
        for (const link of [...document.querySelectorAll('a[href*="/video/"]')]) {
          const href = (link.href || '').split('?')[0];
          const idMatch = href.match(/\\/video\\/(\\d+)/);
          if (!idMatch || seen.has(idMatch[1])) continue;
          seen.add(idMatch[1]);
          const container = link.closest('li, div[class*="result"], div[class*="card"]') || link;
          const title = norm(link.getAttribute('aria-label') || link.getAttribute('title') || link.innerText || container.innerText).slice(0, 200);
          if (!title) continue;
          out.push({
            title,
            url: href,
            author: norm((container.querySelector('a[href*="/user/"]') || {}).innerText),
            text: norm(container.innerText).slice(0, 400),
          });
          if (out.length >= ${limit}) break;
        }
        return out;
      })()`,
      { timeoutMs: 12000 },
    )
    const bodyText = await controller.getText(3000).catch(() => ({ text: '' }))
    const needLogin = /登录后(?:查看|才能)|请先登录/.test(bodyText.text || '')
    return success({
      engine: 'browser',
      site: 'douyin',
      kind: 'search',
      query: keyword,
      results: Array.isArray(results) ? results : [],
      need_login: needLogin,
      note: needLogin ? '抖音要求登录才能查看更多搜索结果；可让用户在本插件浏览器登录一次。' : '',
    })
  } catch (error) {
    return fail(error.code || 'DOUYIN_SEARCH_FAILED', `抖音搜索失败：${error.message}`)
  }
}

/* ------------------------------------------------------------------ */
/* 通用页面                                                            */
/* ------------------------------------------------------------------ */

async function readBrowserPage(url, { maxChars = 12000, includeInteractive = false, waitMs = 700 } = {}, deps) {
  const browser = await deps.getBrowser()
  const current = await browser.currentUrl().catch(() => '')
  const beforeTabs = new Set((await browser.tabs()).map(tab => tab.id))
  if (!current || (url && current.split('#')[0] !== String(url).split('#')[0])) {
    await browser.navigate(url, { timeoutMs: 35000, waitMs })
    await browser.switchToNewPage(beforeTabs).catch(() => false)
  } else if (waitMs > 0) {
    await browser.waitFor({ ms: waitMs }).catch(() => {})
  }
  await browser.waitReady(10000).catch(() => {})
  const data = await browser.evaluate(
    `(() => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const text = document.body ? (document.body.innerText || '') : '';
      const links = [...document.querySelectorAll('a[href]')]
        .map(el => ({ url: el.href, text: norm(el.innerText || el.getAttribute('aria-label') || '').slice(0, 120) }))
        .filter(item => item.url && !item.url.startsWith('javascript:'))
        .slice(0, 60);
      const interactive = ${includeInteractive ? 'true' : 'false'}
        ? [...document.querySelectorAll('input,textarea,select,button')].slice(0, 40).map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            name: el.getAttribute('name') || '',
            placeholder: el.getAttribute('placeholder') || '',
            label: el.getAttribute('aria-label') || '',
            text: norm(el.innerText || '').slice(0, 80),
          }))
        : [];
      const meta = name => {
        const el = document.querySelector('meta[name="' + name + '"],meta[property="' + name + '"]');
        return el ? el.getAttribute('content') || '' : '';
      };
      const h1 = document.querySelector('h1');
      return {
        title: norm(document.title),
        description: norm(meta('description') || meta('og:description')),
        canonical: (document.querySelector('link[rel="canonical"]') || {}).href || '',
        text: text.slice(0, ${Math.max(1000, maxChars)}),
        textLength: text.length,
        links,
        interactive,
        h1: h1 ? norm(h1.innerText) : '',
      };
    })()`,
    { timeoutMs: 15000 },
  )
  return success({
    engine: 'browser',
    site: 'generic',
    kind: 'page',
    url: (await browser.currentUrl()) || url,
    title: String(data.title || data.h1 || '').slice(0, 300),
    description: String(data.description || '').slice(0, 600),
    canonical: data.canonical || '',
    text: String(data.text || ''),
    textLength: Number(data.textLength) || String(data.text || '').length,
    truncated: Number(data.textLength) > maxChars,
    links: Array.isArray(data.links) ? data.links : [],
    interactive: Array.isArray(data.interactive) ? data.interactive : [],
    jsonLd: [],
  })
}

async function readHttpPage(url, { maxChars = 12000, includeInteractive = false } = {}, deps) {
  let response
  try {
    response = await deps.http(url, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      timeoutMs: deps.config().timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      cookieSource: 'http',
    })
  } catch (error) {
    return { ok: false, code: error.code || 'HTTP_FAILED', error: `读取失败：${error.message}` }
  }
  if (!response.ok) {
    return {
      ok: false,
      code: `HTTP_${response.status}`,
      error: `目标返回 HTTP ${response.status}`,
      status: response.status,
      bodyPreview: truncateText(response.text, 500),
    }
  }
  if (/application\/json/i.test(response.contentType)) {
    const data = safeJsonParse(response.text, null)
    const text = data ? JSON.stringify(data, null, 2) : response.text
    return success({
      engine: 'http',
      site: 'generic',
      kind: 'json',
      url: response.url || url,
      title: '',
      text: truncateText(text, maxChars),
      truncated: text.length > maxChars,
      links: [],
      interactive: [],
      json: data || null,
    })
  }
  const extracted = extractHtml(response.text, response.url || url, {
    textLimit: maxChars,
    linkLimit: 40,
    interactiveLimit: includeInteractive ? 30 : 0,
  })
  return success({
    engine: 'http',
    site: 'generic',
    kind: 'page',
    url: response.url || url,
    title: extracted.title,
    description: extracted.description,
    canonical: extracted.canonical,
    text: extracted.text,
    textLength: extracted.textLength,
    truncated: extracted.truncated,
    links: extracted.links,
    interactive: extracted.interactive,
    jsonLd: extracted.jsonLd,
  })
}

async function readTavilyPage(url, { maxChars = 12000 } = {}, deps) {
  const result = await deps.tavilyExtract([url], { maxChars })
  const item = result.ok ? result.results?.[0] : null
  if (!item) return { ok: false, code: result.code || 'TAVILY_EXTRACT_FAILED', error: result.error || 'Tavily 提取失败' }
  const raw = String(item.raw_content || '')
  const text = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  return success({
    engine: 'tavily',
    site: 'generic',
    kind: 'page',
    url: item.url || url,
    title: '',
    description: '',
    text: truncateText(text.replace(/\n{3,}/g, '\n\n'), maxChars),
    textLength: text.length,
    truncated: text.length > maxChars,
    links: [],
    interactive: [],
    note: '当前内容由 Tavily 提取，可能没有完整 DOM 信息。',
  })
}

/** B 站视频 HTML 兜底：解析页面内嵌的 __INITIAL_STATE__（API 被风控时的降级）。 */
async function readBilibiliHtmlFallback(url, { maxChars = 12000 } = {}, deps) {
  let response
  try {
    response = await deps.http(url, {
      headers: { ...biliHeaders(), Accept: 'text/html,application/xhtml+xml' },
      timeoutMs: deps.config().timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      cookieSource: 'bilibili',
    })
  } catch (error) {
    return { ok: false, code: error.code || 'HTTP_FAILED', error: `B站页面读取失败：${error.message}` }
  }
  if (!response.ok) return { ok: false, code: `HTTP_${response.status}`, error: `B站返回 HTTP ${response.status}`, status: response.status }
  const initialState = extractJsonAssignment(response.text, '__INITIAL_STATE__')
  const videoData =
    initialState?.videoData ||
    deepFind(initialState, value => value && typeof value === 'object' && value.bvid && (value.stat || value.title) && value.owner)
  if (videoData?.bvid) {
    return success({
      engine: 'http-embedded',
      site: 'bilibili',
      kind: 'video',
      url: `https://www.bilibili.com/video/${videoData.bvid}`,
      title: String(videoData.title || '').slice(0, 300),
      author: { name: String(videoData.owner?.name || ''), mid: String(videoData.owner?.mid || '') },
      publish_time: videoData.pubdate ? new Date(videoData.pubdate * 1000).toISOString() : '',
      duration_seconds: Number(videoData.duration) || 0,
      description: truncateText(String(videoData.desc || '').replace(/\s+/g, ' ').trim(), Math.min(maxChars, 4000)),
      stats: biliStat(videoData),
      comments: [],
      comments_total: Number(videoData.stat?.reply) || 0,
      bvid: String(videoData.bvid),
      aid: String(videoData.aid || ''),
      note: 'B站 API 不可用，数据来自页面内嵌 JSON；实时评论需要浏览器或登录 Cookie。',
    })
  }
  const extracted = extractHtml(response.text, response.url || url, { textLimit: maxChars, linkLimit: 30 })
  if (!extracted.text) return { ok: false, code: 'EMPTY_PAGE', error: 'B站页面没有可解析的正文。' }
  return success({
    engine: 'http',
    site: 'bilibili',
    kind: 'video',
    url: response.url || url,
    title: extracted.title,
    description: extracted.description,
    text: extracted.text,
    textLength: extracted.textLength,
    truncated: extracted.truncated,
    links: extracted.links,
    comments: [],
    note: '仅抓到页面正文，未拿到结构化点赞 / 评论数据。',
  })
}

/** 通用读取入口：根据站点与可用能力自动选引擎。 */
export async function readPage(target, options = {}, deps) {
  let url = normalizeUrl(target || '')
  if (!url) {
    const running = deps.runningBrowser()
    if (running?.running) url = await running.currentUrl().catch(() => '')
  }
  if (!url) return fail('INVALID_ARGS', '缺少要访问的网址 url。')

  const engine = String(options.engine || 'auto')
  const maxChars = clampNumber(options.maxChars, 800, 60000, 12000)
  const includeInteractive = options.includeInteractive === true
  const comments = options.comments !== false
  const commentLimit = clampNumber(options.commentLimit, 1, 50, 12)

  let info = detectSiteKind(url)
  if (info.kind === 'short') {
    try {
      const resolved = await deps.http(url, { timeoutMs: 15000, maxBytes: 512 * 1024, cookieSource: info.site })
      const finalUrl = resolved.url || url
      if (resolved.ok || resolved.status < 400) {
        url = finalUrl
        info = detectSiteKind(url)
      }
    } catch (_) {
      /* 短链解析失败时保留原 URL，后续浏览器也可以跟随重定向 */
    }
  }

  if (info.site === 'bilibili' && info.kind === 'search' && info.query) return searchBilibili(info.query, { limit: commentLimit, page: options.page }, deps)
  if (info.site === 'douyin' && info.kind === 'search' && info.query) return searchDouyin(info.query, { limit: commentLimit }, deps)

  if (info.site === 'bilibili' && info.kind === 'video' && engine !== 'http') {
    const apiResult = await readBilibiliVideo(info, { comments, commentLimit, maxChars }, deps)
    if (apiResult.ok) return apiResult
    const browserPage = await readBrowserPage(url, { maxChars, includeInteractive, waitMs: 2200 }, deps).catch(error => ({
      ok: false,
      code: error.code || 'BROWSER_FAILED',
      error: error.message,
    }))
    if (browserPage.ok) {
      const domDetails = await extractBilibiliDomDetails(browserPage, { commentLimit }, deps).catch(() => null)
      return { ...browserPage, ...(domDetails || {}), api_error: { code: apiResult.code, error: apiResult.error } }
    }
    const htmlResult = await readBilibiliHtmlFallback(url, { maxChars }, deps)
    if (htmlResult.ok) return { ...htmlResult, api_error: { code: apiResult.code, error: apiResult.error } }
    return apiResult
  }

  if (info.site === 'douyin' && (info.kind === 'video' || info.kind === 'note' || info.kind === 'page')) {
    // 优先官方详情接口：带登录 Cookie 时能一次拿到文案 / 图文图片 / 视频直链。
    const apiResult = await readDouyinDetail(url, {
      maxChars,
      imageLimit: options.imageLimit ?? options.image_limit,
      includeImages: options.includeImages ?? options.include_images,
    }, deps)
    if (apiResult.ok) return apiResult

    if (engine !== 'http') {
      const browserResult = await readDouyinViaBrowser(url, { comments, commentLimit, maxChars }, deps).catch(error => ({
        ok: false,
        code: error.code || 'DOUYIN_BROWSER_FAILED',
        error: error.message,
      }))
      if (browserResult.ok) return { ...browserResult, api_error: { code: apiResult.code, error: apiResult.error } }
      const httpResult = await readDouyinViaHttp(url, { maxChars }, deps)
      if (httpResult.ok) return { ...httpResult, api_error: { code: apiResult.code, error: apiResult.error } }
      return browserResult.code !== 'BROWSER_UNAVAILABLE' && browserResult.code !== 'BROWSER_START_FAILED'
        ? { ...browserResult, api_error: { code: apiResult.code, error: apiResult.error } }
        : { ...httpResult, api_error: { code: apiResult.code, error: apiResult.error } }
    }

    const httpResult = await readDouyinViaHttp(url, { maxChars }, deps)
    if (httpResult.ok) return { ...httpResult, api_error: { code: apiResult.code, error: apiResult.error } }
    return readPageFallback(url, { maxChars, includeInteractive, engine: 'http', browserWaitMs: 700 }, deps)
  }

  return readPageFallback(url, { maxChars, includeInteractive, engine, browserWaitMs: 700 }, deps)
}

async function readPageFallback(url, { maxChars, includeInteractive, engine = 'auto', browserWaitMs = 700 } = {}, deps) {
  const preferBrowser = engine === 'browser'
  const preferHttp = engine === 'http'
  let httpResult = null
  let browserError = null

  if (!preferBrowser) {
    httpResult = await readHttpPage(url, { maxChars, includeInteractive }, deps)
    if (httpResult.ok) {
      const textLength = Number(httpResult.textLength) || 0
      const likelySpa = textLength < 400
      if (!likelySpa || preferHttp) return httpResult
    }
  }

  if (!preferHttp && deps.browserAvailable?.()) {
    try {
      const browserResult = await readBrowserPage(url, { maxChars, includeInteractive, waitMs: browserWaitMs }, deps)
      if (browserResult.ok) {
        return httpResult && !httpResult.ok
          ? { ...browserResult, http_error: { code: httpResult.code, error: httpResult.error } }
          : browserResult
      }
      browserError = browserResult
    } catch (error) {
      browserError = { ok: false, code: error.code || 'BROWSER_FAILED', error: error.message }
    }
  }

  if (httpResult?.ok) return httpResult
  if (deps.config().tavilyApiKey) {
    const tavilyResult = await readTavilyPage(url, { maxChars }, deps)
    if (tavilyResult.ok) return tavilyResult
  }
  if (browserError) return browserError
  if (httpResult) return httpResult
  return fail('READ_FAILED', '无法读取该页面。')
}

/** 浏览器 DOM 兜底：B 站视频页的标题 / UP 主 / 点赞 / 评论。 */
async function extractBilibiliDomDetails(base, { commentLimit = 12 } = {}, deps) {
  const browser = deps.runningBrowser()
  if (!browser?.running) return null
  const url = await browser.currentUrl().catch(() => '')
  if (!/bilibili\.com\/video\//i.test(url)) return null
  const data = await browser.evaluate(
    `(() => {
      const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const body = document.body ? (document.body.innerText || '') : '';
      const pick = selectors => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && norm(el.innerText)) return norm(el.innerText);
        }
        return '';
      };
      const matchCount = label => {
        const match = body.match(new RegExp(label + '[^\\\\d]{0,6}([\\\\d.]+\\\\s*[万亿]?)'));
        return match ? match[1].trim() : '';
      };
      const comments = [];
      for (const el of [...document.querySelectorAll('.reply-item, .comment-list .reply-item, [class*="reply-item"]')]) {
        const content = norm((el.querySelector('.reply-content, [class*="content"]') || {}).innerText);
        if (!content) continue;
        comments.push({
          user: norm((el.querySelector('.user-name, [class*="user-name"], a[href*="space.bilibili"]') || {}).innerText),
          content: content.slice(0, 800),
          likes: norm((el.querySelector('.like, [class*="like"]') || {}).innerText),
        });
        if (comments.length >= ${commentLimit}) break;
      }
      return {
        title: pick(['h1.video-title', '.video-title', '[class*="video-title"]']),
        author: pick(['.up-name', '[class*="up-name"]', '.up-info-container .name', 'a[href*="space.bilibili"]']),
        stats: {
          like: matchCount('点赞') || pick(['.video-like-info', '.like-info']),
          coin: matchCount('投币'),
          favorite: matchCount('收藏'),
          share: matchCount('转发'),
          reply: matchCount('评论'),
          view: matchCount('播放'),
        },
        comments,
      };
    })()`,
    { timeoutMs: 10000 },
  )
  if (!data) return null
  return {
    title: base.title || data.title || '',
    author: base.author || data.author || '',
    stats: data.stats || {},
    comments: data.comments || [],
    note: '数据来自浏览器 DOM 兜底提取，字段可能不如 API 完整。',
  }
}

export { fail, success }

