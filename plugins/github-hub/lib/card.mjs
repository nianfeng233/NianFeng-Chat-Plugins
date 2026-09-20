/*
 * 念风chat · 扩展插件 · github-hub
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * GitHub 预览卡片（纯 SVG 字符串）。前端把 SVG 存进图片服务 / 直接作为消息图片展示；
 * 不依赖 canvas、sharp、字体文件等任何第三方运行时，浏览器与 Node 都能用。
 */

import { bytesToBase64, escapeXml, formatTime, truncate, wrapByWidth } from './util.mjs'
import { languageColor, stateLabel } from './github.mjs'

export const CARD_WIDTH = 760
const PAD = 28
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"

const colorOfValue = (value, fallback = '#57606a') => {
  const text = String(value || '').replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(text) ? `#${text}` : fallback
}

const readableLabelColor = color => {
  const value = colorOfValue(color, '#57606a').slice(1)
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.62 ? '#24292f' : `#${value}`
}

const textLines = (lines, x, startY, { size = 16, weight = 400, fill = '#57606a', lineHeight = 22, anchor = 'start' } = {}) =>
  lines
    .filter(line => line !== undefined && line !== null)
    .map((line, index) => `<text x="${x}" y="${startY + index * lineHeight}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}>${escapeXml(line)}</text>`)
    .join('')

const avatarMarkup = ({ x, y, size, dataUrl, name = '', fallbackColor = '#24292f' }) => {
  const radius = size / 2
  const clipId = `avatarClip_${Math.round(x)}_${Math.round(y)}_${Math.round(size)}`
  if (dataUrl) {
    const clip = `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><circle cx="${x + radius}" cy="${y + radius}" r="${radius}" /></clipPath>`
    return `${clip}<image x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" href="${escapeXml(dataUrl)}" />`
  }
  const initial = escapeXml(String(name || 'G').trim().slice(0, 1).toUpperCase() || 'G')
  return `<circle cx="${x + radius}" cy="${y + radius}" r="${radius}" fill="${fallbackColor}" />` +
    `<text x="${x + radius}" y="${y + radius + size * 0.2}" font-size="${Math.round(size * 0.44)}" font-weight="700" fill="#ffffff" text-anchor="middle">${initial}</text>`
}

const badgeMarkup = (text, { x, y, fill = '#ddf4ff', color = '#0969da', size = 12 } = {}) => {
  const content = String(text || '')
  if (!content) return ''
  const width = Math.max(42, Math.round(content.length * size * (content.match(/[^\x00-\xff]/) ? 1 : 0.62)) + 20)
  return `<rect x="${x - width}" y="${y}" width="${width}" height="${size + 12}" rx="${(size + 12) / 2}" fill="${fill}" />` +
    `<text x="${x - width / 2}" y="${y + size + 3}" font-size="${size}" font-weight="600" fill="${color}" text-anchor="middle">${escapeXml(content)}</text>`
}

const statBoxes = (stats, { y, width = CARD_WIDTH - PAD * 2 } = {}) => {
  const list = (Array.isArray(stats) ? stats : []).filter(item => item && item.label !== undefined && item.value !== undefined && item.value !== '').slice(0, 4)
  if (!list.length) return ''
  const gap = 14
  const boxWidth = Math.floor((width - gap * (list.length - 1)) / list.length)
  return list
    .map((item, index) => {
      const x = PAD + index * (boxWidth + gap)
      const value = truncate(String(item.value), 14)
      const valueSize = value.length > 8 ? 19 : 23
      return `<rect x="${x}" y="${y}" width="${boxWidth}" height="78" rx="12" fill="#f6f8fa" stroke="#d8dee4" />` +
        `<text x="${x + 18}" y="${y + 36}" font-size="${valueSize}" font-weight="700" fill="#1f2328">${escapeXml(value)}</text>` +
        `<text x="${x + 18}" y="${y + 60}" font-size="${12.5}" fill="#57606a">${escapeXml(item.label)}</text>`
    })
    .join('')
}

const labelPills = (labels, { x, y, maxWidth = CARD_WIDTH - PAD * 2 } = {}) => {
  const list = (Array.isArray(labels) ? labels : []).map(label => (typeof label === 'string' ? { name: label, color: '' } : label)).filter(label => label?.name).slice(0, 6)
  if (!list.length) return { markup: '', height: 0, count: 0 }
  let cursor = x
  let row = 0
  const parts = []
  for (const label of list) {
    const name = truncate(String(label.name), 18)
    const color = colorOfValue(label.color, '#57606a')
    const textColor = readableLabelColor(color)
    const width = Math.max(38, Math.round([...name].reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 11 : 6.6), 0)) + 20)
    if (cursor + width > x + maxWidth && cursor > x) {
      row += 1
      cursor = x
    }
    parts.push(`<rect x="${cursor}" y="${y + row * 28}" width="${width}" height="22" rx="11" fill="${color}" opacity="0.16" />`)
    parts.push(`<text x="${cursor + width / 2}" y="${y + row * 28 + 15}" font-size="12" font-weight="600" fill="${textColor}" text-anchor="middle">${escapeXml(name)}</text>`)
    cursor += width + 8
  }
  return { markup: parts.join(''), height: (row + 1) * 28, count: list.length }
}

const wrapCard = (height, content, { background = '#ffffff', border = '#d0d7de' } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" font-family="${FONT}">` +
  `<rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${height - 1}" rx="18" fill="${background}" stroke="${border}" />` +
  content +
  `</svg>`

const footerMarkup = (value, height) =>
  value ? `<text x="${PAD}" y="${height - 18}" font-size="12.5" fill="#6e7781">${escapeXml(truncate(value, 120))}</text>` : ''

const topRightText = (value, { y, color = '#6e7781' } = {}) =>
  value ? `<text x="${CARD_WIDTH - PAD}" y="${y}" font-size="13" fill="${color}" text-anchor="end">${escapeXml(truncate(value, 36))}</text>` : ''

export const renderRepoCard = (repo = {}, { avatarDataUrl = '' } = {}) => {
  const fullName = String(repo.full_name || `${repo.owner?.login || ''}/${repo.name || ''}` || '').trim() || 'GitHub 仓库'
  const description = String(repo.description || repo.homepage || '暂无项目简介')
  const visibility = repo.private ? 'Private' : repo.visibility ? String(repo.visibility) : 'Public'
  const ownerAvatar = avatarDataUrl || String(repo.owner?.avatar_url || '')
  const descLines = wrapByWidth(description, CARD_WIDTH - PAD * 2 - 100, 16, 3)
  const headerBottom = PAD + 64
  const descTop = headerBottom + 28
  const descBottom = descTop + (descLines.length - 1) * 22
  const facts = [
    repo.language ? `● ${repo.language}` : '',
    repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? `许可证 ${repo.license.spdx_id}` : '',
    repo.default_branch ? `默认分支 ${repo.default_branch}` : '',
    repo.pushed_at ? `最近推送 ${formatTime(repo.pushed_at).slice(0, 10)}` : '',
  ].filter(Boolean)
  const factsY = descBottom + 28
  const topics = (Array.isArray(repo.topics) ? repo.topics : []).slice(0, 5)
  const topicsY = factsY + 30
  const statsY = topicsY + (topics.length ? 30 : 6)
  const height = statsY + 78 + PAD + 8
  const languageDot = repo.language
    ? `<circle cx="${PAD + 4}" cy="${factsY - 4}" r="4.5" fill="${languageColor(repo.language)}" />`
    : ''
  const topicPills = topics
    .map((topic, index) => {
      const text = `#${topic}`
      const width = Math.max(46, Math.round(text.length * 7) + 20)
      const x = PAD + index * 0
      return { text, width, x }
    })
    .reduce(
      (acc, item) => {
        const x = acc.x
        const width = item.width
        acc.parts.push(`<rect x="${x}" y="${topicsY - 16}" width="${width}" height="24" rx="12" fill="#ddf4ff" />`)
        acc.parts.push(`<text x="${x + width / 2}" y="${topicsY}" font-size="12" font-weight="600" fill="#0969da" text-anchor="middle">${escapeXml(item.text)}</text>`)
        acc.x = x + width + 8
        return acc
      },
      { x: PAD, parts: [] },
    ).parts.join('')
  const content = [
    avatarMarkup({ x: PAD, y: PAD, size: 64, dataUrl: ownerAvatar, name: repo.owner?.login || fullName }),
    `<text x="${PAD + 82}" y="${PAD + 36}" font-size="27" font-weight="750" fill="#1f2328">${escapeXml(truncate(fullName, 40))}</text>`,
    `<text x="${PAD + 82}" y="${PAD + 59}" font-size="13" fill="#6e7781">${escapeXml(repo.owner?.login ? `@${repo.owner.login}` : 'GitHub')}</text>`,
    badgeMarkup(visibility, { x: CARD_WIDTH - PAD, y: PAD + 2, fill: repo.private ? '#fff8c5' : '#dafbe1', color: repo.private ? '#9a6700' : '#1a7f37' }),
    textLines(descLines, PAD, descTop, { size: 16, lineHeight: 22, fill: '#57606a' }),
    languageDot,
    textLines(facts.filter((_, index) => !(index === 0 && repo.language)), PAD + (repo.language ? 16 : 0), factsY, { size: 13.5, lineHeight: 18, fill: '#57606a' }),
    topicPills,
    statBoxes(
      [
        { label: 'Stars', value: Number(repo.stargazers_count) || 0 },
        { label: 'Forks', value: Number(repo.forks_count) || 0 },
        { label: 'Open Issues', value: Number(repo.open_issues_count) || 0 },
        { label: 'Watchers', value: Number(repo.subscribers_count ?? repo.watchers_count) || 0 },
      ],
      { y: statsY },
    ),
    footerMarkup(repo.html_url || fullName, height),
  ].join('')
  return wrapCard(height, content)
}

export const renderIssueCard = (issue = {}, { kind = 'issue', avatarDataUrl = '' } = {}) => {
  const number = Number(issue.number) || 0
  const title = String(issue.title || issue.name || '未命名 Issue')
  const repoName = String(issue.repository_url || '').replace('https://api.github.com/repos/', '') || ''
  const isPull = kind === 'pull' || !!issue.pull_request
  const state = isPull && issue.merged ? 'merged' : String(issue.state || (isPull ? 'open' : 'open'))
  const stateText = stateLabel(state)
  const stateFill = state === 'merged' ? '#f5f0ff' : state === 'closed' ? '#f6f8fa' : '#dafbe1'
  const stateColor = state === 'merged' ? '#8250df' : state === 'closed' ? '#57606a' : '#1a7f37'
  const titleLines = wrapByWidth(title, CARD_WIDTH - PAD * 2 - 150, 24, 2)
  const titleTop = PAD + 30
  const metaY = titleTop + (titleLines.length - 1) * 30 + 28
  const actor = issue.user?.login || issue.user || ''
  const created = issue.created_at ? formatTime(issue.created_at) : ''
  const meta = [actor ? `👤 ${actor}` : '', created ? `🕒 ${created}` : '', Number(issue.comments) ? `💬 ${issue.comments} 条评论` : ''].filter(Boolean).join(' · ')
  const labelInfo = labelPills(issue.labels, { x: PAD, y: metaY + 16, maxWidth: CARD_WIDTH - PAD * 2 })
  const bodyTop = metaY + 30 + (labelInfo.count ? labelInfo.height + 12 : 0)
  const bodyLines = wrapByWidth(String(issue.body || '（无正文）').replace(/\r\n?/g, '\n'), CARD_WIDTH - PAD * 2, 15, 7)
  const bodyBottom = bodyTop + (bodyLines.length - 1) * 21
  const statsY = bodyBottom + 32
  const stats = [
    { label: 'Comments', value: Number(issue.comments) || 0 },
    { label: 'Reactions', value: Number(issue.reactions?.total_count ?? issue.reactions) || 0 },
    ...(isPull ? [{ label: 'Changes', value: `+${Number(issue.additions) || 0}/-${Number(issue.deletions) || 0}` }] : []),
    ...(isPull ? [{ label: 'Files', value: Number(issue.changed_files) || 0 }] : [{ label: 'State', value: stateText }]),
  ]
  const height = statsY + 78 + PAD + 8
  const content = [
    `<text x="${PAD}" y="${PAD + 10}" font-size="13.5" font-weight="600" fill="#0969da">${escapeXml(repoName || 'GitHub')} ${isPull ? 'Pull Request' : 'Issue'} #${number}</text>`,
    badgeMarkup(stateText, { x: CARD_WIDTH - PAD, y: PAD - 2, fill: stateFill, color: stateColor, size: 12.5 }),
    textLines(titleLines, PAD, titleTop + 24, { size: 24, weight: 700, fill: '#1f2328', lineHeight: 30 }),
    `<text x="${PAD}" y="${metaY}" font-size="13.5" fill="#57606a">${escapeXml(truncate(meta, 90))}</text>`,
    labelInfo.markup,
    textLines(bodyLines, PAD, bodyTop, { size: 15, lineHeight: 21, fill: '#3d444d' }),
    statBoxes(stats, { y: statsY }),
    footerMarkup(issue.html_url || '', height),
  ].join('')
  return wrapCard(height, content)
}

export const renderCommitCard = (commit = {}, { avatarDataUrl = '' } = {}) => {
  const sha = String(commit.sha || '').slice(0, 10)
  const message = String(commit.commit?.message || commit.message || 'Commit')
  const firstLine = message.split('\n')[0]
  const titleLines = wrapByWidth(firstLine, CARD_WIDTH - PAD * 2 - 100, 24, 2)
  const authorName = String(commit.commit?.author?.name || commit.author?.login || 'Unknown')
  const actorAvatar = avatarDataUrl || String(commit.author?.avatar_url || '')
  const date = commit.commit?.author?.date || commit.commit?.committer?.date || ''
  const body = message.split('\n').slice(1).join('\n').trim()
  const bodyLines = body ? wrapByWidth(body, CARD_WIDTH - PAD * 2, 15, 4) : []
  const titleTop = PAD + 34
  const metaY = titleTop + (titleLines.length - 1) * 30 + 30
  const bodyTop = metaY + (bodyLines.length ? 26 : 0)
  const statsY = bodyTop + (bodyLines.length ? (bodyLines.length - 1) * 21 + 30 : 4)
  const height = statsY + 78 + PAD + 8
  const content = [
    avatarMarkup({ x: PAD, y: PAD, size: 56, dataUrl: actorAvatar, name: authorName }),
    `<text x="${PAD + 72}" y="${PAD + 22}" font-size="14" font-weight="650" fill="#1f2328">${escapeXml(truncate(authorName, 34))}</text>`,
    `<text x="${PAD + 72}" y="${PAD + 43}" font-size="12.5" fill="#6e7781">commit ${escapeXml(sha)}</text>`,
    textLines(titleLines, PAD, titleTop + 22, { size: 24, weight: 700, fill: '#1f2328', lineHeight: 30 }),
    `<text x="${PAD}" y="${metaY}" font-size="13.5" fill="#57606a">${escapeXml(truncate(`${date ? `🕒 ${formatTime(date)}` : ''}`, 80))}</text>`,
    textLines(bodyLines, PAD, bodyTop, { size: 15, lineHeight: 21, fill: '#3d444d' }),
    statBoxes(
      [
        { label: 'Additions', value: `+${Number(commit.stats?.additions) || 0}` },
        { label: 'Deletions', value: `-${Number(commit.stats?.deletions) || 0}` },
        { label: 'Changed Files', value: Number(commit.stats?.total ?? commit.files?.length) || 0 },
      ],
      { y: statsY },
    ),
    footerMarkup(commit.html_url || `https://github.com/${commit.repo || ''}/commit/${sha}`, height),
  ].join('')
  return wrapCard(height, content)
}

export const renderReleaseCard = (release = {}) => {
  const tag = String(release.tag_name || release.tag || release.name || 'Release')
  const name = String(release.name || tag)
  const titleLines = wrapByWidth(name, CARD_WIDTH - PAD * 2 - 130, 26, 2)
  const bodyLines = wrapByWidth(String(release.body || '（暂无发布说明）'), CARD_WIDTH - PAD * 2, 15, 8)
  const titleTop = PAD + 30
  const metaY = titleTop + (titleLines.length - 1) * 32 + 30
  const bodyTop = metaY + 26
  const bodyBottom = bodyTop + (bodyLines.length - 1) * 21
  const statsY = bodyBottom + 30
  const height = statsY + 78 + PAD + 8
  const content = [
    `<text x="${PAD}" y="${PAD + 12}" font-size="13.5" font-weight="600" fill="#8250df">${escapeXml(String(release.repo || 'GitHub'))} · Release</text>`,
    badgeMarkup(release.prerelease ? 'Pre-release' : 'Latest', { x: CARD_WIDTH - PAD, y: PAD, fill: release.prerelease ? '#fff8c5' : '#f5f0ff', color: release.prerelease ? '#9a6700' : '#8250df', size: 12 }),
    textLines(titleLines, PAD, titleTop + 25, { size: 26, weight: 750, fill: '#1f2328', lineHeight: 32 }),
    `<text x="${PAD}" y="${metaY}" font-size="13.5" fill="#57606a">${escapeXml(truncate([tag && `🏷 ${tag}`, release.author?.login && `👤 ${release.author.login}`].filter(Boolean).join(' · '), 90))}</text>`,
    textLines(bodyLines, PAD, bodyTop, { size: 15, lineHeight: 21, fill: '#3d444d' }),
    statBoxes(
      [
        { label: 'Tag', value: tag },
        { label: 'Assets', value: Number(release.assets?.length) || 0 },
        { label: 'Published', value: formatTime(release.published_at || release.created_at).slice(0, 10) || '—' },
      ],
      { y: statsY },
    ),
    footerMarkup(release.html_url || '', height),
  ].join('')
  return wrapCard(height, content)
}

export const renderUserCard = (user = {}, { avatarDataUrl = '' } = {}) => {
  const name = String(user.name || user.login || 'GitHub 用户')
  const login = String(user.login || '')
  const bioLines = wrapByWidth(String(user.bio || '暂无简介'), CARD_WIDTH - PAD * 2 - 110, 16, 3)
  const headerBottom = PAD + 76
  const bioTop = headerBottom + 26
  const statsY = bioTop + (bioLines.length - 1) * 22 + 30
  const height = statsY + 78 + PAD + 8
  const content = [
    avatarMarkup({ x: PAD, y: PAD, size: 76, dataUrl: avatarDataUrl || String(user.avatar_url || ''), name }),
    `<text x="${PAD + 96}" y="${PAD + 34}" font-size="27" font-weight="750" fill="#1f2328">${escapeXml(truncate(name, 34))}</text>`,
    `<text x="${PAD + 96}" y="${PAD + 60}" font-size="14.5" fill="#57606a">@${escapeXml(login)}</text>`,
    badgeMarkup(user.type || 'User', { x: CARD_WIDTH - PAD, y: PAD + 4, fill: '#f6f8fa', color: '#57606a', size: 11.5 }),
    textLines(bioLines, PAD, bioTop, { size: 16, lineHeight: 22, fill: '#3d444d' }),
    statBoxes(
      [
        { label: 'Public Repos', value: Number(user.public_repos) || 0 },
        { label: 'Followers', value: Number(user.followers) || 0 },
        { label: 'Following', value: Number(user.following) || 0 },
      ],
      { y: statsY },
    ),
    footerMarkup(user.html_url || `https://github.com/${login}`, height),
  ].join('')
  return wrapCard(height, content)
}

export const renderEventCard = (event = {}) => {
  const title = String(event.title || event.actionText || 'GitHub 动态')
  const subtitle = String(event.subtitle || event.repo || '')
  const description = String(event.description || '')
  const titleLines = wrapByWidth(title, CARD_WIDTH - PAD * 2 - 100, 23, 2)
  const descLines = description ? wrapByWidth(description, CARD_WIDTH - PAD * 2, 15, 6) : []
  const titleTop = PAD + 44
  const descTop = titleTop + (titleLines.length - 1) * 28 + 30
  const stats = (Array.isArray(event.stats) ? event.stats : []).filter(item => item && item.value !== '' && item.value !== undefined)
  const statsY = descTop + (descLines.length ? (descLines.length - 1) * 21 + 28 : 0)
  const height = statsY + (stats.length ? 78 : 0) + PAD + 2
  const content = [
    `<text x="${PAD}" y="${PAD + 12}" font-size="13.5" font-weight="600" fill="#0969da">${escapeXml(subtitle || 'GitHub')}</text>`,
    badgeMarkup(event.badge || String(event.kind || ''), { x: CARD_WIDTH - PAD, y: PAD - 2, size: 12 }),
    `<text x="${PAD}" y="${PAD + 40}" font-size="20" font-weight="700" fill="#1f2328">${escapeXml(truncate(event.actor || 'GitHub Hub', 38))}</text>`,
    textLines(titleLines, PAD, titleTop + 24, { size: 23, weight: 700, fill: '#1f2328', lineHeight: 28 }),
    textLines(descLines, PAD, descTop, { size: 15, lineHeight: 21, fill: '#3d444d' }),
    stats.length ? statBoxes(stats, { y: statsY }) : '',
    footerMarkup(event.url || '', height),
  ].join('')
  return wrapCard(height, content)
}

/** 根据 bridge /preview 返回值选择卡片。 */
export const renderPreviewCard = preview => {
  const kind = String(preview?.kind || '')
  const data = preview?.data || {}
  if (kind === 'repo') return renderRepoCard(data, { avatarDataUrl: preview.avatarDataUrl || '' })
  if (kind === 'issue' || kind === 'pull') return renderIssueCard(data, { kind, avatarDataUrl: preview.avatarDataUrl || '' })
  if (kind === 'commit') return renderCommitCard(data, { avatarDataUrl: preview.avatarDataUrl || '' })
  if (kind === 'release') return renderReleaseCard(data)
  if (kind === 'user') return renderUserCard(data, { avatarDataUrl: preview.avatarDataUrl || '' })
  const fallback = {
    title: data.full_name || data.title || data.name || preview?.url || 'GitHub 链接',
    subtitle: preview?.kind || 'GitHub',
    description: data.description || data.body || '',
    actor: data.owner?.login || data.user?.login || '',
    badge: preview?.kind || '',
    url: data.html_url || preview?.url || '',
    stats: [],
  }
  return renderEventCard(fallback)
}

export const svgToDataUrl = svg => {
  const value = String(svg || '')
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(value) : null
  if (bytes) return `data:image/svg+xml;base64,${bytesToBase64(bytes)}`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`
}

/**
 * 链接预览的纯文本摘要。用于外部渠道无法接收 SVG 图片时的降级，
 * 保证“发链接后至少能收到项目 / Issue 的预览内容”。
 */
export const previewToText = preview => {
  const kind = String(preview?.kind || '')
  const data = preview?.data || {}
  const url = preview?.htmlUrl || preview?.url || ''
  const line = (label, value) => (value ? `${label}${value}` : '')
  if (kind === 'repo') {
    const repo = data.full_name || data.name || url
    const stats = [
      Number(data.stargazers_count) ? `⭐ ${data.stargazers_count}` : '',
      Number(data.forks_count) ? `🍴 ${data.forks_count}` : '',
      Number(data.open_issues_count) ? `🐛 ${data.open_issues_count}` : '',
      data.language ? `🔧 ${data.language}` : '',
    ].filter(Boolean).join(' · ')
    return [
      `📦 ${repo}`,
      data.description ? truncate(String(data.description), 240) : '',
      stats,
      url ? `🔗 ${url}` : '',
    ].filter(Boolean).join('\n')
  }
  if (kind === 'issue' || kind === 'pull') {
    const repo = String(data.repository_url || '').replace(/^https?:\/\/[^/]+\/repos\//, '') || ''
    return [
      `${kind === 'pull' ? '🔀' : '📮'} ${repo ? `${repo} ` : ''}#${data.number || ''} ${data.title || ''}`.trim(),
      [data.state, data.user?.login ? `👤 ${data.user.login}` : '', Number(data.comments) ? `💬 ${data.comments}` : ''].filter(Boolean).join(' · '),
      data.body ? truncate(String(data.body).replace(/\s+/g, ' '), 300) : '',
      line('', url ? `🔗 ${url}` : ''),
    ].filter(Boolean).join('\n')
  }
  if (kind === 'commit') {
    return [
      `🧩 ${data.repo || ''} ${String(data.sha || '').slice(0, 10)}`,
      data.commit?.message ? truncate(String(data.commit.message), 260) : '',
      url ? `🔗 ${url}` : '',
    ].filter(Boolean).join('\n')
  }
  if (kind === 'release') {
    return [
      `📦 ${data.repo || ''} Release ${data.tag_name || data.name || ''}`,
      data.body ? truncate(String(data.body).replace(/\s+/g, ' '), 260) : '',
      url ? `🔗 ${url}` : '',
    ].filter(Boolean).join('\n')
  }
  if (kind === 'user') {
    return [
      `👤 ${data.name || data.login || ''}${data.login && data.name ? ` (@${data.login})` : ''}`,
      data.bio ? truncate(String(data.bio), 200) : '',
      [Number(data.public_repos) ? `repos ${data.public_repos}` : '', Number(data.followers) ? `followers ${data.followers}` : ''].filter(Boolean).join(' · '),
      url ? `🔗 ${url}` : '',
    ].filter(Boolean).join('\n')
  }
  return [data.full_name || data.title || data.name || url || 'GitHub 链接', url ? `🔗 ${url}` : ''].filter(Boolean).join('\n')
}

export const cardAsImage = preview => {
  const svg = renderPreviewCard(preview)
  return {
    svg,
    dataUrl: svgToDataUrl(svg),
    mime: 'image/svg+xml',
    name: `github-${preview?.kind || 'preview'}.svg`,
    width: CARD_WIDTH,
    height: (() => {
      const match = /height="(\d+)"/.exec(svg)
      return match ? Number(match[1]) : 520
    })(),
  }
}
