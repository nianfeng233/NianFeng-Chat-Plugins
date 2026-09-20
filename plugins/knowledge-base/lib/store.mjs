/*
 * 念风chat · 独立扩展 · 知识库
 * 本地知识库存储层：SQLite 优先，旧 Node 回退 JSON。
 *
 * 数据模型：
 *   kb_entries  当前有效条目（status=active/deleted）
 *   kb_history  每次编辑前的历史版本（每个条目最多保留 50 版）
 *
 * 目录不用单独建表：path="崩坏：星穹铁道/星神/命途"，
 * 中间层级由 path 前缀自然形成；写入时自动“建目录”。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

let DatabaseSyncClass = null
try {
  const sqlite = await import('node:sqlite')
  DatabaseSyncClass = sqlite.DatabaseSync || null
} catch (_) {
  DatabaseSyncClass = null
}

export const DEFAULT_MAX_CONTENT = 200 * 1024
export const MAX_TITLE_LEN = 200
export const MAX_TAG_LEN = 60
export const MAX_TAGS = 40
export const MAX_PATH_DEPTH = 12
export const HISTORY_LIMIT_PER_ENTRY = 50

const nowIso = () => new Date().toISOString()

const asString = value => String(value ?? '')

function safeJsonParse(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch (_) {
    return fallback
  }
}

export function normalizePath(input) {
  const raw = asString(input).replace(/\\/g, '/').trim()
  const parts = raw
    .split('/')
    .map(part => part.replace(/[\u0000-\u001f]/g, '').trim())
    .filter(Boolean)
  const out = []
  for (const part of parts) {
    if (part === '.' || part === '..') continue
    out.push(part.slice(0, 120))
  }
  return out.slice(0, MAX_PATH_DEPTH).join('/')
}

export function normalizeTitle(input, content = '') {
  let title = asString(input).replace(/[\u0000-\u001f]/g, '').trim()
  if (!title) {
    const firstLine = asString(content)
      .split(/\r?\n/)
      .map(line => line.replace(/^#+\s*/, '').trim())
      .find(Boolean)
    title = firstLine ? firstLine.slice(0, 40) : '未命名条目'
  }
  return title.slice(0, MAX_TITLE_LEN)
}

export function normalizeTags(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，、\s]+/)
      : []
  const out = []
  for (const item of raw) {
    const tag = asString(item).replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_TAG_LEN)
    if (!tag || out.some(existing => existing.toLowerCase() === tag.toLowerCase())) continue
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

export function normalizeMeta(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  try {
    const clone = JSON.parse(JSON.stringify(input))
    return JSON.stringify(clone).length > 32 * 1024 ? {} : clone
  } catch (_) {
    return {}
  }
}

/**
 * 中文按二元组、英文按单词切分。
 * 索引同时保留单字兜底；查询侧优先二元组，精确性更高。
 */
export function tokenizeForIndex(text) {
  const raw = asString(text).toLowerCase()
  const tokens = []
  const cjkRuns = raw.match(/[\u3400-\u9fff]+/g) || []
  for (const run of cjkRuns) {
    const chars = [...run]
    if (chars.length === 1) {
      tokens.push(chars[0])
      continue
    }
    for (let i = 0; i < chars.length; i += 1) {
      if (i < chars.length - 1) tokens.push(chars[i] + chars[i + 1])
      else tokens.push(chars[i])
    }
  }
  for (const word of raw.match(/[a-z0-9][a-z0-9._+#@-]{1,63}/g) || []) tokens.push(word)
  return tokens
}

export function tokenizeQuery(text) {
  const raw = asString(text).toLowerCase()
  const tokens = []
  const cjkRuns = raw.match(/[\u3400-\u9fff]+/g) || []
  for (const run of cjkRuns) {
    const chars = [...run]
    if (chars.length === 1) {
      tokens.push(chars[0])
      continue
    }
    for (let i = 0; i < chars.length - 1; i += 1) tokens.push(chars[i] + chars[i + 1])
  }
  for (const word of raw.match(/[a-z0-9][a-z0-9._+#@-]{1,63}/g) || []) tokens.push(word)
  return [...new Set(tokens)]
}

export function weightedSearchTokens(entry) {
  const title = tokenizeForIndex(entry.title)
  const tags = tokenizeForIndex((entry.tags || []).join(' '))
  const path = tokenizeForIndex(entry.path)
  const content = tokenizeForIndex(asString(entry.content).slice(0, 40000))
  const out = []
  // 用重复次数做字段权重：标题 6、标签 4、路径 3、正文 1。
  for (let i = 0; i < 6; i += 1) out.push(...title)
  for (let i = 0; i < 4; i += 1) out.push(...tags)
  for (let i = 0; i < 3; i += 1) out.push(...path)
  out.push(...content)
  return out
}

function fieldsFromRow(row) {
  const tags = safeJsonParse(row.tags, [])
  const meta = safeJsonParse(row.meta, {})
  const embedding = safeJsonParse(row.embedding, [])
  return {
    id: row.id,
    path: row.path || '',
    title: row.title || '未命名条目',
    content: row.content || '',
    tags: Array.isArray(tags) ? tags : [],
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
    status: row.status || 'active',
    revision: Number(row.revision) || 1,
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
    accessed_at: row.accessed_at || '',
    deleted_at: row.deleted_at || '',
    embedding: Array.isArray(embedding) ? embedding : [],
    embedding_provider: row.embedding_provider || '',
    embedding_model: row.embedding_model || '',
    embedding_dim: Number(row.embedding_dim) || 0,
    search_tokens: row.search_tokens || '',
  }
}

export class KnowledgeStore {
  constructor(dataDir, logger) {
    this.logger = logger
    this.entries = new Map()
    this.history = new Map() // entryId -> [{ revision, ... }]
    mkdirSync(dataDir, { recursive: true })
    if (DatabaseSyncClass) {
      this.driver = 'sqlite'
      this.file = join(dataDir, 'knowledge.db')
      this.db = new DatabaseSyncClass(this.file)
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS kb_entries (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          meta TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active',
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          accessed_at TEXT NOT NULL DEFAULT '',
          deleted_at TEXT NOT NULL DEFAULT '',
          search_tokens TEXT NOT NULL DEFAULT '',
          embedding TEXT NOT NULL DEFAULT '[]',
          embedding_provider TEXT NOT NULL DEFAULT '',
          embedding_model TEXT NOT NULL DEFAULT '',
          embedding_dim INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_kb_entries_path ON kb_entries(path);
        CREATE INDEX IF NOT EXISTS idx_kb_entries_status_updated ON kb_entries(status, updated_at);
        CREATE TABLE IF NOT EXISTS kb_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          path TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          meta TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_kb_history_entry ON kb_history(entry_id, revision);
      `)
      this.loadSqlite()
    } else {
      this.driver = 'json'
      this.file = join(dataDir, 'knowledge.json')
      this.loadJson()
    }
  }

  loadSqlite() {
    const rows = this.db.prepare('SELECT * FROM kb_entries').all()
    this.entries.clear()
    for (const row of rows) {
      const entry = fieldsFromRow(row)
      if (!entry.search_tokens) entry.search_tokens = weightedSearchTokens(entry).join(' ')
      this.entries.set(entry.id, entry)
    }
    const historyRows = this.db
      .prepare('SELECT * FROM kb_history ORDER BY entry_id ASC, revision DESC')
      .all()
    this.history.clear()
    for (const row of historyRows) {
      const list = this.history.get(row.entry_id) || []
      if (list.length >= HISTORY_LIMIT_PER_ENTRY) continue
      list.push({
        revision: Number(row.revision) || 1,
        path: row.path || '',
        title: row.title || '',
        content: row.content || '',
        tags: safeJsonParse(row.tags, []),
        meta: safeJsonParse(row.meta, {}),
        created_at: row.created_at || '',
        reason: row.reason || '',
      })
      this.history.set(row.entry_id, list)
    }
  }

  loadJson() {
    let data = { version: 1, entries: [], history: [] }
    if (existsSync(this.file)) {
      try {
        data = JSON.parse(readFileSync(this.file, 'utf8'))
      } catch (err) {
        this.logger?.warn?.(`[knowledge] knowledge.json 损坏，已重置：${err?.message || err}`)
      }
    }
    this.entries.clear()
    for (const raw of Array.isArray(data?.entries) ? data.entries : []) {
      const entry = {
        id: asString(raw.id) || `kb_${randomUUID()}`,
        path: normalizePath(raw.path),
        title: normalizeTitle(raw.title, raw.content),
        content: asString(raw.content).slice(0, DEFAULT_MAX_CONTENT),
        tags: normalizeTags(raw.tags),
        meta: normalizeMeta(raw.meta),
        status: raw.status === 'deleted' ? 'deleted' : 'active',
        revision: Number(raw.revision) || 1,
        created_at: raw.created_at || nowIso(),
        updated_at: raw.updated_at || raw.created_at || nowIso(),
        accessed_at: raw.accessed_at || '',
        deleted_at: raw.deleted_at || '',
        embedding: Array.isArray(raw.embedding) ? raw.embedding : [],
        embedding_provider: raw.embedding_provider || '',
        embedding_model: raw.embedding_model || '',
        embedding_dim: Number(raw.embedding_dim) || 0,
        search_tokens: raw.search_tokens || '',
      }
      if (!entry.search_tokens) entry.search_tokens = weightedSearchTokens(entry).join(' ')
      this.entries.set(entry.id, entry)
    }
    this.history.clear()
    for (const raw of Array.isArray(data?.history) ? data.history : []) {
      const entryId = asString(raw.entry_id || raw.entryId)
      if (!entryId) continue
      const list = this.history.get(entryId) || []
      if (list.length >= HISTORY_LIMIT_PER_ENTRY) continue
      list.push({
        revision: Number(raw.revision) || 1,
        path: raw.path || '',
        title: raw.title || '',
        content: raw.content || '',
        tags: normalizeTags(raw.tags),
        meta: normalizeMeta(raw.meta),
        created_at: raw.created_at || nowIso(),
        reason: raw.reason || '',
      })
      this.history.set(entryId, list)
    }
  }

  persistEntry(entry) {
    if (this.driver === 'sqlite') {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO kb_entries (
            id, path, title, content, tags, meta, status, revision,
            created_at, updated_at, accessed_at, deleted_at, search_tokens,
            embedding, embedding_provider, embedding_model, embedding_dim
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.path,
          entry.title,
          entry.content,
          JSON.stringify(entry.tags || []),
          JSON.stringify(entry.meta || {}),
          entry.status || 'active',
          entry.revision || 1,
          entry.created_at,
          entry.updated_at,
          entry.accessed_at || '',
          entry.deleted_at || '',
          entry.search_tokens || '',
          JSON.stringify(entry.embedding || []),
          entry.embedding_provider || '',
          entry.embedding_model || '',
          entry.embedding_dim || 0,
        )
    } else {
      this.persistJson()
    }
  }

  persistHistory(entryId, revision) {
    if (this.driver === 'sqlite') {
      const list = this.history.get(entryId) || []
      const record = list.find(item => item.revision === revision)
      if (!record) return
      this.db
        .prepare(
          `INSERT OR REPLACE INTO kb_history (entry_id, revision, path, title, content, tags, meta, created_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entryId,
          revision,
          record.path || '',
          record.title || '',
          record.content || '',
          JSON.stringify(record.tags || []),
          JSON.stringify(record.meta || {}),
          record.created_at || nowIso(),
          record.reason || '',
        )
      const oldRows = this.db
        .prepare('SELECT id FROM kb_history WHERE entry_id = ? ORDER BY revision DESC LIMIT -1 OFFSET ?')
        .all(entryId, HISTORY_LIMIT_PER_ENTRY)
      for (const row of oldRows) this.db.prepare('DELETE FROM kb_history WHERE id = ?').run(row.id)
    } else {
      this.persistJson()
    }
  }

  persistJson() {
    try {
      const tmp = `${this.file}.tmp`
      const entries = [...this.entries.values()]
      const history = []
      for (const [entryId, list] of this.history) {
        for (const item of list) history.push({ entry_id: entryId, ...item })
      }
      writeFileSync(tmp, JSON.stringify({ version: 1, entries, history }, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      this.logger?.warn?.(`[knowledge] 写入 knowledge.json 失败：${err?.message || err}`)
    }
  }

  list({ includeDeleted = false } = {}) {
    return [...this.entries.values()].filter(entry => includeDeleted || entry.status !== 'deleted')
  }

  get(id) {
    return this.entries.get(String(id || '')) || null
  }

  findByPathTitle(path, title) {
    const wantedPath = normalizePath(path)
    const wantedTitle = normalizeTitle(title)
    return (
      [...this.entries.values()].find(
        entry =>
          entry.status !== 'deleted' &&
          entry.path === wantedPath &&
          entry.title.toLowerCase() === wantedTitle.toLowerCase(),
      ) || null
    )
  }

  saveEntry(entry, { reason = '', previous = null } = {}) {
    entry.search_tokens = weightedSearchTokens(entry).join(' ')
    if (previous && previous.revision) {
      const list = this.history.get(entry.id) || []
      list.unshift({
        revision: previous.revision,
        path: previous.path,
        title: previous.title,
        content: previous.content,
        tags: [...(previous.tags || [])],
        meta: { ...(previous.meta || {}) },
        created_at: nowIso(),
        reason: asString(reason).slice(0, 200),
      })
      this.history.set(entry.id, list.slice(0, HISTORY_LIMIT_PER_ENTRY))
      this.persistHistory(entry.id, previous.revision)
    }
    this.entries.set(entry.id, entry)
    this.persistEntry(entry)
    return entry
  }

  updateAccess(id) {
    const entry = this.get(id)
    if (!entry) return
    entry.accessed_at = nowIso()
    this.persistEntry(entry)
  }

  deleteEntry(entry, reason = '') {
    const previous = { ...entry, tags: [...entry.tags], meta: { ...entry.meta } }
    entry.status = 'deleted'
    entry.deleted_at = nowIso()
    entry.updated_at = nowIso()
    entry.revision = (Number(entry.revision) || 1) + 1
    this.saveEntry(entry, { reason: reason || 'delete', previous })
    return entry
  }

  historyOf(id, { limit = 10 } = {}) {
    const list = this.history.get(String(id || '')) || []
    return list.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))
  }

  stats() {
    const entries = [...this.entries.values()]
    return {
      driver: this.driver,
      file: this.file,
      active: entries.filter(entry => entry.status !== 'deleted').length,
      deleted: entries.filter(entry => entry.status === 'deleted').length,
      revisions: [...this.history.values()].reduce((sum, list) => sum + list.length, 0),
    }
  }

  close() {
    try {
      this.db?.close?.()
    } catch (_) {
      /* ignore */
    }
  }
}
