/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · ffmpeg 封装（抽音频 / 转 mp3、amr / 探时长 / 探测编码 / 兼容转码 H.264）
 */
import { stat } from 'node:fs/promises'
import { libUrl } from './rev.mjs'

const { run } = await import(libUrl('tools.mjs'))

const AUDIO_FORMATS = {
  mp3: {
    ext: 'mp3',
    mime: 'audio/mpeg',
    args: (bitrate = '96k') => ['-vn', '-c:a', 'libmp3lame', '-b:a', String(bitrate)],
  },
  amr: {
    ext: 'amr',
    mime: 'audio/amr',
    args: () => ['-vn', '-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb', '-b:a', '12.2k'],
  },
  wav: {
    ext: 'wav',
    mime: 'audio/wav',
    args: () => ['-vn', '-c:a', 'pcm_s16le'],
  },
}

export const AUDIO_FORMAT_KEYS = Object.keys(AUDIO_FORMATS)

/**
 * 把任意媒体文件里的音轨转成目标格式。
 * @returns {{ ok:boolean, file?:string, mime?:string, bytes?:number, duration?:number, error?:string }}
 */
export async function transcodeAudio(ffmpeg, input, output, { format = 'mp3', bitrate = '96k', timeoutMs = 600000 } = {}) {
  const preset = AUDIO_FORMATS[String(format || 'mp3').toLowerCase().replace(/^\./, '')]
  if (!preset) return { ok: false, error: `不支持的目标格式：${format}` }
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    ...preset.args(bitrate),
    output,
  ]
  const result = await run(ffmpeg, args, { timeoutMs })
  if (result.code !== 0) {
    const detail = (result.stderr || result.error || '').trim().split('\n').slice(-3).join(' ')
    return { ok: false, error: detail.slice(0, 400) || 'ffmpeg 转码失败' }
  }
  const info = await stat(output).catch(() => null)
  if (!info?.isFile()) return { ok: false, error: 'ffmpeg 执行成功但没有找到输出文件' }
  const duration = await probeDuration(ffmpeg, output)
  return { ok: true, file: output, mime: preset.mime, bytes: info.size, duration }
}

/** 用 ffmpeg 读取时长（标准 ffmpeg 可执行文件自带解码器信息，无需 ffprobe）。 */
export async function probeDuration(ffmpeg, input) {
  const result = await run(ffmpeg, ['-hide_banner', '-i', input], { timeoutMs: 30000 })
  const text = `${result.stderr || ''} ${result.stdout || ''}`
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return 0
  return Math.round(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]))
}

/** 抽一帧当封面（可选，失败不致命）。 */
export async function extractCover(ffmpeg, input, output, { at = 1, width = 640 } = {}) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(Math.max(0, Number(at) || 0)),
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${Math.max(120, Number(width) || 640)}:-2`,
    output,
  ]
  const result = await run(ffmpeg, args, { timeoutMs: 120000 })
  return result.code === 0
}

/* ---------------- 编码探测 / 兼容转码（原画质下载后的「发得出去」保障） ---------------- */

/**
 * 从 `ffmpeg -i` 的输出里解析编码 / 分辨率 / 时长（纯函数，方便单测）。
 * 只取第一条视频 / 音频流：对 B站 DASH、抖音 MP4 足够用。
 */
export function parseMediaInfo(text) {
  const source = String(text || '')
  const streamName = kind => {
    const match = new RegExp(`Stream #\\d+:\\d+(?:\\([^)]*\\))?(?:\\[[^\\]]*\\])?:\\s*${kind}:\\s*([A-Za-z0-9_.\\-]+)`).exec(source)
    return match ? match[1].toLowerCase() : ''
  }
  const size = /,\s*(\d{2,5})x(\d{2,5})(?=[\s,[(]|$)/.exec(source)
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(source)
  return {
    vcodec: streamName('Video'),
    acodec: streamName('Audio'),
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    duration: duration
      ? Math.round(Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]))
      : 0,
  }
}

/** 用 ffmpeg（不需要 ffprobe）读取媒体信息。 */
export async function probeMedia(ffmpeg, input, { timeoutMs = 60000 } = {}) {
  const result = await run(ffmpeg, ['-hide_banner', '-i', input], { timeoutMs })
  const info = parseMediaInfo(`${result.stderr || ''}\n${result.stdout || ''}`)
  return { ok: !!(info.vcodec || info.acodec), ...info, error: result.error || '' }
}

/** H.264 + AAC 是 QQ / NapCat / 手机播放器兼容性最好的组合；有些流本身无音轨也算兼容。 */
export function isQqCompatibleVideo(info = {}) {
  const video = String(info.vcodec || '').toLowerCase()
  const audio = String(info.acodec || '').toLowerCase()
  if (video !== 'h264') return false
  return !audio || audio === 'aac' || audio === 'mp3'
}

/** 直接封装（不重编码）：H.264 + AAC 时用，秒级完成且不损画质。 */
export async function remuxVideo(ffmpeg, videoFile, audioFile, output, { timeoutMs = 600000 } = {}) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoFile, '-i', audioFile,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy', '-movflags', '+faststart', output,
  ]
  const result = await run(ffmpeg, args, { timeoutMs })
  if (result.code !== 0) {
    const detail = (result.stderr || result.error || '').trim().split('\n').slice(-3).join(' ')
    return { ok: false, error: detail.slice(0, 400) || 'ffmpeg 封装失败' }
  }
  const info = await stat(output).catch(() => null)
  if (!info?.isFile() || !info.size) return { ok: false, error: 'ffmpeg 执行成功但没有生成有效的 mp4 文件' }
  return { ok: true, file: output, bytes: info.size }
}

/**
 * 转码成 QQ / NapCat 能播的 H.264 + AAC。
 * maxHeight > 0 时按比例限制高度（不放大）：避免 4K AV1 / HEVC 转码把体积和耗时炸掉。
 */
export async function transcodeVideoH264(ffmpeg, inputs, output, {
  maxHeight = 1080,
  crf = 20,
  preset = 'veryfast',
  audioBitrate = '128k',
  timeoutMs = 1800000,
} = {}) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).filter(Boolean)
  if (!list.length) return { ok: false, error: '缺少转码输入文件' }
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  for (const input of list) args.push('-i', input)
  args.push('-map', '0:v:0')
  args.push('-map', list.length > 1 ? '1:a:0?' : '0:a:0?')
  args.push('-c:v', 'libx264', '-preset', String(preset), '-crf', String(crf), '-pix_fmt', 'yuv420p')
  const limit = Number(maxHeight) > 0 ? Math.round(Number(maxHeight)) : 0
  if (limit) args.push('-vf', `scale=-2:${limit}:force_original_aspect_ratio=decrease`)
  args.push('-c:a', 'aac', '-b:a', String(audioBitrate), '-movflags', '+faststart', '-sn', output)

  const result = await run(ffmpeg, args, { timeoutMs })
  if (result.code !== 0) {
    const detail = (result.stderr || result.error || '').trim().split('\n').slice(-3).join(' ')
    return { ok: false, error: detail.slice(0, 400) || 'ffmpeg 转码失败' }
  }
  const info = await stat(output).catch(() => null)
  if (!info?.isFile() || !info.size) return { ok: false, error: 'ffmpeg 执行成功但没有生成有效的 mp4 文件' }
  return { ok: true, file: output, bytes: info.size }
}
