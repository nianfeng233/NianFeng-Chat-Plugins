/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 纯逻辑自测：不联网、不启动后端。
 *   node extensions/model-status/test.mjs
 */

import { BUILTIN_SOURCES, listAllSources, sourceUrlCandidates, buildCustomSource, isValidHttpUrl } from './lib/sources.mjs'
import { parseStatusPageSummary, statusPageHistoryFeedUrl, statusPageSummaryUrl, componentStatusLabel, incidentStatusLabel } from './lib/statuspage.mjs'
import { parseFeed, looksLikeFeed } from './lib/feed.mjs'
import { parseGoogleCloudIncidents, googleCloudProducts } from './lib/google-cloud.mjs'
import { collectStatusPageEvents, collectFeedEvents, collectGoogleCloudEvents, eventMatchesSubscription, formatEventText, formatEventDigestText } from './lib/detect.mjs'
import { classifyStatusText, extractAffectedComponents, localizeStatusTitle, summarizeStatusBody } from './lib/text.mjs'
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✔ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function statusSummary(overrides = {}) {
  return {
    page: { id: 'page-1', name: 'DeepSeek', url: 'https://status.deepseek.com', time_zone: 'UTC', updated_at: '2026-09-20T08:00:00Z' },
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [
      { id: 'api', name: 'API', status: 'operational', updated_at: '2026-09-20T08:00:00Z' },
      { id: 'chat', name: 'Chat', status: 'operational', updated_at: '2026-09-20T08:00:00Z' },
      {
        id: 'models',
        name: 'Models',
        group: true,
        status: 'operational',
        updated_at: '2026-09-20T08:00:00Z',
        components: [{ id: 'r1', name: 'DeepSeek-R1', status: 'operational', updated_at: '2026-09-20T08:00:00Z' }],
      },
    ],
    incidents: [],
    scheduled_maintenances: [],
    ...overrides,
  }
}

function incident(overrides = {}) {
  return {
    id: 'inc-1',
    name: 'API 错误率升高',
    status: 'investigating',
    impact: 'major',
    created_at: '2026-09-20T08:04:00Z',
    updated_at: '2026-09-20T08:05:00Z',
    shortlink: 'https://status.deepseek.com/incidents/inc-1',
    components: [{ id: 'api', name: 'API', status: 'degraded_performance' }],
    incident_updates: [
      {
        id: 'upd-1',
        status: 'investigating',
        body: '我们正在排查 API 错误率升高的问题。',
        created_at: '2026-09-20T08:04:00Z',
        updated_at: '2026-09-20T08:05:00Z',
        affected_components: [{ code: 'api', name: 'API', old_status: 'operational', new_status: 'degraded_performance' }],
      },
    ],
    ...overrides,
  }
}

/* ------------------------------------------------------------------ */
section('1. 内置来源目录')
/* ------------------------------------------------------------------ */

const ids = BUILTIN_SOURCES.map(item => item.id)
check('内置来源 id 唯一', ids.length === new Set(ids).size)
check('包含用户点名的 5 家', ['deepseek', 'anthropic', 'openai', 'gemini', 'xai'].every(id => ids.includes(id)))
check('所有内置 url 都是合法 http(s)', BUILTIN_SOURCES.every(item => isValidHttpUrl(item.url)))
check('所有内置 adapter 合法', BUILTIN_SOURCES.every(item => ['auto', 'statuspage', 'rss', 'google-cloud'].includes(item.adapter)))
check('Gemini 默认带 gemini 关键词', (BUILTIN_SOURCES.find(item => item.id === 'gemini')?.keywords || []).includes('gemini'))
const manifestVersion = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')).version
const versionOf = (file, name) => {
  const match = readFileSync(new URL(file, import.meta.url), 'utf8').match(new RegExp(`export const ${name} = '([^']+)'`))
  return match ? match[1] : ''
}
check(
  '清单 / 前端 / 后端 / 面板版本号一致',
  versionOf('./index.mjs', 'version') === manifestVersion &&
    versionOf('./bridge.mjs', 'version') === manifestVersion &&
    versionOf('./panel.mjs', 'PANEL_VERSION') === manifestVersion,
  `manifest=${manifestVersion} index=${versionOf('./index.mjs', 'version')} bridge=${versionOf('./bridge.mjs', 'version')} panel=${versionOf('./panel.mjs', 'PANEL_VERSION')}`,
)

check('Statuspage 目录能派生 summary.json', statusPageSummaryUrl('https://status.deepseek.com') === 'https://status.deepseek.com/api/v2/summary.json')
check('Statuspage summary 地址也能派生 history.rss', statusPageHistoryFeedUrl('https://status.deepseek.com/api/v2/summary.json') === 'https://status.deepseek.com/history.rss')
check('auto 候选派生 summary + rss', sourceUrlCandidates({ url: 'https://status.deepseek.com' }).includes('https://status.deepseek.com/api/v2/summary.json'))

const custom = buildCustomSource({ name: '我的状态页', url: 'https://status.example.com', adapter: 'auto' }, ids)
check('自定义来源有唯一 id', custom.id.startsWith('custom-') && !ids.includes(custom.id))
check('listAllSources 合并自定义来源', listAllSources({ [custom.id]: custom }).some(item => item.id === custom.id))

/* ------------------------------------------------------------------ */
section('2. Statuspage 解析')
/* ------------------------------------------------------------------ */

const parsed = parseStatusPageSummary(statusSummary(), { id: 'deepseek', name: 'DeepSeek' })
check('解析出 group 内的子组件', parsed.components.some(item => item.id === 'r1' && item.group === 'Models'))
check('组件状态中文文案', componentStatusLabel('degraded_performance') === '性能下降')
check('incident 状态中文文案', incidentStatusLabel('investigating') === '调查中')

const parsedIncident = parseStatusPageSummary(
  statusSummary({
    status: { indicator: 'major', description: 'Partial System Outage' },
    incidents: [incident()],
    components: [{ id: 'api', name: 'API', status: 'degraded_performance', updated_at: '2026-09-20T08:05:00Z' }],
  }),
  { id: 'deepseek', name: 'DeepSeek' },
)
check('解析 incident 与最新进展', parsedIncident.incidents.length === 1 && parsedIncident.incidents[0].latestBody.includes('排查'))
check('合并 incident 影响组件', parsedIncident.incidents[0].components.some(item => item.id === 'api'))

/* ------------------------------------------------------------------ */
section('3. Statuspage 事件检测')
/* ------------------------------------------------------------------ */

const first = collectStatusPageEvents({
  source: { id: 'deepseek', name: 'DeepSeek', emoji: '🐋' },
  parsed,
  previous: null,
  endpoint: 'https://status.deepseek.com/api/v2/summary.json',
})
check('第一次轮询只建立基线', first.seed === true && first.events.length === 0)
check('快照包含 incidents / components 初始化标记', first.snapshot.initialized === true && !!first.snapshot.components.api)

const withIncident = parseStatusPageSummary(
  statusSummary({
    status: { indicator: 'major', description: 'Partial System Outage' },
    incidents: [incident()],
    components: [{ id: 'api', name: 'API', status: 'degraded_performance', updated_at: '2026-09-20T08:05:00Z' }],
  }),
  { id: 'deepseek', name: 'DeepSeek' },
)
const second = collectStatusPageEvents({ source: { id: 'deepseek', name: 'DeepSeek' }, parsed: withIncident, previous: first.snapshot })
check('incident 更新会产生一条事件', second.events.length === 1 && second.events[0].kind === 'incident')
check('首次异常标记为重要通知', second.events[0].important === true)
check('incident 正文包含最新进展', second.events[0].body.includes('排查'))
check('同一次故障的组件变化被抑制，不刷两条', second.events.filter(item => item.kind === 'component').length === 0)

const updatedIncident = incident({
  status: 'monitoring',
  updated_at: '2026-09-20T08:20:00Z',
  incident_updates: [
    { id: 'upd-1', status: 'investigating', body: '正在排查。', created_at: '2026-09-20T08:04:00Z', updated_at: '2026-09-20T08:05:00Z' },
    { id: 'upd-2', status: 'monitoring', body: '已完成修复，正在观察。', created_at: '2026-09-20T08:19:00Z', updated_at: '2026-09-20T08:20:00Z' },
  ],
})
const third = collectStatusPageEvents({
  source: { id: 'deepseek', name: 'DeepSeek' },
  parsed: parseStatusPageSummary(
    statusSummary({
      status: { indicator: 'minor', description: 'Degraded Performance' },
      incidents: [updatedIncident],
      components: [{ id: 'api', name: 'API', status: 'degraded_performance', updated_at: '2026-09-20T08:05:00Z' }],
    }),
    { id: 'deepseek', name: 'DeepSeek' },
  ),
  previous: second.snapshot,
})
check('同一 incident 的过程更新仍记录在最近事件', third.events.length === 1 && third.events[0].statusLabel === '观察中')
check('过程更新默认不推送（important=false）', third.events[0].important === false)

const resolved = incident({
  status: 'resolved',
  impact: 'none',
  updated_at: '2026-09-20T08:40:00Z',
  resolved_at: '2026-09-20T08:40:00Z',
  incident_updates: [
    { id: 'upd-3', status: 'resolved', body: '问题已解决。', created_at: '2026-09-20T08:39:00Z', updated_at: '2026-09-20T08:40:00Z' },
  ],
})
const fourth = collectStatusPageEvents({
  source: { id: 'deepseek', name: 'DeepSeek' },
  parsed: parseStatusPageSummary(
    statusSummary({
      incidents: [resolved],
      components: [{ id: 'api', name: 'API', status: 'operational', updated_at: '2026-09-20T08:40:00Z' }],
    }),
    { id: 'deepseek', name: 'DeepSeek' },
  ),
  previous: third.snapshot,
})
check('incident 恢复会推送 recovery', fourth.events.length === 1 && fourth.events[0].kind === 'recovery')
check('恢复通知标记为重要通知', fourth.events[0].important === true)
check('恢复事件的组件变化同样被抑制', fourth.events.filter(item => item.kind === 'component').length === 0)

const componentOnly = collectStatusPageEvents({
  source: { id: 'deepseek', name: 'DeepSeek' },
  parsed: parseStatusPageSummary(
    statusSummary({
      components: [
        { id: 'api', name: 'API', status: 'operational', updated_at: '2026-09-20T08:00:00Z' },
        { id: 'chat', name: 'Chat', status: 'degraded_performance', updated_at: '2026-09-20T09:00:00Z' },
      ],
    }),
    { id: 'deepseek', name: 'DeepSeek' },
  ),
  previous: first.snapshot,
})
check('没有 incident 时组件状态变化会推送', componentOnly.events.length === 1 && componentOnly.events[0].kind === 'component')
check('组件变化事件带旧 / 新状态', componentOnly.events[0].oldStatus === 'operational' && componentOnly.events[0].newStatus === 'degraded_performance')
check('首次质量下降标记为重要通知', componentOnly.events[0].important === true)
const componentRecovered = collectStatusPageEvents({
  source: { id: 'deepseek', name: 'DeepSeek' },
  parsed: parseStatusPageSummary(
    statusSummary({
      components: [
        { id: 'api', name: 'API', status: 'operational', updated_at: '2026-09-20T09:30:00Z' },
        { id: 'chat', name: 'Chat', status: 'operational', updated_at: '2026-09-20T09:30:00Z' },
      ],
    }),
    { id: 'deepseek', name: 'DeepSeek' },
  ),
  previous: componentOnly.snapshot,
})
check('组件恢复会推送 recovery 事件', componentRecovered.events.length === 1 && componentRecovered.events[0].newStatus === 'operational')
check('组件恢复仅在推送过异常后通知', componentRecovered.events[0].important === true)
const digestText = formatEventDigestText([componentOnly.events[0], { ...componentOnly.events[0], id: 'chat-2', title: 'Chat', componentId: 'chat2', componentName: 'Chat 2' }])
check('多条组件变化会合并为一条摘要', digestText.includes('共 2 个组件状态变化') && digestText.includes('Chat：') && digestText.includes('Chat 2'))


/* ------------------------------------------------------------------ */
section('4. RSS / Atom 解析与检测')
/* ------------------------------------------------------------------ */

const rssText = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Example Status</title><link>https://status.example.com/</link>
<item><title>Investigating API latency</title><link>https://status.example.com/incidents/1</link>
<guid>incident-1</guid><pubDate>Sat, 20 Sep 2026 08:00:00 GMT</pubDate>
<description><![CDATA[<p>We are investigating elevated latency.</p>]]></description></item>
</channel></rss>`
const atomText = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Status</title><link href="https://status.example.org/" />
<entry><title>Resolved: API issue</title><link rel="alternate" href="https://status.example.org/incidents/2" />
<id>tag:example.org,2026:2</id><updated>2026-09-20T09:00:00Z</updated><summary>All clear.</summary></entry></feed>`

check('识别 RSS / Atom', looksLikeFeed(rssText) && looksLikeFeed(atomText))
const rss = parseFeed(rssText, { id: 'rss-example', name: 'Example' })
const atom = parseFeed(atomText, { id: 'atom-example', name: 'Atom' })
check('解析 RSS item 标题 / guid / 正文', rss.items[0].title.includes('API latency') && rss.items[0].id === 'incident-1' && rss.items[0].body.includes('elevated latency'))
check('解析 Atom entry 链接 / id', atom.items[0].url === 'https://status.example.org/incidents/2' && atom.items[0].id.includes('example.org'))

const feedFirst = collectFeedEvents({ source: { id: 'rss-example', name: 'Example', emoji: '📰' }, feed: rss, previous: null })
check('RSS 第一次轮询只建立基线', feedFirst.seed === true && feedFirst.events.length === 0 && Object.keys(feedFirst.snapshot.seen).includes('incident-1'))
const rssNext = parseFeed(
  rssText.replace('</channel>', '<item><title>Resolved: API latency</title><link>https://status.example.com/incidents/2</link><guid>incident-2</guid><pubDate>Sat, 20 Sep 2026 09:00:00 GMT</pubDate><description>Issue resolved.</description></item></channel>'),
  { id: 'rss-example', name: 'Example' },
)
const feedSecond = collectFeedEvents({ source: { id: 'rss-example', name: 'Example' }, feed: rssNext, previous: feedFirst.snapshot })
check('RSS 新增恢复条目会识别为 recovery', feedSecond.events.length === 1 && feedSecond.events[0].kind === 'recovery')
check('未先看到异常的恢复不推送（important=false）', feedSecond.events[0].important === false && feedSecond.events[0].url.includes('/incidents/2'))

const rssUpdated = {
  ...rssNext,
  items: rssNext.items.map(item => (item.id === 'incident-1' ? { ...item, body: 'We are now seeing severe latency.' } : item)),
}
const feedThird = collectFeedEvents({ source: { id: 'rss-example', name: 'Example' }, feed: rssUpdated, previous: feedSecond.snapshot })
check('同一 guid 内容更新仍会记录事件', feedThird.events.length === 1 && feedThird.events[0].kind === 'incident')
check('基线中的过程更新不推送（important=false）', feedThird.events[0].important === false)

/* 真实 OpenAI history.rss 的典型形态：标题是事件名，正文带
 * “Status: Investigating / Monitoring / Resolved”和 affected components 列表。 */
const openaiSource = { id: 'openai-rss', name: 'GPT（OpenAI）', emoji: '🤖' }
const openaiFeedText = items => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>OpenAI Status</title><link>https://status.openai.com</link>${items}</channel></rss>`
const openaiItem = body => `<item><title>Elevated Error Rates</title><link>https://status.openai.com/incidents/01KYC</link><guid>01KYC</guid><pubDate>Wed, 23 Sep 2026 11:00:00 GMT</pubDate><description><![CDATA[${body}]]></description></item>`
const openaiSeed = collectFeedEvents({ source: openaiSource, feed: parseFeed(openaiFeedText(''), openaiSource), previous: null })
check('OpenAI 式 RSS 首次只建立空基线', openaiSeed.seed === true && Object.keys(openaiSeed.snapshot.incidents).length === 0)
const openaiActive = collectFeedEvents({
  source: openaiSource,
  feed: parseFeed(openaiFeedText(openaiItem('<p>Status: Investigating</p><p>We are investigating elevated error rates. Affected components Conversations (Operational), Images (Degraded Performance), Files (Operational)</p>')), openaiSource),
  previous: openaiSeed.snapshot,
})
check('OpenAI 式 RSS 首次异常会推送', openaiActive.events.length === 1 && openaiActive.events[0].kind === 'incident' && openaiActive.events[0].important === true)
check('OpenAI 英文标题会中文化', openaiActive.events[0].title === '错误率升高' && openaiActive.events[0].statusLabel === '调查中')
check('OpenAI 组件列表会从英文正文提取', openaiActive.events[0].components.length === 3 && openaiActive.events[0].components[0].name === 'Conversations')
check('OpenAI 英文过程正文不会原样刷屏', !openaiActive.events[0].body.includes('Status:') && !openaiActive.events[0].body.includes('Affected components'))
const openaiMonitoring = collectFeedEvents({
  source: openaiSource,
  feed: parseFeed(openaiFeedText(openaiItem('<p>Status: Monitoring</p><p>We are monitoring the fix.</p>')), openaiSource),
  previous: openaiActive.snapshot,
})
check('OpenAI 过程更新 important=false', openaiMonitoring.events.length === 1 && openaiMonitoring.events[0].important === false)
const openaiResolved = collectFeedEvents({
  source: openaiSource,
  feed: parseFeed(openaiFeedText(openaiItem('<p>Status: Resolved</p><p>All impacted services have now fully recovered. Affected components Conversations (Operational), Images (Operational), Files (Operational)</p>')), openaiSource),
  previous: openaiMonitoring.snapshot,
})
check('OpenAI 恢复会推送 recovery', openaiResolved.events.length === 1 && openaiResolved.events[0].kind === 'recovery' && openaiResolved.events[0].important === true)
check('OpenAI 恢复正文中文化且不刷英文列表', openaiResolved.events[0].body === '受影响服务已全部恢复。' && !formatEventText(openaiResolved.events[0]).includes('Operational'))

const legacyRssSnapshot = clone(feedFirst.snapshot)
delete legacyRssSnapshot.incidents
const legacyFeed = collectFeedEvents({ source: { id: 'rss-example', name: 'Example' }, feed: rss, previous: legacyRssSnapshot })
check('旧版 RSS 快照升级后静默重建状态', legacyFeed.seed === true && legacyFeed.events.length === 0 && !!legacyFeed.snapshot.incidents)

/* ------------------------------------------------------------------ */
section('5. Google Cloud 解析与检测')
/* ------------------------------------------------------------------ */

const googleRaw = [
  {
    id: 'g-1',
    begin: '2026-09-20T08:00:00Z',
    end: null,
    status_impact: 'SERVICE_DISRUPTION',
    external_desc: 'Gemini API is experiencing elevated error rates.',
    affected_products: [
      { title: 'Gemini API', id: 'generativelanguage.googleapis.com' },
      { title: 'Vertex AI', id: 'aiplatform.googleapis.com' },
    ],
    updates: [
      { created: '2026-09-20T08:01:00Z', status: 'SERVICE_DISRUPTION', text: 'We are investigating elevated errors on Gemini API.' },
    ],
  },
  {
    id: 'g-2',
    begin: '2026-09-20T08:00:00Z',
    end: null,
    status_impact: 'SERVICE_OUTAGE',
    external_desc: 'Cloud SQL outage.',
    affected_products: [{ title: 'Cloud SQL', id: 'cloudsql.googleapis.com' }],
    updates: [{ created: '2026-09-20T08:02:00Z', status: 'SERVICE_OUTAGE', text: 'Cloud SQL is down.' }],
  },
]
const googleParsed = parseGoogleCloudIncidents(googleRaw, { id: 'gemini', name: 'Gemini', keywords: ['gemini'] })
check('Google Cloud 默认只保留 Gemini 相关事件', googleParsed.incidents.length === 1 && googleParsed.incidents[0].id === 'g-1')
check('Google Cloud 事件包含 Gemini 产品组件', googleParsed.incidents[0].components.some(item => item.name === 'Gemini API'))
check('Google Cloud 产品列表可用于组件筛选', googleCloudProducts(googleParsed, { keywords: ['gemini'] }).some(item => item.name === 'Gemini API'))

const googleFirst = collectGoogleCloudEvents({ source: { id: 'gemini', name: 'Gemini' }, parsed: googleParsed, previous: null })
check('Google Cloud 第一次轮询只建立基线', googleFirst.seed === true && googleFirst.events.length === 0)
const googleNextRaw = clone(googleRaw)
googleNextRaw[0].updates.push({ created: '2026-09-20T08:10:00Z', status: 'SERVICE_DISRUPTION', text: 'Mitigation is in progress.' })
const googleSecond = collectGoogleCloudEvents({
  source: { id: 'gemini', name: 'Gemini' },
  parsed: parseGoogleCloudIncidents(googleNextRaw, { id: 'gemini', name: 'Gemini', keywords: ['gemini'] }),
  previous: googleFirst.snapshot,
})
check('Google Cloud 过程更新仍记录在最近事件', googleSecond.events.length === 1 && googleSecond.events[0].kind === 'incident')
check('基线中已存在的 Google 事件不会被当成新异常推送', googleSecond.events[0].important === false)

const googleSource = { id: 'gemini', name: 'Gemini', keywords: ['gemini'] }
const googleNewRaw = clone(googleNextRaw)
googleNewRaw.push({
  id: 'g-3',
  begin: '2026-09-20T10:00:00Z',
  end: null,
  status_impact: 'SERVICE_OUTAGE',
  external_desc: 'Gemini API is down.',
  affected_products: [{ title: 'Gemini API', id: 'generativelanguage.googleapis.com' }],
  updates: [{ created: '2026-09-20T10:01:00Z', status: 'SERVICE_OUTAGE', text: 'Gemini API is unavailable.' }],
})
const googleThird = collectGoogleCloudEvents({
  source: googleSource,
  parsed: parseGoogleCloudIncidents(googleNewRaw, googleSource),
  previous: googleSecond.snapshot,
})
check('Google Cloud 新增异常会推送', googleThird.events.length === 1 && googleThird.events[0].important === true && googleThird.events[0].kind === 'incident')
const googleResolvedRaw = clone(googleNewRaw)
const g3 = googleResolvedRaw.find(item => item.id === 'g-3')
g3.end = '2026-09-20T10:30:00Z'
g3.status_impact = 'SERVICE_AVAILABLE'
const googleFourth = collectGoogleCloudEvents({
  source: googleSource,
  parsed: parseGoogleCloudIncidents(googleResolvedRaw, googleSource),
  previous: googleThird.snapshot,
})
check('Google Cloud 恢复会推送 recovery', googleFourth.events.length === 1 && googleFourth.events[0].kind === 'recovery' && googleFourth.events[0].important === true)

/* ------------------------------------------------------------------ */
section('6. 订阅过滤与文案')
/* ------------------------------------------------------------------ */

const baseSub = { enabled: true, events: { incident: true, maintenance: true, component: true }, components: [], keywords: [] }
const incidentEvent = fourth.events.length ? third.events[0] : second.events[0]
check('默认订阅命中事件', eventMatchesSubscription(incidentEvent, baseSub) === true)
check('关闭故障事件后不命中', eventMatchesSubscription(incidentEvent, { ...baseSub, events: { incident: false } }) === false)
check('组件选择不匹配时不命中', eventMatchesSubscription(incidentEvent, { ...baseSub, components: ['some-other-component'] }) === false)
check('组件选择匹配时命中', eventMatchesSubscription(incidentEvent, { ...baseSub, components: ['api'] }) === true)
check('关键词匹配时命中', eventMatchesSubscription(incidentEvent, { ...baseSub, keywords: ['错误率'] }) === true)
check('关键词不匹配时不命中', eventMatchesSubscription(incidentEvent, { ...baseSub, keywords: ['不存在的关键词'] }) === false)

const text = formatEventText(incidentEvent, { maxTextChars: 1200, timeZone: 'Asia/Shanghai' })
check('通知正文包含来源与事件标题', text.includes('DeepSeek') && text.includes('API 错误率升高'))
check('通知正文包含状态和详情链接', text.includes('状态：') && text.includes('https://status.deepseek.com/incidents/inc-1'))
check('通知正文受最大长度约束', formatEventText(incidentEvent, { maxTextChars: 200 }).length <= 200)

const openaiRecovery = classifyStatusText({
  title: 'Elevated Error Rates',
  body: 'Status: Resolved\nAll impacted services have now fully recovered. Affected components Conversations (Operational), Images (Operational)',
})
check('英文 OpenAI 恢复动态能识别为 recovery', openaiRecovery.phase === 'recovery' && openaiRecovery.label === '已恢复')
const openaiComponents = extractAffectedComponents('Affected components Conversations (Operational), Images (Operational)')
check('英文 affected components 能提取组件名', openaiComponents.join('、') === 'Conversations、Images')
check('常见英文事件标题会中文化', localizeStatusTitle('Elevated Error Rates') === '错误率升高')
const englishSummary = summarizeStatusBody('Status: Resolved. All impacted services have now fully recovered. Affected components Conversations (Operational).')
check('英文恢复正文会压成中文短句', englishSummary.includes('已全部恢复') && !englishSummary.includes('Operational'))
const incidentDigest = formatEventDigestText([
  { ...second.events[0], id: 'd1', title: '错误率升高', statusLabel: '调查中', statusEmoji: '🔴', url: '' },
  { ...second.events[0], id: 'd2', title: 'API 延迟升高', statusLabel: '服务受阻', statusEmoji: '🟠', url: '' },
])
check('多条异常会合并为一条摘要', incidentDigest.includes('共 2 项服务异常') && incidentDigest.includes('错误率升高') && incidentDigest.includes('API 延迟升高'))
check('摘要受最大长度约束', formatEventDigestText([second.events[0], third.events[0]], { maxTextChars: 200 }).length <= 200)


console.log(`\n结果：${passed}/${passed + failed} 项通过`)
if (failed) process.exit(1)
