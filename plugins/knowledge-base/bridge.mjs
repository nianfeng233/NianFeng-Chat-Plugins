/*
 * 念风chat · 独立扩展 · 知识库（后端桥）
 *
 * 这个文件只会在外部插件目录里生效：不会被 package-release 复制进本体。
 * 它负责真正的数据持久化和本地检索：
 *   - SQLite kb_entries / kb_history（旧 Node 回退 JSON）
 *   - path 多级目录：通过 "A/B/C" 前缀自然形成目录树
 *   - BM25 + 可选 embedding 向量 + RRF 混合检索
 *   - 写入时自动建立目录、更新时保留历史版本
 *   - 只读管理接口 /api/knowledge/entries[/:id]，供「记忆与知识库」页面浏览
 *
 * 前端 index.mjs 只负责把能力包装成模型工具。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_MAX_CONTENT,
  KnowledgeStore,
  normalizeMeta,
  normalizePath,
  normalizeTags,
  normalizeTitle,
  tokenizeQuery,
} from './lib/store.mjs'
import { buildTree, hybridRank, previewContent } from './lib/search.mjs'

export const name = 'knowledge-base-bridge'
export const version = '2.0.0'
export const displayName = '知识库后端桥'
export const description = '本地知识库 · 多级目录 / 标签 / 历史版本 / BM25 + 向量检索'
export const author = '念风扩展'
export const core = false
export const inject = ['settings', 'httpApi', 'models']
export const provides = [{ name: 'knowledge-base', type: 'singleton' }]

const DEFAULT_CONFIG = {
  autoEmbed: true,
  embeddingProvider: '',
  embeddingModel: '',
}

const nowIso = () => new Date().toISOString()

function clampNumber(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.floor(num)))
}

function asString(value) {
  return String(value ?? '')
}

function errorResult(code, error, hint = '') {
  return { ok: false, code, error, ...(hint ? { hint } : {}) }
}

export function apply(ctx, config = {}) {
  const settings = ctx.settings
  const httpApi = ctx.httpApi
  const models = ctx.models || (typeof ctx.inject === 'function' ? ctx.inject('models?') : null) || null

  const dataDir = config.dataDir || settings.dataDir || process.cwd()
  const pluginDir = join(dataDir, 'knowledge-base')
  mkdirSync(pluginDir, { recursive: true })
  const store = new KnowledgeStore(pluginDir, ctx.logger)
  const configFile = join(pluginDir, 'config.json')

  let pluginConfig = { ...DEFAULT_CONFIG }
  if (existsSync(configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'))
      pluginConfig = { ...pluginConfig, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
    } catch (err) {
      ctx.logger?.warn?.(`[knowledge] config.json 损坏，使用默认配置：${err?.message || err}`)
    }
  }

  const persistConfig = () => {
    try {
      writeFileSync(configFile, JSON.stringify(pluginConfig, null, 2), 'utf8')
    } catch (err) {
      ctx.logger?.warn?.(`[knowledge] 写入 config.json 失败：${err?.message || err}`)
    }
  }

  const preferences = () => settings.get()?.preferences || {}
  const resolveEmbeddingConfig = () => {
    const knowledge = preferences().knowledge || {}
    const memory = preferences().memory || {}
    return {
      provider: asString(pluginConfig.embeddingProvider || knowledge.embeddingProvider || memory.embeddingProvider || '').trim(),
      model: asString(pluginConfig.embeddingModel || knowledge.embeddingModel || memory.embeddingModel || '').trim(),
    }
  }

  const embedTexts = async (texts, { required = false } = {}) => {
    if (pluginConfig.autoEmbed === false) return null
    const embedding = resolveEmbeddingConfig()
    if (!embedding.provider || !embedding.model) {
      if (required) throw new Error('尚未配置知识库向量模型（可复用「设置 → 模型 → 记忆模型」的向量模型）')
      return null
    }
    if (!models?.embed) {
      if (required) throw new Error('当前后端没有可用的 embedding 服务')
      return null
    }
    const input = (Array.isArray(texts) ? texts : [texts]).map(text => asString(text).slice(0, 8000))
    const result = await models.embed({ provider: embedding.provider, model: embedding.model, input })
    return result
  }

  const entrySummary = entry => ({
    id: entry.id,
    path: entry.path,
    title: entry.title,
    tags: entry.tags || [],
    revision: entry.revision,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    content_length: asString(entry.content).length,
    preview: previewContent(entry.content),
    embedded: Array.isArray(entry.embedding) && entry.embedding.length > 0,
  })

  const writeEntry = async input => {
    const content = asString(input.content).slice(0, DEFAULT_MAX_CONTENT)
    if (!content.trim()) return errorResult('EMPTY_CONTENT', 'content 不能为空；请把要记住的知识正文放进 content。')
    const path = normalizePath(input.path || input.directory || '')
    const title = normalizeTitle(input.title, content)
    const tags = normalizeTags(input.tags)
    const meta = normalizeMeta(input.metadata ?? input.meta)
    const explicitId = asString(input.id || input.entry_id).trim()
    const existing = explicitId ? store.get(explicitId) : store.findByPathTitle(path, title)
    if (explicitId && !existing) return errorResult('NOT_FOUND', `知识条目不存在：${explicitId}`)
    if (!explicitId && existing && input.mode === 'create') {
      return errorResult('DUPLICATE', `同一目录下已有同名条目：${existing.title}`, '可使用 kb_edit 或 kb_write 不传 mode=create 来更新。')
    }

    const embeddingText = [title, path, tags.join(' '), content.slice(0, 8000)].filter(Boolean).join('\n')
    let embedding = null
    try {
      embedding = await embedTexts([embeddingText], { required: false })
    } catch (err) {
      ctx.logger?.debug?.(`[knowledge] 条目向量化失败，继续以关键词模式保存：${err?.message || err}`)
    }

    const now = nowIso()
    const entry = existing
      ? {
          ...existing,
          path,
          title,
          content,
          tags,
          meta,
          revision: (Number(existing.revision) || 1) + 1,
          updated_at: now,
          embedding: embedding?.embeddings?.[0] || existing.embedding || [],
          embedding_provider: embedding?.provider || existing.embedding_provider || '',
          embedding_model: embedding?.model || existing.embedding_model || '',
          embedding_dim: embedding?.dimension || existing.embedding_dim || 0,
        }
      : {
          id: `kb_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
          path,
          title,
          content,
          tags,
          meta,
          status: 'active',
          revision: 1,
          created_at: now,
          updated_at: now,
          accessed_at: '',
          deleted_at: '',
          embedding: embedding?.embeddings?.[0] || [],
          embedding_provider: embedding?.provider || '',
          embedding_model: embedding?.model || '',
          embedding_dim: embedding?.dimension || 0,
          search_tokens: '',
        }

    store.saveEntry(entry, { reason: asString(input.reason || (existing ? 'kb_write 更新' : 'kb_write 新建')), previous: existing || null })
    return {
      ok: true,
      created: !existing,
      updated: !!existing,
      id: entry.id,
      path: entry.path,
      title: entry.title,
      tags: entry.tags,
      revision: entry.revision,
      embedded: Array.isArray(entry.embedding) && entry.embedding.length > 0,
      hint: '已写入本地知识库。后续可用 kb_search 检索。',
    }
  }

  const editEntry = async input => {
    const id = asString(input.id || input.entry_id).trim()
    if (!id) return errorResult('MISSING_ID', '缺少 id；请先用 kb_search / kb_read 找到条目 ID。')
    const existing = store.get(id)
    if (!existing || existing.status === 'deleted') return errorResult('NOT_FOUND', `知识条目不存在：${id}`)

    const patch = {}
    if (input.path !== undefined || input.directory !== undefined) patch.path = normalizePath(input.path ?? input.directory)
    if (input.title !== undefined) patch.title = normalizeTitle(input.title, existing.content)
    if (input.tags !== undefined) patch.tags = normalizeTags(input.tags)
    if (input.metadata !== undefined || input.meta !== undefined) patch.meta = normalizeMeta(input.metadata ?? input.meta)

    let content = existing.content
    if (input.content !== undefined) {
      const incoming = asString(input.content)
      const mode = asString(input.content_mode || 'replace').toLowerCase()
      if (mode === 'append') content = `${content}${content && !content.endsWith('\n') ? '\n' : ''}${incoming}`
      else if (mode === 'prepend') content = `${incoming}${incoming && !incoming.endsWith('\n') ? '\n' : ''}${content}`
      else content = incoming
      patch.content = content.slice(0, DEFAULT_MAX_CONTENT)
    }

    const addedTags = normalizeTags(input.add_tags || input.addTags)
    const removedTags = normalizeTags(input.remove_tags || input.removeTags)
    let tags = patch.tags !== undefined ? patch.tags : [...(existing.tags || [])]
    if (addedTags.length) tags = normalizeTags([...tags, ...addedTags])
    if (removedTags.length) {
      const removeSet = new Set(removedTags.map(tag => tag.toLowerCase()))
      tags = tags.filter(tag => !removeSet.has(tag.toLowerCase()))
    }
    if (addedTags.length || removedTags.length) patch.tags = tags

    const next = { ...existing, ...patch }
    if (
      next.path === existing.path &&
      next.title === existing.title &&
      asString(next.content) === asString(existing.content) &&
      JSON.stringify(next.tags) === JSON.stringify(existing.tags) &&
      JSON.stringify(next.meta) === JSON.stringify(existing.meta)
    ) {
      return { ok: true, updated: false, id: existing.id, hint: '没有检测到字段变化。' }
    }

    const embeddingText = [next.title, next.path, (next.tags || []).join(' '), asString(next.content).slice(0, 8000)]
      .filter(Boolean)
      .join('\n')
    let embedding = null
    try {
      embedding = await embedTexts([embeddingText], { required: false })
    } catch (err) {
      ctx.logger?.debug?.(`[knowledge] 编辑后向量化失败，继续以关键词模式保存：${err?.message || err}`)
    }
    next.revision = (Number(existing.revision) || 1) + 1
    next.updated_at = nowIso()
    next.embedding = embedding?.embeddings?.[0] || existing.embedding || []
    next.embedding_provider = embedding?.provider || existing.embedding_provider || ''
    next.embedding_model = embedding?.model || existing.embedding_model || ''
    next.embedding_dim = embedding?.dimension || existing.embedding_dim || 0
    store.saveEntry(next, { reason: asString(input.reason || 'kb_edit'), previous: existing })
    return {
      ok: true,
      updated: true,
      id: next.id,
      path: next.path,
      title: next.title,
      revision: next.revision,
      embedded: Array.isArray(next.embedding) && next.embedding.length > 0,
      hint: '已更新，旧版本已保留。',
    }
  }

  const readEntry = input => {
    const ids = Array.isArray(input.ids) ? input.ids : input.id ? [input.id] : []
    if (!ids.length) return errorResult('MISSING_ID', '缺少 id（或 ids）。')
    const maxChars = clampNumber(input.max_chars ?? input.maxChars, 200, 80000, 12000)
    const offset = clampNumber(input.offset, 0, DEFAULT_MAX_CONTENT, 0)
    const includeHistory = input.history === true || input.include_history === true
    const items = []
    for (const rawId of ids.slice(0, 10)) {
      const entry = store.get(asString(rawId).trim())
      if (!entry || entry.status === 'deleted') {
        items.push({ id: asString(rawId), ok: false, error: '条目不存在或已删除' })
        continue
      }
      const content = asString(entry.content)
      const slice = content.slice(offset, offset + maxChars)
      store.updateAccess(entry.id)
      items.push({
        id: entry.id,
        ok: true,
        path: entry.path,
        title: entry.title,
        tags: entry.tags || [],
        metadata: entry.meta || {},
        revision: entry.revision,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        content: slice,
        content_length: content.length,
        offset,
        next_offset: offset + slice.length < content.length ? offset + slice.length : null,
        truncated: offset + slice.length < content.length,
        ...(includeHistory
          ? {
              history: store.historyOf(entry.id, { limit: input.history_limit || 10 }).map(item => ({
                revision: item.revision,
                title: item.title,
                path: item.path,
                content_length: asString(item.content).length,
                updated_at: item.created_at,
                reason: item.reason,
              })),
            }
          : {}),
      })
    }
    return { ok: true, returned: items.length, entries: items }
  }

  const searchEntries = async input => {
    const query = asString(input.query).trim()
    const semantic = asString(input.semantic).trim()
    const queryTokens = tokenizeQuery(query)
    const semanticText = semantic || query
    const limit = clampNumber(input.limit, 1, 20, 5)
    const pathPrefix = normalizePath(input.path_prefix ?? input.pathPrefix ?? '')
    const tags = normalizeTags(input.tags)
    const tagMode = asString(input.tag_mode || input.tagMode || 'all').toLowerCase()
    const timeStart = asString(input.time_start || input.timeStart || '').trim()
    const timeEnd = asString(input.time_end || input.timeEnd || '').trim()

    let entries = store.list()
    if (pathPrefix) {
      entries = entries.filter(entry => entry.path === pathPrefix || entry.path.startsWith(`${pathPrefix}/`))
    }
    if (tags.length) {
      entries = entries.filter(entry => {
        const entryTags = new Set((entry.tags || []).map(tag => tag.toLowerCase()))
        return tagMode === 'any'
          ? tags.some(tag => entryTags.has(tag.toLowerCase()))
          : tags.every(tag => entryTags.has(tag.toLowerCase()))
      })
    }
    if (timeStart) entries = entries.filter(entry => asString(entry.updated_at) >= timeStart)
    if (timeEnd) entries = entries.filter(entry => asString(entry.updated_at) <= timeEnd)

    let queryEmbedding = null
    let embeddingError = ''
    if (semanticText) {
      try {
        const result = await embedTexts([semanticText], { required: false })
        queryEmbedding = result?.embeddings?.[0] || null
      } catch (err) {
        embeddingError = String(err?.message || err)
        ctx.logger?.debug?.(`[knowledge] 语义检索降级为关键词：${embeddingError}`)
      }
    }

    const ranked = hybridRank(entries, { queryTokens, queryEmbedding })
    const selected = ranked.slice(0, limit)
    return {
      ok: true,
      query: query || semantic,
      semantic_applied: !!queryEmbedding,
      embedding_error: embeddingError || undefined,
      total: entries.length,
      returned: selected.length,
      entries: selected.map(item => ({
        ...entrySummary(item.entry),
        score: item.score,
        keyword_score: item.keyword_score,
        vector_score: item.vector_score,
      })),
      hint: 'search 只返回预览；需要全文时把 id 传给 kb_read。',
    }
  }

  const deleteEntries = input => {
    const reason = asString(input.reason || 'kb_delete').slice(0, 200)
    if (input.id || input.entry_id) {
      const entry = store.get(asString(input.id || input.entry_id).trim())
      if (!entry || entry.status === 'deleted') return errorResult('NOT_FOUND', '知识条目不存在或已删除。')
      if (input.confirm !== true) return errorResult('CONFIRM_REQUIRED', '删除是不可逆操作；确认后请传 confirm=true（并先征得用户同意）。')
      store.deleteEntry(entry, reason)
      return { ok: true, deleted: 1, ids: [entry.id] }
    }
    const path = normalizePath(input.path)
    if (!path) return errorResult('MISSING_TARGET', '请提供 id，或提供 path + recursive=true 删除一个目录。')
    if (input.confirm !== true) return errorResult('CONFIRM_REQUIRED', '删除是不可逆操作；确认后请传 confirm=true（并先征得用户同意）。')
    const recursive = input.recursive !== false
    const entries = store
      .list()
      .filter(entry => (recursive ? entry.path === path || entry.path.startsWith(`${path}/`) : entry.path === path))
    for (const entry of entries) store.deleteEntry(entry, reason)
    return { ok: true, deleted: entries.length, ids: entries.map(entry => entry.id), path, recursive }
  }

  const tree = input => {
    const pathPrefix = normalizePath(input.path_prefix ?? input.path ?? '')
    const depth = clampNumber(input.depth, 0, 6, 2)
    const limit = clampNumber(input.limit, 1, 500, 200)
    const includeEntries = input.include_entries !== false
    return {
      ok: true,
      ...buildTree(store.list(), { prefix: pathPrefix, depth, limit, includeEntries }),
      hint: 'path 使用 / 分层；写入时 path 会自动建立目录。可继续 kb_tree 深入到具体目录。',
    }
  }

  /**
   * 知识库页面：分页列出有效条目（只返回预览），支持关键词 / 目录前缀 / 标签 / 时间过滤。
   * 与 kb_search 的区别是它不做 BM25 排序，而是按更新时间倒序，适合“浏览全部知识”。
   */
  const listEntries = input => {
    const query = asString(input.q ?? input.query).trim().toLowerCase()
    const pathPrefix = normalizePath(input.path_prefix ?? input.pathPrefix ?? input.path ?? '')
    const tags = normalizeTags(input.tags)
    const tagMode = asString(input.tag_mode || input.tagMode || 'all').toLowerCase()
    const timeStart = asString(input.time_start || input.timeStart || '').trim()
    const timeEnd = asString(input.time_end || input.timeEnd || '').trim()
    const limit = clampNumber(Number(input.limit) || 50, 1, 200, 50)
    const offset = clampNumber(Number(input.offset) || 0, 0, 100000, 0)

    let entries = store.list()
    if (pathPrefix) entries = entries.filter(entry => entry.path === pathPrefix || entry.path.startsWith(`${pathPrefix}/`))
    if (tags.length) {
      entries = entries.filter(entry => {
        const entryTags = new Set((entry.tags || []).map(tag => tag.toLowerCase()))
        return tagMode === 'any'
          ? tags.some(tag => entryTags.has(tag.toLowerCase()))
          : tags.every(tag => entryTags.has(tag.toLowerCase()))
      })
    }
    if (timeStart) entries = entries.filter(entry => asString(entry.updated_at) >= timeStart)
    if (timeEnd) entries = entries.filter(entry => asString(entry.updated_at) <= timeEnd)
    if (query) {
      entries = entries.filter(entry =>
        [entry.title, entry.path, (entry.tags || []).join(' '), entry.content]
          .map(value => asString(value).toLowerCase())
          .join('\n')
          .includes(query),
      )
    }
    entries = entries.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    const total = entries.length
    const page = entries.slice(offset, offset + limit)
    return {
      ok: true,
      total,
      offset,
      limit,
      returned: page.length,
      entries: page.map(entrySummary),
      hint: '列表只返回预览；点击条目后调用 GET /api/knowledge/entries/:id 读取全文。',
    }
  }

  /** 知识库页面：读取单条知识全文与历史版本摘要。 */
  const getEntry = input => {
    const id = asString(input.id || input.entry_id).trim()
    if (!id) return errorResult('MISSING_ID', '缺少知识条目 ID。')
    const result = readEntry({
      id,
      max_chars: clampNumber(input.max_chars ?? input.maxChars, 200, 80000, 80000),
      history: input.history !== false,
      history_limit: clampNumber(input.history_limit ?? input.historyLimit, 1, 50, 20),
    })
    const entry = result?.entries?.[0]
    if (!result?.ok || !entry?.ok) return errorResult('NOT_FOUND', entry?.error || `知识条目不存在：${id}`)
    return { ok: true, entry }
  }

  const history = input => {
    const id = asString(input.id || input.entry_id).trim()
    if (!id) return errorResult('MISSING_ID', '缺少 id。')
    const entry = store.get(id)
    if (!entry) return errorResult('NOT_FOUND', '知识条目不存在。')
    const limit = clampNumber(input.limit, 1, 50, 10)
    return {
      ok: true,
      id,
      title: entry.title,
      current_revision: entry.revision,
      history: store.historyOf(id, { limit }).map(item => ({
        revision: item.revision,
        path: item.path,
        title: item.title,
        content_length: asString(item.content).length,
        created_at: item.created_at,
        reason: item.reason,
      })),
    }
  }

  const service = {
    name: 'knowledge-base',
    write: writeEntry,
    edit: editEntry,
    read: readEntry,
    search: searchEntries,
    delete: deleteEntries,
    tree,
    history,
    stats: () => ({ ...store.stats(), embedding: resolveEmbeddingConfig(), autoEmbed: pluginConfig.autoEmbed !== false }),
    close: () => store.close(),
  }

  ctx.provide('knowledge-base', service, { type: 'singleton' })

  const readJsonBody = (req, maxBytes = 32 * 1024 * 1024) => httpApi.readBody(req, maxBytes)
  const respond = (res, result, status = 200) => httpApi.sendJson(res, status, result)

  const routeDisposers = []
  const kbRoute = (...args) => {
    const dispose = httpApi.route(...args)
    routeDisposers.push(dispose)
    return dispose
  }

  kbRoute('GET', '/api/knowledge/status', async (req, res) => {
    respond(res, {
      ok: true,
      ...service.stats(),
      storage: store.stats(),
      config: { autoEmbed: pluginConfig.autoEmbed !== false },
    })
  })

  kbRoute('GET', '/api/knowledge/config', async (req, res) => {
    respond(res, { ok: true, config: { ...pluginConfig }, embedding: resolveEmbeddingConfig() })
  })

  kbRoute('PUT', '/api/knowledge/config', async (req, res) => {
    try {
      const body = await readJsonBody(req, 1024 * 1024)
      if (body.autoEmbed !== undefined) pluginConfig.autoEmbed = body.autoEmbed !== false
      if (body.embeddingProvider !== undefined) pluginConfig.embeddingProvider = asString(body.embeddingProvider).trim()
      if (body.embeddingModel !== undefined) pluginConfig.embeddingModel = asString(body.embeddingModel).trim()
      persistConfig()
      respond(res, { ok: true, config: { ...pluginConfig } })
    } catch (err) {
      respond(res, errorResult('CONFIG_FAILED', err?.message || '配置保存失败'))
    }
  })

  /** 知识库页面：浏览 / 搜索知识条目列表（只含预览）。 */
  kbRoute('GET', '/api/knowledge/entries', async (req, res, params, url) => {
    try {
      const query = url?.searchParams
      respond(
        res,
        listEntries({
          q: query?.get('q') || query?.get('query') || '',
          path: query?.get('path') || query?.get('pathPrefix') || query?.get('path_prefix') || '',
          tags: query?.get('tags') || '',
          tag_mode: query?.get('tagMode') || query?.get('tag_mode') || 'all',
          time_start: query?.get('timeStart') || query?.get('time_start') || '',
          time_end: query?.get('timeEnd') || query?.get('time_end') || '',
          limit: query?.get('limit') || '',
          offset: query?.get('offset') || '',
        }),
      )
    } catch (err) {
      respond(res, errorResult('LIST_FAILED', err?.message || '知识条目读取失败'))
    }
  })

  /** 知识库页面：读取单条知识全文与历史版本摘要。 */
  kbRoute('GET', '/api/knowledge/entries/:id', async (req, res, params) => {
    try {
      const result = getEntry({ id: params.id, history: true })
      respond(res, result, result.ok === false ? 404 : 200)
    } catch (err) {
      respond(res, errorResult('READ_FAILED', err?.message || '知识条目读取失败'))
    }
  })

  kbRoute('POST', '/api/knowledge/write', async (req, res) => {
    try {
      respond(res, await writeEntry(await readJsonBody(req)))
    } catch (err) {
      respond(res, errorResult('WRITE_FAILED', err?.message || '写入失败'))
    }
  })

  kbRoute('POST', '/api/knowledge/edit', async (req, res) => {
    try {
      respond(res, await editEntry(await readJsonBody(req)))
    } catch (err) {
      respond(res, errorResult('EDIT_FAILED', err?.message || '编辑失败'))
    }
  })

  kbRoute('POST', '/api/knowledge/read', async (req, res) => {
    try {
      respond(res, readEntry(await readJsonBody(req)))
    } catch (err) {
      respond(res, errorResult('READ_FAILED', err?.message || '读取失败'))
    }
  })

  kbRoute('POST', '/api/knowledge/search', async (req, res) => {
    try {
      respond(res, await searchEntries(await readJsonBody(req)))
    } catch (err) {
      respond(res, errorResult('SEARCH_FAILED', err?.message || '检索失败'))
    }
  })

  kbRoute('POST', '/api/knowledge/tree', async (req, res) => {
    try {
      respond(res, tree(await readJsonBody(req)))
    } catch (err) {
      respond(res, errorResult('TREE_FAILED', err?.message || '目录读取失败'))
    }
  })

  kbRoute('POST', '/api/knowledge/history', async (req, res) => {
    try {
      respond(res, history(await readJsonBody(req)))
    } catch (err) {
      respond(res, errorResult('HISTORY_FAILED', err?.message || '历史读取失败'))
    }
  })

  kbRoute('POST', '/api/knowledge/delete', async (req, res) => {
    try {
      respond(res, deleteEntries(await readJsonBody(req)))
    } catch (err) {
      respond(res, errorResult('DELETE_FAILED', err?.message || '删除失败'))
    }
  })

  httpApi.registerCapability?.('knowledge-base')
  ctx.effect?.(() => () => {
    for (const dispose of routeDisposers) {
      try { dispose?.() } catch (_) { /* ignore */ }
    }
  })

  ctx.effect?.(() => () => service.close())
  ctx.logger.info(`知识库就绪（${store.driver} · ${store.stats().active} 条有效知识）`)
}
