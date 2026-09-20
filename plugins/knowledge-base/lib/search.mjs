/*
 * 念风chat · 独立扩展 · 知识库
 * 纯本地检索：BM25 + 可选向量 + RRF 融合；不依赖外部服务。
 */

const BM25_K1 = 1.5
const BM25_B = 0.75
const RRF_K = 60

export function bm25Rank(entries, queryTokens) {
  const docs = entries.map(entry => ({
    entry,
    tokens: String(entry.search_tokens || '')
      .split(' ')
      .filter(Boolean),
  }))
  const docCount = docs.length || 1
  const avgLen = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docCount || 1
  const df = new Map()
  for (const doc of docs) {
    for (const token of new Set(doc.tokens)) df.set(token, (df.get(token) || 0) + 1)
  }
  const uniqueQuery = [...new Set(queryTokens || [])]
  const scored = docs.map(doc => {
    const tf = new Map()
    for (const token of doc.tokens) tf.set(token, (tf.get(token) || 0) + 1)
    let score = 0
    for (const term of uniqueQuery) {
      const freq = tf.get(term) || 0
      if (!freq) continue
      const n = df.get(term) || 0
      const idf = Math.log(1 + (docCount - n + 0.5) / (n + 0.5))
      score += idf * ((freq * (BM25_K1 + 1)) / (freq + BM25_K1 * (1 - BM25_B + BM25_B * (doc.tokens.length / avgLen))))
    }
    return { entry: doc.entry, score }
  })
  return scored.sort((a, b) => b.score - a.score)
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return null
  let dot = 0
  let normLeft = 0
  let normRight = 0
  for (let i = 0; i < left.length; i += 1) {
    const a = Number(left[i]) || 0
    const b = Number(right[i]) || 0
    dot += a * b
    normLeft += a * a
    normRight += b * b
  }
  if (!normLeft || !normRight) return 0
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight))
}

/**
 * 返回 [{ entry, score, keyword_score, vector_score }]。
 * queryTokens 为空、也没有 queryEmbedding 时按更新时间倒序，便于“只看目录/标签”。
 */
export function hybridRank(entries, { queryTokens = [], queryEmbedding = null } = {}) {
  const hasTokens = queryTokens.length > 0
  const keywordRanked = hasTokens ? bm25Rank(entries, queryTokens) : []
  const keywordRank = new Map(keywordRanked.map((item, index) => [item.entry.id, { score: item.score, rank: index }]))

  const vectorRanked = []
  if (Array.isArray(queryEmbedding) && queryEmbedding.length) {
    for (const entry of entries) {
      const score = cosineSimilarity(entry.embedding, queryEmbedding)
      if (score === null) continue
      vectorRanked.push({ entry, score })
    }
    vectorRanked.sort((a, b) => b.score - a.score)
  }
  const vectorRank = new Map(vectorRanked.map((item, index) => [item.entry.id, { score: item.score, rank: index }]))

  const hasVector = vectorRank.size > 0
  if (!hasTokens && !hasVector) {
    return [...entries]
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .map((entry, index) => ({ entry, score: 0, keyword_score: 0, vector_score: null, keyword_rank: index, vector_rank: null }))
  }

  const ids = new Set([...keywordRank.keys(), ...vectorRank.keys()])
  const fused = []
  for (const id of ids) {
    const entry = entries.find(item => item.id === id)
    if (!entry) continue
    const keyword = keywordRank.get(id)
    const vector = vectorRank.get(id)
    const rrfScore =
      (keyword ? 1 / (RRF_K + keyword.rank + 1) : 0) +
      (hasVector && vector ? 1 / (RRF_K + vector.rank + 1) : 0)
    fused.push({
      entry,
      score: rrfScore,
      keyword_score: keyword?.score || 0,
      vector_score: vector?.score ?? null,
      keyword_rank: keyword?.rank ?? null,
      vector_rank: vector?.rank ?? null,
    })
  }
  return fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return String(b.entry.updated_at || '').localeCompare(String(a.entry.updated_at || ''))
  })
}

export function previewContent(content, maxChars = 360) {
  const text = String(content || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function withinPrefix(path, prefix) {
  if (!prefix) return true
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * 目录树：不建目录表，从条目 path 反推。
 * 返回范围内的目录（带条目数）和当前 path 下的直接条目。
 */
export function buildTree(entries, { prefix = '', depth = 2, limit = 200, includeEntries = true } = {}) {
  const rootPrefix = String(prefix || '')
  const maxDepth = Math.max(0, Math.min(6, Number(depth) || 2))
  const maxItems = Math.max(1, Math.min(500, Number(limit) || 200))
  const directorySet = new Set([''])
  for (const entry of entries) {
    const segments = String(entry.path || '').split('/').filter(Boolean)
    let path = ''
    for (let i = 0; i < segments.length; i += 1) {
      path = path ? `${path}/${segments[i]}` : segments[i]
      directorySet.add(path)
    }
  }
  const directories = [...directorySet]
    .filter(path => withinPrefix(path, rootPrefix))
    .filter(path => {
      const relative = rootPrefix ? path.slice(rootPrefix.length).replace(/^\//, '') : path
      const level = relative ? relative.split('/').length : 0
      return level <= maxDepth
    })
    .filter(path => path !== rootPrefix || !rootPrefix)
    .map(path => {
      const direct = Number(path.split('/').filter(Boolean).length)
      const entryCount = entries.filter(entry => withinPrefix(entry.path || '', path)).length
      const childDirs = [...directorySet].filter(
        item => item !== path && withinPrefix(item, path) && item.split('/').filter(Boolean).length === direct + 1,
      ).length
      return {
        path,
        name: path ? path.split('/').at(-1) : '根目录',
        depth: direct,
        entry_count: entryCount,
        subdirectory_count: childDirs,
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, maxItems)

  const directEntries = includeEntries
    ? entries
        .filter(entry => (entry.path || '') === rootPrefix)
        .slice(0, maxItems)
        .map(entry => ({
          id: entry.id,
          title: entry.title,
          tags: entry.tags || [],
          revision: entry.revision,
          updated_at: entry.updated_at,
        }))
    : []

  return { root: rootPrefix, directories, entries: directEntries }
}
