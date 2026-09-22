/*
 * 念风chat · 扩展插件 · github-hub
 * 纯逻辑自测：node extensions/github-hub/test.mjs
 */
import assert from 'node:assert/strict'
import {
  eventToChannelText,
  eventToCardData,
  extractGithubUrls,
  formatEventTime,
  githubRawEventKey,
  normalizeEventFilters,
  normalizeGithubEvent,
  normalizeRepoFullName,
  parseGithubUrl,
  resolveRepoAndNumber,
  webhookEventToRaw,
} from './lib/github.mjs'
import { renderIssueCard, renderRepoCard, cardAsImage, svgToDataUrl, previewToText } from './lib/card.mjs'
import { wrapByWidth } from './lib/util.mjs'

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
  } catch (error) {
    console.error(`x ${name}`)
    console.error(error?.stack || error)
    process.exitCode = 1
  }
}

test('normalizeRepoFullName 支持 URL / .git / 简写', () => {
  assert.equal(normalizeRepoFullName('nianfeng233/NianFeng-Chat'), 'nianfeng233/NianFeng-Chat')
  assert.equal(normalizeRepoFullName('https://github.com/nianfeng233/NianFeng-Chat.git'), 'nianfeng233/NianFeng-Chat')
  assert.equal(normalizeRepoFullName('git@github.com:nianfeng233/NianFeng-Chat.git'), 'nianfeng233/NianFeng-Chat')
  assert.equal(normalizeRepoFullName('not a repo'), '')
})

test('parseGithubUrl 识别 repo / issue / pull / commit / release / user', () => {
  assert.equal(parseGithubUrl('https://github.com/a/b').kind, 'repo')
  assert.equal(parseGithubUrl('github.com/a/b/issues/12').number, 12)
  assert.equal(parseGithubUrl('https://github.com/a/b/pull/3').kind, 'pull')
  assert.equal(parseGithubUrl('https://github.com/a/b/commit/abcdef123456').kind, 'commit')
  assert.equal(parseGithubUrl('https://github.com/a/b/releases/tag/v1.2.0').tag, 'v1.2.0')
  assert.equal(parseGithubUrl('https://github.com/nianfeng233').kind, 'user')
  assert.equal(parseGithubUrl('https://example.com/a/b'), null)
})

test('extractGithubUrls 去重并限制数量', () => {
  const list = extractGithubUrls('看看 https://github.com/a/b 和 https://github.com/a/b/issues/1 还有 c/d', 3)
  assert.equal(list.length, 3)
  assert.equal(list[0].kind, 'repo')
  assert.equal(list[1].kind, 'issue')
  assert.equal(list[2].owner, 'c')
})

test('resolveRepoAndNumber 支持链接与 repo + number 组合', () => {
  assert.deepEqual(resolveRepoAndNumber({ repo: 'a/b', number: 7 }), { repo: 'a/b', number: 7, kind: 'issue', url: 'https://github.com/a/b/issues/7' })
  assert.equal(resolveRepoAndNumber({ url: 'https://github.com/a/b/pull/9' }).number, 9)
  assert.equal(resolveRepoAndNumber({}).repo, '')
})

test('normalizeEventFilters 补齐默认值并保留显式 false', () => {
  const filters = normalizeEventFilters({ push: true, issues: false })
  assert.equal(filters.push, true)
  assert.equal(filters.issues, false)
  assert.equal(filters.releases, true)
})

test('normalizeGithubEvent 解析 IssuesEvent / PushEvent / ReleaseEvent', () => {
  const issueEvent = normalizeGithubEvent({
    id: 'e1',
    type: 'IssuesEvent',
    created_at: '2026-09-15T00:00:00Z',
    actor: { login: 'alice', avatar_url: 'https://example.com/a.png' },
    repo: { name: 'a/b', url: 'https://api.github.com/repos/a/b' },
    payload: { action: 'opened', issue: { number: 12, title: '启动失败', body: '日志如下', html_url: 'https://github.com/a/b/issues/12', state: 'open', comments: 2, labels: [{ name: 'bug', color: 'd73a4a' }] } },
  })
  assert.equal(issueEvent.kind, 'issue')
  assert.equal(issueEvent.number, 12)
  assert.equal(issueEvent.actionText, '新 Issue')
  assert.match(eventToChannelText(issueEvent), /启动失败/)

  const pushEvent = normalizeGithubEvent({
    id: 'e2',
    type: 'PushEvent',
    created_at: '2026-09-15T00:00:00Z',
    actor: { login: 'alice' },
    repo: { name: 'a/b', url: 'https://api.github.com/repos/a/b' },
    payload: { ref: 'refs/heads/main', size: 2, head_commit: { message: 'fix: npe', url: 'https://api.github.com/repos/a/b/commits/abc' }, commits: [] },
  })
  assert.equal(pushEvent.kind, 'push')
  assert.equal(pushEvent.branch, 'main')
  assert.match(eventToChannelText(pushEvent), /main/)

  const releaseEvent = normalizeGithubEvent({
    id: 'e3',
    type: 'ReleaseEvent',
    created_at: '2026-09-15T00:00:00Z',
    actor: { login: 'alice' },
    repo: { name: 'a/b', url: 'https://api.github.com/repos/a/b' },
    payload: { action: 'published', release: { tag_name: 'v1.0.0', name: 'First', body: 'hello', html_url: 'https://github.com/a/b/releases/tag/v1.0.0' } },
  })
  assert.equal(releaseEvent.kind, 'release')
  assert.match(eventToChannelText(releaseEvent), /v1.0.0/)
})

test('Webhook payload 转 Events API 结构，并与轮询事件使用同一个稳定 key', () => {
  const updatedAt = '2026-09-22T00:00:00Z'
  const apiEvent = {
    id: '12345',
    type: 'IssuesEvent',
    created_at: updatedAt,
    actor: { login: 'alice' },
    repo: { name: 'a/b', url: 'https://api.github.com/repos/a/b' },
    payload: {
      action: 'opened',
      issue: { id: 77, number: 5, title: 'webhook', body: 'body', html_url: 'https://github.com/a/b/issues/5', state: 'open', updated_at: updatedAt },
    },
  }
  const webhookRaw = webhookEventToRaw({
    event: 'issues',
    deliveryId: 'delivery-123',
    payload: {
      action: 'opened',
      repository: { full_name: 'a/b', url: 'https://api.github.com/repos/a/b' },
      sender: { login: 'alice' },
      issue: { id: 77, number: 5, title: 'webhook', body: 'body', html_url: 'https://github.com/a/b/issues/5', state: 'open', updated_at: updatedAt },
    },
  })
  assert.equal(webhookRaw.type, 'IssuesEvent')
  assert.equal(githubRawEventKey(webhookRaw), githubRawEventKey(apiEvent))
  const normalized = normalizeGithubEvent(webhookRaw)
  assert.equal(normalized.kind, 'issue')
  assert.equal(normalized.apiId, 'delivery-123')
  assert.equal(normalized.source, 'events')
  assert.match(normalized.id, /a\/b:issues:5:opened:/)
})

test('Star Webhook 能区分 Star / 取消 Star', () => {
  const created = normalizeGithubEvent(
    webhookEventToRaw({
      event: 'star',
      deliveryId: 'star-1',
      payload: { action: 'created', repository: { full_name: 'a/b' }, sender: { id: 9, login: 'bob' } },
    }),
  )
  const deleted = normalizeGithubEvent(
    webhookEventToRaw({
      event: 'star',
      deliveryId: 'star-2',
      payload: { action: 'deleted', repository: { full_name: 'a/b' }, sender: { id: 9, login: 'bob' } },
    }),
  )
  assert.equal(created.kind, 'star')
  assert.equal(created.actionText, '收到新的 Star')
  assert.equal(deleted.actionText, '取消了 Star')
})

test('formatEventTime 把 GitHub UTC 时间转成 Asia/Shanghai 并带时区', () => {
  assert.equal(formatEventTime('2026-09-17T17:09:57Z'), '2026-09-18 01:09 (UTC+08:00)')
  assert.equal(formatEventTime('2026-09-16T11:24:00Z'), '2026-09-16 19:24 (UTC+08:00)')
  assert.equal(formatEventTime('not-a-date'), 'not-a-date')
  assert.equal(formatEventTime(''), '')
})

test('summary PushEvent 没有 size/commits 时不伪造 1 个提交', () => {
  const summaryPush = normalizeGithubEvent({
    id: 'e4',
    type: 'PushEvent',
    created_at: '2026-09-16T11:24:00Z',
    actor: { login: 'alice' },
    repo: { name: 'a/b', url: 'https://api.github.com/repos/a/b' },
    payload: { ref: 'refs/heads/preview', before: '1111111', head: '2222222' },
  })
  assert.equal(summaryPush.kind, 'push')
  assert.equal(summaryPush.commitCount, 0)
  const text = eventToChannelText(summaryPush, { timeZone: 'Asia/Shanghai' })
  assert.match(text, /2026-09-16 19:24 \(UTC\+08:00\)/)
  assert.doesNotMatch(text, /1 个提交/)
  assert.match(text, /分支：preview/)
})

test('PushEvent 有真实提交数和说明时正常展示', () => {
  const push = normalizeGithubEvent({
    id: 'e5',
    type: 'PushEvent',
    created_at: '2026-09-17T17:09:57Z',
    actor: { login: 'alice' },
    repo: { name: 'a/b', url: 'https://api.github.com/repos/a/b' },
    payload: { ref: 'refs/heads/preview', size: 2, head_commit: { message: 'fix: 时间戳' }, commits: [] },
  })
  const text = eventToChannelText(push)
  assert.match(text, /2026-09-18 01:09 \(UTC\+08:00\)/)
  assert.match(text, /2 个提交/)
  assert.match(text, /最新提交：fix: 时间戳/)
})

test('PushEvent 带 after / commits 时生成提交链接并展示提交列表', () => {
  const push = normalizeGithubEvent({
    id: 'e6',
    type: 'PushEvent',
    created_at: '2026-09-17T17:09:57Z',
    actor: { login: 'alice' },
    repo: { name: 'a/b', url: 'https://api.github.com/repos/a/b' },
    payload: {
      ref: 'refs/heads/main',
      before: '1111111',
      after: '2222222',
      size: 2,
      commits: [
        { sha: 'abc1234', message: 'feat: 第一个提交', url: 'https://api.github.com/repos/a/b/commits/abc1234' },
        { sha: 'def5678', message: 'fix: 第二个提交', url: 'https://api.github.com/repos/a/b/commits/def5678' },
      ],
    },
  })
  assert.equal(push.head, '2222222')
  assert.equal(push.commitCount, 2)
  assert.equal(push.url, 'https://github.com/a/b/compare/1111111...2222222')
  const text = eventToChannelText(push)
  assert.match(text, /提交列表/)
  assert.match(text, /feat: 第一个提交/)
  assert.match(text, /fix: 第二个提交/)
  const card = eventToCardData(push)
  assert.equal(card.url, 'https://github.com/a/b/compare/1111111...2222222')
  assert.equal(card.stats.some(item => item.label === 'Commits' && item.value === 2), true)
})

test('PushEvent 只有 head_commit 时也保留提交说明，不丢内容', () => {
  const push = normalizeGithubEvent({
    id: 'e7',
    type: 'PushEvent',
    created_at: '2026-09-17T17:09:57Z',
    actor: { login: 'alice' },
    repo: { name: 'a/b', url: 'https://api.github.com/repos/a/b' },
    payload: { ref: 'refs/heads/main', after: 'abc9999', head_commit: { message: 'docs: 补充说明' } },
  })
  assert.equal(push.commitCount, 1)
  assert.equal(push.commitMessage, 'docs: 补充说明')
  assert.match(eventToChannelText(push), /最新提交：docs: 补充说明/)
})


test('SVG 卡片生成且带转义', () => {
  const repoCard = renderRepoCard({ full_name: 'a/b', description: '<hello> & world', html_url: 'https://github.com/a/b', owner: { login: 'a', avatar_url: '' }, stargazers_count: 3, forks_count: 1, open_issues_count: 2, language: 'JavaScript', topics: ['test'] })
  assert.match(repoCard, /^<svg /)
  assert.ok(repoCard.includes('&lt;hello&gt;'))
  assert.ok(!repoCard.includes('<hello>'))
  const image = cardAsImage({ kind: 'repo', data: { full_name: 'a/b', description: 'demo', owner: { login: 'a' }, html_url: 'https://github.com/a/b' } })
  assert.equal(image.mime, 'image/svg+xml')
  assert.ok(image.dataUrl.startsWith('data:image/svg+xml;base64,'))
  assert.ok(svgToDataUrl('<svg></svg>').startsWith('data:image/svg+xml;base64,'))
  assert.match(previewToText({ kind: 'repo', htmlUrl: 'https://github.com/a/b', data: { full_name: 'a/b', description: 'demo', stargazers_count: 3 } }), /a\/b/)
  assert.match(previewToText({ kind: 'issue', htmlUrl: 'https://github.com/a/b/issues/1', data: { number: 1, title: '启动失败', state: 'open' } }), /启动失败/)
})

test('Issue 卡片包含标题、编号与正文', () => {
  const svg = renderIssueCard({ number: 5, title: '无法启动', body: '步骤一\n步骤二', state: 'open', html_url: 'https://github.com/a/b/issues/5', user: { login: 'alice' }, labels: [{ name: 'bug', color: 'd73a4a' }] })
  assert.ok(svg.includes('无法启动'))
  assert.ok(svg.includes('#5'))
  assert.ok(svg.includes('bug'))
})

test('wrapByWidth 按最大行数截断并加省略号', () => {
  const lines = wrapByWidth('这是一段很长很长的中文描述，需要在卡片里自动换行显示，超出后截断。', 120, 16, 2)
  assert.ok(lines.length <= 2)
  assert.ok(lines[lines.length - 1].endsWith('…'))
})

console.log(`OK github-hub test · ${passed} 项通过`)
