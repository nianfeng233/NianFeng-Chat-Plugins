/*
 * 念风chat · 独立扩展 · 知识库（前端工具层）
 *
 * 给模型提供一组本地知识库工具：
 *   kb_search  本地混合检索（关键词 + 语义 + 标签 + 目录 + 时间）
 *   kb_read    读取条目全文 / 分段 / 历史摘要
 *   kb_write   写入新条目或按 path+title 更新
 *   kb_edit    编辑已有条目（正文追加/替换、增删标签、移动目录）
 *   kb_tree    查看多级目录结构，写前先看已有路径
 *   kb_delete  软删除条目 / 目录（必须先征得用户确认）
 *
 * 真正的存储和检索在同目录 bridge.mjs，数据在 <数据目录>/knowledge-base/。
 */

export const name = 'knowledge-base'
export const version = '2.0.0'
export const scope = 'both'
export const displayName = '知识库'
export const description = '工具 · 模型自维护的本地知识库：多级目录 / 标签 / 时间戳 / 历史版本 / 本地混合检索；可在「记忆与知识库」页面浏览条目全文。'
export const author = '念风扩展'
export const icon = '📚'
export const core = false
export const enabled = true
export const depends = {
  'tool-registry': '^1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
}
export const inject = ['tool-registry', 'api?']
export const provides = [{ name: 'knowledge-base-tools', type: 'singleton' }]
export const permissions = []

export function apply(ctx) {
  const registry = ctx.inject('tool-registry')
  const api = () => ctx.registry.get('api')

  const call = async (path, body = {}) => {
    const client = api()
    if (!client?.post) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用，无法访问本地知识库。' }
    try {
      return await client.post(path, body, { timeoutMs: 120000 })
    } catch (err) {
      return { ok: false, code: 'KNOWLEDGE_BACKEND_ERROR', error: `知识库后端请求失败：${err?.message || err}` }
    }
  }

  const kbSearch = (args = {}) => call('/knowledge/search', args)
  const kbRead = (args = {}) => call('/knowledge/read', args)
  const kbWrite = (args = {}) => call('/knowledge/write', args)
  const kbEdit = (args = {}) => call('/knowledge/edit', args)
  const kbTree = (args = {}) => call('/knowledge/tree', args)
  const kbDelete = (args = {}) => call('/knowledge/delete', args)

  const disposers = [
    registry.register(
      'kb_search',
      {
        description:
          '在本地知识库中检索已保存的知识条目，适合个人资料、世界观、设定、专有名词、用户教过并要求记住的内容。支持关键词、语义、目录前缀、标签、时间过滤；只返回预览和 ID，全文用 kb_read。写入前先用它查重。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词查询；中文按二元组、英文按单词匹配。' },
            semantic: { type: 'string', description: '可选语义描述；配置了向量模型时会与关键词结果 RRF 融合，找不到精确词时优先用它。' },
            path_prefix: { type: 'string', description: '可选目录前缀，如“崩坏：星穹铁道/星神”，搜索该目录及其所有子目录。' },
            tags: { type: 'array', items: { type: 'string' }, description: '可选标签过滤。' },
            tag_mode: { type: 'string', enum: ['all', 'any'], description: '多标签匹配方式，默认 all（同时满足）。' },
            time_start: { type: 'string', description: '可选 ISO 8601 起始时间，按条目的 updated_at 过滤。' },
            time_end: { type: 'string', description: '可选 ISO 8601 结束时间，按条目的 updated_at 过滤。' },
            limit: { type: 'number', description: '返回条数，默认 5，最大 20。' },
          },
        },
      },
      kbSearch,
    ),
    registry.register(
      'kb_read',
      {
        description:
          '按条目 ID 读取知识库全文。长条目用 offset / max_chars 分段，按返回的 next_offset 续读；history=true 返回历史版本摘要。预览不够时必须读原文，不要根据预览猜内容。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'kb_search / kb_tree 返回的条目 ID。' },
            ids: { type: 'array', items: { type: 'string' }, description: '一次读取多条（最多 10 条），与 id 二选一。' },
            offset: { type: 'number', description: '从第几个字符开始读，默认 0。' },
            max_chars: { type: 'number', description: '本次最多读取的字符数，默认 12000，最大 80000。' },
            history: { type: 'boolean', description: '是否同时返回历史版本摘要（不返回历史全文）。' },
            history_limit: { type: 'number', description: '返回多少条历史摘要，默认 10，最大 50。' },
          },
        },
      },
      kbRead,
    ),
    registry.register(
      'kb_write',
      {
        description:
          '把值得长期保留的知识写入本地知识库：用户说“记住 / 存起来”的内容，或个人偏好、设定、术语、资料要点。path 用 / 分多级目录，如“崩坏：星穹铁道/星神/命途”；同 path+title 默认更新。条目要原子化，一个条目录一个主题。写前建议先 kb_search 查重、kb_tree 看目录。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '多级目录路径，例如“崩坏：星穹铁道/星神/命途”；根目录用空字符串。' },
            title: { type: 'string', description: '条目标题，例如“毁灭星神”，同一目录下唯一。' },
            content: { type: 'string', description: '知识正文，Markdown / 纯文本都可以。' },
            tags: { type: 'array', items: { type: 'string' }, description: '可选标签，如 ["星神","毁灭","设定"]。' },
            metadata: { type: 'object', description: '可选结构化元数据，如 { "来源": "用户口述", "可信度": "高" }。' },
            id: { type: 'string', description: '可选；编辑已有条目时传 ID，明确覆盖同 ID 条目。' },
            mode: { type: 'string', enum: ['upsert', 'create'], description: '默认 upsert（同 path+title 更新）；create 表示发现重复时报错。' },
            reason: { type: 'string', description: '可选写入原因，便于以后看历史。' },
          },
          required: ['title', 'content'],
        },
      },
      kbWrite,
    ),
    registry.register(
      'kb_edit',
      {
        description:
          '编辑已有知识条目（先用 kb_search / kb_read 找 ID）：可改标题、目录、正文（replace / append / prepend）、标签和 metadata；每次编辑保留历史。只读不改时不要调用。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '要编辑的条目 ID。' },
            title: { type: 'string', description: '可选，新标题。' },
            path: { type: 'string', description: '可选，新目录路径；用于移动条目。' },
            content: { type: 'string', description: '可选，正文内容。' },
            content_mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: '正文处理方式，默认 replace。' },
            tags: { type: 'array', items: { type: 'string' }, description: '可选，整体替换标签。' },
            add_tags: { type: 'array', items: { type: 'string' }, description: '可选，追加标签。' },
            remove_tags: { type: 'array', items: { type: 'string' }, description: '可选，移除标签。' },
            metadata: { type: 'object', description: '可选，整体替换 metadata。' },
            reason: { type: 'string', description: '可选编辑原因。' },
          },
          required: ['id'],
        },
      },
      kbEdit,
    ),
    registry.register(
      'kb_tree',
      {
        description:
          '查看知识库多级目录和当前目录下的直接条目。写新条目前先看已有路径，复用目录、避免建出多个近义目录；目录由条目的 path 自动形成，不需要手动创建。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要看哪个目录，默认根目录；例如“崩坏：星穹铁道”。' },
            depth: { type: 'number', description: '向下展开的层级数，默认 2，最大 6。' },
            limit: { type: 'number', description: '最多返回多少个目录 / 条目，默认 200。' },
            include_entries: { type: 'boolean', description: '是否返回当前目录下直接条目，默认 true。' },
          },
        },
      },
      kbTree,
    ),
    registry.register(
      'kb_delete',
      {
        description:
          '软删除知识条目或整个目录。删除前必须先向用户确认；只有用户明确同意后才能传 confirm=true。目录删除传 recursive=true 会连同子目录一起删除；不传只匹配路径完全相同的条目。删除后默认不再出现在检索中，历史版本仍保留。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '要删除的条目 ID；与 path 二选一。' },
            path: { type: 'string', description: '要删除的目录路径；与 id 二选一。' },
            recursive: { type: 'boolean', description: '按目录删除时是否包含子目录，默认 true。' },
            confirm: { type: 'boolean', description: '用户确认删除后传 true，否则会被拒绝。' },
            reason: { type: 'string', description: '可选删除原因。' },
          },
        },
      },
      kbDelete,
    ),
  ]

  const service = {
    name: 'knowledge-base',
    definitions: () => registry.definitions(),
    names: () => registry.names(),
    execute: (name, args, context) => registry.execute(name, args, context),
  }

  ctx.provide('knowledge-base-tools', service, { type: 'singleton' })
  ctx.effect(() => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (_) {
        /* ignore */
      }
    }
  })

  ctx.logger.debug(`知识库工具就绪（${registry.names().length} 个工具）`)
}
