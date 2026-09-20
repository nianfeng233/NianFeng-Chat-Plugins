/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · 媒体缓存（纯 Node 模块，可被 bridge 直接使用）
 *
 *   <数据目录>/media-post/media/<id>.<ext>   媒体原文件
 *   <数据目录>/media-post/media.json         索引（不含 base64，只有元信息）
 *
 * 缓存策略：按「条数 + 总体积 + 保留天数」三重上限清理最旧文件，避免硬盘无限增长。
 */
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const INDEX_FILE = 'media.json'
export const DEFAULT_KEEP = 200
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const DEFAULT_TTL_DAYS = 7

const queues = new Map()
const cache = new Map()

const trimSlash = value => String(value || '').replace(/[/\\]+$/, '')
const mediaDir = dataDir => join(trimSlash(dataDir) || '.', 'media-post', 'media')
const indexPath = dataDir => join(trimSlash(dataDir) || '.', 'media-post', INDEX_FILE)

const withQueue = (key, fn) => {
  const previous = queues.get(key) || Promise.resolve()
  const run = previous.catch(() => {}).then(fn)
  queues.set(key, run.catch(() => {}))
  return run
}

function stateFor(dataDir) {
  const key = trimSlash(dataDir) || '.'
  let state = cache.get(key)
  if (!state) {
    state = { records: null }
    cache.set(key, state)
  }
  return state
}

async function loadIndex(dataDir) {
  const state = stateFor(dataDir)
  if (state.records) return state.records
  try {
    const parsed = JSON.parse(await readFile(indexPath(dataDir), 'utf8'))
    state.records = parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object' ? parsed.items : {}
  } catch (_) {
    state.records = {}
  }
  return state.records
}

async function persistIndex(dataDir, records) {
  const dir = join(trimSlash(dataDir) || '.', 'media-post')
  await mkdir(dir, { recursive: true })
  const payload = JSON.stringify({ version: 1, updatedAt: Date.now(), items: records }, null, 2)
  const tmp = `${indexPath(dataDir)}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, indexPath(dataDir))
}

const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const pickExt = (meta = {}) => {
  const explicit = String(meta.ext || '').replace(/^\./, '').toLowerCase()
  if (/^[a-z0-9]{1,8}$/.test(explicit)) return explicit
  const byMime = MIME_EXT[String(meta.mime || '').toLowerCase().split(';')[0].trim()]
  if (byMime) return byMime
  return 'bin'
}

export function newId(prefix = 'mp') {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

export function newSecret() {
  return randomBytes(16).toString('hex')
}

/** 索引里的私密字段不外传（secret 只给需要拉文件的内部调用）。 */
export function publicRecord(record) {
  if (!record) return null
  const { secret, ...rest } = record
  return { ...rest }
}

/** 把一份 buffer 落盘成媒体文件，返回完整 record（含 secret）。 */
export async function saveBuffer(dataDir, buffer, meta = {}) {
  if (!buffer?.length) throw Object.assign(new Error('媒体内容为空'), { status: 400 })
  const key = trimSlash(dataDir) || '.'
  return withQueue(key, async () => {
    const records = await loadIndex(dataDir)
    const id = String(meta.id || '').trim() || newId(meta.kind === 'image' ? 'img' : meta.kind === 'audio' ? 'aud' : 'vid')
    const ext = pickExt(meta)
    const file = `${id}.${ext}`
    await mkdir(mediaDir(dataDir), { recursive: true })
    const target = join(mediaDir(dataDir), file)
    const tmp = `${target}.${process.pid}.tmp`
    await writeFile(tmp, buffer)
    await rename(tmp, target)
    const record = {
      id,
      kind: ['video', 'audio', 'image', 'file'].includes(meta.kind) ? meta.kind : 'file',
      file,
      ext,
      mime: String(meta.mime || 'application/octet-stream'),
      size: buffer.length,
      title: String(meta.title || '').slice(0, 300),
      author: String(meta.author || '').slice(0, 120),
      duration: Math.max(0, Math.round(Number(meta.duration) || 0)),
      source: String(meta.source || ''),
      platformId: String(meta.platformId || ''),
      sourceUrl: String(meta.sourceUrl || ''),
      cover: String(meta.cover || ''),
      secret: String(meta.secret || newSecret()),
      variants: meta.variants && typeof meta.variants === 'object' ? meta.variants : {},
      meta: meta.meta && typeof meta.meta === 'object' ? meta.meta : {},
      createdAt: Date.now(),
    }
    records[id] = record
    await persistIndex(dataDir, records)
    return record
  })
}

/** 把外部临时文件（yt-dlp 下载产物）搬进媒体库（同盘优先 rename，避免大视频进内存）。 */
export async function saveFile(dataDir, sourcePath, meta = {}) {
  const info = await stat(sourcePath).catch(() => null)
  if (!info?.isFile()) throw Object.assign(new Error('下载文件不存在'), { status: 404 })
  const key = trimSlash(dataDir) || '.'
  return withQueue(key, async () => {
    const records = await loadIndex(dataDir)
    const id = String(meta.id || '').trim() || newId(meta.kind === 'image' ? 'img' : meta.kind === 'audio' ? 'aud' : 'vid')
    const ext = pickExt(meta)
    const file = `${id}.${ext}`
    await mkdir(mediaDir(dataDir), { recursive: true })
    const target = join(mediaDir(dataDir), file)
    try {
      await rename(sourcePath, target)
    } catch (_) {
      // 跨盘 / 权限问题时退回读内存再写。
      await writeFile(target, await readFile(sourcePath))
      await unlink(sourcePath).catch(() => {})
    }
    const record = {
      id,
      kind: ['video', 'audio', 'image', 'file'].includes(meta.kind) ? meta.kind : 'file',
      file,
      ext,
      mime: String(meta.mime || 'application/octet-stream'),
      size: info.size,
      title: String(meta.title || '').slice(0, 300),
      author: String(meta.author || '').slice(0, 120),
      duration: Math.max(0, Math.round(Number(meta.duration) || 0)),
      source: String(meta.source || ''),
      platformId: String(meta.platformId || ''),
      sourceUrl: String(meta.sourceUrl || ''),
      cover: String(meta.cover || ''),
      secret: String(meta.secret || newSecret()),
      variants: meta.variants && typeof meta.variants === 'object' ? meta.variants : {},
      meta: meta.meta && typeof meta.meta === 'object' ? meta.meta : {},
      createdAt: Date.now(),
    }
    records[id] = record
    await persistIndex(dataDir, records)
    return record
  })
}

export async function getRecord(dataDir, id) {
  const records = await loadIndex(dataDir)
  return records[String(id || '').trim()] || null
}

/** 读取 record 对应的文件内容。 */
export async function readRecord(dataDir, id) {
  const record = await getRecord(dataDir, id)
  if (!record?.file) return null
  try {
    return { record, buffer: await readFile(join(mediaDir(dataDir), record.file)) }
  } catch (_) {
    return null
  }
}

export async function removeRecord(dataDir, id) {
  const key = trimSlash(dataDir) || '.'
  return withQueue(key, async () => {
    const records = await loadIndex(dataDir)
    const record = records[String(id || '').trim()]
    if (!record) return false
    delete records[record.id]
    await unlink(join(mediaDir(dataDir), record.file)).catch(() => {})
    await persistIndex(dataDir, records)
    return true
  })
}

/** 更新索引里的字段（例如给源记录登记变体）。 */
export async function patchRecord(dataDir, id, patch = {}) {
  const key = trimSlash(dataDir) || '.'
  return withQueue(key, async () => {
    const records = await loadIndex(dataDir)
    const record = records[String(id || '').trim()]
    if (!record) return null
    const next = { ...record, ...patch }
    records[next.id] = next
    await persistIndex(dataDir, records)
    return next
  })
}

export async function listRecords(dataDir, { limit = 100 } = {}) {
  const records = await loadIndex(dataDir)
  return Object.values(records)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)))
}

export async function cacheStats(dataDir) {
  const records = await loadIndex(dataDir)
  const items = Object.values(records)
  return {
    count: items.length,
    bytes: items.reduce((sum, item) => sum + (Number(item.size) || 0), 0),
    createdAt: items.reduce((min, item) => (min === 0 || (item.createdAt || 0) < min ? item.createdAt || 0 : min), 0),
  }
}

/**
 * 清理：先按保留天数，再按总量上限，最后按条数上限，最旧的优先删除。
 * @returns {{ removed:number, count:number, bytes:number }}
 */
export async function prune(dataDir, { keep = DEFAULT_KEEP, maxBytes = DEFAULT_MAX_BYTES, ttlDays = DEFAULT_TTL_DAYS } = {}) {
  const key = trimSlash(dataDir) || '.'
  return withQueue(key, async () => {
    const records = await loadIndex(dataDir)
    const now = Date.now()
    const maxAge = Math.max(0, Number(ttlDays) || 0) * 24 * 3600 * 1000
    const keepLimit = Math.max(1, Number(keep) || DEFAULT_KEEP)
    const sizeLimit = Math.max(0, Number(maxBytes) || DEFAULT_MAX_BYTES)

    let items = Object.values(records).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    const remove = new Set()
    if (maxAge > 0) {
      for (const item of items) if (now - (item.createdAt || 0) > maxAge) remove.add(item.id)
    }

    let total = items.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
    for (const item of items) {
      if (total <= sizeLimit && items.length - remove.size <= keepLimit) break
      if (remove.has(item.id)) continue
      remove.add(item.id)
      total -= Number(item.size) || 0
    }

    for (const id of remove) {
      const record = records[id]
      if (!record) continue
      delete records[id]
      await unlink(join(mediaDir(dataDir), record.file)).catch(() => {})
    }
    if (remove.size) await persistIndex(dataDir, records)
    const rest = Object.values(records)
    return { removed: remove.size, count: rest.length, bytes: rest.reduce((sum, item) => sum + (Number(item.size) || 0), 0) }
  })
}

/** 供测试 / 维护使用：清空缓存目录。 */
export async function clearAll(dataDir) {
  const key = trimSlash(dataDir) || '.'
  return withQueue(key, async () => {
    await rm(join(trimSlash(dataDir) || '.', 'media-post'), { recursive: true, force: true }).catch(() => {})
    cache.delete(key)
    return true
  })
}
