/*
 * media-post 纯逻辑自测（不联网、不依赖外部工具）
 * 运行：node extensions/media-post/test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatDuration, normalizeKeyword, parseDuration, rankCandidates, scoreCandidate } from './lib/match.mjs'
import { signWbi, mixinKey, pickBilibiliStreams } from './lib/bilibili.mjs'
import { pickDouyinStreams } from './lib/douyin.mjs'
import { extractMediaLinks, normalizeLinkList } from './lib/links.mjs'
import { isQqCompatibleVideo, parseMediaInfo } from './lib/ffmpeg.mjs'
import { buildDownloadArgs, parsePrintedMeta } from './lib/ytdlp.mjs'
import { libUrl } from './lib/rev.mjs'
import { cacheStats, getRecord, listRecords, prune, publicRecord, readRecord, removeRecord, saveBuffer } from './lib/store.mjs'

const checks = []
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✗'} ${name}${ok ? '' : '  -> ' + detail}`) }

/* ---------- 时长 / 归一化 ---------- */
check('parseDuration 3:26 → 206', parseDuration('3:26') === 206, String(parseDuration('3:26')))
check('parseDuration 133:2 → 7982', parseDuration('133:2') === 7982)
check('parseDuration 1:02:03 → 3723', parseDuration('1:02:03') === 3723)
check('formatDuration 206 → 3:26', formatDuration(206) === '3:26')
check('normalizeKeyword 折叠粗体装饰', normalizeKeyword('【𝐇𝐢-𝐑𝐞𝐬无损音质】｜《 来不及爱你 》') === 'hires无损音质来不及爱你', normalizeKeyword('【𝐇𝐢-𝐑𝐞𝐬无损音质】｜《 来不及爱你 》'))

/* ---------- 打分：用真实搜索里的两条候选做回归 ---------- */
const shortDrama = { title: '【正版全集】 来不及爱你 全集', author: '必看短剧', duration: '133:2', play: 17954, url: 'https://www.bilibili.com/video/BV1Vf421q78r' }
const theSong = { title: '【𝐇𝐢-𝐑𝐞𝐬无损音质】｜《 来不及爱你 》- h3R3 -‘将这段回忆画个句号吧’', author: 'VV音乐局', duration: '3:26', play: 453058, url: 'https://www.bilibili.com/video/BV1wJDzB6EaV' }
const ranked = rankCandidates([shortDrama, theSong], '来不及爱你')
check('打分排序：纯歌排在短剧前', ranked[0].url === theSong.url, ranked.map(item => `${item.score}:${item.title}`).join(' | '))
check('短剧被扣分（负数理由）', ranked.find(item => item.url === shortDrama.url)?.reasons.some(reason => /短剧|合集/.test(reason)))
check('歌曲命中时长 / 无损特征', ranked[0].reasons.some(reason => /时长/.test(reason)) && ranked[0].reasons.some(reason => /无损|高音质/.test(reason)))
const noMatch = scoreCandidate({ title: '完全无关的视频', duration: '10:00', play: 10 }, '来不及爱你')
check('无关候选分数明显更低', noMatch.score < ranked[0].score - 40, `${noMatch.score} vs ${ranked[0].score}`)

/* ---------- WBI 签名（与 web-access 同算法，做个稳定性快照） ---------- */
check('WBI mixinKey 长度 32', mixinKey('7e1c2b4a9f8d6e5c7a3b1d9f0e2c4a6b3d5f7a9c1e3b5d7f9a0c2e4b6d8f0a1c').length === 32)
check('WBI 签名稳定', signWbi({ bvid: 'BV1wJDzB6EaV', cid: 37326096011 }, '7e1c2b4a9f8d6e5c', '3a1b5c7d9e0f2a4b', 1700000000).w_rid.length === 32)

/* ---------- 热更新缓存穿透 ---------- */
{
  const previous = globalThis.__MEDIA_POST_BRIDGE_REV
  globalThis.__MEDIA_POST_BRIDGE_REV = 'rev-test'
  check('libUrl 在热更新时携带 revision', libUrl('tools.mjs') === './tools.mjs?v=rev-test')
  if (previous === undefined) delete globalThis.__MEDIA_POST_BRIDGE_REV
  else globalThis.__MEDIA_POST_BRIDGE_REV = previous
}


/* ---------- B站选流：原画质优先，同清晰度优先 QQ 能播的 H.264 + AAC ---------- */
{
  const playData = {
    dash: {
      video: [
        { id: 80, baseUrl: 'https://x/avc720', width: 720, height: 1280, bandwidth: 500000, codecid: 7, codecs: 'avc1.640032' },
        { id: 32, baseUrl: 'https://x/av1-480', width: 480, height: 854, bandwidth: 300000, codecid: 13, codecs: 'av01.0.04M.08' },
        { id: 16, baseUrl: 'https://x/avc360', width: 360, height: 640, bandwidth: 260000, codecid: 7, codecs: 'avc1.640028' },
        { id: 64, baseUrl: 'https://x/hevc480', width: 480, height: 854, bandwidth: 310000, codecid: 12, codecs: 'hev1.1.6.L120.90' },
      ],
      audio: [
        { id: 30250, baseUrl: 'https://x/dolby', bandwidth: 448000, codecid: 0, codecs: 'ec-3' },
        { id: 30232, baseUrl: 'https://x/aac', bandwidth: 132000, codecid: 0, codecs: 'mp4a.40.2' },
      ],
    },
  }
  const picked = pickBilibiliStreams(playData, {})
  check('默认原画质：最高的 720p 排第一', picked.videoList[0]?.width === 720, JSON.stringify(picked.videoList[0]))
  check('竖屏 720p 不被 height<=720 误伤', picked.videoList[0]?.width === 720, JSON.stringify(picked.videoList[0]))
  check('选流优先 AAC 而不是杜比/其他音轨', picked.audioList[0]?.codecs === 'mp4a.40.2', JSON.stringify(picked.audioList[0]))
  check('限高 720P 时不会选到更高的流', pickBilibiliStreams(playData, { maxHeight: 720 }).videoList.every(item => Math.min(item.width, item.height) <= 720))
  const onlyAv1 = pickBilibiliStreams({ dash: { video: [{ id: 32, baseUrl: 'https://x/av1', width: 480, height: 854, codecid: 13 }], audio: [] } }, { maxHeight: 720 })
  check('没有 AVC 时保留 AV1 候选交给 bridge 转码', onlyAv1.videoList[0]?.codecid === 13, JSON.stringify(onlyAv1.videoList[0]))
  const mixed = pickBilibiliStreams(
    {
      dash: {
        video: [
          { id: 80, baseUrl: 'https://x/avc-720p', width: 1280, height: 720, bandwidth: 900000, codecid: 7, codecs: 'avc1' },
          { id: 80, baseUrl: 'https://x/av1-1080p', width: 1920, height: 1080, bandwidth: 1500000, codecid: 13, codecs: 'av01' },
        ],
        audio: [],
      },
    },
    {},
  )
  check('原画质优先：AV1 1080P 排在 H.264 720P 前（交给 bridge 转码）', mixed.videoList[0]?.width === 1920, JSON.stringify(mixed.videoList[0]))
}

/* ---------- 抖音选流：只取 play_addr（无水印），按浏览器画质排序 ---------- */
{
  const detail = {
    video: {
      url: 'https://x/default-play',
      download_url_list: ['https://x/watermarked-download'],
      qualities: [
        { gear: 'normal_540_0', height: 540, bitrate: 1200000, is_h265: false, url: 'https://x/540-avc' },
        { gear: 'normal_1080_0', height: 1080, bitrate: 3000000, is_h265: true, url: 'https://x/1080-hevc' },
        { gear: 'normal_1080_1', height: 1080, bitrate: 2600000, is_h265: false, url: 'https://x/1080-avc' },
        { gear: 'normal_720_0', height: 720, bitrate: 1800000, is_h265: false, url: 'https://x/720-avc' },
      ],
    },
  }
  const list = pickDouyinStreams(detail, {})
  check('抖音选流：最高 1080P 排第一', list[0]?.height === 1080, JSON.stringify(list.map(item => item.label)))
  check('抖音选流：同清晰度优先 H.264（免转码）', list[0]?.url === 'https://x/1080-avc', JSON.stringify(list[0]))
  check('抖音选流：绝不使用带水印的 download_addr', list.every(item => !item.url.includes('watermarked')), JSON.stringify(list.map(item => item.url)))
  check('抖音选流：顶层 play_addr 只作兜底排在最后', list[list.length - 1]?.url === 'https://x/default-play', JSON.stringify(list[list.length - 1]))
  const capped = pickDouyinStreams(detail, { maxHeight: 720 })
  check('抖音限高 720P 时不选 1080P', capped.every(item => !item.height || item.height <= 720), JSON.stringify(capped.map(item => item.label)))
  const raw = pickDouyinStreams(
    { video: { bit_rate: [{ gear_name: 'normal_1080_0', bit_rate: 3000000, play_addr: { url_list: ['https://x/raw-1080'] } }], download_addr: { url_list: ['https://x/raw-wm'] } } },
    {},
  )
  check('抖音原始 bit_rate 结构也能解析', raw[0]?.url === 'https://x/raw-1080' && raw.every(item => !item.url.includes('raw-wm')), JSON.stringify(raw))
}

/* ---------- 链接解析：一次多条 / 去重 / 裸 BV 号 ---------- */
{
  const text = '帮我把这几个发群里 https://www.bilibili.com/video/BV1wJDzB6EaV 还有 https://v.douyin.com/iRxAbCd/，另外这个别管 https://example.com/a.mp4'
  const links = extractMediaLinks(text)
  check('从文本里抽出多条受支持链接', links.length === 2 && links[0].includes('BV1wJDzB6EaV') && links[1].includes('v.douyin.com'), JSON.stringify(links))
  check('不认识的域名被忽略（不会变成 SSRF 跳板）', links.every(url => !url.includes('example.com')), JSON.stringify(links))
  const deduped = normalizeLinkList(['BV1wJDzB6EaV', 'https://www.bilibili.com/video/BV1wJDzB6EaV', 'BV1wJDzB6EaV'])
  check('裸 BV 号补全并去重', deduped.length === 1 && deduped[0] === 'https://www.bilibili.com/video/BV1wJDzB6EaV', JSON.stringify(deduped))
  const urlArray = normalizeLinkList(['https://v.douyin.com/aaa/', null, 'https://b23.tv/bbb 和 https://b23.tv/ccc'])
  check('urls 数组元素里塞多条链接也能拆开', urlArray.length === 3, JSON.stringify(urlArray))
  check('批量上限生效', normalizeLinkList(['https://b23.tv/1', 'https://b23.tv/2', 'https://b23.tv/3'], { limit: 2 }).length === 2)
  check('中文标点不会粘进链接', extractMediaLinks('看这个 https://b23.tv/abc，很好看的')[0] === 'https://b23.tv/abc')
}

/* ---------- 编码探测：H.264 + AAC 免转码，AV1 / HEVC 需要转码 ---------- */
{
  const info = parseMediaInfo(`
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':
  Duration: 00:03:26.12, start: 0.000000, bitrate: 1234 kb/s
    Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 1200 kb/s, 30 fps
    Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s
`)
  check('解析 H.264 + AAC 媒体信息', info.vcodec === 'h264' && info.acodec === 'aac' && info.width === 1920 && info.height === 1080 && info.duration === 206, JSON.stringify(info))
  check('H.264 + AAC 判定为 QQ 兼容', isQqCompatibleVideo(info) === true)
  const av1 = parseMediaInfo('Stream #0:0: Video: av1 (Main), yuv420p, 1080x1920, 30 fps\nStream #0:1: Audio: aac, 44100 Hz, stereo')
  check('AV1 判定为不兼容（需要转码）', isQqCompatibleVideo(av1) === false, JSON.stringify(av1))
  const hevc = parseMediaInfo('Stream #0:0: Video: hevc (Main), yuv420p, 1280x720, 25 fps\nStream #0:1: Audio: opus, 48000 Hz')
  check('HEVC 判定为不兼容', isQqCompatibleVideo(hevc) === false, JSON.stringify(hevc))
  check('无音轨的 H.264 仍算兼容', isQqCompatibleVideo({ vcodec: 'h264', acodec: '' }) === true)
}

/* ---------- QQ 官方语音：内置 silk-wasm 编码器 ---------- */
{
  const { encode: silkEncode, isSilk } = await import('./vendor/silk-wasm/lib/index.mjs')
  const samples = new Int16Array(4800)
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.round(Math.sin(index / 6) * 5000)
  const encoded = await silkEncode(samples.buffer, 24000)
  check('silk-wasm 可将 PCM 编码为 SILK', isSilk(encoded.data) && encoded.data.length > 0 && encoded.duration > 0, JSON.stringify({ bytes: encoded.data.length, duration: encoded.duration }))
}

/* ---------- 媒体库 ---------- */
const dir = await mkdtemp(join(tmpdir(), 'media-post-test-'))
try {
  const audio = await saveBuffer(dir, Buffer.from('fake-mp3-bytes'), { kind: 'audio', ext: 'mp3', mime: 'audio/mpeg', title: '测试歌曲', duration: 206 })
  check('媒体库写入', !!audio.id && audio.size === 14)
  check('publicRecord 不暴露 secret', !('secret' in publicRecord(audio)) && !!audio.secret)
  const found = await readRecord(dir, audio.id)
  check('媒体库读取', found?.buffer?.toString('utf8') === 'fake-mp3-bytes')
  const stats = await cacheStats(dir)
  check('媒体库统计', stats.count === 1 && stats.bytes === 14)
  for (let index = 0; index < 5; index += 1) {
    await saveBuffer(dir, Buffer.alloc(10, index), { kind: 'image', ext: 'jpg', mime: 'image/jpeg', title: `图 ${index}` })
  }
  const pruned = await prune(dir, { keep: 3, maxBytes: 1024, ttlDays: 7 })
  check('缓存按条数清理', pruned.removed >= 3 && pruned.count === 3, JSON.stringify(pruned))
  const survivor = (await listRecords(dir, { limit: 1 }))[0] || audio
  check('删除媒体', (await removeRecord(dir, survivor.id)) === true && !(await getRecord(dir, survivor.id)))
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/* ---------- yt-dlp 输出解析：标题 / 作者 / 时长 ---------- */
{
  const stdout = [
    '[download] Destination: C:\\tmp\\dl_x.mp4',
    '__MP_META__【Hi-Res】某首歌||某UP主||206.4||https://www.bilibili.com/video/BV1wJDzB6EaV',
    'C:\\tmp\\dl_x.mp4',
  ].join('\n')
  const meta = parsePrintedMeta(stdout)
  check('解析 yt-dlp 打印的标题 / 作者 / 时长', meta?.title === '【Hi-Res】某首歌' && meta?.author === '某UP主' && meta?.duration === 206 && meta?.sourceUrl.includes('BV1wJDzB6EaV'), JSON.stringify(meta))
  check('yt-dlp 缺失字段（NA）当作空值', parsePrintedMeta('__MP_META__标题||NA||NA||NA')?.author === '' && parsePrintedMeta('__MP_META__标题||NA||NA||NA')?.duration === 0)
  check('没有元数据行时返回 null', parsePrintedMeta('普通输出\nC:\\a.mp4') === null)
}

/* ---------- yt-dlp 参数：原画质优先、限高可选、音频抽 mp3 ---------- */
{
  const pick = (args, flag) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : ''
  }
  const original = buildDownloadArgs({ url: 'https://x/1', ffmpegPath: 'ffmpeg.exe', outputTemplate: 'o.%(ext)s' })
  check('原画质：不限制高度（bv*+ba）', pick(original, '-f') === 'bv*+ba/b', pick(original, '-f'))
  check('原画质：排序清晰度优先、同清晰度优先 H.264 + AAC', pick(original, '-S') === 'res,vcodec:h264,acodec:aac,br', pick(original, '-S'))
  check('有 ffmpeg 时合并成 mp4 并打印标题元数据', original.includes('--merge-output-format') && original.some(arg => arg.includes('before_dl:')))
  const capped = buildDownloadArgs({ url: 'https://x/1', ffmpegPath: 'ffmpeg.exe', maxHeight: 720 })
  check('限高时才加 [height<=720]', pick(capped, '-f') === 'bv*[height<=720]+ba/b[height<=720]/b', pick(capped, '-f'))
  const noFfmpeg = buildDownloadArgs({ url: 'https://x/1', willNotUse: true })
  check('没有 ffmpeg 时退到单流（保证有音轨）', pick(noFfmpeg, '-f') === 'b/b' && !noFfmpeg.includes('--merge-output-format'), pick(noFfmpeg, '-f'))
  const audio = buildDownloadArgs({ url: 'https://x/1', mode: 'audio', ffmpegPath: 'ffmpeg.exe', audioQuality: '128K' })
  check('音频模式：抽 mp3', pick(audio, '-f') === 'ba/b' && pick(audio, '--audio-format') === 'mp3' && pick(audio, '--audio-quality') === '128K')
  const plain = buildDownloadArgs({ url: 'https://x/1', withMeta: false })
  check('withMeta=false 时退化为只打印文件路径', plain.filter(arg => arg === '--print').length === 1 && !plain.some(arg => arg.includes('before_dl:')))
}

/* ---------- 后端桥装配 / 配置迁移（不联网：stub 掉 httpApi，只验证路由与状态） ---------- */
{
  const { writeFile } = await import('node:fs/promises')
  const bridge = await import('./bridge.mjs')
  const boot = async saved => {
    const dataDir = await mkdtemp(join(tmpdir(), 'media-post-bridge-'))
    const routes = new Map()
    const cleanups = []
    await writeFile(join(dataDir, 'media-post.json'), JSON.stringify({ version: 1, config: saved || {}, cookies: {} }), 'utf8')
    bridge.apply({
      settings: { dataDir },
      logger: { info: () => {}, warn: () => {} },
      reflect: { get: () => null },
      effect: fn => { cleanups.push(fn); return () => {} },
      httpApi: {
        route: (method, path, handler) => { routes.set(`${method} ${path}`, handler); return () => {} },
        sendJson: (res, status, body) => { res.status = status; res.body = body },
        sendError: (res, status, message) => { res.status = status; res.body = { ok: false, error: message } },
        readBody: req => Promise.resolve(req.body || {}),
      },
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    const call = async (method, path, body) => {
      const res = {}
      await routes.get(`${method} ${path}`)({ method, body }, res, {}, new URL(`http://local${path}`))
      return res
    }
    const close = async () => {
      for (const fn of cleanups) {
        try {
          const dispose = fn()
          if (typeof dispose === 'function') await dispose()
        } catch (_) { /* ignore */ }
      }
      await rm(dataDir, { recursive: true, force: true }).catch(() => {})
    }
    return { dataDir, routes, call, close }
  }

  const legacy = await boot({ maxHeight: 720, maxVideoMB: 150 })
  check('bridge.apply 注册了媒体路由', legacy.routes.has('POST /api/media/prepare') && legacy.routes.has('POST /api/media/send') && legacy.routes.has('GET /api/media/status'), [...legacy.routes.keys()].join(','))
  const status = await legacy.call('GET', '/api/media/status')
  check('旧版 maxHeight=720 迁移为原画质（best）', status.body?.config?.videoQuality === 'best' && !('maxHeight' in (status.body?.config || {})), JSON.stringify(status.body?.config))
  const saved = await legacy.call('POST', '/api/media/config', { videoQuality: '1080', transcodeMaxHeight: 0, maxVideoMB: 300 })
  check('videoQuality / transcodeMaxHeight=0 能保存（0 不是默认值兜底）', saved.body?.config?.videoQuality === '1080' && saved.body?.config?.transcodeMaxHeight === 0, JSON.stringify(saved.body?.config))
  const bad = await legacy.call('POST', '/api/media/config', { videoQuality: '随便' })
  check('非法画质回退原画质', bad.body?.config?.videoQuality === 'best', JSON.stringify(bad.body?.config))
  await legacy.close()

  const manual = await boot({ maxHeight: 480 })
  const manualStatus = await manual.call('GET', '/api/media/status')
  check('用户手动改过的 maxHeight 会保留为画质上限', manualStatus.body?.config?.videoQuality === '480', JSON.stringify(manualStatus.body?.config))
  check('状态里带当前画质标签', manualStatus.body?.qualityLabel === '480P', JSON.stringify(manualStatus.body?.qualityLabel))
  await manual.close()
}

/* ---------- 前端工具层：一次多条链接 / 多首点歌（stub 掉后端 api） ---------- */
{
  const plugin = await import('./index.mjs')
  const tools = {}
  const appended = []
  const prepareCalls = []
  const sendCalls = []
  const cleanups = []
  const api = {
    post: async (path, body) => {
      if (path === '/media/prepare') {
        prepareCalls.push(body)
        const index = prepareCalls.length
        return {
          ok: true,
          media: {
            id: `m${index}`,
            kind: body.kind === 'audio' ? 'audio' : 'video',
            title: `标题${index}`,
            duration: 200,
            sourceUrl: body.url,
            meta: { quality: '1080P', watermarkFree: true },
          },
        }
      }
      if (path === '/media/send') {
        sendCalls.push(body)
        return { ok: true, messageId: `platform-${sendCalls.length}`, target: 'napcat' }
      }
      if (path === '/web-access/browse') {
        const keyword = String(body?.query || '')
        if (keyword.includes('不存在')) return { ok: true, results: [] }
        return {
          ok: true,
          results: [{ title: `${keyword} - 测试歌手 Hi-Res 无损音质`, author: '测试UP', duration: '3:30', play: 999999, url: `https://www.bilibili.com/video/BV1${keyword.length}aaaaaaaaa` }],
        }
      }
      return { ok: false, error: `unexpected ${path}` }
    },
  }
  const registry = { register: (name, schema, handler) => { tools[name] = { schema, handler }; return () => {} } }
  const sessions = {
    get: () => ({
      id: 'conv1',
      name: '测试群',
      meta: { napcatInstanceId: 'inst', napcatTargetId: '10001', napcatTargetType: 'group', napcatChannelId: 'napcat:1' },
    }),
  }
  const store = { append: (id, message) => { appended.push({ id, message }); return { message_id: `msg${appended.length}` } }, conversationIdFor: () => 'conv1' }
  const services = { 'tool-registry': registry, 'session-service': sessions, 'chat-store': store }
  plugin.apply({
    inject: name => services[String(name || '').replace(/\?$/, '')] || null,
    registry: { get: name => (name === 'api' ? api : null) },
    effect: fn => { cleanups.push(fn); return () => {} },
    logger: { info: () => {}, warn: () => {} },
    provide: () => {},
  })

  const context = { channelId: 'napcat:1', conversationId: 'conv1' }

  check('media_send 工具已注册且带 urls 数组参数', !!tools.media_send && tools.media_send.schema.parameters.properties.urls?.type === 'array')
  const bad = await tools.media_send.handler({ url: 'https://example.com/a.mp4' }, context)
  check('非白名单链接直接拒绝（不下载任意直链）', bad.ok === false && bad.code === 'INVALID_ARGS', JSON.stringify(bad))

  const batch = await tools.media_send.handler({ urls: ['https://b23.tv/1', 'https://v.douyin.com/2/'], mode: 'video', caption: '来啦' }, context)
  check('多条链接一次发出（delivered=batch, count=2）', batch.ok === true && batch.delivered === 'batch' && batch.count === 2 && batch.items.length === 2, JSON.stringify(batch))
  check('多条链接各自下载 + 各自发送', prepareCalls.length === 2 && sendCalls.length === 2, JSON.stringify({ prepare: prepareCalls.length, send: sendCalls.length }))
  check('caption 只跟第一条走', sendCalls[0]?.caption === '来啦' && sendCalls[1]?.caption === '', JSON.stringify(sendCalls.map(item => item.caption)))
  check('结果里带画质 / 无水印信息', batch.items[0]?.quality === '1080P' && batch.items[0]?.watermark_free === true, JSON.stringify(batch.items[0]))
  check('按顺序发送（第一条先发）', sendCalls[0]?.id === 'm1' && sendCalls[1]?.id === 'm2', JSON.stringify(sendCalls.map(item => item.id)))

  prepareCalls.length = 0
  sendCalls.length = 0
  const multiInOneField = await tools.media_send.handler({ url: '看这个 https://b23.tv/a 还有 https://b23.tv/b', mode: 'voice' }, context)
  check('url 字段里塞多条链接也能拆成多条', multiInOneField.count === 2 && prepareCalls.every(item => item.kind === 'audio'), JSON.stringify(prepareCalls))
  check('语音批量返回 voice', multiInOneField.items.every(item => item.delivered === 'voice'), JSON.stringify(multiInOneField.items))

  prepareCalls.length = 0
  sendCalls.length = 0
  const over = await tools.media_send.handler({ urls: ['https://b23.tv/1', 'https://b23.tv/2', 'https://b23.tv/3', 'https://b23.tv/4', 'https://b23.tv/5', 'https://b23.tv/6', 'https://b23.tv/7'] }, context)
  check('超过上限只发前 5 条并标记 truncated', over.count === 5 && over.truncated === true && over.requested === 5, JSON.stringify({ count: over.count, truncated: over.truncated }))

  prepareCalls.length = 0
  sendCalls.length = 0
  const playlist = await tools.media_play.handler({ queries: ['晴天', '七里香'], mode: 'voice' }, context)
  check('media_play 支持一次多首（queries 数组）', playlist.count === 2 && playlist.items.length === 2 && playlist.picked?.length === 2, JSON.stringify(playlist))
  check('多首点歌都按 voice 发出', sendCalls.every(item => item.mode === 'voice') && playlist.skipped.length === 0, JSON.stringify(playlist.items))

  const ambiguous = await tools.media_play.handler({ queries: ['晴天', '不存在的歌不存在'], mode: 'voice' }, context)
  check('搜不到的歌进 skipped，其它照常发出', ambiguous.ok === true && ambiguous.delivered === 'voice' && ambiguous.skipped.length === 1 && ambiguous.skipped[0].query === '不存在的歌不存在', JSON.stringify(ambiguous.skipped))

  for (const fn of cleanups) { try { const dispose = fn(); if (typeof dispose === 'function') dispose() } catch (_) { /* ignore */ } }
}

console.log(`\n结果：${checks.filter(Boolean).length}/${checks.length} 通过`)
process.exitCode = checks.every(Boolean) ? 0 : 1
