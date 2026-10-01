/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · yt-dlp 调用封装
 *
 * 支持两种形态：
 *   - binary：直接执行下载好的 yt-dlp(.exe)
 *   - python：python -m yt_dlp（PYTHONPATH 指向插件目录里的 pip --target 安装）
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { libUrl } from './rev.mjs'

const { run } = await import(libUrl('tools.mjs'))

function launcher(tool) {
  if (!tool?.available) return null
  if (tool.kind === 'python') {
    return {
      command: tool.path,
      args: [...(tool.moduleArgs || []), '-m', 'yt_dlp'],
      env: { PYTHONPATH: [tool.pythonPath, process.env.PYTHONPATH].filter(Boolean).join(';') },
    }
  }
  return { command: tool.path, args: [], env: {} }
}

export async function runYtDlp(tool, args, { timeoutMs = 600000, cwd, onProgress } = {}) {
  const l = launcher(tool)
  if (!l) return { code: -1, stdout: '', stderr: '', error: 'yt-dlp 不可用' }
  const result = await run(l.command, [...l.args, ...args], { timeoutMs, cwd, env: l.env })
  onProgress?.(result)
  return result
}

const commonArgs = ({ cookiesPath, userAgent, referer, extra = [] }) => {
  const args = ['--no-playlist', '--no-warnings', '--no-progress', '--newline', '--retries', '5', '--fragment-retries', '5', '--socket-timeout', '30']
  if (cookiesPath) args.push('--cookies', cookiesPath)
  if (userAgent) args.push('--user-agent', userAgent)
  if (referer) args.push('--add-header', `Referer: ${referer}`)
  args.push(...extra)
  return args
}

/** 只取元数据（不下载媒体）。 */
export async function probe(tool, { url, cookiesPath, userAgent, referer, timeoutMs = 120000 } = {}) {
  const args = commonArgs({ cookiesPath, userAgent, referer, extra: ['--dump-single-json', '--skip-download', url] })
  const result = await runYtDlp(tool, args, { timeoutMs })
  const line = String(result.stdout || '').trim().split('\n').filter(Boolean).pop() || ''
  let info = null
  try { info = JSON.parse(line) } catch { /* 有些 warning 行会混进来 */ }
  return { ok: result.code === 0 && !!info, info, stderr: result.stderr, code: result.code }
}

/** 媒体格式 id -> 页面 URL（把 B站 / 抖音的直接链接交给后续下载或发送）。 */
export function pickDirectUrl(info = {}) {
  const formats = Array.isArray(info.formats) ? info.formats : []
  const direct = formats.filter(f => /^https?:\/\//i.test(String(f.url || '')))
  const requested = formats.find(f => String(f.format_id) === String(info.requested_downloads?.[0]?.format_id))
  return requested?.url || direct[0]?.url || ''
}

/**
 * 构造 yt-dlp 下载参数（纯函数，方便单测）。
 *   video 默认「原画质」：bv*+ba/b，清晰度优先，同清晰度优先 H.264 + AAC；
 *   maxHeight>0 时才加 [height<=N]；
 *   audio 用 ba/b，有 ffmpeg 时直接抽 mp3。
 */
export function buildDownloadArgs({
  url = '',
  mode = 'video',
  cookiesPath = '',
  userAgent = '',
  referer = '',
  maxHeight = 0,
  ffmpegPath = '',
  audioQuality = '96K',
  outputTemplate = 'media.%(ext)s',
  withMeta = true,
  metaPrefix = '__MP_META__',
} = {}) {
  const extra = withMeta
    ? ['--print', 'after_move:filepath', '--print', `before_dl:${metaPrefix}%(title)s||%(uploader)s||%(duration)s||%(webpage_url)s`]
    : ['--print', 'after_move:filepath']
  const args = commonArgs({ cookiesPath, userAgent, referer, extra })

  if (mode === 'audio') {
    if (ffmpegPath) args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', audioQuality, '--ffmpeg-location', ffmpegPath)
    else args.push('-f', 'ba/b')
    return args.concat('-o', outputTemplate, url)
  }

  const limit = Number(maxHeight) > 0 ? Math.max(240, Math.min(2160, Math.round(Number(maxHeight)))) : 0
  const filter = limit ? `[height<=${limit}]` : ''
  const selector = ffmpegPath
    ? filter
      ? `bv*${filter}+ba/b${filter}/b`
      : 'bv*+ba/b'
    : `b${filter}/b`
  if (ffmpegPath) args.push('-f', selector, '--merge-output-format', 'mp4', '--ffmpeg-location', ffmpegPath)
  else args.push('-f', selector)
  // 清晰度优先（原画质），同清晰度再优先 H.264 + AAC；
  // 选到 AV1 / HEVC 时由 bridge 探测并转码成 H.264，而不是把画质降下去。
  args.push('-S', 'res,vcodec:h264,acodec:aac,br')
  return args.concat('-o', outputTemplate, url)
}

/**
 * 下载视频 / 音频。
 *   mode = video：默认拿「原画质」bv*+ba 合并 mp4（需要 ffmpeg），maxHeight>0 时才降清晰度；
 *                 同清晰度优先 H.264 + AAC，避免为了编码把 1080P 降成 720P；
 *   mode = audio：优先 bestaudio；有 ffmpeg 时转 mp3，没有 ffmpeg 时保留原始音轨（m4a 等）。
 * @returns {{ ok:boolean, file?:string, ext?:string, meta?:object, info?:object, error?:string, raw?:object }}
 */
export async function download(tool, {
  url,
  mode = 'video',
  outDir,
  cookiesPath = '',
  userAgent = '',
  referer = '',
  maxHeight = 0,
  ffmpegPath = '',
  timeoutMs = 1800000,
  audioQuality = '96K',
  onProgress,
} = {}) {
  const ext = mode === 'audio' && ffmpegPath ? 'mp3' : mode === 'video' && ffmpegPath ? 'mp4' : 'orig'
  const suffix = ext === 'orig' ? '%(ext)s' : ext
  const outputTemplate = join(outDir, `dl_${Date.now().toString(36)}_%(id)s.${suffix}`)
  const build = withMeta =>
    buildDownloadArgs({ url, mode, cookiesPath, userAgent, referer, maxHeight, ffmpegPath, audioQuality, outputTemplate, withMeta })

  let result = await runYtDlp(tool, build(true), { timeoutMs, cwd: outDir, onProgress })
  // 老版本 yt-dlp 可能不认 before_dl: 前缀：去掉元数据打印重试一次，别为了标题把下载搞挂。
  if (result.code !== 0 && /before_dl|Invalid template|unknown (option|argument)|not recognized/i.test(`${result.stderr || ''}${result.stdout || ''}`)) {
    result = await runYtDlp(tool, build(false), { timeoutMs, cwd: outDir, onProgress })
  }

  // 从 stdout 里找 yt-dlp 打印的最终文件路径；失败时绝不再把目录里的 .part / 中间产物当成品。
  const lines = String(result.stdout || '').split('\n').map(line => line.trim()).filter(Boolean)
  let file = lines.reverse().find(line => /^[A-Za-z]:[\\/]|^\//.test(line) && !line.includes('merged into'))
  if (file && /\.(part|ytdl|temp)$/i.test(file)) file = ''
  if (file) {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) file = ''
  }
  if (!file && result.code === 0) {
    const entries = await readdir(outDir, { withFileTypes: true }).catch(() => [])
    const candidates = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('dl_')) continue
      if (/\.(part|ytdl|temp)$/i.test(entry.name)) continue
      const full = join(outDir, entry.name)
      const info = await stat(full).catch(() => null)
      if (info?.isFile() && info.size > 0) candidates.push({ full, mtime: info.mtimeMs })
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    file = candidates[0]?.full || ''
  }

  if (result.code !== 0 || !file) {
    const detail = (result.stderr || result.error || result.stdout || '').trim().split('\n').slice(-3).join(' ')
    return { ok: false, error: detail.slice(0, 400) || 'yt-dlp 下载失败', raw: result }
  }
  // 把真实扩展名一起返回：没有 ffmpeg 时 yt-dlp 可能留下 webm / m4a / mp4，
  // 调用方要按它写媒体库索引（否则 m4a 容器被标成 mp4 会播不出来）。
  const actualExt = (/\.[A-Za-z0-9]{1,8}$/.exec(file) || [''])[0].replace(/^\./, '').toLowerCase()
  return { ok: true, file, ext: actualExt, meta: parsePrintedMeta(String(result.stdout || ''), metaPrefix), raw: result }
}

/** 解析 `--print before_dl:__MP_META__标题||作者||时长||链接` 那一行（纯函数，方便单测）。 */
export function parsePrintedMeta(stdout, prefix = '__MP_META__') {
  const line = String(stdout || '')
    .split('\n')
    .map(item => item.trim())
    .find(item => item.startsWith(prefix))
  if (!line) return null
  // yt-dlp 缺字段时会打印 NA，这里统一当空值。
  const field = value => (value && value !== 'NA' ? value : '')
  const [title = '', author = '', duration = '', sourceUrl = ''] = line.slice(prefix.length).split('||')
  const seconds = Number(duration)
  return {
    title: field(title).slice(0, 300),
    author: field(author).slice(0, 120),
    duration: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0,
    sourceUrl: field(sourceUrl),
  }
}
