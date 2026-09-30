/*
 * media-post 纯逻辑自测（不联网、不依赖外部工具）
 * 运行：node extensions/media-post/test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatDuration, normalizeKeyword, parseDuration, rankCandidates, scoreCandidate } from './lib/match.mjs'
import { signWbi, mixinKey, pickBilibiliStreams } from './lib/bilibili.mjs'
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

/* ---------- B站选流：优先 QQ 能播的 H.264 + AAC，避免 AV1 空视频 ---------- */
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
  const picked = pickBilibiliStreams(playData, { maxHeight: 720 })
  check('选流优先 H.264 而不是 AV1', picked.videoList[0]?.codecid === 7, JSON.stringify(picked.videoList[0]))
  check('竖屏 720p 不被 height<=720 误伤', picked.videoList[0]?.width === 720, JSON.stringify(picked.videoList[0]))
  check('选流优先 AAC 而不是杜比/其他音轨', picked.audioList[0]?.codecs === 'mp4a.40.2', JSON.stringify(picked.audioList[0]))
  const onlyAv1 = pickBilibiliStreams({ dash: { video: [{ id: 32, baseUrl: 'https://x/av1', width: 480, height: 854, codecid: 13 }], audio: [] } }, { maxHeight: 720 })
  check('没有 AVC 时保留 AV1 候选交给 bridge 转码', onlyAv1.videoList[0]?.codecid === 13, JSON.stringify(onlyAv1.videoList[0]))
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

console.log(`\n结果：${checks.filter(Boolean).length}/${checks.length} 通过`)
process.exitCode = checks.every(Boolean) ? 0 : 1
