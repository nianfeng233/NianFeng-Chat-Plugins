/*
 * 念风chat · 扩展插件 · napcat-group-guard 纯 Node 档案图兜底渲染器
 *
 * 给「服务端代聊 / headless」实例用。render-server.mjs 优先调用
 * PowerShell + System.Drawing 生成完整档案图；如果当前环境不允许
 * 拉起子进程（EPERM / ENOENT / 被安全软件拦截），这里用 Node 内置的
 * zlib 直接编码一张 PNG，保证服务端仍然有图可发，不会把事件让给
 * 必须常驻的 WebUI 页面。
 *
 * 约束：
 *   - 只用 node:zlib，不引入第三方包；
 *   - 不解析字体文件、不拉取外部资源，因此昵称 / 群名只渲染 ASCII，
 *     中文会被跳过；完整中文信息仍在群消息文本里。
 *   - 输出的 PNG 是标准 8bit RGBA，NapCat / QQ 可直接接收 base64://。
 */
import { deflateSync } from 'node:zlib'

const WIDTH = 760
const HEIGHT = 486

const COLOR = {
  bg: [11, 18, 32],
  panel: [17, 28, 49],
  panelDeep: [9, 15, 27],
  ink: [226, 232, 240],
  muted: [148, 163, 184],
  teal: [94, 234, 212],
  blue: [96, 165, 250],
  amber: [251, 191, 36],
  red: [248, 113, 113],
}

/** 3x5 点阵字体：够画 QQ 号、事件标签和 ASCII 昵称，代码量小且不会乱码。 */
const FONT_3X5 = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  A: ['010', '101', '111', '101', '101'],
  B: ['110', '101', '110', '101', '110'],
  C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'],
  H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
  J: ['001', '001', '001', '101', '010'],
  K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['101', '111', '111', '111', '101'],
  O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'],
  Q: ['010', '101', '101', '111', '011'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'],
  V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'],
  X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  Z: ['111', '001', '010', '100', '111'],
  ' ': ['000', '000', '000', '000', '000'],
  '-': ['000', '000', '111', '000', '000'],
  '_': ['000', '000', '000', '000', '111'],
  '.': ['000', '000', '000', '000', '010'],
  ':': ['000', '010', '000', '010', '000'],
  '/': ['001', '001', '010', '100', '100'],
  '?': ['110', '001', '010', '000', '010'],
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

class TinyCanvas {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.data = Buffer.alloc(width * height * 4)
  }

  fillRect(x, y, width, height, color) {
    const [r, g, b] = color
    const left = Math.max(0, Math.floor(x))
    const top = Math.max(0, Math.floor(y))
    const right = Math.min(this.width, Math.ceil(x + width))
    const bottom = Math.min(this.height, Math.ceil(y + height))
    for (let py = top; py < bottom; py += 1) {
      let offset = (py * this.width + left) * 4
      for (let px = left; px < right; px += 1) {
        this.data[offset] = r
        this.data[offset + 1] = g
        this.data[offset + 2] = b
        this.data[offset + 3] = 255
        offset += 4
      }
    }
  }

  strokeRect(x, y, width, height, thickness, color) {
    this.fillRect(x, y, width, thickness, color)
    this.fillRect(x, y + height - thickness, width, thickness, color)
    this.fillRect(x, y, thickness, height, color)
    this.fillRect(x + width - thickness, y, thickness, height, color)
  }

  drawGlyph(char, x, y, scale, color) {
    const glyph = FONT_3X5[char] || FONT_3X5['?']
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === '1') {
          this.fillRect(x + col * scale, y + row * scale, scale, scale, color)
        }
      }
    }
  }

  drawText(text, x, y, scale, color, { spacing = 1 } = {}) {
    let cursor = x
    for (const raw of String(text ?? '')) {
      const char = raw.toUpperCase()
      this.drawGlyph(char, cursor, y, scale, color)
      cursor += (3 + spacing) * scale
    }
    return cursor - spacing * scale
  }

  textWidth(text, scale, { spacing = 1 } = {}) {
    const length = [...String(text ?? '')].length
    if (!length) return 0
    return (length * 3 + (length - 1) * spacing) * scale
  }

  toPng() {
    const stride = this.width * 4
    const raw = Buffer.alloc((stride + 1) * this.height)
    for (let y = 0; y < this.height; y += 1) {
      raw[y * (stride + 1)] = 0
      this.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.width, 0)
    ihdr.writeUInt32BE(this.height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // color type: RGBA
    ihdr[10] = 0 // compression
    ihdr[11] = 0 // filter
    ihdr[12] = 0 // interlace
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    return Buffer.concat([
      signature,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
  }
}

/** 只保留点阵字体支持的 ASCII；中文与不支持的符号直接丢弃，避免变成一串问号。 */
function asciiOnly(value, max = 24) {
  return [...String(value ?? '')]
    .filter(char => /[\x20-\x7e]/.test(char) && FONT_3X5[char.toUpperCase()])
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .toUpperCase()
}

function accentOf(eventType) {
  const type = String(eventType || 'join').toLowerCase()
  if (type === 'leave') return COLOR.amber
  if (type === 'kick' || type === 'blacklist' || type === 'cleanup') return COLOR.red
  if (type === 'request') return COLOR.blue
  return COLOR.teal
}

function eventLabelOf(eventType) {
  const type = String(eventType || 'join').toLowerCase()
  if (type === 'leave') return 'LEAVE'
  if (type === 'kick' || type === 'blacklist' || type === 'cleanup') return 'KICK'
  if (type === 'request') return 'REQUEST'
  return 'JOIN'
}

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? String(Math.max(0, Math.floor(number))) : ''
}

/**
 * 渲染一张纯 Node 档案图。
 * @param {object} payload { profile, eventType, groupName }
 * @returns {{ok:true,renderer:string,mime:string,bytes:number,base64:string,dataUrl:string}|{ok:false,code:string,error:string}}
 */
export function renderNodeDossierCard(payload = {}) {
  try {
    const profile = payload?.profile && typeof payload.profile === 'object' ? payload.profile : {}
    const canvas = new TinyCanvas(WIDTH, HEIGHT)
    const accent = accentOf(payload.eventType)

    canvas.fillRect(0, 0, WIDTH, HEIGHT, COLOR.bg)
    canvas.fillRect(22, 22, WIDTH - 44, HEIGHT - 44, COLOR.panel)
    canvas.strokeRect(22, 22, WIDTH - 44, HEIGHT - 44, 3, accent)
    canvas.fillRect(22, 22, WIDTH - 44, 8, accent)

    canvas.drawText('PROFILE DOSSIER', 46, 44, 2, accent)
    canvas.drawText(eventLabelOf(payload.eventType), 652, 42, 3, accent)

    // 头像占位：没有字体/图片解码能力，画一个带 Q 的色块，保证卡片不是空白。
    canvas.fillRect(46, 100, 148, 148, [15, 118, 110])
    canvas.strokeRect(46, 100, 148, 148, 2, accent)
    canvas.drawGlyph('Q', 108, 148, 19, COLOR.ink)

    const qq = safeNumber(profile.qq)
    const qqText = qq ? `QQ ${qq}` : 'QQ UNKNOWN'
    canvas.drawText(qqText, 226, 108, 7, COLOR.ink)

    const nickname = asciiOnly(profile.nickname, 18)
    if (nickname) {
      canvas.drawText(nickname, 226, 178, 4, COLOR.muted)
    } else {
      canvas.fillRect(226, 182, 360, 18, COLOR.muted)
    }

    const levelText = profile.level === undefined || profile.level === null ? 'LEVEL HIDDEN' : `LEVEL ${safeNumber(profile.level)}`
    canvas.drawText(levelText, 226, 232, 3, accent)
    canvas.drawText(profile.vip ? `VIP ${safeNumber(profile.vipLevel) || ''}`.trim() : 'VIP NONE', 470, 232, 3, COLOR.muted)

    const signature = asciiOnly(profile.signature, 40)
    if (signature) canvas.drawText(signature, 226, 274, 2, COLOR.muted)

    const groupName = asciiOnly(payload.groupName, 22)
    if (groupName) canvas.drawText(`GROUP ${groupName}`, 46, 300, 2, COLOR.muted)

    canvas.fillRect(46, 330, WIDTH - 92, 108, COLOR.panelDeep)
    canvas.drawText('SERVER RENDERED DOSSIER', 64, 348, 3, accent)
    canvas.drawText(qqText, 64, 390, 3, COLOR.ink)
    const member = profile.member && typeof profile.member === 'object' ? profile.member : null
    const joinText = asciiOnly(member?.join_time, 30)
    if (joinText) canvas.drawText(`JOIN ${joinText}`, 420, 390, 2, COLOR.muted)

    canvas.drawText('NIANFENG GROUP GUARD', 46, 452, 2, COLOR.muted)

    const buffer = canvas.toPng()
    const base64 = buffer.toString('base64')
    return {
      ok: true,
      renderer: 'node-png-fallback',
      mime: 'image/png',
      bytes: buffer.length,
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
    }
  } catch (err) {
    return {
      ok: false,
      code: 'NODE_RENDER_FAILED',
      error: `纯 Node 档案图渲染失败：${err?.message || err}`,
    }
  }
}
