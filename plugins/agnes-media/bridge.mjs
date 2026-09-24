/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * agnes-media · 后端桥（独立扩展版本）。
 *
 * 功能：
 *   - Agnes API Key / 国际站 / 国内站 / 插件专属代理的安全存储；
 *   - GET  /api/agnes-media/models          自动获取模型列表并按图片 / 视频分类；
 *   - POST /api/agnes-media/tasks/image     挂载图片生成任务（后台执行，立刻返回 task_id）；
 *   - POST /api/agnes-media/tasks/video     挂载视频生成任务（后台轮询 Agnes 异步任务）；
 *   - GET  /api/agnes-media/tasks           查询任务列表 / 恢复未完成轮询；
 *   - GET  /api/agnes-media/tasks/:id       查询单个任务，必要时向上游刷新一次；
 *   - POST /api/agnes-media/tasks/:id/claim 原子占用“自动发送”资格，避免网页与代聊重复发；
 *   - POST /api/agnes-media/tasks/:id/sent  回写自动发送结果；
 *   - GET  /api/agnes-media/files/:name     回传已下载到本地的生成结果。
 *
 * 所有出网请求都按插件配置的代理走；参考图会先下载成 Data URI，
 * 避免 Agnes 服务端访问不到带防盗链 / 需要登录态的图源。
 */
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { dirname, extname, join } from 'node:path'
import { classifyModelList, catalogPayload, IMAGE_FALLBACK_MODELS, VIDEO_FALLBACK_MODELS, KNOWN_MODELS, normalizeModelId } from './lib/catalog.mjs'
import {
  aspectRatioOptions,
  buildImagePayload,
  buildVideoPayload,
  buildVideoQueryUrl,
  imageSizeOptions,
  isFailedStatus,
  isV25VideoModel,
  isV2VideoModel,
  normalizeBaseUrl,
  normalizeVideoState,
  isCompletedStatus,
  originFromBase,
  videoModeOptions,
  videoSizeOptions,
} from './lib/agnes-api.mjs'
import { downloadToFile, isImageContentType, requestBuffer, requestJson } from './lib/http.mjs'

export const name = 'agnes-media-bridge'
export const version = '1.0.0'
export const build = '2026-09-24-1'
export const displayName = 'Agnes 生图 / 生视频后端桥'
export const description = 'Agnes 图像 / 视频模型接入 · 后台异步任务 · 插件专属代理 · 模型列表与免费状态标注'
export const core = false
export const inject = ['settings', 'httpApi']
export const provides = [{ name: 'agnes-media', type: 'singleton' }]

const ENC_PREFIX = 'enc:v1:'
const STATE_FILE = 'agnes-media.json'
const FILE_DIR = 'agnes-media'
const MAX_TASKS = 200
const MODELS_CACHE_MS = 5 * 60 * 1000
const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1'
const CN_BASE_URL = 'https://apihub.agnes-ai.cn/v1'

const DEFAULT_CONFIG = {
  apiKey: '',
  baseUrl: DEFAULT_BASE_URL,
  basePreset: 'international',
  proxy: '',
  imageModel: 'agnes-image-2.5-flash',
  imageModelMode: 'select',
  videoModel: 'agnes-video-2.5-flash',
  videoModelMode: 'select',
  imageSize: '2K',
  imageRatio: '1:1',
  imageResponseFormat: 'url',
  videoSize: '720P',
  videoAspect: '16:9',
  videoSeconds: '5',
  videoMode: 'text',
  autoSend: true,
  autoDownload: true,
  imageTimeoutMs: 360000,
  videoTimeoutMs: 30 * 60 * 1000,
  videoPollMs: 3000,
  maxConcurrent: 2,
  maxImageMB: 25,
  maxVideoMB: 300,
  maxReferenceMB: 12,
  maxReferenceTotalMB: 40,
  referenceFallbackRemote: true,
  allowPrivateNetwork: false,
}

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  json: 'application/json; charset=utf-8',
}

function fail(code, error, hint = '') {
  return { ok: false, code, error, ...(hint ? { hint } : {}) }
}

function clean(value, fallback = '') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

function maskSecret(value) {
  const text = String(value || '')
  if (!text) return ''
  if (text.length <= 8) return `${text.slice(0, 2)}****`
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

function fileDataToUrl(fileName) {
  return `/api/agnes-media/files/${encodeURIComponent(fileName)}`
}

function extFromMime(mime, fallback = 'png') {
  const value = String(mime || '').toLowerCase()
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg'
  if (value.includes('webp')) return 'webp'
  if (value.includes('gif')) return 'gif'
  if (value.includes('avif')) return 'avif'
  if (value.includes('bmp')) return 'bmp'
  if (value.includes('svg')) return 'svg'
  if (value.includes('mp4')) return 'mp4'
  if (value.includes('webm')) return 'webm'
  if (value.includes('quicktime')) return 'mov'
  return fallback
}

function mimeFromExt(ext) {
  return MIME[String(ext || '').toLowerCase().replace(/^\./, '')] || 'application/octet-stream'
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function isDataUrl(value) {
  return /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=+-]+)*,/i.test(String(value || '').trim())
}

function dataUrlByteLength(value) {
  const text = String(value || '')
  const comma = text.indexOf(',')
  if (comma < 0) return 0
  const payload = text.slice(comma + 1)
  if (/;base64,/i.test(text.slice(0, comma + 1))) {
    const cleanBase64 = payload.replace(/\s+/g, '')
    return Math.floor((cleanBase64.length * 3) / 4)
  }
  return Buffer.byteLength(decodeURIComponent(payload), 'utf8')
}

function logTask(ctx, task, message) {
  const line = `${new Date().toISOString()} ${message}`
  task.log = [...(Array.isArray(task.log) ? task.log : []), line].slice(-30)
  ctx.logger?.debug?.(`[agnes-media] ${task.id} ${message}`)
}

export function apply(ctx) {
  const settings = ctx.settings
  const httpApi = ctx.httpApi

  const state = {
    version: 1,
    config: { ...DEFAULT_CONFIG },
    tasks: [],
  }
  const tasks = new Map()
  const running = new Set()
  const pollLocks = new Map()
  let secretKey = null
  let readyResolve
  const ready = new Promise(resolve => {
    readyResolve = resolve
  })
  let persistTimer = null
  let persistChain = Promise.resolve()
  let closed = false
  let modelsCache = { at: 0, payload: null }
  let lastPumpError = ''

  const dataDir = () => settings.dataDir || process.cwd()
  const baseDir = () => join(dataDir(), FILE_DIR)
  const filesDir = () => join(baseDir(), 'files')
  const statePath = () => join(dataDir(), STATE_FILE)
  const keyPath = () => join(dataDir(), '.secret-key')

  /* ---------------- 加密 / 持久化 ---------------- */

  const encrypt = plain => {
    const value = String(plain ?? '')
    if (!value || !secretKey) return value
    if (value.startsWith(ENC_PREFIX)) return value
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secretKey, iv)
    const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `${ENC_PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${payload.toString('base64')}`
  }

  const decrypt = stored => {
    const value = String(stored ?? '')
    if (!value || !value.startsWith(ENC_PREFIX)) return value
    if (!secretKey) return ''
    try {
      const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split(':')
      const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
    } catch (_) {
      ctx.logger.warn('[agnes-media] API Key 解密失败，请在设置页重新填写')
      return ''
    }
  }

  const ensureSecret = async () => {
    try {
      const raw = (await readFile(keyPath(), 'utf8')).trim()
      const key = Buffer.from(raw, 'base64')
      if (key.length === 32) return key
    } catch (_) {
      /* 文件不存在或损坏：重建 */
    }
    const key = randomBytes(32)
    await mkdir(dataDir(), { recursive: true })
    await writeFile(keyPath(), key.toString('base64'), 'utf8')
    await chmod(keyPath(), 0o600).catch(() => {})
    return key
  }

  const publicTask = task => {
    if (!task) return null
    const result = task.result || null
    return {
      id: task.id,
      kind: task.kind,
      status: task.status,
      progress: Number(task.progress) || 0,
      model: task.model,
      prompt: task.prompt,
      options: task.options || {},
      target: {
        conversation_id: task.conversationId || '',
        channel_id: task.channelId || '',
      },
      auto_send: task.autoSend !== false,
      caption: task.caption || '',
      reference_count: Number(task.referenceCount) || 0,
      reference_warnings: Array.isArray(task.referenceWarnings) ? task.referenceWarnings.slice(0, 4) : [],
      upstream: {
        video_id: task.upstream?.videoId || '',
        task_id: task.upstream?.taskId || '',
      },
      result: result
        ? {
            remote_url: result.remoteUrl || '',
            local_url: result.localUrl || '',
            file: result.file || '',
            mime: result.mime || '',
            bytes: Number(result.bytes) || 0,
            width: Number(result.width) || 0,
            height: Number(result.height) || 0,
          }
        : null,
      error: task.error || '',
      created_at: Number(task.createdAt) || 0,
      updated_at: Number(task.updatedAt) || 0,
      started_at: Number(task.startedAt) || 0,
      finished_at: Number(task.finishedAt) || 0,
      send: {
        claimed: !!task.send?.claimId,
        claimed_by: task.send?.claimId || '',
        sent_at: Number(task.send?.sentAt) || 0,
        message_ids: Array.isArray(task.send?.messageIds) ? task.send.messageIds : [],
        attempts: Number(task.send?.attempts) || 0,
        last_error: task.send?.lastError || '',
      },
    }
  }

  const schedulePersist = () => {
    if (closed || persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistState().catch(error => ctx.logger.warn(`[agnes-media] 状态写入失败：${error.message}`))
    }, 350)
  }

  const serializeTask = task => ({
    id: task.id,
    kind: task.kind,
    status: task.status,
    progress: Number(task.progress) || 0,
    model: task.model,
    prompt: task.prompt,
    options: task.options || {},
    conversationId: task.conversationId || '',
    channelId: task.channelId || '',
    roleId: task.roleId || '',
    userId: task.userId || '',
    userName: task.userName || '',
    caption: task.caption || '',
    autoSend: task.autoSend !== false,
    referenceCount: Number(task.referenceCount) || 0,
    referenceWarnings: Array.isArray(task.referenceWarnings) ? task.referenceWarnings.slice(0, 8) : [],
    upstream: task.upstream ? { ...task.upstream } : null,
    result: task.result ? { ...task.result } : null,
    error: task.error || '',
    createdAt: Number(task.createdAt) || 0,
    updatedAt: Number(task.updatedAt) || 0,
    startedAt: Number(task.startedAt) || 0,
    finishedAt: Number(task.finishedAt) || 0,
    lastPollAt: Number(task.lastPollAt) || 0,
    send: {
      claimId: task.send?.claimId || '',
      claimedAt: Number(task.send?.claimedAt) || 0,
      sentAt: Number(task.send?.sentAt) || 0,
      messageIds: Array.isArray(task.send?.messageIds) ? task.send.messageIds : [],
      attempts: Number(task.send?.attempts) || 0,
      lastError: task.send?.lastError || '',
    },
    log: Array.isArray(task.log) ? task.log.slice(-12) : [],
  })

  const persistState = () => {
    const task = async () => {
      await mkdir(dataDir(), { recursive: true })
      const list = [...tasks.values()]
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .slice(0, MAX_TASKS)
        .map(serializeTask)
      const payload = {
        version: 1,
        updatedAt: Date.now(),
        config: { ...state.config, apiKey: encrypt(state.config.apiKey) },
        tasks: list,
      }
      const tmp = `${statePath()}.${process.pid}.${Date.now().toString(36)}.tmp`
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tmp, statePath())
      await chmod(statePath(), 0o600).catch(() => {})
    }
    persistChain = persistChain.then(task, task)
    return persistChain
  }

  const loadState = async () => {
    await mkdir(dataDir(), { recursive: true })
    secretKey = await ensureSecret()
    let raw = null
    try {
      raw = JSON.parse(await readFile(statePath(), 'utf8'))
    } catch (_) {
      raw = null
    }
    if (raw?.config && typeof raw.config === 'object') {
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (raw.config[key] !== undefined) state.config[key] = raw.config[key]
      }
    }
    state.config.apiKey = decrypt(String(raw?.config?.apiKey || ''))
    state.config.baseUrl = normalizeBaseUrl(state.config.baseUrl || DEFAULT_BASE_URL)
    if (!['international', 'china', 'custom'].includes(state.config.basePreset)) state.config.basePreset = 'international'

    for (const item of Array.isArray(raw?.tasks) ? raw.tasks : []) {
      if (!item?.id) continue
      const task = {
        ...item,
        referenceCount: Number(item.referenceCount) || 0,
        referenceWarnings: Array.isArray(item.referenceWarnings) ? item.referenceWarnings : [],
        result: item.result ? { ...item.result } : null,
        upstream: item.upstream ? { ...item.upstream } : null,
        send: {
          claimId: item.send?.claimId || '',
          claimedAt: Number(item.send?.claimedAt) || 0,
          sentAt: Number(item.send?.sentAt) || 0,
          messageIds: Array.isArray(item.send?.messageIds) ? item.send.messageIds : [],
          attempts: Number(item.send?.attempts) || 0,
          lastError: item.send?.lastError || '',
        },
      }
      tasks.set(task.id, task)
    }
  }

  const trimTasks = () => {
    if (tasks.size <= MAX_TASKS) return
    const list = [...tasks.values()].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    for (const task of list.slice(MAX_TASKS)) {
      if (task.kind === 'video' && ['queued', 'running'].includes(task.status)) continue
      tasks.delete(task.id)
    }
  }

  const touchTask = (task, patch = {}) => {
    Object.assign(task, patch, { updatedAt: Date.now() })
    schedulePersist()
    return task
  }

  /* ---------------- 代理 / Agnes API ---------------- */

  const effectiveProxy = () => clean(state.config.proxy) || clean(settings.get?.()?.network?.proxy)

  const proxyHint = () => {
    if (state.config.proxy) return '使用插件专属代理。'
    const globalProxy = clean(settings.get?.()?.network?.proxy)
    return globalProxy ? `未单填插件代理，跟随全局：${globalProxy}` : '未配置代理，将直连 Agnes。'
  }

  const authHeaders = () => ({
    Authorization: `Bearer ${state.config.apiKey}`,
    'Content-Type': 'application/json',
  })

  const agnesRequest = async (path, options = {}) => {
    const base = normalizeBaseUrl(state.config.baseUrl)
    return requestJson(`${base}${path}`, {
      method: options.method || 'GET',
      headers: { ...authHeaders(), ...(options.headers || {}) },
      body: options.body,
      timeoutMs: options.timeoutMs || 60000,
      proxy: effectiveProxy(),
      trusted: true,
      maxBytes: options.maxBytes || 4 * 1024 * 1024,
      maxRedirects: options.maxRedirects || 3,
    })
  }

  const fetchModels = async ({ force = false } = {}) => {
    if (!force && modelsCache.payload && Date.now() - modelsCache.at < MODELS_CACHE_MS) return modelsCache.payload
    const fallback = {
      ok: false,
      code: 'MODELS_UNAVAILABLE',
      error: '尚未刷新模型列表，先展示内置目录；可点「刷新模型列表」或手动填写模型名。',
      ...catalogPayload(),
      fetched: false,
    }
    if (!state.config.apiKey) {
      const payload = { ...fallback, code: 'NO_API_KEY', error: '尚未填写 Agnes API Key，先展示内置模型目录；配置后可以自动获取账户可用模型。' }
      modelsCache = { at: Date.now(), payload }
      return payload
    }
    try {
      const response = await agnesRequest('/models', { timeoutMs: 30000, maxBytes: 2 * 1024 * 1024 })
      const list = Array.isArray(response.data?.data)
        ? response.data.data
        : Array.isArray(response.data?.models)
          ? response.data.models
          : Array.isArray(response.data)
            ? response.data
            : []
      const ids = list.map(item => normalizeModelId(typeof item === 'string' ? item : item?.id || item?.name)).filter(Boolean)
      const classified = classifyModelList(ids)
      const payload = {
        ok: true,
        error: '',
        fetched: true,
        fetched_at: Date.now(),
        total: classified.all.length,
        ...classified,
        ...catalogPayload(),
        models: classified.all,
        imageOptions: classified.imageOptions,
        videoOptions: classified.videoOptions,
        imageFallback: IMAGE_FALLBACK_MODELS.map(id => ({ id, ...KNOWN_MODELS[id], freeLabel: KNOWN_MODELS[id].free ? '免费' : '付费' })),
        videoFallback: VIDEO_FALLBACK_MODELS.map(id => ({ id, ...KNOWN_MODELS[id], freeLabel: KNOWN_MODELS[id].free ? '免费' : '付费' })),
      }
      modelsCache = { at: Date.now(), payload }
      return payload
    } catch (error) {
      ctx.logger.warn(`[agnes-media] 获取模型列表失败：${error.message}`)
      const payload = {
        ...fallback,
        error: `自动获取模型列表失败：${error.message}`,
        code: error?.status === 401 ? 'INVALID_API_KEY' : 'MODELS_FETCH_FAILED',
        status: Number(error?.status) || 0,
      }
      modelsCache = { at: Date.now(), payload }
      return payload
    }
  }

  const statusPayload = async () => {
    const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
    for (const task of tasks.values()) {
      if (counts[task.status] !== undefined) counts[task.status] += 1
    }
    return {
      ok: true,
      configured: !!state.config.apiKey,
      apiKey: { configured: !!state.config.apiKey, mask: maskSecret(state.config.apiKey) },
      base: {
        baseUrl: state.config.baseUrl,
        basePreset: state.config.basePreset,
        presets: { international: DEFAULT_BASE_URL, china: CN_BASE_URL },
      },
      proxy: { value: state.config.proxy, effective: effectiveProxy(), hint: proxyHint() },
      settings: {
        imageModel: state.config.imageModel,
        imageModelMode: state.config.imageModelMode,
        videoModel: state.config.videoModel,
        videoModelMode: state.config.videoModelMode,
        imageSize: state.config.imageSize,
        imageRatio: state.config.imageRatio,
        imageResponseFormat: state.config.imageResponseFormat,
        videoSize: state.config.videoSize,
        videoAspect: state.config.videoAspect,
        videoSeconds: state.config.videoSeconds,
        videoMode: state.config.videoMode,
        autoSend: state.config.autoSend !== false,
        autoDownload: state.config.autoDownload !== false,
        videoPollMs: Number(state.config.videoPollMs) || 3000,
        imageTimeoutMs: Number(state.config.imageTimeoutMs) || 360000,
        videoTimeoutMs: Number(state.config.videoTimeoutMs) || 30 * 60 * 1000,
        maxConcurrent: Number(state.config.maxConcurrent) || 2,
        maxImageMB: Number(state.config.maxImageMB) || 25,
        maxVideoMB: Number(state.config.maxVideoMB) || 300,
        maxReferenceMB: Number(state.config.maxReferenceMB) || 12,
        referenceFallbackRemote: state.config.referenceFallbackRemote !== false,
        allowPrivateNetwork: state.config.allowPrivateNetwork === true,
      },
      options: {
        imageSizes: imageSizeOptions(),
        ratios: aspectRatioOptions(),
        videoSizes: videoSizeOptions(state.config.videoModel),
        videoModes: videoModeOptions(),
      },
      catalog: catalogPayload(),
      modelsCache: modelsCache.payload
        ? { fetched: true, total: modelsCache.payload.total || 0, fetchedAt: modelsCache.at }
        : { fetched: false, total: 0, fetchedAt: 0 },
      counts,
      running: running.size,
      recentTasks: [...tasks.values()]
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .slice(0, 20)
        .map(publicTask),
    }
  }

  /* ---------------- 参考图处理 ---------------- */

  const materializeReferences = async task => {
    const rawReferences = Array.isArray(task.references) ? task.references.filter(Boolean) : []
    const maxBytes = clampNumber(state.config.maxReferenceMB, 1, 50, 12) * 1024 * 1024
    const maxTotalBytes = clampNumber(state.config.maxReferenceTotalMB, 1, 200, 40) * 1024 * 1024
    let totalBytes = 0
    const out = []
    const warnings = []
    for (let index = 0; index < rawReferences.length; index += 1) {
      const raw = String(rawReferences[index] || '').trim()
      if (!raw) continue
      if (isDataUrl(raw)) {
        if (!/^data:image\//i.test(raw)) {
          warnings.push(`第 ${index + 1} 张参考图不是图片 Data URI，已跳过。`)
          continue
        }
        const bytes = dataUrlByteLength(raw)
        if (bytes > maxBytes) {
          warnings.push(`第 ${index + 1} 张参考图约 ${Math.round(bytes / 1024 / 1024)}MB，超过单张 ${state.config.maxReferenceMB}MB 限制，已跳过。`)
          continue
        }
        totalBytes += bytes
        out.push(raw)
        continue
      }
      if (!isHttpUrl(raw)) {
        warnings.push(`第 ${index + 1} 张参考图既不是 http(s) 也不是 Data URI，已跳过。`)
        continue
      }
      try {
        const response = await requestBuffer(raw, {
          method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NianFeng-AgnesMedia/1.0)' },
          timeoutMs: 30000,
          proxy: effectiveProxy(),
          allowPrivate: state.config.allowPrivateNetwork === true,
          maxBytes,
          maxRedirects: 5,
        })
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status })
        if (response.truncated) throw Object.assign(new Error(`参考图超过单张 ${state.config.maxReferenceMB}MB 限制`), { code: 'TOO_LARGE' })
        const mime = String(response.contentType || '').split(';')[0].trim().toLowerCase() || `image/${extFromMime('', 'png')}`
        if (!isImageContentType(mime)) {
          throw Object.assign(new Error(`服务器返回的不是图片（${mime || '未知类型'}）`), { code: 'NOT_IMAGE' })
        }
        const dataUrl = `data:${mime};base64,${response.buffer.toString('base64')}`
        const bytes = response.buffer.length
        if (bytes > maxBytes) throw Object.assign(new Error(`图片超过单张 ${state.config.maxReferenceMB}MB 限制`), { code: 'TOO_LARGE' })
        totalBytes += bytes
        out.push(dataUrl)
      } catch (error) {
        if (state.config.referenceFallbackRemote !== false) {
          warnings.push(`第 ${index + 1} 张参考图下载失败（${error.message}），已退回让 Agnes 直接访问原 URL。`)
          out.push(raw)
        } else {
          throw Object.assign(new Error(`第 ${index + 1} 张参考图下载失败：${error.message}`), { code: error?.code || 'REFERENCE_DOWNLOAD_FAILED' })
        }
      }
      if (totalBytes > maxTotalBytes) {
        throw Object.assign(new Error(`参考图总大小超过 ${state.config.maxReferenceTotalMB}MB，请减少数量或换小图。`), { code: 'REFERENCES_TOO_LARGE' })
      }
    }
    task.referenceCount = out.length
    task.referenceWarnings = warnings
    return out
  }

  /* ---------------- 结果保存 ---------------- */

  const saveGeneratedBuffer = async (task, buffer, mime) => {
    const ext = extFromMime(mime, task.kind === 'video' ? 'mp4' : 'png')
    const name = `${task.kind}_${task.id}.${ext}`
    await mkdir(filesDir(), { recursive: true })
    const file = join(filesDir(), name)
    await writeFile(file, buffer)
    return {
      file,
      localUrl: fileDataToUrl(name),
      remoteUrl: '',
      mime: mime || mimeFromExt(ext),
      bytes: buffer.length,
      width: 0,
      height: 0,
    }
  }

  const downloadGeneratedResult = async (task, remoteUrl, mimeHint = '') => {
    if (state.config.autoDownload === false) {
      return { file: '', localUrl: '', remoteUrl, mime: mimeHint, bytes: 0, width: 0, height: 0 }
    }
    const maxBytes = task.kind === 'video'
      ? clampNumber(state.config.maxVideoMB, 1, 2048, 300) * 1024 * 1024
      : clampNumber(state.config.maxImageMB, 1, 100, 25) * 1024 * 1024
    const ext = extFromMime(mimeHint, task.kind === 'video' ? 'mp4' : 'png')
    const name = `${task.kind}_${task.id}.${ext}`
    const file = join(filesDir(), name)
    await mkdir(dirname(file), { recursive: true })
    await downloadToFile(remoteUrl, file, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NianFeng-AgnesMedia/1.0)' },
      timeoutMs: task.kind === 'video' ? Math.max(60000, Number(state.config.videoTimeoutMs) || 600000) : 180000,
      proxy: effectiveProxy(),
      trusted: true,
      allowPrivate: false,
      maxBytes,
      maxRedirects: 5,
    })
    const info = await stat(file)
    return {
      file,
      localUrl: fileDataToUrl(name),
      remoteUrl,
      mime: mimeHint || mimeFromExt(ext),
      bytes: info.size,
      width: 0,
      height: 0,
    }
  }

  const finishImageTask = async (task, result) => {
    task.result = result
    task.progress = 100
    task.finishedAt = Date.now()
    touchTask(task, { status: 'completed', error: '' })
    logTask(ctx, task, `完成：${result.localUrl || result.remoteUrl || '(无地址)'}`)
  }

  const failTask = (task, error, code = '') => {
    task.progress = Number(task.progress) || 0
    task.finishedAt = Date.now()
    touchTask(task, { status: 'failed', error: String(error?.message || error || '生成失败') })
    logTask(ctx, task, `失败：${code ? `[${code}] ` : ''}${task.error}`)
  }

  const cancelTask = task => {
    task.cancelRequested = true
    if (task.status === 'queued') {
      task.finishedAt = Date.now()
      touchTask(task, { status: 'cancelled', error: '任务已取消' })
    }
    schedulePersist()
  }

  /* ---------------- 图片任务 ---------------- */

  const runImageTask = async task => {
    if (task.cancelRequested) return
    task.startedAt = task.startedAt || Date.now()
    task.progress = 5
    touchTask(task, { status: 'running', error: '' })
    logTask(ctx, task, `开始生成图片：${task.model}`)

    const references = await materializeReferences(task)
    if (task.cancelRequested) {
      task.finishedAt = Date.now()
      return touchTask(task, { status: 'cancelled', error: '任务已取消' })
    }
    const payload = buildImagePayload({
      prompt: task.prompt,
      model: task.model,
      size: task.options?.size,
      ratio: task.options?.ratio,
      dimensions: task.options?.dimensions,
      references,
      response_format: task.options?.responseFormat || state.config.imageResponseFormat,
    })
    task.payloadSummary = { size: payload.size, ratio: payload.ratio || '', model: payload.model, references: references.length }
    task.progress = 20
    touchTask(task)

    const response = await agnesRequest('/images/generations', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: clampNumber(state.config.imageTimeoutMs, 60000, 900000, 360000),
      maxBytes: 32 * 1024 * 1024,
    })
    if (task.cancelRequested) {
      task.finishedAt = Date.now()
      return touchTask(task, { status: 'cancelled', error: '任务已取消' })
    }
    const item = response.data?.data?.[0] || response.data?.images?.[0] || {}
    const remoteUrl = clean(item.url || response.data?.url)
    const b64 = clean(item.b64_json || response.data?.b64_json)
    task.progress = 80
    touchTask(task)

    if (b64) {
      const mime = clean(item.mime || item.content_type, 'image/png')
      const result = await saveGeneratedBuffer(task, Buffer.from(b64, 'base64'), mime)
      return finishImageTask(task, result)
    }
    if (!remoteUrl) {
      throw Object.assign(new Error('Agnes 返回成功，但没有找到图片 URL / b64_json。'), { code: 'EMPTY_IMAGE_RESULT' })
    }
    const mimeHint = clean(item.mime || item.content_type, 'image/png')
    try {
      const result = await downloadGeneratedResult(task, remoteUrl, mimeHint)
      return finishImageTask(task, result)
    } catch (error) {
      logTask(ctx, task, `结果下载失败，保留远程 URL：${error.message}`)
      return finishImageTask(task, { file: '', localUrl: '', remoteUrl, mime: mimeHint, bytes: 0, width: 0, height: 0 })
    }
  }

  /* ---------------- 视频任务 ---------------- */

  const pollVideoOnce = async task => {
    if (!task.upstream?.videoId) throw Object.assign(new Error('缺少 Agnes video_id，无法查询任务。'), { code: 'MISSING_VIDEO_ID' })
    const queryUrl = buildVideoQueryUrl(state.config.baseUrl, task.model, task.upstream.videoId)
    const response = await requestJson(queryUrl, {
      method: 'GET',
      headers: authHeaders(),
      timeoutMs: 40000,
      proxy: effectiveProxy(),
      trusted: true,
      maxBytes: 1024 * 1024,
      maxRedirects: 3,
    })
    task.lastPollAt = Date.now()
    const stateNow = normalizeVideoState(response.data || {})
    if (stateNow.progress !== null) task.progress = Math.max(Number(task.progress) || 0, stateNow.progress)
    if (stateNow.status) task.upstreamStatus = stateNow.status
    touchTask(task)
    return stateNow
  }

  const runVideoTask = async task => {
    if (task.cancelRequested) return
    task.startedAt = task.startedAt || Date.now()

    if (!task.upstream?.videoId) {
      task.progress = 5
      touchTask(task, { status: 'running', error: '' })
      logTask(ctx, task, `创建视频任务：${task.model}`)
      const references = await materializeReferences(task)
      if (task.cancelRequested) {
        task.finishedAt = Date.now()
        return touchTask(task, { status: 'cancelled', error: '任务已取消' })
      }
      const payload = buildVideoPayload({
        prompt: task.prompt,
        model: task.model,
        mode: task.options?.mode,
        seconds: task.options?.seconds,
        size: task.options?.size,
        aspect_ratio: task.options?.aspectRatio,
        seed: task.options?.seed,
        negative_prompt: task.options?.negativePrompt,
        first_frame: task.options?.firstFrame,
        last_frame: task.options?.lastFrame,
        reference_images: references,
        reference_audios: task.options?.referenceAudios,
        reference_videos: task.options?.referenceVideos,
        width: task.options?.width,
        height: task.options?.height,
        num_frames: task.options?.numFrames,
        frame_rate: task.options?.frameRate,
        num_inference_steps: task.options?.numInferenceSteps,
      })
      task.progress = 15
      touchTask(task)
      const response = await agnesRequest('/videos', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: 120000,
        maxBytes: 2 * 1024 * 1024,
      })
      const created = normalizeVideoState(response.data || {})
      task.upstream = {
        videoId: created.videoId,
        taskId: created.taskId,
        model: task.model,
        createdAt: Date.now(),
      }
      if (!task.upstream.videoId) {
        throw Object.assign(new Error('Agnes 没有返回 video_id，无法继续查询任务。'), { code: 'MISSING_VIDEO_ID' })
      }
      task.progress = 20
      touchTask(task, { status: 'running' })
      logTask(ctx, task, `上游任务已创建：video_id=${task.upstream.videoId}`)
      if (isCompletedStatus(created.status) && created.url) {
        const downloaded = await downloadGeneratedResult(task, created.url, 'video/mp4')
        return finishImageTask(task, downloaded)
      }
      if (isFailedStatus(created.status)) {
        throw Object.assign(new Error(created.error || 'Agnes 视频任务创建后直接返回失败'), { code: 'UPSTREAM_FAILED' })
      }
    } else {
      touchTask(task, { status: 'running' })
    }

    const timeoutMs = clampNumber(state.config.videoTimeoutMs, 60000, 3 * 60 * 60 * 1000, 30 * 60 * 1000)
    const pollMs = clampNumber(state.config.videoPollMs, 1000, 60000, 3000)
    const deadline = Date.now() + timeoutMs
    let pollErrors = 0
    while (!task.cancelRequested && Date.now() < deadline) {
      let stateNow
      try {
        stateNow = await pollVideoOnce(task)
        pollErrors = 0
        if (task.error && task.error.startsWith('轮询暂时失败')) {
          task.error = ''
          touchTask(task)
        }
      } catch (error) {
        const status = Number(error?.status) || 0
        const transient = status === 429 || status >= 500 || status === 0
        if (!transient) throw error
        pollErrors += 1
        task.error = `轮询暂时失败（${error.message}），仍在重试…`
        touchTask(task)
        logTask(ctx, task, task.error)
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, pollMs * Math.min(pollErrors, 5))))
        continue
      }
      if (isCompletedStatus(stateNow.status)) {
        if (!stateNow.url) throw Object.assign(new Error('Agnes 返回 completed，但没有视频 URL。'), { code: 'EMPTY_VIDEO_RESULT' })
        const downloaded = await downloadGeneratedResult(task, stateNow.url, 'video/mp4')
        return finishImageTask(task, downloaded)
      }
      if (isFailedStatus(stateNow.status)) {
        throw Object.assign(new Error(stateNow.error || 'Agnes 视频任务失败'), { code: 'UPSTREAM_FAILED' })
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    if (task.cancelRequested) {
      task.finishedAt = Date.now()
      return touchTask(task, { status: 'cancelled', error: '任务已取消' })
    }
    throw Object.assign(new Error(`视频生成等待超过 ${Math.round(timeoutMs / 60000)} 分钟；任务可能仍在 Agnes 排队，可用 agnes_task_status 继续查询。`), {
      code: 'VIDEO_TIMEOUT',
    })
  }

  /* ---------------- 任务调度 ---------------- */

  const runTask = async task => {
    try {
      if (task.cancelRequested) {
        task.finishedAt = Date.now()
        touchTask(task, { status: 'cancelled', error: '任务已取消' })
        return
      }
      if (task.kind === 'image') await runImageTask(task)
      else if (task.kind === 'video') await runVideoTask(task)
      else failTask(task, '未知任务类型', 'INVALID_TASK_KIND')
    } catch (error) {
      failTask(task, error, error?.code || '')
    } finally {
      running.delete(task.id)
      trimTasks()
      schedulePersist()
      pump()
    }
  }

  const pump = () => {
    const maxConcurrent = clampNumber(state.config.maxConcurrent, 1, 8, 2)
    if (running.size >= maxConcurrent) return
    const next = [...tasks.values()]
      .filter(task => task.status === 'queued' && !task.cancelRequested)
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))[0]
    if (!next) return
    running.add(next.id)
    next.status = 'running'
    next.startedAt = next.startedAt || Date.now()
    touchTask(next)
    runTask(next).catch(error => {
      lastPumpError = String(error?.message || error)
      ctx.logger.warn(`[agnes-media] 任务调度异常：${lastPumpError}`)
      running.delete(next.id)
      failTask(next, error, 'TASK_LOOP_ERROR')
      pump()
    })
    if (running.size < maxConcurrent) pump()
  }

  const createTask = ({ kind, prompt, model, options = {}, references = [], context = {}, caption = '', autoSend = true }) => {
    const id = `am_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
    const task = {
      id,
      kind,
      status: 'queued',
      progress: 0,
      prompt: clean(prompt),
      model: clean(model),
      options: { ...options },
      references: references.map(item => String(item || '')).filter(Boolean).slice(0, 8),
      referenceCount: Math.min(references.length, 8),
      referenceWarnings: [],
      conversationId: clean(context.conversationId),
      channelId: clean(context.channelId),
      roleId: clean(context.roleId),
      userId: clean(context.userId),
      userName: clean(context.userName),
      caption: clean(caption).slice(0, 300),
      autoSend: autoSend !== false,
      upstream: null,
      result: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      lastPollAt: 0,
      send: { claimId: '', claimedAt: 0, sentAt: 0, messageIds: [], attempts: 0, lastError: '' },
      log: [],
    }
    tasks.set(id, task)
    trimTasks()
    schedulePersist()
    pump()
    return task
  }

  /* ---------------- 启动恢复 ---------------- */

  const restoreTasks = () => {
    for (const task of tasks.values()) {
      if (!['queued', 'running'].includes(task.status)) continue
      if (task.kind === 'video' && task.upstream?.videoId) {
        task.status = 'queued'
        task.error = ''
        task.progress = Number(task.progress) || 20
        task.upstreamStatus = task.upstreamStatus || 'created'
        pump()
        continue
      }
      failTask(task, '念风后端在任务执行期间重启，任务已中断；请重新发起生成。', 'BACKEND_RESTARTED')
    }
  }

  /* ---------------- 路由 ---------------- */

  const safeRoute = (method, path, handler) =>
    httpApi.route(method, path, async (req, res, params, url) => {
      try {
        await ready
        await handler(req, res, params, url)
      } catch (error) {
        ctx.logger.warn(`[agnes-media] ${req.method} ${url?.pathname || path} 失败：${error?.message || error}`)
        if (!res.headersSent) httpApi.sendJson(res, Number(error?.status) || 500, fail(error?.code || 'INTERNAL_ERROR', error?.message || String(error)))
        else res.end()
      }
    })

  const readConfigBody = async req => {
    const body = (await httpApi.readBody(req, 256 * 1024)) || {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
    return body
  }

  const routes = [
    safeRoute('GET', '/api/agnes-media/status', async (req, res) => {
      httpApi.sendJson(res, 200, await statusPayload())
    }),

    safeRoute('GET', '/api/agnes-media/models', async (req, res, params, url) => {
      const force = String(url?.searchParams?.get('force') || '') === '1'
      const payload = await fetchModels({ force })
      httpApi.sendJson(res, 200, payload)
    }),

    safeRoute('PUT', '/api/agnes-media/config', async (req, res) => {
      const patch = await readConfigBody(req)
      if (patch.clearApiKey === true) state.config.apiKey = ''
      if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
        const key = patch.apiKey.trim()
        if (key.length < 8) throw Object.assign(new Error('API Key 看起来太短，请检查是否复制完整。'), { code: 'INVALID_API_KEY' })
        state.config.apiKey = key
      }
      if (patch.basePreset !== undefined) {
        const preset = String(patch.basePreset || '')
        if (!['international', 'china', 'custom'].includes(preset)) throw Object.assign(new Error('basePreset 不合法'), { status: 400 })
        state.config.basePreset = preset
        if (preset === 'international') state.config.baseUrl = DEFAULT_BASE_URL
        if (preset === 'china') state.config.baseUrl = CN_BASE_URL
      }
      if (patch.baseUrl !== undefined && String(patch.baseUrl).trim()) {
        state.config.baseUrl = normalizeBaseUrl(String(patch.baseUrl).trim())
        if (state.config.basePreset !== 'china' && state.config.basePreset !== 'international') state.config.basePreset = 'custom'
      }
      if (state.config.basePreset === 'international') state.config.baseUrl = DEFAULT_BASE_URL
      if (state.config.basePreset === 'china') state.config.baseUrl = CN_BASE_URL
      if (patch.proxy !== undefined) {
        const proxy = String(patch.proxy || '').trim()
        if (proxy && !/^https?:\/\//i.test(proxy)) throw Object.assign(new Error('代理地址要以 http:// 或 https:// 开头'), { code: 'INVALID_PROXY' })
        state.config.proxy = proxy
      }
      if (patch.imageModel !== undefined) state.config.imageModel = normalizeModelId(patch.imageModel) || state.config.imageModel
      if (patch.videoModel !== undefined) state.config.videoModel = normalizeModelId(patch.videoModel) || state.config.videoModel
      if (patch.imageModelMode !== undefined) state.config.imageModelMode = patch.imageModelMode === 'manual' ? 'manual' : 'select'
      if (patch.videoModelMode !== undefined) state.config.videoModelMode = patch.videoModelMode === 'manual' ? 'manual' : 'select'
      if (patch.imageSize !== undefined) state.config.imageSize = clean(patch.imageSize, state.config.imageSize)
      if (patch.imageRatio !== undefined) state.config.imageRatio = clean(patch.imageRatio, state.config.imageRatio)
      if (patch.imageResponseFormat !== undefined) state.config.imageResponseFormat = patch.imageResponseFormat === 'b64_json' ? 'b64_json' : 'url'
      if (patch.videoSize !== undefined) state.config.videoSize = clean(patch.videoSize, state.config.videoSize)
      if (patch.videoAspect !== undefined) state.config.videoAspect = clean(patch.videoAspect, state.config.videoAspect)
      if (patch.videoSeconds !== undefined) state.config.videoSeconds = clean(patch.videoSeconds, state.config.videoSeconds)
      if (patch.videoMode !== undefined) state.config.videoMode = clean(patch.videoMode, state.config.videoMode)
      if (patch.autoSend !== undefined) state.config.autoSend = patch.autoSend !== false
      if (patch.autoDownload !== undefined) state.config.autoDownload = patch.autoDownload !== false
      if (patch.allowPrivateNetwork !== undefined) state.config.allowPrivateNetwork = patch.allowPrivateNetwork === true
      if (patch.referenceFallbackRemote !== undefined) state.config.referenceFallbackRemote = patch.referenceFallbackRemote !== false
      if (patch.imageTimeoutMs !== undefined) state.config.imageTimeoutMs = clampNumber(patch.imageTimeoutMs, 60000, 900000, 360000)
      if (patch.videoTimeoutMs !== undefined) state.config.videoTimeoutMs = clampNumber(patch.videoTimeoutMs, 60000, 3 * 60 * 60 * 1000, 30 * 60 * 1000)
      if (patch.videoPollMs !== undefined) state.config.videoPollMs = clampNumber(patch.videoPollMs, 1000, 60000, 3000)
      if (patch.maxConcurrent !== undefined) state.config.maxConcurrent = clampNumber(patch.maxConcurrent, 1, 8, 2)
      if (patch.maxImageMB !== undefined) state.config.maxImageMB = clampNumber(patch.maxImageMB, 1, 100, 25)
      if (patch.maxVideoMB !== undefined) state.config.maxVideoMB = clampNumber(patch.maxVideoMB, 1, 2048, 300)
      if (patch.maxReferenceMB !== undefined) state.config.maxReferenceMB = clampNumber(patch.maxReferenceMB, 1, 50, 12)
      if (patch.maxReferenceTotalMB !== undefined) state.config.maxReferenceTotalMB = clampNumber(patch.maxReferenceTotalMB, 1, 200, 40)
      modelsCache = { at: 0, payload: null }
      await persistState()
      pump()
      httpApi.sendJson(res, 200, await statusPayload())
    }),

    safeRoute('POST', '/api/agnes-media/test', async (req, res) => {
      if (!state.config.apiKey) throw Object.assign(new Error('请先填写 Agnes API Key'), { code: 'NO_API_KEY' })
      const started = Date.now()
      const payload = await fetchModels({ force: true })
      httpApi.sendJson(res, 200, {
        ok: payload.ok === true,
        ms: Date.now() - started,
        code: payload.code || '',
        error: payload.error || '',
        total: payload.total || 0,
        baseUrl: state.config.baseUrl,
        proxy: effectiveProxy(),
      })
    }),

    safeRoute('POST', '/api/agnes-media/tasks/image', async (req, res) => {
      const body = (await httpApi.readBody(req, 32 * 1024 * 1024)) || {}
      if (!state.config.apiKey) throw Object.assign(new Error('尚未配置 Agnes API Key，请先到「设置 → Agnes 生图 / 生视频」填写。'), { code: 'NO_API_KEY', status: 400 })
      const prompt = clean(body.prompt)
      if (!prompt) throw Object.assign(new Error('缺少 prompt（图片描述）。'), { code: 'INVALID_ARGS', status: 400 })
      const model = clean(body.model, state.config.imageModel)
      const references = Array.isArray(body.references) ? body.references.slice(0, 8) : []
      const task = createTask({
        kind: 'image',
        prompt,
        model,
        options: {
          size: clean(body.size, state.config.imageSize),
          ratio: clean(body.ratio, state.config.imageRatio),
          dimensions: clean(body.dimensions),
          responseFormat: clean(body.response_format, state.config.imageResponseFormat),
        },
        references,
        context: body.context || {},
        caption: body.caption || '',
        autoSend: body.auto_send !== false && state.config.autoSend !== false,
      })
      httpApi.sendJson(res, 200, {
        ok: true,
        task: publicTask(task),
        note:
          '图片生成任务已经在后台挂载，马上会返回 task_id，不需要等待生成完成；完成后插件会自动把图片发到目标会话。' +
          '如需了解进度，可以用 agnes_task_status 查询。',
      })
    }),

    safeRoute('POST', '/api/agnes-media/tasks/video', async (req, res) => {
      const body = (await httpApi.readBody(req, 4 * 1024 * 1024)) || {}
      if (!state.config.apiKey) throw Object.assign(new Error('尚未配置 Agnes API Key，请先到「设置 → Agnes 生图 / 生视频」填写。'), { code: 'NO_API_KEY', status: 400 })
      const prompt = clean(body.prompt)
      if (!prompt) throw Object.assign(new Error('缺少 prompt（视频描述）。'), { code: 'INVALID_ARGS', status: 400 })
      const model = clean(body.model, state.config.videoModel)
      const references = Array.isArray(body.references) ? body.references.slice(0, 8) : []
      const firstFrame = clean(body.first_frame)
      const lastFrame = clean(body.last_frame)
      const hasReferenceMedia = references.length > 0 || (Array.isArray(body.reference_audios) && body.reference_audios.length > 0) || (Array.isArray(body.reference_videos) && body.reference_videos.length > 0)
      // 不显式传 mode 时按素材自动判断：首尾帧 -> keyframe；有参考图 / 音频 / 视频 -> reference；
      // 都没有才用插件默认值（通常是 text）。
      const inferMode = clean(body.mode) || (firstFrame || lastFrame ? 'keyframe' : hasReferenceMedia ? 'reference' : clean(state.config.videoMode, 'text'))
      const task = createTask({
        kind: 'video',
        prompt,
        model,
        options: {
          mode: inferMode,
          seconds: clean(body.seconds, state.config.videoSeconds),
          size: clean(body.size, state.config.videoSize),
          aspectRatio: clean(body.aspect_ratio || body.aspectRatio, state.config.videoAspect),
          seed: body.seed,
          negativePrompt: clean(body.negative_prompt),
          firstFrame: clean(body.first_frame),
          lastFrame: clean(body.last_frame),
          referenceAudios: Array.isArray(body.reference_audios) ? body.reference_audios.slice(0, 3) : [],
          referenceVideos: Array.isArray(body.reference_videos) ? body.reference_videos.slice(0, 1) : [],
          width: body.width,
          height: body.height,
          numFrames: body.num_frames,
          frameRate: body.frame_rate,
          numInferenceSteps: body.num_inference_steps,
        },
        references,
        context: body.context || {},
        caption: body.caption || '',
        autoSend: body.auto_send !== false && state.config.autoSend !== false,
      })
      httpApi.sendJson(res, 200, {
        ok: true,
        task: publicTask(task),
        note:
          '视频生成任务已经在后台挂载，不需要等待；Agnes 异步出片后插件会自动发到目标会话，也可以用 agnes_task_status 主动查询进度。',
      })
    }),

    safeRoute('GET', '/api/agnes-media/tasks', async (req, res, params, url) => {
      const status = clean(url?.searchParams?.get('status')).toLowerCase()
      const conversationId = clean(url?.searchParams?.get('conversationId') || url?.searchParams?.get('conversation_id'))
      const pendingOnly = ['1', 'true', 'yes'].includes(String(url?.searchParams?.get('pending') || '').toLowerCase())
      const limit = clampNumber(url?.searchParams?.get('limit'), 1, 200, 50)
      const list = [...tasks.values()]
        .filter(task => (status ? task.status === status : true))
        .filter(task => (pendingOnly ? ['queued', 'running'].includes(task.status) : true))
        .filter(task => (conversationId ? task.conversationId === conversationId : true))
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .slice(0, limit)
        .map(publicTask)
      httpApi.sendJson(res, 200, { ok: true, total: list.length, tasks: list })
    }),

    safeRoute('GET', '/api/agnes-media/tasks/:id', async (req, res, params) => {
      const task = tasks.get(String(params.id || ''))
      if (!task) throw Object.assign(new Error('任务不存在'), { status: 404 })
      const refresh = String(req.url || '').includes('refresh=1')
      if (refresh && task.kind === 'video' && ['queued', 'running'].includes(task.status) && task.upstream?.videoId) {
        const key = String(task.id)
        if (!pollLocks.has(key)) {
          const promise = pollVideoOnce(task)
            .catch(error => {
              logTask(ctx, task, `手动刷新失败：${error.message}`)
            })
            .finally(() => pollLocks.delete(key))
          pollLocks.set(key, promise)
        }
        await pollLocks.get(key)
      }
      httpApi.sendJson(res, 200, { ok: true, task: publicTask(task) })
    }),

    safeRoute('POST', '/api/agnes-media/tasks/:id/cancel', async (req, res, params) => {
      const task = tasks.get(String(params.id || ''))
      if (!task) throw Object.assign(new Error('任务不存在'), { status: 404 })
      cancelTask(task)
      httpApi.sendJson(res, 200, { ok: true, task: publicTask(task) })
    }),

    safeRoute('POST', '/api/agnes-media/tasks/:id/claim', async (req, res, params) => {
      const task = tasks.get(String(params.id || ''))
      if (!task) throw Object.assign(new Error('任务不存在'), { status: 404 })
      const body = await readConfigBody(req)
      const clientId = clean(body.clientId || randomUUID()).slice(0, 120)
      const terminal = ['completed', 'failed', 'cancelled'].includes(task.status)
      if (!terminal) throw Object.assign(new Error('任务还没有结束，不能占用自动发送资格。'), { code: 'TASK_NOT_FINISHED' })
      const current = task.send?.claimId
      if (task.send?.sentAt) return httpApi.sendJson(res, 200, { ok: true, already_sent: true, task: publicTask(task) })
      const claimAge = Date.now() - (Number(task.send?.claimedAt) || 0)
      const claimExpired = !current || claimAge > 2 * 60 * 1000
      if (current && current !== clientId && !claimExpired) {
        return httpApi.sendJson(res, 200, { ok: false, code: 'ALREADY_CLAIMED', error: '该任务已被另一个前端 / 代聊实例占用发送。', task: publicTask(task) })
      }
      task.send = { ...(task.send || {}), claimId: clientId, claimedAt: Date.now() }
      touchTask(task)
      httpApi.sendJson(res, 200, { ok: true, claimed: true, clientId, task: publicTask(task) })
    }),

    safeRoute('POST', '/api/agnes-media/tasks/:id/sent', async (req, res, params) => {
      const task = tasks.get(String(params.id || ''))
      if (!task) throw Object.assign(new Error('任务不存在'), { status: 404 })
      const body = await readConfigBody(req)
      const clientId = clean(body.clientId)
      if (task.send?.claimId && clientId && task.send.claimId !== clientId) {
        throw Object.assign(new Error('发送回写者与占用者不一致'), { code: 'CLAIM_MISMATCH', status: 409 })
      }
      const error = clean(body.error)
      if (error) {
        task.send = {
          ...(task.send || {}),
          claimId: '',
          attempts: (Number(task.send?.attempts) || 0) + 1,
          lastError: error.slice(0, 300),
        }
        touchTask(task)
        return httpApi.sendJson(res, 200, { ok: true, released: true, attempts: task.send.attempts, task: publicTask(task) })
      }
      task.send = {
        ...(task.send || {}),
        claimId: '',
        sentAt: Date.now(),
        messageIds: Array.isArray(body.messageIds) ? body.messageIds.map(String).slice(0, 8) : [],
        attempts: (Number(task.send?.attempts) || 0) + 1,
        lastError: '',
      }
      touchTask(task, { sent_at: task.send.sentAt })
      httpApi.sendJson(res, 200, { ok: true, sent: true, task: publicTask(task) })
    }),

    safeRoute('GET', '/api/agnes-media/files/:name', async (req, res, params) => {
      const name = String(params.name || '')
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) return httpApi.sendError(res, 400, '文件名不合法')
      const file = join(filesDir(), name)
      let info
      try {
        info = await stat(file)
      } catch (_) {
        return httpApi.sendError(res, 404, '文件不存在')
      }
      if (!info.isFile()) return httpApi.sendError(res, 404, '文件不存在')
      res.writeHead(200, {
        'Content-Type': mimeFromExt(extname(name)),
        'Content-Length': info.size,
        'Cache-Control': 'private, max-age=600',
      })
      const stream = createReadStream(file)
      stream.on('error', () => {
        try {
          res.destroy()
        } catch (_) {
          /* ignore */
        }
      })
      stream.pipe(res)
    }),
  ]

  /* ---------------- 服务注册 ---------------- */

  httpApi.registerCapability('agnes-media')

  ctx.provide(
    'agnes-media',
    {
      name: 'agnes-media',
      version,
      ready: () => ready,
      status: () => statusPayload(),
      models: options => fetchModels(options || {}),
      createImageTask: options => {
        const task = createTask({
          kind: 'image',
          prompt: options?.prompt,
          model: options?.model || state.config.imageModel,
          options: {
            size: options?.size || state.config.imageSize,
            ratio: options?.ratio || state.config.imageRatio,
            dimensions: options?.dimensions,
            responseFormat: options?.responseFormat || state.config.imageResponseFormat,
          },
          references: options?.references || [],
          context: options?.context || {},
          caption: options?.caption || '',
          autoSend: options?.autoSend !== false,
        })
        return Promise.resolve(publicTask(task))
      },
      createVideoTask: options => {
        const task = createTask({
          kind: 'video',
          prompt: options?.prompt,
          model: options?.model || state.config.videoModel,
          options: {
            mode: options?.mode || state.config.videoMode,
            seconds: options?.seconds || state.config.videoSeconds,
            size: options?.size || state.config.videoSize,
            aspectRatio: options?.aspectRatio || state.config.videoAspect,
            seed: options?.seed,
            negativePrompt: options?.negativePrompt,
            firstFrame: options?.firstFrame,
            lastFrame: options?.lastFrame,
            referenceAudios: options?.referenceAudios || [],
            referenceVideos: options?.referenceVideos || [],
          },
          references: options?.references || [],
          context: options?.context || {},
          caption: options?.caption || '',
          autoSend: options?.autoSend !== false,
        })
        return Promise.resolve(publicTask(task))
      },
      task: id => Promise.resolve(publicTask(tasks.get(String(id)))),
      tasks: () => Promise.resolve([...tasks.values()].map(publicTask)),
      fileDataToUrl,
    },
    { type: 'singleton' },
  )

  ctx.effect(() => () => {
    closed = true
    if (persistTimer) clearTimeout(persistTimer)
    for (const dispose of routes) {
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
    persistState().catch(() => {})
  })

  loadState()
    .then(() => {
      ctx.logger.info(
        `[agnes-media] 后端桥 v${version}(${build}) 就绪 · ${state.config.apiKey ? 'API Key 已配置' : '尚未配置 API Key'} · ${state.config.baseUrl}`,
      )
      restoreTasks()
      readyResolve()
    })
    .catch(error => {
      ctx.logger.error(`[agnes-media] 初始化失败：${error?.message || error}`)
      readyResolve()
    })
}
