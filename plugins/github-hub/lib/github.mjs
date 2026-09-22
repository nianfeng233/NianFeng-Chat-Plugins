/*
 * 念风chat · 扩展插件 · github-hub
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * GitHub URL 解析、事件归一化与渠道通知文案。纯函数，前端 / 后端桥共用。
 */

import { oneLine, truncate } from './util.mjs'

export const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'gist.github.com'])
export const EVENT_FILTER_KEYS = ['issues', 'issueComments', 'push', 'releases', 'pullRequests', 'create', 'delete', 'fork', 'star']
export const DEFAULT_EVENT_FILTERS = {
  issues: true,
  issueComments: true,
  push: true,
  releases: true,
  pullRequests: true,
  create: false,
  delete: false,
  fork: false,
  star: false,
}
export const EVENT_FILTER_LABELS = {
  issues: 'Issue',
  issueComments: 'Issue 评论',
  push: '分支更新',
  releases: 'Release',
  pullRequests: 'Pull Request',
  create: '新建分支/标签',
  delete: '删除分支/标签',
  fork: 'Fork',
  star: 'Star',
}

export const normalizeEventFilters = value => {
  const out = { ...DEFAULT_EVENT_FILTERS }
  for (const key of EVENT_FILTER_KEYS) {
    if (value && value[key] !== undefined) out[key] = value[key] === true
  }
  return out
}

export const normalizeRepoFullName = input => {
  const text = String(input ?? '').trim()
  if (!text) return ''
  const cleaned = text
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[?#].*$/, '')
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(cleaned)
  if (!match) return ''
  return `${match[1]}/${match[2]}`
}

export const isValidRepoFullName = value => !!normalizeRepoFullName(value)

/**
 * 解析 GitHub 链接。
 * @returns {null | {kind:string, owner:string, repo:string, number?:number, sha?:string, tag?:string, user?:string, gistId?:string, htmlUrl:string, canonicalUrl:string, branch?:string, path?:string}}
 */
export const parseGithubUrl = input => {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw.replace(/\.git$/i, ''))
  if (shorthand) {
    return {
      kind: 'repo',
      owner: shorthand[1],
      repo: shorthand[2],
      htmlUrl: `https://github.com/${shorthand[1]}/${shorthand[2]}`,
      canonicalUrl: `https://github.com/${shorthand[1]}/${shorthand[2]}`,
    }
  }
  let url
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch (_) {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host === 'gist.github.com') {
    const gistId = url.pathname.split('/').filter(Boolean)[0] || ''
    if (!gistId) return null
    return { kind: 'gist', gistId, htmlUrl: `https://gist.github.com/${gistId}`, canonicalUrl: `https://gist.github.com/${gistId}` }
  }
  if (!GITHUB_HOSTS.has(host)) return null
  const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
  if (!segments.length) return null
  const owner = segments[0]
  const repo = segments[1]
  if (!repo) {
    return { kind: 'user', user: owner, owner, htmlUrl: `https://github.com/${owner}`, canonicalUrl: `https://github.com/${owner}` }
  }
  const base = { owner, repo, htmlUrl: `https://github.com/${owner}/${repo}`, canonicalUrl: `https://github.com/${owner}/${repo}` }
  const rest = segments.slice(2)
  const sub = String(rest[0] || '').toLowerCase()
  if (!sub) return { ...base, kind: 'repo' }
  if ((sub === 'issues' || sub === 'pull') && /^\d+$/.test(String(rest[1] || ''))) {
    const number = Number(rest[1])
    const kind = sub === 'pull' ? 'pull' : 'issue'
    return {
      ...base,
      kind,
      number,
      htmlUrl: `https://github.com/${owner}/${repo}/${sub}/${number}`,
      canonicalUrl: `https://github.com/${owner}/${repo}/${sub}/${number}`,
    }
  }
  if (sub === 'commit' && rest[1]) {
    const sha = String(rest[1]).replace(/[^0-9a-f]/gi, '').slice(0, 40)
    if (!sha) return { ...base, kind: 'repo' }
    return {
      ...base,
      kind: 'commit',
      sha,
      htmlUrl: `https://github.com/${owner}/${repo}/commit/${sha}`,
      canonicalUrl: `https://github.com/${owner}/${repo}/commit/${sha}`,
    }
  }
  if (sub === 'releases' && String(rest[1] || '').toLowerCase() === 'tag' && rest[2]) {
    const tag = rest.slice(2).join('/')
    return {
      ...base,
      kind: 'release',
      tag,
      htmlUrl: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`,
      canonicalUrl: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
    }
  }
  if ((sub === 'tree' || sub === 'blob') && rest[1]) {
    return {
      ...base,
      kind: 'repo',
      branch: rest[1],
      path: rest.slice(2).join('/'),
      htmlUrl: url.href,
      canonicalUrl: `https://github.com/${owner}/${repo}`,
    }
  }
  return { ...base, kind: 'repo' }
}

/**
 * 从一段聊天文本中提取 GitHub 项目 / Issue 链接。
 * 支持完整 URL，也支持 `owner/repo` 简写（简写只在没有完整 GitHub 链接时兜底）。
 */
export const extractGithubUrls = (text, max = 3) => {
  const source = String(text ?? '')
  const limit = Math.max(1, Number(max) || 1)
  const found = []
  const seen = new Set()
  const push = value => {
    const parsed = parseGithubUrl(value)
    if (!parsed) return
    const key = parsed.canonicalUrl.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push(parsed)
  }
  const urlPattern = /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[/#?][^\s<>"'`)\]}，。；、！？]*)?/gi
  let match
  while ((match = urlPattern.exec(source))) {
    let value = match[0].replace(/[.,;:!?]+$/g, '').replace(/\)+$/g, '')
    if (value && !/^https?:\/\//i.test(value)) value = `https://${value}`
    push(value)
    if (found.length >= limit) return found
  }
  const shorthandPattern = /(?:^|[\s(【（])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|[\s)】），。；、！？])/g
  while (match = shorthandPattern.exec(source)) {
    const value = match[1]
    if (/^(https?|git)$/i.test(value)) continue
    push(value)
    if (found.length >= limit) return found
  }
  return found.slice(0, limit)
}

export const resolveRepoAndNumber = (args = {}) => {
  const directNumber = Number(args.number ?? args.issue_number ?? args.issueNumber)
  const parsed = parseGithubUrl(args.url || args.link || '')
  if (parsed && (parsed.kind === 'issue' || parsed.kind === 'pull')) {
    return { repo: `${parsed.owner}/${parsed.repo}`, number: parsed.number, kind: parsed.kind, url: parsed.htmlUrl }
  }
  const fallbackRepo = parsed?.owner && parsed?.repo ? `${parsed.owner}/${parsed.repo}` : ''
  const repo = normalizeRepoFullName(args.repo || args.repository || fallbackRepo)
  if (repo && Number.isFinite(directNumber) && directNumber > 0) {
    return { repo, number: Math.floor(directNumber), kind: parsed?.kind || 'issue', url: `https://github.com/${repo}/issues/${Math.floor(directNumber)}` }
  }
  return { repo: repo || '', number: Number.isFinite(directNumber) && directNumber > 0 ? Math.floor(directNumber) : 0, kind: parsed?.kind || 'issue', url: parsed?.htmlUrl || '' }
}

export const stateLabel = value => {
  const state = String(value || '').toLowerCase()
  if (state === 'open') return 'Open'
  if (state === 'closed') return 'Closed'
  if (state === 'merged') return 'Merged'
  return state ? state[0].toUpperCase() + state.slice(1) : ''
}

export const languageColor = language => {
  const key = String(language || '').toLowerCase()
  const colors = {
    javascript: '#f1e05a',
    typescript: '#3178c6',
    python: '#3572a5',
    go: '#00add8',
    rust: '#dea584',
    java: '#b07219',
    'c++': '#f34b7d',
    c: '#555555',
    'c#': '#178600',
    php: '#4f5d95',
    ruby: '#701516',
    swift: '#f05138',
    kotlin: '#a97bff',
    html: '#e34c26',
    css: '#563d7c',
    shell: '#89e051',
    vue: '#41b883',
    dart: '#00b4ab',
    lua: '#000080',
    r: '#198ce7',
    scala: '#c22d40',
    elixir: '#6e4a7e',
    haskell: '#5e5086',
    objectivec: '#438eff',
  }
  return colors[key] || '#8250df'
}

const labelList = labels =>
  (Array.isArray(labels) ? labels : [])
    .map(label => (typeof label === 'string' ? { name: label, color: '' } : { name: String(label?.name || ''), color: String(label?.color || '') }))
    .filter(label => label.name)

const actorOf = raw =>
  raw?.actor
    ? { login: String(raw.actor.login || ''), avatarUrl: String(raw.actor.avatar_url || ''), url: String(raw.actor.html_url || '') }
    : { login: '', avatarUrl: '', url: '' }

const compactKey = (value, max = 160) => String(value ?? '').trim().slice(0, max)

/**
 * 跨来源稳定 event key。
 *
 * GitHub Events API 的 Event.id 与 Webhook 的 X-GitHub-Delivery 完全不同，
 * 同一个 Push / Issue 如果先走 Webhook 再被轮询兜底抓到，不能用来源 id 去重。
 * 这里根据 payload 中稳定的对象 id（issue.id / comment.id / after / release.id…）
 * 生成同一个事件键，轮询和 Webhook 两条链路共用，避免同一条动态推送两次。
 */
export const githubRawEventKey = raw => {
  const type = String(raw?.type || '')
  const payload = isPlainObject(raw?.payload) ? raw.payload : {}
  const repo = normalizeRepoFullName(raw?.repo?.name || '')
  if (!repo || !type) return compactKey(raw?.id || '')
  const action = compactKey(payload.action || '', 40).toLowerCase()
  const issue = payload.issue || {}
  const comment = payload.comment || {}
  const pr = payload.pull_request || {}
  const release = payload.release || {}
  const forkee = payload.forkee || {}
  const sender = payload.sender || payload.actor || raw?.actor || {}
  switch (type) {
    case 'IssuesEvent':
      // issue.number 在 Events API / Webhook 两种 payload 里都稳定存在，优先用它。
      return `${repo}:issues:${compactKey(issue.number || issue.id || '', 80)}:${action}:${compactKey(issue.updated_at || '', 40)}`
    case 'IssueCommentEvent':
      return `${repo}:issue-comment:${compactKey(comment.id || '', 80)}:${action}`
    case 'PushEvent':
      return `${repo}:push:${compactKey(payload.after || payload.head_commit?.id || payload.head_commit?.sha || '', 80)}`
    case 'ReleaseEvent':
      return `${repo}:release:${compactKey(release.id || release.tag_name || '', 80)}:${action}`
    case 'PullRequestEvent':
      return `${repo}:pull-request:${compactKey(pr.number || pr.id || '', 80)}:${action}`
    case 'CreateEvent':
    case 'DeleteEvent':
      return `${repo}:${type === 'CreateEvent' ? 'create' : 'delete'}:${compactKey(payload.ref_type || '', 30)}:${compactKey(payload.ref || '', 160)}`
    case 'ForkEvent':
      return `${repo}:fork:${compactKey(forkee.id || forkee.full_name || '', 120)}`
    case 'WatchEvent':
    case 'StarEvent':
      return `${repo}:star:${compactKey(sender.id || sender.login || '', 80)}:${action === 'deleted' || action === 'unstarred' ? 'unstarred' : 'starred'}`
    default:
      return compactKey(raw?.id || '')
  }
}

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * 把 GitHub Webhook 回调体转成与 Events API 相同的数据结构。
 * GitHub 事件名与 Events API type 的映射见 WEBHOOK_EVENT_TYPE。
 */
export const WEBHOOK_EVENT_TYPE = {
  issues: 'IssuesEvent',
  issue_comment: 'IssueCommentEvent',
  push: 'PushEvent',
  release: 'ReleaseEvent',
  pull_request: 'PullRequestEvent',
  create: 'CreateEvent',
  delete: 'DeleteEvent',
  fork: 'ForkEvent',
  watch: 'WatchEvent',
  star: 'StarEvent',
}

export const webhookEventToRaw = ({ event = '', deliveryId = '', payload = null } = {}) => {
  const type = WEBHOOK_EVENT_TYPE[String(event || '').toLowerCase()] || ''
  if (!type || !isPlainObject(payload)) return null
  const repository = isPlainObject(payload.repository) ? payload.repository : {}
  const repo = normalizeRepoFullName(repository.full_name || '')
  if (!repo) return null
  const updatedAt =
    payload.issue?.updated_at ||
    payload.comment?.updated_at ||
    payload.pull_request?.updated_at ||
    payload.release?.published_at ||
    payload.release?.created_at ||
    payload.head_commit?.timestamp ||
    payload.repository?.updated_at ||
    ''
  const createdAt = updatedAt || new Date().toISOString()
  return {
    id: compactKey(deliveryId || '', 120),
    type,
    created_at: createdAt,
    actor: isPlainObject(payload.sender)
      ? { login: payload.sender.login, avatar_url: payload.sender.avatar_url, html_url: payload.sender.html_url }
      : undefined,
    repo: {
      name: repo,
      url: String(repository.url || repository.html_url || `https://api.github.com/repos/${repo}`),
    },
    payload,
  }
}

/**
 * 把 GitHub Events API 的原始事件转成结构化事件。
 * 不支持的 event type 返回 null（轮询时仍然会记入 seen，避免重复处理）。
 */
export const normalizeGithubEvent = raw => {
  const type = String(raw?.type || '')
  const payload = raw?.payload || {}
  const repo = String(raw?.repo?.name || '')
  const repoUrl = String(raw?.repo?.url || '').replace('api.github.com/repos', 'github.com')
  const base = {
    // id 使用跨来源稳定键；apiId 仅保留来源 id 方便排查。
    id: String(raw?.dedupeKey || githubRawEventKey(raw) || raw?.id || ''),
    apiId: String(raw?.id || ''),
    source: String(raw?.source || 'events'),
    type,
    repo,
    repoUrl,
    actor: actorOf(raw),
    at: String(raw?.created_at || ''),
    time: Date.parse(String(raw?.created_at || '')) || Date.now(),
    raw: null,
  }
  const issueLike = payload.issue || {}
  const prLike = payload.pull_request || {}
  const label = payload.label ? { name: String(payload.label.name || ''), color: String(payload.label.color || '') } : null
  switch (type) {
    case 'IssuesEvent': {
      const action = String(payload.action || '')
      const actionText = { opened: '新 Issue', reopened: '重新打开 Issue', closed: '关闭了 Issue', labeled: 'Issue 标记', unlabeled: '移除 Issue 标记', assigned: '分配 Issue', edited: '编辑 Issue' }[action] || `Issue ${action}`
      return {
        ...base,
        kind: 'issue',
        action,
        actionText,
        number: Number(issueLike.number) || 0,
        title: String(issueLike.title || ''),
        url: String(issueLike.html_url || ''),
        body: String(issueLike.body || ''),
        state: String(issueLike.state || ''),
        comments: Number(issueLike.comments) || 0,
        labels: labelList(issueLike.labels),
        label: label ? { name: label.name, color: label.color } : null,
        user: String(issueLike.user?.login || ''),
      }
    }
    case 'IssueCommentEvent': {
      const action = String(payload.action || '')
      if (action !== 'created' && action !== 'edited') return null
      const comment = payload.comment || {}
      return {
        ...base,
        kind: 'issue_comment',
        action,
        actionText: action === 'created' ? '有新评论' : '编辑了评论',
        number: Number(issueLike.number) || 0,
        title: String(issueLike.title || ''),
        url: String(issueLike.html_url || ''),
        commentUrl: String(comment.html_url || ''),
        body: String(comment.body || ''),
        issueBody: String(issueLike.body || ''),
        user: String(comment.user?.login || issueLike.user?.login || ''),
        avatarUrl: String(comment.user?.avatar_url || issueLike.user?.avatar_url || ''),
        issueAuthor: String(issueLike.user?.login || ''),
        commentAuthor: String(comment.user?.login || ''),
        labels: labelList(issueLike.labels),
      }
    }
    case 'PushEvent': {
      const commits = Array.isArray(payload.commits) ? payload.commits : []
      const headCommit = payload.head_commit || commits[commits.length - 1] || {}
      const ref = String(payload.ref || '')
      const branch = ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '')
      const head = String(payload.after || headCommit.sha || '')
      const before = String(payload.before || '')
      const headMessage = String(headCommit.message || commits[commits.length - 1]?.message || '')
      const commitUrl = head && repoUrl ? `${repoUrl}/commit/${encodeURIComponent(head)}` : String(headCommit.url || '').replace('api.github.com/repos', 'github.com').replace('/commits/', '/commit/')
      const compareUrl = repoUrl && before && !/^0+$/.test(before) && before !== head ? `${repoUrl}/compare/${encodeURIComponent(before)}...${encodeURIComponent(head)}` : ''
      const branchUrl = repoUrl ? `${repoUrl}/tree/${encodeURIComponent(branch)}` : ''
      return {
        ...base,
        kind: 'push',
        action: 'pushed',
        actionText: '分支更新',
        ref,
        branch,
        /* Events API 的 summary payload 有时没有 size / commits；这里允许 0 表示未知，
         * 由后端桥再补一次 compare / commits 查询。不要默认写成 1 个提交。 */
        commitCount: Number(payload.size ?? payload.distinct_size ?? commits.length) || (headMessage ? 1 : 0),
        before,
        head,
        commitMessage: headMessage,
        commitUrl,
        compareUrl,
        // 优先指向 compare / 具体提交，读不到提交时再退回分支页面。
        url: compareUrl || commitUrl || branchUrl,
        branchUrl,
        commits: commits.slice(0, 5).map(commit => ({
          sha: String(commit.sha || '').slice(0, 7),
          message: String(commit.message || ''),
          url: String(commit.url || ''),
        })),
      }
    }
    case 'ReleaseEvent': {
      const action = String(payload.action || '')
      const release = payload.release || {}
      return {
        ...base,
        kind: 'release',
        action,
        actionText: action === 'published' ? '发布了新 Release' : action === 'created' ? '创建了 Release' : action === 'released' ? '发布了 Release' : `Release ${action}`,
        tag: String(release.tag_name || ''),
        name: String(release.name || ''),
        url: String(release.html_url || ''),
        body: String(release.body || ''),
        prerelease: release.prerelease === true,
        draft: release.draft === true,
        publishedAt: String(release.published_at || release.created_at || ''),
      }
    }
    case 'PullRequestEvent': {
      const action = String(payload.action || '')
      const actionText = { opened: '有新的 Pull Request', reopened: '重新打开 Pull Request', closed: prLike.merged ? '合并了 Pull Request' : '关闭了 Pull Request', synchronize: '更新了 Pull Request', ready_for_review: 'Pull Request 待评审', converted_to_draft: 'Pull Request 转为草稿' }[action] || `Pull Request ${action}`
      return {
        ...base,
        kind: 'pull_request',
        action,
        actionText,
        number: Number(prLike.number) || 0,
        title: String(prLike.title || ''),
        url: String(prLike.html_url || ''),
        body: String(prLike.body || ''),
        state: String(prLike.state || ''),
        merged: prLike.merged === true,
        draft: prLike.draft === true,
        comments: Number(prLike.comments) || 0,
        additions: Number(prLike.additions) || 0,
        deletions: Number(prLike.deletions) || 0,
        changedFiles: Number(prLike.changed_files) || 0,
        baseRef: String(prLike.base?.ref || ''),
        headRef: String(prLike.head?.ref || ''),
        labels: labelList(prLike.labels),
        user: String(prLike.user?.login || ''),
      }
    }
    case 'CreateEvent':
      return {
        ...base,
        kind: 'create',
        action: String(payload.action || ''),
        actionText: `创建了${payload.ref_type === 'tag' ? '标签' : '分支'}`,
        refType: String(payload.ref_type || ''),
        refName: String(payload.ref || ''),
        url: payload.ref ? `${repoUrl || `https://github.com/${repo}`}/tree/${encodeURIComponent(String(payload.ref))}` : repoUrl,
      }
    case 'DeleteEvent':
      return {
        ...base,
        kind: 'delete',
        action: String(payload.action || ''),
        actionText: `删除了${payload.ref_type === 'tag' ? '标签' : '分支'}`,
        refType: String(payload.ref_type || ''),
        refName: String(payload.ref || ''),
        url: repoUrl,
      }
    case 'ForkEvent':
      return {
        ...base,
        kind: 'fork',
        action: 'forks',
        actionText: '被 Fork',
        forkName: String(payload.forkee?.full_name || ''),
        forkUrl: String(payload.forkee?.html_url || ''),
        url: String(payload.forkee?.html_url || repoUrl),
      }
    case 'WatchEvent':
    case 'StarEvent': {
      const rawAction = String(payload.action || '').toLowerCase()
      const unstarred = rawAction === 'deleted' || rawAction === 'unstarred'
      return {
        ...base,
        kind: 'star',
        action: unstarred ? 'unstarred' : 'started',
        actionText: unstarred ? '取消了 Star' : '收到新的 Star',
        url: repoUrl,
      }
    }
    default:
      return null
  }
}

export const eventFilterKeyOfKind = kind => {
  if (kind === 'issue') return 'issues'
  if (kind === 'issue_comment') return 'issueComments'
  if (kind === 'pull_request') return 'pullRequests'
  if (kind === 'release') return 'releases'
  if (kind === 'push') return 'push'
  if (kind === 'create') return 'create'
  if (kind === 'delete') return 'delete'
  if (kind === 'fork') return 'fork'
  if (kind === 'star') return 'star'
  return ''
}

export const eventIcon = kind => {
  const icons = { issue: '📮', issue_comment: '💬', push: '🚀', release: '📦', pull_request: '🔀', create: '🌿', delete: '🧹', fork: '🍴', star: '⭐' }
  return icons[String(kind || '')] || '🔔'
}

const shortBody = (value, max = 240) => {
  const text = oneLine(value, max)
  return text || ''
}

const pad2 = value => String(value).padStart(2, '0')

const normalizeZoneName = value => {
  const text = String(value || '').trim()
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text)
  if (match) return `UTC${match[1]}${pad2(match[2])}:${match[3] || '00'}`
  return text
}

/**
 * 把 GitHub 的 UTC 时间转成通知里显示的本地时间。
 * GitHub Events API 的 created_at 永远是 UTC；GitHub 网页会按浏览器时区显示，
 * 但插件如果不转换，就会出现“通知时间戳和本地时间差 8 小时”的问题。
 * @param {string|number|Date} value
 * @param {{ timeZone?: string }} options 默认 Asia/Shanghai（念风主要面向中文用户）
 */
export const formatEventTime = (value, { timeZone = 'Asia/Shanghai' } = {}) => {
  if (value === null || value === undefined || value === '') return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const tz = String(timeZone || '').trim() || 'Asia/Shanghai'
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    }).formatToParts(date)
    const get = type => parts.find(part => part.type === type)?.value || ''
    const dateText = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
    const zoneText = normalizeZoneName(get('timeZoneName')) || tz
    return `${dateText} (${zoneText})`
  } catch (_) {
    // 极旧运行时不支持 IANA 时区 / shortOffset 时退回宿主本地时区。
    const sign = date.getTimezoneOffset() > 0 ? '-' : '+'
    const abs = Math.abs(date.getTimezoneOffset())
    const zoneText = `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())} (${zoneText})`
  }
}

/** 事件 -> 渠道通知纯文本（无 Markdown 依赖，QQ / 微信 / WebUI 都能读）。 */
export const eventToChannelText = (event, { maxChars = 900, timeZone = 'Asia/Shanghai' } = {}) => {
  if (!event) return ''
  const head = `${eventIcon(event.kind)} ${event.repo} ${event.actionText || '有更新'}`
  const lines = [head, '']
  const actor = event.actor?.login ? `👤 ${event.kind === 'issue_comment' ? `评论者 ${event.actor.login}` : event.actor.login}` : ''
  const author = event.kind === 'issue_comment' && event.issueAuthor ? `📄 Issue 作者 ${event.issueAuthor}` : ''
  const time = event.at ? `🕒 ${formatEventTime(event.at, { timeZone })}` : ''
  const meta = [actor, author, time].filter(Boolean).join(' · ')
  if (event.number || event.title) {
    lines.push(`#${event.number || '?'} ${event.title || ''}`.trim())
  }
  if (event.kind === 'push') {
    const count = Number(event.commitCount) || 0
    lines.push(`分支：${event.branch || event.ref || '未知'}${count > 0 ? ` · ${count} 个提交` : ''}`)
    const commits = (Array.isArray(event.commits) ? event.commits : []).filter(item => item && String(item.message || '').trim())
    if (commits.length > 1) {
      lines.push('提交列表：')
      for (const commit of commits.slice(-3)) {
        lines.push(`• ${commit.sha ? `${commit.sha} ` : ''}${shortBody(commit.message, 110)}`)
      }
    } else if (event.commitMessage) {
      lines.push(`最新提交：${shortBody(event.commitMessage, 180)}`)
    }
    if (event.changedFiles) lines.push(`变更文件：${event.changedFiles} 个`)
    if (!event.commitMessage && !commits.length && event.enrichError) {
      lines.push(`提交详情读取失败：${shortBody(event.enrichError, 180)}`)
    }
  }
  if (event.kind === 'release') {
    lines.push(`版本：${event.tag || event.name || '未命名'}${event.name && event.name !== event.tag ? `（${event.name}）` : ''}`)
    if (event.body) lines.push(`说明：${shortBody(event.body, 220)}`)
  }
  if (event.kind === 'fork' && event.forkName) lines.push(`Fork 仓库：${event.forkName}`)
  if (event.kind === 'create' || event.kind === 'delete') lines.push(`${event.refType === 'tag' ? '标签' : '分支'}：${event.refName || '未知'}`)
  if (event.body && event.kind !== 'push' && event.kind !== 'release') lines.push('', shortBody(event.body, 260))
  if (event.labels?.length) lines.push('', `🏷 ${event.labels.slice(0, 6).map(label => label.name).join(' / ')}`)
  if (meta) lines.splice(3, 0, meta)
  const link = event.kind === 'issue_comment' && event.commentUrl ? event.commentUrl : event.url
  if (link) lines.push('', `🔗 ${link}`)
  return truncate(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), Math.max(120, Number(maxChars) || 900))
}

/** 事件 -> 卡片数据（供 lib/card.mjs 渲染）。 */
export const eventToCardData = event => ({
  kind: event?.kind === 'issue_comment' ? 'issue_comment' : event?.kind || 'event',
  title: event?.title || event?.actionText || 'GitHub 动态',
  subtitle: `${event?.repo || ''}${event?.number ? ` #${event.number}` : ''}`.trim(),
  description: event?.body || event?.commitMessage || (event?.kind === 'push' && event?.enrichError ? `提交详情读取失败：${event.enrichError}` : ''),
  actor: event?.actor?.login || '',
  actorAvatar: event?.actor?.avatarUrl || '',
  time: event?.at || '',
  url: event?.url || '',
  badge: event?.actionText || '',
  stats: event
    ? [
        event.kind === 'push' && Number(event.commitCount) > 0 ? { label: 'Commits', value: event.commitCount } : null,
        event.kind === 'push' && Number(event.changedFiles) > 0 ? { label: 'Files', value: event.changedFiles } : null,
        event.kind === 'release' ? { label: 'Tag', value: event.tag || '' } : null,
        event.comments ? { label: 'Comments', value: event.comments } : null,
        event.additions !== undefined && event.kind === 'pull_request' ? { label: 'Changes', value: `+${event.additions}/-${event.deletions || 0}` } : null,
      ].filter(Boolean)
    : [],
  labels: event?.labels || [],
})
