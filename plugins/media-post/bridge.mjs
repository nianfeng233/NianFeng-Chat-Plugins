/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · 后端桥
 *
 * 能力：
 *   /api/media/status           工具 / 缓存 / Cookie / 可用 NapCat 渠道状态
 *   /api/media/tools/install    一键安装 ffmpeg（npm 镜像）/ yt-dlp（pip 镜像或 GitHub）
 *   /api/media/prepare          B站 / 抖音链接 → 下载视频 / 音频 / 图文到媒体库
 *   /api/media/transcode        音频转 mp3 / amr / 为 QQ 官方语音生成 SILK
 *   /api/media/send             NapCat 特权发送 / QQ 官方机器人 SILK 语音；其它渠道返回降级信息
 *   /api/media/file/:id/:token  媒体文件回传（给远程 NapCat / 聊天降级链接用）
 *   /api/media/library          媒体库列表 / 清理 / 删除
 *   /api/media/cookies/sync     从「联网访问」Cookie 库导出 yt-dlp 用 cookies.txt
 *
 * 依赖：联网访问（web-access）后端服务提供搜索 / 抖音图文 / Cookie；
 *       本机 NapCat 服务（可选）提供 record / video / file 消息段发送。
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  cacheStats,
  getRecord,
  listRecords,
  patchRecord,
  publicRecord,
  prune,
  readRecord,
  removeRecord,
  saveBuffer,
  saveFile,
} from './lib/store.mjs'
import { installFfmpeg, installYtDlp, run, toolStatus } from './lib/tools.mjs'
import { download as ytdlpDownload } from './lib/ytdlp.mjs'
import { transcodeAudio } from './lib/ffmpeg.mjs'
import { downloadDirect, extractBvid, resolveBilibili } from './lib/bilibili.mjs'
import { encode as silkEncode, isSilk as isSilkBuffer } from './vendor/silk-wasm/lib/index.mjs'

export const name = 'media-post-bridge'
export const version = '2.1.0'
export const displayName = '点歌台后端桥'
export const description = '媒体下载 / 转码 / 缓存与 NapCat 语音、QQ 官方机器人 SILK 语音、视频、文件发送'
export const core = false
export const inject = ['settings', 'httpApi']
export const provides = [{ name: 'media-post', type: 'singleton' }]

const DEFAULT_CONFIG = {
  voiceFormat: 'mp3', // mp3 | amr
  mp3Bitrate: '96k',
  maxHeight: 720,
  maxVideoMB: 150,
  maxAudioMB: 40,
  maxImageMB: 15,
  maxImages: 9,
  fileBaseUrl: '', // 远程 NapCat 时填 http://<本机局域网IP>:<后端端口>
  pipMirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  ffmpegPath: '',
  ytdlpPath: '',
  pythonPath: '',
  keep: 200,
  maxBytes: 2 * 1024 * 1024 * 1024,
  ttlDays: 7,
  sendCaption: true,
}

const PLATFORM_LABEL = { bilibili: 'B站', douyin: '抖音' }

const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra })
const trimSlash = value => String(value || '').replace(/\/+$/, '')

function platformOf(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    if (host === 'b23.tv' || host.endsWith('.b23.tv') || host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili'
    if (host === 'v.douyin.com' || host.endsWith('.douyin.com') || host === 'douyin.com' || host.endsWith('.iesdouyin.com')) return 'douyin'
  } catch (_) {
    /* ignore */
  }
  return ''
}

function absoluteFileUrl(path) {
  const normalized = String(path || '').replace(/\\/g, '/')
  if (!normalized) return ''
  return `file:///${normalized.replace(/^\//, '')}`
}

export function apply(ctx) {
  const settings = ctx.settings
  const httpApi = ctx.httpApi

  const dataDir = () => settings.dataDir || process.cwd()
  const statePath = () => join(dataDir(), 'media-post.json')
  const tmpDir = () => join(dataDir(), 'media-post', '.tmp')

  let state = { version: 1, config: { ...DEFAULT_CONFIG }, cookies: {} }
  let persistTimer = null
  let readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })
  let toolCache = { at: 0, value: null }

  const schedulePersist = () => {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persist().catch(error => ctx.logger.warn(`[media-post] 状态写入失败：${error.message}`))
    }, 300)
    persistTimer.unref?.()
  }

  const persist = async () => {
    await mkdir(dataDir(), { recursive: true })
    const payload = JSON.stringify({ version: 1, updatedAt: Date.now(), config: state.config, cookies: state.cookies }, null, 2)
    const tmp = `${statePath()}.${process.pid}.tmp`
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, statePath())
  }

  const loadState = async () => {
    try {
      const raw = JSON.parse(await readFile(statePath(), 'utf8'))
      state = {
        version: 1,
        config: { ...DEFAULT_CONFIG, ...(raw?.config || {}) },
        cookies: raw?.cookies && typeof raw.cookies === 'object' ? raw.cookies : {},
      }
    } catch (_) {
      state = { version: 1, config: { ...DEFAULT_CONFIG }, cookies: {} }
    }
    readyResolve?.()
  }

  const serviceOf = name => {
    try {
      return ctx.reflect.get(name, false) || null
    } catch (_) {
      return null
    }
  }
  const webAccess = () => serviceOf('web-access')
  const napcat = () => serviceOf('napcat')
  const httpService = () => serviceOf('http')

  const tools = async ({ fresh = false } = {}) => {
    if (!fresh && toolCache.value && Date.now() - toolCache.at < 30000) return toolCache.value
    const value = await toolStatus({ dataDir: dataDir(), config: state.config })
    toolCache = { at: Date.now(), value }
    return value
  }

  const baseUrl = () => {
    const configured = trimSlash(state.config.fileBaseUrl)
    if (configured) return configured
    const http = httpService()
    const port = http?.port?.() || 8788
    return `http://127.0.0.1:${port}`
  }

  const fileUrlOf = record =>
    `${baseUrl()}/api/media/file/${encodeURIComponent(record.id)}/${encodeURIComponent(record.secret)}/${encodeURIComponent(record.file)}`

  /** 目标渠道不支持媒体直发时统一的降级信息（前端会改写成标题 / 链接 / 本地路径）。 */
  const fallbackPayload = ({ records = [], mode = 'video', code = 'FALLBACK', reason = '', reasonText = '', caption = '' } = {}) => ({
    ok: true,
    fallback: true,
    code: code || 'FALLBACK',
    reason: reason || code || 'FALLBACK',
    reasonText: reasonText || '',
    mode,
    media: records.map(publicRecord),
    fileUrls: records.map(fileUrlOf),
    filePaths: records.map(record => join(dataDir(), 'media-post', 'media', record.file)),
    downloadUrl: records[0] ? fileUrlOf(records[0]) : '',
    caption: String(caption || ''),
    title: records[0]?.title || '',
    sourceUrl: records[0]?.sourceUrl || '',
  })

  const sourceOf = (record, { preferUrl = false } = {}) => {
    if (preferUrl || state.config.fileBaseUrl) return fileUrlOf(record)
    const absolute = join(dataDir(), 'media-post', 'media', record.file)
    return isAbsolute(absolute) ? absoluteFileUrl(absolute) : absolute
  }

  /* ---------------- 联网访问（web-access）适配层 ---------------- */
  /**
   * 优先用 web-access 的后端服务；服务缺失时退回它的 HTTP 路由。
   * 只要「联网访问」的后端桥在运行，本插件就能工作（包含它已登录的 Cookie 库）。
   */
  const webAccessHttp = async (method, requestPath, body, timeoutMs = 60000) => {
    const http = httpService()
    const base = String(http?.url?.() || `http://127.0.0.1:${http?.port?.() || 8788}`).replace(/\/+$/, '')
    try {
      const response = await fetch(`${base}/api/web-access${requestPath}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      try { return JSON.parse(text) } catch { return { ok: false, error: text } }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  /** 从已导出的 cookies.txt 里拼 Cookie 头（服务不可用 / HTTP 兼容模式）。 */
  const cookieHeaderFromFile = async rawUrl => {
    let domain = ''
    try {
      domain = new URL(String(rawUrl)).hostname.replace(/^www\./, '')
    } catch (_) {
      return ''
    }
    for (const site of ['bilibili', 'douyin']) {
      const file = state.cookies[site]?.path
      if (!file) continue
      try {
        const text = await readFile(file, 'utf8')
        const pairs = []
        for (const line of text.split(/\r?\n/)) {
          const raw = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line
          if (!raw || raw.trim().startsWith('#')) continue
          const parts = raw.split('\t')
          if (parts.length < 7) continue
          const host = parts[0].replace(/^\./, '')
          if (!(host === domain || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`))) continue
          pairs.push(`${parts[5]}=${parts[6]}`)
        }
        if (pairs.length) return pairs.join('; ')
      } catch (_) {
        /* ignore */
      }
    }
    return ''
  }

  const webAccessOps = {
    /** @returns {Promise<{ok:boolean, mode:'service'|'http'|'none', version:string}>} */
    available: async () => {
      const service = webAccess()
      if (service) return { ok: true, mode: 'service', version: service.version || '' }
      const status = await webAccessHttp('GET', '/status', undefined, 10000)
      if (status?.ok) return { ok: true, mode: 'http', version: status.version || '' }
      return { ok: false, mode: 'none', version: '' }
    },
    search: async (site, query, options = {}) => {
      const service = webAccess()
      if (service?.search) return service.search(site, query, options)
      return webAccessHttp('POST', '/browse', { action: 'search', site, query, limit: options.limit })
    },
    readDouyin: async (url, options = {}) => {
      const service = webAccess()
      if (service?.readDouyin) return service.readDouyin(url, options)
      return webAccessHttp('POST', '/browse', { action: 'read', url, engine: 'auto', include_images: true, image_limit: options.imageLimit || 9 }, 120000)
    },
    cookieSummary: async domain => {
      const service = webAccess()
      if (service?.cookieSummary) return service.cookieSummary(domain)
      const result = await webAccessHttp('POST', '/cookies', { domain }, 20000)
      return { total: Number(result?.total) || 0, domains: result?.domains || [] }
    },
    exportCookies: async (domains, options = {}) => {
      const service = webAccess()
      if (service?.exportCookies) return service.exportCookies(domains, options)
      return webAccessHttp('POST', '/cookies', { export: true, domains, file: options.file }, 60000)
    },
    cookieHeaderFor: async url => {
      const service = webAccess()
      if (service?.cookieHeaderFor) return service.cookieHeaderFor(url)
      return cookieHeaderFromFile(url)
    },
  }

  const cookieInfo = async site => {
    const domain = site === 'douyin' ? 'douyin.com' : 'bilibili.com'
    const summary = await webAccessOps.cookieSummary(domain)
    return {
      site,
      hasCookies: Number(summary.total) > 0,
      count: Number(summary.total) || 0,
      exportedAt: state.cookies[site]?.updatedAt || 0,
      exportedPath: state.cookies[site]?.path || '',
    }
  }

  /** 从联网访问的 Cookie 库导出 yt-dlp 用的 cookies.txt。 */
  const ensureCookies = async (site, { required = true } = {}) => {
    const access = await webAccessOps.available()
    if (!access.ok) {
      return fail('NEED_WEB_ACCESS', '没有找到可用的「联网访问」后端（web-access bridge）。', {
        hint: '请确认已安装 web-access v1.1.0+，然后到「设置 → 插件」点「重新扫描」热加载后端桥；仍无效就重启念风后端。',
      })
    }
    const domain = site === 'douyin' ? 'douyin.com' : 'bilibili.com'
    const summary = await webAccessOps.cookieSummary(domain)
    if (!Number(summary.total)) {
      if (!required) return { ok: true, optional: true, path: '' }
      return fail('NEED_LOGIN', `还没有 ${PLATFORM_LABEL[site] || site} 的登录 Cookie。`, {
        hint: `到「设置 → 点歌台」点「登录${PLATFORM_LABEL[site] || ''}」，在弹出的独立浏览器里扫码登录后点「同步 Cookie 并导出」；如果你已经在「联网访问」里登录过，这里直接同步即可，不需要重复登录。`,
      })
    }
    try {
      const exported = await webAccessOps.exportCookies([domain], { file: `media-post-${site}.txt` })
      if (!exported?.ok || !exported.path) {
        return fail('COOKIE_EXPORT_UNSUPPORTED', exported?.error || '当前「联网访问」版本不支持导出 cookies.txt。', { hint: '请把「联网访问」升级到 v1.1.0+。' })
      }
      state.cookies[site] = { path: exported.path, count: exported.count, updatedAt: Date.now() }
      schedulePersist()
      return { ok: true, path: exported.path, count: exported.count }
    } catch (error) {
      return fail('COOKIE_EXPORT_FAILED', `Cookie 导出失败：${error.message}`)
    }
  }

  const browserUserAgent = async () => {
    const wa = webAccess()
    try {
      const status = await wa?.status?.()
      return status?.browser?.userAgent || ''
    } catch (_) {
      return ''
    }
  }

  const ensureTmp = async () => {
    const dir = join(tmpDir(), `${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`)
    await mkdir(dir, { recursive: true })
    return dir
  }

  const cleanupTmp = async dir => {
    if (!dir) return
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  const saveDownloadedFile = async (file, meta) => {
    const record = await saveFile(dataDir(), file, meta)
    await prune(dataDir(), { keep: state.config.keep, maxBytes: state.config.maxBytes, ttlDays: state.config.ttlDays })
    return record
  }

  /** 直链下载到媒体库（抖音 / B站原生兜底共用）。 */
  const directDownloadToStore = async (url, { headers = {}, kind, meta = {}, maxBytes } = {}) => {
    const dir = await ensureTmp()
    try {
      const name = `${kind || 'file'}_${Date.now().toString(36)}`
      const downloaded = await downloadDirect(url, dir, { headers, filename: name, maxBytes: maxBytes || state.config.maxVideoMB * 1024 * 1024 })
      return await saveDownloadedFile(downloaded.file, { ...meta, kind: kind || 'file' })
    } finally {
      await cleanupTmp(dir)
    }
  }

  const douyinHeaders = async userAgent => {
    const cookieHeader = await webAccessOps.cookieHeaderFor('https://www.douyin.com/')
    return {
      'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Referer: 'https://www.douyin.com/',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    }
  }

  /** 抖音没有 yt-dlp 时，从 bit_rate 清晰度列表里挑一个 ≤maxHeight 的直链。 */
  const pickDouyinStream = (detail, maxHeight) => {
    const height = Math.max(240, Number(maxHeight) || 720)
    const qualities = (detail?.video?.qualities || []).filter(item => item?.url)
    const fit = qualities
      .filter(item => !item.height || item.height <= height)
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))
    if (fit[0]?.url) return fit[0].url
    const smallest = qualities.slice().sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))
    return smallest[0]?.url || detail?.video?.download_url_list?.[0] || detail?.video?.url || ''
  }

  const prepareDouyin = async ({ url, kind, detail, toolsInfo, cookiePath, userAgent }) => {
    const meta = {
      source: 'douyin',
      platformId: detail.id,
      sourceUrl: detail.url || url,
      title: detail.title,
      author: detail.author?.name || '',
      duration: detail.duration_seconds || 0,
      cover: detail.video?.cover || detail.images?.[0]?.url || '',
    }

    if (kind === 'images' || (kind === 'auto' && detail.kind === 'note')) {
      const list = (detail.images || []).slice(0, Math.max(1, Math.min(18, Number(state.config.maxImages) || 9)))
      if (!list.length) return fail('NO_IMAGES', '这条抖音内容里没有解析到图片。')
      const records = []
      for (const image of list) {
        const record = await directDownloadToStore(image.url, {
          headers: await douyinHeaders(userAgent),
          kind: 'image',
          meta: { ...meta, kind: 'image', ext: 'jpg', mime: 'image/jpeg', duration: 0, meta: { index: image.index } },
          maxBytes: Math.max(1, Number(state.config.maxImageMB) || 15) * 1024 * 1024,
        })
        records.push(record)
      }
      return { ok: true, media: { kind: 'images', items: records.map(publicRecord), title: meta.title, author: meta.author, source: 'douyin', sourceUrl: meta.sourceUrl } }
    }

    if (kind === 'video') {
      if (toolsInfo.ytdlp.available) {
        const dir = await ensureTmp()
        try {
          const result = await ytdlpDownload(toolsInfo.ytdlp, {
            url,
            mode: 'video',
            outDir: dir,
            cookiesPath: cookiePath,
            userAgent: userAgent || '', 
            referer: 'https://www.douyin.com/',
            maxHeight: state.config.maxHeight,
            ffmpegPath: toolsInfo.ffmpeg.available ? toolsInfo.ffmpeg.path : '',
          })
          if (!result.ok) return fail('DOWNLOAD_FAILED', result.error || 'yt-dlp 下载失败')
          const record = await saveDownloadedFile(result.file, { ...meta, kind: 'video', ext: 'mp4', mime: 'video/mp4' })
          return { ok: true, media: publicRecord(record) }
        } finally {
          await cleanupTmp(dir)
        }
      }
      const direct = pickDouyinStream(detail, state.config.maxHeight)
      if (!direct) return fail('NO_VIDEO_URL', '没有从抖音解析到可下载的视频地址。')
      const record = await directDownloadToStore(direct, {
        headers: await douyinHeaders(userAgent),
        kind: 'video',
        meta: { ...meta, kind: 'video', ext: 'mp4', mime: 'video/mp4' },
        maxBytes: Math.max(1, Number(state.config.maxVideoMB) || 150) * 1024 * 1024,
      })
      return { ok: true, media: publicRecord(record) }
    }

    // kind === audio
    if (toolsInfo.ytdlp.available && toolsInfo.ffmpeg.available) {
      const dir = await ensureTmp()
      try {
        const result = await ytdlpDownload(toolsInfo.ytdlp, {
          url,
          mode: 'audio',
          outDir: dir,
          cookiesPath: cookiePath,
          userAgent: userAgent || '', 
          referer: 'https://www.douyin.com/',
          ffmpegPath: toolsInfo.ffmpeg.path,
          audioQuality: state.config.mp3Bitrate,
        })
        if (!result.ok) return fail('DOWNLOAD_FAILED', result.error || 'yt-dlp 音频下载失败')
        const record = await saveDownloadedFile(result.file, { ...meta, kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' })
        return { ok: true, media: publicRecord(record) }
      } finally {
        await cleanupTmp(dir)
      }
    }

    // 没有 yt-dlp：直接下载视频再抽音频（有 ffmpeg 时）
    const direct = pickDouyinStream(detail, state.config.maxHeight)
    if (!direct) return fail('NO_VIDEO_URL', '没有从抖音解析到可下载的视频地址。')
    const videoRecord = await directDownloadToStore(direct, {
      headers: await douyinHeaders(userAgent),
      kind: 'video',
      meta: { ...meta, kind: 'video', ext: 'mp4', mime: 'video/mp4' },
      maxBytes: Math.max(1, Number(state.config.maxVideoMB) || 150) * 1024 * 1024,
    })
    if (!toolsInfo.ffmpeg.available) {
      // 没有 ffmpeg：把视频当音频记录返回，发送时 NapCat 会尝试按原样发；失败则降级为文件。
      return { ok: true, media: publicRecord(videoRecord), degraded: 'no-ffmpeg' }
    }
    const audio = await transcodeRecord(videoRecord, { format: 'mp3', bitrate: state.config.mp3Bitrate, toolsInfo })
    if (!audio.ok) return { ok: true, media: publicRecord(videoRecord), degraded: 'transcode-failed' }
    return { ok: true, media: publicRecord(audio.media) }
  }

  const prepareBilibili = async ({ url, kind, toolsInfo, cookiePath, cookieHeader }) => {
    const bvid = extractBvid(url)
    const metaBase = { source: 'bilibili', platformId: bvid, sourceUrl: url, ext: 'mp4', mime: 'video/mp4' }

    if (toolsInfo.ytdlp.available) {
      const dir = await ensureTmp()
      try {
        const result = await ytdlpDownload(toolsInfo.ytdlp, {
          url,
          mode: kind === 'audio' ? 'audio' : 'video',
          outDir: dir,
          cookiesPath: cookiePath,
          maxHeight: state.config.maxHeight,
          ffmpegPath: toolsInfo.ffmpeg.available ? toolsInfo.ffmpeg.path : '',
          audioQuality: state.config.mp3Bitrate,
        })
        if (!result.ok) return fail('DOWNLOAD_FAILED', result.error || 'yt-dlp 下载失败')
        const isAudio = kind === 'audio'
        const record = await saveDownloadedFile(result.file, {
          ...metaBase,
          kind: isAudio ? 'audio' : 'video',
          ext: isAudio ? (toolsInfo.ffmpeg.available ? 'mp3' : 'm4a') : 'mp4',
          mime: isAudio ? 'audio/mpeg' : 'video/mp4',
        })
        return { ok: true, media: publicRecord(record) }
      } finally {
        await cleanupTmp(dir)
      }
    }

    // 原生兜底
    const resolved = await resolveBilibili({ url, cookieHeader, maxHeight: state.config.maxHeight, mode: kind === 'audio' ? 'audio' : 'video' })
    if (!resolved.ok) return fail('RESOLVE_FAILED', resolved.error || 'B站解析失败')
    const meta = {
      ...metaBase,
      platformId: resolved.bvid,
      sourceUrl: resolved.url,
      title: resolved.title,
      author: resolved.author,
      duration: resolved.duration,
      cover: resolved.cover,
    }
    const dir = await ensureTmp()
    try {
      if (kind === 'audio') {
        const source = resolved.audio?.[0]
        if (!source?.url) return fail('NO_AUDIO_URL', 'B站没有返回可下载的音频流。')
        const downloaded = await downloadDirect(source.url, dir, { cookieHeader, filename: `bili_${resolved.bvid}.m4a`, maxBytes: Math.max(1, Number(state.config.maxAudioMB) || 40) * 1024 * 1024 })
        let file = downloaded.file
        let ext = 'm4a'
        let mime = 'audio/mp4'
        if (toolsInfo.ffmpeg.available) {
          const out = join(dir, `bili_${resolved.bvid}.mp3`)
          const converted = await transcodeAudio(toolsInfo.ffmpeg.path, file, out, { format: 'mp3', bitrate: state.config.mp3Bitrate })
          if (converted.ok) { file = converted.file; ext = 'mp3'; mime = 'audio/mpeg' }
        }
        const record = await saveDownloadedFile(file, { ...meta, kind: 'audio', ext, mime })
        return { ok: true, media: publicRecord(record) }
      }

      // 视频：优先 durl 合流 MP4，其次 DASH 视频 + 音频 mux（需要 ffmpeg）
      if (resolved.durl?.[0]?.url) {
        const downloaded = await downloadDirect(resolved.durl[0].url, dir, { cookieHeader, filename: `bili_${resolved.bvid}.mp4`, maxBytes: Math.max(1, Number(state.config.maxVideoMB) || 150) * 1024 * 1024 })
        const record = await saveDownloadedFile(downloaded.file, { ...meta, kind: 'video', ext: 'mp4', mime: 'video/mp4' })
        return { ok: true, media: publicRecord(record) }
      }
      const video = resolved.video?.[0]
      const audio = resolved.audio?.[0]
      if (video?.url && audio?.url && toolsInfo.ffmpeg.available) {
        const v = await downloadDirect(video.url, dir, { cookieHeader, filename: `bili_${resolved.bvid}_v.m4s`, maxBytes: Math.max(1, Number(state.config.maxVideoMB) || 150) * 1024 * 1024 })
        const a = await downloadDirect(audio.url, dir, { cookieHeader, filename: `bili_${resolved.bvid}_a.m4s`, maxBytes: Math.max(1, Number(state.config.maxAudioMB) || 40) * 1024 * 1024 })
        const out = join(dir, `bili_${resolved.bvid}.mp4`)
        const mux = await run(toolsInfo.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-y', '-i', v.file, '-i', a.file, '-c', 'copy', out], { timeoutMs: 300000 })
        if (mux.code === 0) {
          const record = await saveDownloadedFile(out, { ...meta, kind: 'video', ext: 'mp4', mime: 'video/mp4' })
          return { ok: true, media: publicRecord(record) }
        }
      }
      return fail('NO_VIDEO_STREAM', '没有拿到可用的 B站视频流（可尝试安装 yt-dlp 或 ffmpeg 后重试）。')
    } finally {
      await cleanupTmp(dir)
    }
  }

  const transcodeRecord = async (record, { format = 'mp3', bitrate = '96k', toolsInfo = null } = {}) => {
    const info = toolsInfo || await tools()
    if (!info.ffmpeg.available) return fail('FFMPEG_UNAVAILABLE', '没有检测到 ffmpeg，无法转码。', { hint: '到「设置 → 点歌台」点「安装 ffmpeg」即可。' })
    const source = await stat(join(dataDir(), 'media-post', 'media', record.file)).catch(() => null)
    if (!source?.isFile()) return fail('MEDIA_NOT_FOUND', '媒体文件不存在或已被清理。')
    const dir = await ensureTmp()
    try {
      const ext = format === 'amr' ? 'amr' : 'mp3'
      const output = join(dir, `${record.id}.${ext}`)
      const converted = await transcodeAudio(info.ffmpeg.path, join(dataDir(), 'media-post', 'media', record.file), output, { format, bitrate })
      if (!converted.ok) return fail('TRANSCODE_FAILED', converted.error || '转码失败')
      const derived = await saveBuffer(dataDir(), await readFile(output), {
        kind: 'audio',
        ext,
        mime: converted.mime,
        title: record.title,
        author: record.author,
        duration: converted.duration || record.duration,
        source: record.source,
        platformId: record.platformId,
        sourceUrl: record.sourceUrl,
        cover: record.cover,
        meta: { derivedFrom: record.id, format },
      })
      const parent = await getRecord(dataDir(), record.id)
        if (parent) {
          await patchRecord(dataDir(), record.id, {
            variants: { ...(parent.variants || {}), [format]: { id: derived.id, file: derived.file, size: derived.size, mime: derived.mime } },
          })
        }
      return { ok: true, media: publicRecord(derived) }
    } finally {
      await cleanupTmp(dir)
    }
  }

  /**
   * 生成 QQ 官方机器人需要的 SILK 语音：
   * 任意音频 → ffmpeg 转 24k 单声道 PCM → silk-wasm 编码。
   */
  const transcodeToSilk = async (record, { toolsInfo = null } = {}) => {
    const info = toolsInfo || (await tools())
    const input = join(dataDir(), 'media-post', 'media', record.file)
    const source = await stat(input).catch(() => null)
    if (!source?.isFile()) return fail('MEDIA_NOT_FOUND', '媒体文件不存在或已被清理。')
    if (/\.silk$/i.test(record.file || '')) {
      try {
        const buffer = await readFile(input)
        if (isSilkBuffer(buffer)) return { ok: true, base64: buffer.toString('base64'), duration: Number(record.duration) || 0, bytes: buffer.length }
      } catch (_) {
        /* fallthrough */
      }
    }
    if (!info.ffmpeg.available) {
      return fail('FFMPEG_UNAVAILABLE', '没有检测到 ffmpeg，无法生成 QQ 官方语音。', { hint: '到「设置 → 点歌台」点「一键安装缺失工具」。' })
    }
    const dir = await ensureTmp()
    try {
      const pcmFile = join(dir, `${record.id}.pcm`)
      const result = await run(
        info.ffmpeg.path,
        ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '24000', pcmFile],
        { timeoutMs: 600000 },
      )
      if (result.code !== 0) {
        const detail = (result.stderr || result.error || '').trim().split('\n').slice(-3).join(' ')
        return fail('SILK_TRANSCODE_FAILED', detail.slice(0, 400) || 'ffmpeg 转 PCM 失败')
      }
      const pcm = await readFile(pcmFile)
      const encoded = await silkEncode(pcm, 24000)
      const buffer = Buffer.from(encoded.data)
      if (!isSilkBuffer(buffer)) return fail('SILK_TRANSCODE_FAILED', 'silk-wasm 输出的不是有效 SILK。')
      return { ok: true, base64: buffer.toString('base64'), duration: Math.round((Number(encoded.duration) || 0) / 1000), bytes: buffer.length }
    } catch (error) {
      return fail('SILK_TRANSCODE_FAILED', error?.message || String(error))
    } finally {
      await cleanupTmp(dir)
    }
  }

  /* ------------------------------------------------------------------ */
  /* 发送：NapCat 特权段 / QQ 官方机器人语音 / 其它渠道降级信息           */
  /* ------------------------------------------------------------------ */

  const sendViaNapcat = async ({ channelId, napcatChannelId, napcatTarget, records, mode, caption }) => {
    const napcatService = napcat()
    if (!napcatService?.action) return { ok: false, code: 'NAPCAT_UNAVAILABLE' }

    // 优先用会话 meta 直接给出的 instanceId / targetType / targetId：
    // 不依赖后端 NapCat 渠道表是否同步成功（渠道表缺失时也能发）。
    let target = null
    if (napcatTarget && typeof napcatTarget === 'object') {
      const instanceId = String(napcatTarget.instanceId || '').trim()
      const targetId = String(napcatTarget.targetId || '').trim()
      if (instanceId && targetId) {
        target = {
          instanceId,
          targetType: napcatTarget.targetType === 'group' ? 'group' : 'private',
          targetId,
          source: 'session-meta',
        }
      }
    }

    if (!target) {
      let channel = null
      let tableIds = []
      try {
        const list = napcatService.channels?.() || []
        tableIds = list.map(item => String(item.id)).slice(0, 8)
        const candidates = [napcatChannelId, channelId].map(value => String(value || '').trim()).filter(Boolean)
        for (const candidate of candidates) {
          const bare = candidate.replace(/^[a-zA-Z0-9_-]+:/, '')
          channel =
            list.find(item => String(item.id) === candidate) ||
            list.find(item => String(item.id) === bare) ||
            list.find(item => candidate.endsWith(`:${item.id}`)) ||
            list.find(item => String(item.conversationId || '') === candidate) ||
            null
          if (channel) break
        }
        // 上下文只给了稳定前缀（napcat:<id>）时，如果只有一条渠道就直接用它
        if (!channel && list.length === 1 && candidates.some(value => /^napcat:/i.test(value))) channel = list[0]
      } catch (_) {
        channel = null
      }
      if (channel) {
        target = {
          instanceId: String(channel.instanceId || channel.instance_id || ''),
          targetType: channel.targetType === 'group' ? 'group' : 'private',
          targetId: String(channel.targetId || channel.target_id || ''),
          source: 'channel-table',
        }
      } else {
        return {
          ok: false,
          code: 'NOT_NAPCAT_CHANNEL',
          error: `没有拿到 NapCat 发送目标：会话 meta 里缺 instanceId/targetId，渠道表里也找不到 ${napcatChannelId || channelId || ''}${tableIds.length ? `（后端现有渠道：${tableIds.join(', ')}）` : '（后端渠道表为空）'}。`,
        }
      }
    }

    const instanceId = target.instanceId
    const targetType = target.targetType === 'group' ? 'group' : 'private'
    const targetId = target.targetId
    if (!instanceId || !targetId) return { ok: false, code: 'BAD_TARGET', error: 'NapCat 发送目标缺少连接或目标号。' }

    const segments = []
    const text = String(caption || '').slice(0, 300)
    if (state.config.sendCaption && text) segments.push({ type: 'text', data: { text } })

    for (const record of records) {
      const file = sourceOf(record)
      if (!file) continue
      if (mode === 'voice') segments.push({ type: 'record', data: { file } })
      else if (mode === 'video') segments.push({ type: 'video', data: { file } })
      else if (mode === 'images') segments.push({ type: 'image', data: { file } })
      else segments.push({ type: 'file', data: { file, name: record.file || 'media' } })
    }
    if (!segments.length) return { ok: false, code: 'EMPTY', error: '没有可发送的媒体段。' }

    const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = targetType === 'group' ? { group_id: Number(targetId), message: segments } : { user_id: Number(targetId), message: segments }
    const result = await napcatService.action(instanceId, action, params)
    if (!result?.ok) return { ok: false, code: result?.code || 'SEND_FAILED', error: result?.error || result?.message || 'NapCat 发送失败' }
    return {
      ok: true,
      sent: true,
      mode,
      targetType,
      targetId,
      instanceId,
      source: target.source,
      messageId: result.data?.message_id ?? result.data?.messageId ?? null,
    }
  }

  /* ------------------------------------------------------------------ */
  /* 路由                                                                */
  /* ------------------------------------------------------------------ */

  const routes = []
  const route = (method, path, handler) => {
    routes.push(httpApi.route(method, path, async (req, res, params = {}, url) => {
      try {
        await ready
        await handler(req, res, params, url)
      } catch (error) {
        ctx.logger.warn(`[media-post] ${req.method} ${url?.pathname || path} 失败：${error?.message || error}`)
        if (!res.headersSent) httpApi.sendError(res, Number(error?.status) || 500, error?.message || String(error))
        else res.end()
      }
    }))
  }

  route('GET', '/api/media/status', async (req, res) => {
    const info = await tools()
    const accessInfo = await webAccessOps.available()
    const stats = await cacheStats(dataDir())
    const napcatService = napcat()
    const qqbotService = serviceOf('qqbot')
    let channels = []
    try {
      channels = (napcatService?.channels?.() || []).map(channel => ({
        id: channel.id,
        instanceId: channel.instanceId,
        targetType: channel.targetType,
        targetId: channel.targetId,
        name: channel.name || '',
      }))
    } catch (_) {
      channels = []
    }
    httpApi.sendJson(res, 200, {
      ok: true,
      dataDir: dataDir(),
      config: { ...state.config },
      tools: {
        ffmpeg: info.ffmpeg,
        ytdlp: info.ytdlp,
        python: info.python,
      },
      cache: {
        ...stats,
        keep: state.config.keep,
        maxBytes: state.config.maxBytes,
        ttlDays: state.config.ttlDays,
      },
      cookies: { bilibili: await cookieInfo('bilibili'), douyin: await cookieInfo('douyin') },
      webAccess: accessInfo.ok,
      webAccessMode: accessInfo.mode,
      webAccessVersion: accessInfo.version,
      webAccessHint: accessInfo.ok ? '' : '没有检测到「联网访问」后端桥：请到「设置 → 插件」点「重新扫描」；仍无效就重启念风后端。',
      napcat: !!napcatService,
      napcatChannels: channels,
      qqbot: !!qqbotService,
      qqbotVoice: !!qqbotService && qqbotService.supportsVoice?.() !== false,
    })
  })

  route('POST', '/api/media/tools/install', async (req, res) => {
    const body = (await httpApi.readBody(req)) || {}
    const target = String(body.target || 'auto')
    const info = await tools({ fresh: true })
    const installed = {}
    if (target === 'ffmpeg' || (target === 'auto' && !info.ffmpeg.available)) {
      installed.ffmpeg = await installFfmpeg({ dataDir: dataDir(), onProgress: step => ctx.logger.info(`[media-post] ffmpeg 安装：${step.phase}`) })
    }
    if (target === 'ytdlp' || (target === 'auto' && !info.ytdlp.available)) {
      installed.ytdlp = await installYtDlp({
        dataDir: dataDir(),
        python: info.python,
        pipMirror: state.config.pipMirror,
        onProgress: step => ctx.logger.info(`[media-post] yt-dlp 安装：${step.phase}`),
      })
    }
    toolCache = { at: 0, value: null }
    const fresh = await tools({ fresh: true })
    httpApi.sendJson(res, 200, { ok: true, installed, tools: { ffmpeg: fresh.ffmpeg, ytdlp: fresh.ytdlp, python: fresh.python } })
  })

  route('POST', '/api/media/config', async (req, res) => {
    const body = (await httpApi.readBody(req)) || {}
    const allowed = Object.keys(DEFAULT_CONFIG)
    for (const key of allowed) {
      if (body[key] === undefined) continue
      if (typeof DEFAULT_CONFIG[key] === 'number') state.config[key] = Number(body[key]) || DEFAULT_CONFIG[key]
      else state.config[key] = String(body[key] ?? '')
    }
    schedulePersist()
    toolCache = { at: 0, value: null }
    httpApi.sendJson(res, 200, { ok: true, config: { ...state.config } })
  })

  route('POST', '/api/media/cookies/sync', async (req, res) => {
    const body = (await httpApi.readBody(req)) || {}
    const site = body.site === 'douyin' ? 'douyin' : body.site === 'bilibili' ? 'bilibili' : ''
    if (site) {
      const result = await ensureCookies(site, { required: false })
      return httpApi.sendJson(res, 200, { ...result, cookies: { bilibili: await cookieInfo('bilibili'), douyin: await cookieInfo('douyin') } })
    }
    httpApi.sendJson(res, 200, { ok: true, cookies: { bilibili: await cookieInfo('bilibili'), douyin: await cookieInfo('douyin') } })
  })

  route('POST', '/api/media/prepare', async (req, res) => {
    const body = (await httpApi.readBody(req)) || {}
    const url = String(body.url || '').trim()
    const kind = ['auto', 'video', 'audio', 'images'].includes(body.kind) ? body.kind : 'auto'
    if (!url) return httpApi.sendJson(res, 400, fail('INVALID_ARGS', '缺少媒体链接 url。'))
    const platform = platformOf(url)
    if (!platform) return httpApi.sendJson(res, 400, fail('UNSUPPORTED_URL', '目前支持 B站 / 抖音链接（b23.tv、bilibili.com、v.douyin.com、douyin.com）。'))
    const info = await tools()

    if (platform === 'douyin') {
      const cookie = await ensureCookies('douyin')
      if (!cookie.ok) return httpApi.sendJson(res, 200, cookie)
      const detail = await webAccessOps.readDouyin(url, { includeImages: true, imageLimit: Number(state.config.maxImages) || 9 })
      if (!detail?.ok) return httpApi.sendJson(res, 200, fail(detail?.code || 'DOUYIN_FAILED', detail?.error || '抖音解析失败', { hint: detail?.hint || '' }))
      const result = await prepareDouyin({ url, kind, detail, toolsInfo: info, cookiePath: cookie.path, userAgent: await browserUserAgent() })
      return httpApi.sendJson(res, 200, { platform, ...result })
    }

    if (kind === 'images') {
      return httpApi.sendJson(res, 200, fail('UNSUPPORTED_KIND', 'B站的图文（动态 / 专栏）暂未支持，可以先发链接，或改发视频 / 音频。', { hint: '抖音图文已支持：直接发抖音图文链接即可。' }))
    }
    const access = await webAccessOps.available()
    if (!access.ok) {
      return httpApi.sendJson(res, 200, fail('NEED_WEB_ACCESS', '没有找到可用的「联网访问」后端（web-access bridge）。', { hint: '请到「设置 → 插件」点「重新扫描」；仍无效就重启念风后端。' }))
    }
    const cookie = await ensureCookies('bilibili', { required: false })
    if (!cookie.ok) return httpApi.sendJson(res, 200, cookie)
    const cookieHeader = await webAccessOps.cookieHeaderFor('https://api.bilibili.com/')
    const result = await prepareBilibili({ url, kind, toolsInfo: info, cookiePath: cookie.path || '', cookieHeader })
    httpApi.sendJson(res, 200, { platform, ...result })
  })

  route('POST', '/api/media/transcode', async (req, res) => {
    const body = (await httpApi.readBody(req)) || {}
    const record = body.id ? await getRecord(dataDir(), String(body.id)) : null
    if (!record) return httpApi.sendJson(res, 404, fail('MEDIA_NOT_FOUND', '媒体不存在。'))
    const format = body.format === 'amr' ? 'amr' : body.format === 'wav' ? 'wav' : 'mp3'
    const result = await transcodeRecord(record, { format, bitrate: state.config.mp3Bitrate })
    httpApi.sendJson(res, 200, result)
  })

  route('POST', '/api/media/send', async (req, res) => {
    const body = (await httpApi.readBody(req)) || {}
    const channelId = String(body.channelId || '').trim()
    const mode = ['voice', 'video', 'file', 'images'].includes(body.mode) ? body.mode : 'video'
    if (!channelId) return httpApi.sendJson(res, 400, fail('INVALID_ARGS', '缺少 channelId。'))

    const ids = Array.isArray(body.ids) ? body.ids.map(String) : body.id ? [String(body.id)] : []
    if (!ids.length) return httpApi.sendJson(res, 400, fail('INVALID_ARGS', '缺少媒体 id。'))
    let records = []
    for (const id of ids) {
      const record = await getRecord(dataDir(), id)
      if (record) records.push(record)
    }
    if (!records.length) return httpApi.sendJson(res, 404, fail('MEDIA_NOT_FOUND', '媒体不存在或已被清理。'))

    const qqbotChannelId = String(body.qqbotChannelId || '').replace(/^qqbot:/i, '').trim()
    const qqbotService = qqbotChannelId ? serviceOf('qqbot') : null
    const looksQqbot = !!qqbotChannelId && !!qqbotService

    if (mode === 'voice') {
      const wanted = state.config.voiceFormat === 'amr' ? 'amr' : 'mp3'
      const prepared = []
      for (const record of records) {
        const variantId = record.variants?.[wanted]?.id
        let target = variantId ? await getRecord(dataDir(), variantId) : null
        if (!target) {
          const converted = await transcodeRecord(record, { format: wanted, bitrate: state.config.mp3Bitrate })
          if (converted.ok) {
            target = await getRecord(dataDir(), converted.media.id)
          } else if (record.kind === 'audio') {
            // 已经是音频：没有 ffmpeg 也先按原格式尝试（NapCat 对 m4a/mp3 的兼容性交给它自己）。
            target = record
          } else {
            return httpApi.sendJson(res, 200, converted)
          }
        }
        prepared.push(target || record)
      }
      records = prepared
    }

    // QQ 官方机器人语音：转 SILK → qqbot 服务上传 file_type=3 → msg_type=7。
    if (mode === 'voice' && looksQqbot) {
      const silk = await transcodeToSilk(records[0])
      if (silk.ok) {
        const caption = state.config.sendCaption ? String(body.caption || '').slice(0, 200) : ''
        const sent = await Promise.resolve(
          qqbotService.send({
            channelId: qqbotChannelId,
            text: caption,
            voice: { dataUrl: `data:audio/silk;base64,${silk.base64}`, mime: 'audio/silk' },
          }),
        ).catch(error => ({ ok: false, code: 'SEND_FAILED', error: error?.message || String(error) }))
        if (sent?.ok) {
          const messageId = sent.id || sent.messageId || sent.msgId || ''
          ctx.logger?.info?.(
            `[media-post] QQ 官方语音发送成功：channel=${qqbotChannelId} messageId=${messageId || '（接口未回传 id）'} duration=${silk.duration || records[0]?.duration || 0}s`,
          )
          return httpApi.sendJson(res, 200, {
            ok: true,
            success: true,
            target: 'qqbot',
            targetSource: 'qqbot',
            mode: 'voice',
            voiceFormat: 'silk',
            duration: silk.duration || records[0]?.duration || 0,
            messageId,
            msgId: sent.msgId || '',
            media: records.map(publicRecord),
            caption,
          })
        }
        ctx.logger?.warn?.(
          `[media-post] QQ 官方语音发送失败：channel=${qqbotChannelId} code=${sent?.code || 'SEND_FAILED'} error=${sent?.error || '未知错误'}`,
        )
        return httpApi.sendJson(
          res,
          200,
          fallbackPayload({
            records,
            mode,
            code: sent?.code || 'SEND_FAILED',
            reasonText: sent?.error || 'QQ 官方机器人语音发送失败',
            caption: body.caption,
          }),
        )
      }
      return httpApi.sendJson(
        res,
        200,
        fallbackPayload({
          records,
          mode,
          code: silk.code || 'SILK_TRANSCODE_FAILED',
          reasonText: silk.error || 'SILK 转码失败',
          caption: body.caption,
        }),
      )
    }

    const napcatChannelId = String(body.napcatChannelId || '').trim()
    const napcatTarget = body.napcatTarget && typeof body.napcatTarget === 'object' ? body.napcatTarget : null
    let napcatResult = await sendViaNapcat({ channelId, napcatChannelId, napcatTarget, records, mode, caption: body.caption })
    // NapCat 拒绝 mp3 语音时，自动转 amr 再试一次（QQ 语音兼容性最好）。
    if (!napcatResult.ok && mode === 'voice' && !['NOT_NAPCAT_CHANNEL', 'NAPCAT_UNAVAILABLE'].includes(napcatResult.code)) {
      const info = await tools()
      if (info.ffmpeg.available && records.every(record => !/\.amr$/i.test(record.file || ''))) {
        const convertedRecords = []
        for (const record of records) {
          const converted = await transcodeRecord(record, { format: 'amr' })
          convertedRecords.push(converted.ok ? await getRecord(dataDir(), converted.media.id) : record)
        }
        const retry = await sendViaNapcat({ channelId, napcatChannelId, napcatTarget, records: convertedRecords, mode, caption: body.caption })
        if (retry.ok) {
          napcatResult = { ...retry, voiceFormat: 'amr' }
          records = convertedRecords
        }
      }
    }
    if (napcatResult.ok) {
      return httpApi.sendJson(res, 200, {
        ...napcatResult,
        targetSource: napcatResult.source || '',
        media: records.map(publicRecord),
        fileUrls: state.config.fileBaseUrl ? records.map(fileUrlOf) : [],
      })
    }

    // 非 NapCat / 未配置：返回降级信息，由前端插件改写为普通聊天消息（文本 + 图片）或链接。
    const fallback = fallbackPayload({
      records,
      mode,
      code: napcatResult.code || 'FALLBACK',
      reason: napcatResult.code || 'FALLBACK',
      reasonText: napcatResult.error || '',
      caption: body.caption,
    })
    httpApi.sendJson(res, 200, fallback)
  })

  route('GET', '/api/media/library', async (req, res, params, url) => {
    const limit = Math.max(1, Math.min(500, Number(url?.searchParams?.get('limit')) || 100))
    const records = await listRecords(dataDir(), { limit })
    httpApi.sendJson(res, 200, { ok: true, items: records.map(publicRecord), cache: await cacheStats(dataDir()) })
  })

  route('POST', '/api/media/prune', async (req, res) => {
    const result = await prune(dataDir(), { keep: state.config.keep, maxBytes: state.config.maxBytes, ttlDays: state.config.ttlDays })
    httpApi.sendJson(res, 200, { ok: true, ...result })
  })

  route('DELETE', '/api/media/:id', async (req, res, params) => {
    const removed = await removeRecord(dataDir(), params.id)
    httpApi.sendJson(res, 200, { ok: removed, id: params.id })
  })

  const serveMediaFile = async (req, res, params) => {
    const record = await getRecord(dataDir(), params.id)
    if (!record || String(record.secret) !== String(params.token || '')) return httpApi.sendError(res, 404, '文件不存在')
    const absolute = join(dataDir(), 'media-post', 'media', record.file)
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) return httpApi.sendError(res, 404, '文件不存在')

    const range = String(req.headers.range || '')
    const mime = record.mime || 'application/octet-stream'
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      const startAt = match && match[1] ? Number(match[1]) : 0
      const endAt = match && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
      if (startAt >= info.size || startAt > endAt) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
        return res.end()
      }
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Length': endAt - startAt + 1,
        'Content-Range': `bytes ${startAt}-${endAt}/${info.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      })
      createReadStream(absolute, { start: startAt, end: endAt }).pipe(res)
      return
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': info.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    })
    createReadStream(absolute).pipe(res)
  }

  route('GET', '/api/media/file/:id/:token', serveMediaFile)
  route('GET', '/api/media/file/:id/:token/:name', serveMediaFile)

  /* ------------------------------------------------------------------ */
  /* 启动 / 清理                                                          */
  /* ------------------------------------------------------------------ */

  loadState()
    .then(() => ctx.logger.info(`[media-post] 后端桥就绪 · 数据目录 ${dataDir()}`))
    .catch(error => ctx.logger.warn(`[media-post] 状态加载失败：${error.message}`))

  ctx.effect(() => () => {
    if (persistTimer) clearTimeout(persistTimer)
    for (const dispose of routes) {
      try { dispose?.() } catch (_) { /* ignore */ }
    }
    persist().catch(() => {})
  })
}

