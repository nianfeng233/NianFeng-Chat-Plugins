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
import { run } from './tools.mjs'

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
  const args = ['--no-playlist', '--no-warnings', '--no-progress', '--newline']
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
 * 下载视频 / 音频。
 *   mode = video：优先 bv*+ba 合并 mp4（需要 ffmpeg），没 ffmpeg 时退回单流 b；
 *   mode = audio：优先 bestaudio；有 ffmpeg 时转 mp3，没有 ffmpeg 时保留原始音轨（m4a 等）。
 * @returns {{ ok:boolean, file?:string, info?:object, error?:string, raw?:object }}
 */
export async function download(tool, {
  url,
  mode = 'video',
  outDir,
  cookiesPath = '',
  userAgent = '',
  referer = '',
  maxHeight = 720,
  ffmpegPath = '',
  timeoutMs = 900000,
  audioQuality = '96K',
  onProgress,
} = {}) {
  const ext = mode === 'audio' && ffmpegPath ? 'mp3' : mode === 'video' && ffmpegPath ? 'mp4' : 'orig'
  const suffix = ext === 'orig' ? '%(ext)s' : ext
  const outputTemplate = join(outDir, `dl_${Date.now().toString(36)}_%(id)s.${suffix}`)
  const args = commonArgs({ cookiesPath, userAgent, referer, extra: ['--print', 'after_move:filepath'] })

  if (mode === 'audio') {
    if (ffmpegPath) {
      args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', audioQuality)
      args.push('--ffmpeg-location', ffmpegPath)
    } else {
      args.push('-f', 'ba/b')
    }
  } else {
    const height = Math.max(240, Math.min(2160, Number(maxHeight) || 720))
    if (ffmpegPath) {
      args.push('-f', `bv*[height<=${height}]+ba/b[height<=${height}]/b`, '--merge-output-format', 'mp4')
      args.push('--ffmpeg-location', ffmpegPath)
    } else {
      args.push('-f', `b[height<=${height}]/b`)
    }
  }

  args.push('-o', outputTemplate, url)
  const result = await runYtDlp(tool, args, { timeoutMs, cwd: outDir, onProgress })

  // 从 stdout 里找 yt-dlp 打印的最终文件路径；找不到就扫描输出目录里最新的 dl_ 文件。
  const lines = String(result.stdout || '').split('\n').map(line => line.trim()).filter(Boolean)
  let file = lines.reverse().find(line => /^[A-Za-z]:[\\/]|^\//.test(line) && !line.includes('merged into'))
  if (file) {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) file = ''
  }
  if (!file) {
    const entries = await readdir(outDir, { withFileTypes: true }).catch(() => [])
    const candidates = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('dl_')) continue
      const full = join(outDir, entry.name)
      const info = await stat(full).catch(() => null)
      if (info?.isFile()) candidates.push({ full, mtime: info.mtimeMs })
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    file = candidates[0]?.full || ''
  }

  if (result.code !== 0 && !file) {
    const detail = (result.stderr || result.error || result.stdout || '').trim().split('\n').slice(-3).join(' ')
    return { ok: false, error: detail.slice(0, 400) || 'yt-dlp 下载失败', raw: result }
  }
  return { ok: true, file, raw: result }
}
