/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · B站原生兜底下载（没有 yt-dlp 时使用）
 *
 * 实测：未登录也能拿到 DASH 音频（66k / 110k / 205k）与 720P/1080P 视频；
 * 带 SESSDATA 后画质/音质更全。这里只实现最小可用路径：
 *   b23.tv / BV号 → view 接口 → WBI playurl → 下载 DASH 音频或 durl MP4。
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

const biliHeaders = cookieHeader => ({
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  ...(cookieHeader ? { Cookie: cookieHeader } : {}),
})

export function mixinKey(original) {
  return MIXIN_TAB.map(index => String(original || '')[index] || '').join('').slice(0, 32)
}

/** 纯函数：B站 WBI 签名（与 web-access 的实现保持一致，便于单测）。 */
export function signWbi(params, imgKey, subKey, wts = Math.floor(Date.now() / 1000)) {
  const mixin = mixinKey(`${imgKey || ''}${subKey || ''}`)
  const all = { ...params, wts }
  const query = Object.keys(all)
    .sort()
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(all[key]).replace(/[!'()*]/g, '')))
    .join('&')
  const wRid = createHash('md5').update(query + mixin).digest('hex')
  return { ...all, w_rid: wRid }
}

export function extractBvid(url) {
  const text = String(url || '')
  const match = /(BV[0-9A-Za-z]{10})/.exec(text) || /\/video\/(BV[0-9A-Za-z]{10})/.exec(text) || /(av\d+)/i.exec(text)
  return match ? match[1] : ''
}

async function getJson(url, { cookieHeader, timeoutMs = 20000 } = {}) {
  const response = await fetch(url, { headers: biliHeaders(cookieHeader), signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  try { return JSON.parse(text) } catch { return null }
}

async function resolveShort(url, cookieHeader) {
  if (!/^https?:\/\/b23\.tv/i.test(url)) return { url, bvid: extractBvid(url) }
  const response = await fetch(url, { redirect: 'follow', headers: biliHeaders(cookieHeader), signal: AbortSignal.timeout(15000) })
  const finalUrl = response.url || url
  return { url: finalUrl, bvid: extractBvid(finalUrl) }
}

async function wbiKeys(cookieHeader) {
  const data = await getJson('https://api.bilibili.com/x/web-interface/nav', { cookieHeader })
  const pick = value => String(value || '').split('/').pop()?.split('.')[0] || ''
  return { imgKey: pick(data?.data?.wbi_img?.img_url), subKey: pick(data?.data?.wbi_img?.sub_url) }
}

function signedUrl(path, params, keys) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }
  let search = query
  if (keys?.imgKey) {
    const signed = signWbi(Object.fromEntries(query.entries()), keys.imgKey, keys.subKey)
    search = new URLSearchParams()
    for (const [key, value] of Object.entries(signed)) search.set(key, String(value))
  }
  return `https://api.bilibili.com${path}${search.toString() ? `?${search}` : ''}`
}

function qualityLabel(quality) {
  return ({ 127: '8K', 126: '杜比视界', 125: 'HDR', 120: '4K', 116: '1080P60', 112: '1080P+', 80: '1080P', 64: '720P', 32: '480P', 16: '360P' })[Number(quality)] || `qn${quality}`
}

/**
 * 取 B站视频信息与可下载地址。
 * @param {{ url:string, cookieHeader?:string, maxHeight?:number, mode?:'video'|'audio' }} options
 */
export async function resolveBilibili({ url, cookieHeader = '', maxHeight = 720, mode = 'video' } = {}) {
  const resolved = await resolveShort(String(url || ''), cookieHeader)
  if (!resolved.bvid) return { ok: false, error: '没能从链接里解析出 B站 BV 号' }
  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(resolved.bvid)}`, { cookieHeader })
  const data = view?.data
  if (!data?.cid) return { ok: false, error: `B站详情接口失败：${view?.message || '没有 cid'}` }

  const keys = await wbiKeys(cookieHeader)
  const play = await getJson(
    signedUrl('/x/player/wbi/playurl', { bvid: data.bvid, cid: data.cid, fnval: 4048, fourk: 1, fnver: 0, qn: 127, platform: 'pc' }, keys),
    { cookieHeader },
  )
  const playData = play?.data
  if (!playData) return { ok: false, error: `B站取流失败：${play?.message || '没有 playurl 数据'}` }

  const audioList = (playData.dash?.audio || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
  const videoList = (playData.dash?.video || [])
    .filter(item => !maxHeight || Number(item.height) <= maxHeight)
    .slice()
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))

  const result = {
    ok: true,
    bvid: data.bvid,
    title: String(data.title || ''),
    author: String(data.owner?.name || ''),
    duration: Number(data.duration) || 0,
    cover: String(data.pic || ''),
    url: `https://www.bilibili.com/video/${data.bvid}`,
    audio: audioList.map(item => ({ id: String(item.id), bandwidth: Number(item.bandwidth) || 0, url: item.baseUrl || item.base_url || '' })),
    video: videoList.map(item => ({ id: String(item.id), height: Number(item.height) || 0, label: qualityLabel(item.id), url: item.baseUrl || item.base_url || '' })),
    durl: (playData.durl || []).map(item => ({ url: item.url || '', size: Number(item.size) || 0 })),
  }
  if (mode === 'audio' && !result.audio.length && result.durl.length) result.audio = result.durl.map(item => ({ id: 'durl', bandwidth: 0, url: item.url }))
  return result
}

/** 下载一个直链到 outDir，返回本地路径。 */
export async function downloadDirect(url, outDir, { cookieHeader = '', headers = {}, filename = '', maxBytes = 512 * 1024 * 1024, onProgress } = {}) {
  await mkdir(outDir, { recursive: true })
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(cookieHeader ? { Cookie: cookieHeader } : {}), ...headers },
    signal: AbortSignal.timeout(900000),
  })
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  if (total && total > maxBytes) throw new Error(`文件超过大小上限（${Math.round(total / 1024 / 1024)}MB）`)
  const chunks = []
  let received = 0
  const reader = response.body?.getReader?.()
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (received > maxBytes) throw new Error('文件超过大小上限')
      chunks.push(Buffer.from(value))
      onProgress?.({ received, total })
    }
  } else {
    chunks.push(Buffer.from(await response.arrayBuffer()))
  }
  const buffer = Buffer.concat(chunks)
  const target = join(outDir, filename || `bilibili_${Date.now().toString(36)}.mp4`)
  await writeFile(target, buffer)
  return { file: target, bytes: buffer.length }
}
