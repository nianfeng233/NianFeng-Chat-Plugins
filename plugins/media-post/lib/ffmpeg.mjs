/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · ffmpeg 封装（只做我们需要的几件事：抽音频 / 转 mp3、amr / 探时长）
 */
import { stat } from 'node:fs/promises'
import { run } from './tools.mjs'

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
