/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · 抖音直链挑选（零依赖纯函数，方便单测）
 *
 * 抖音详情接口会给两套地址：
 *   - play_addr（以及 bit_rate[].play_addr）：网页播放器实际播放的「无水印」流；
 *   - download_addr：带水印的下载流 —— 浏览器里看到的不是它，永远不要用。
 *
 * 这里只从 play_addr 系列里生成候选，并模拟网页播放器的选择：
 *   清晰度（短边）高优先 → 同清晰度 H.264 优先（QQ / NapCat 免转码）→ 码率高优先。
 * 拿不到的清晰度不会被「降级」；调用方按顺序尝试下载，前几个失败会依次回退。
 */

const QUALITY_HEIGHTS = [
  [2160, '4K'],
  [1440, '2K'],
  [1080, '1080P'],
  [720, '720P'],
  [540, '540P'],
  [480, '480P'],
  [360, '360P'],
]

function readUrlList(node) {
  if (!node) return []
  const keys = ['url_list', 'urlList', 'play_url', 'playUrl', 'url']
  const out = []
  for (const key of keys) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) out.push(typeof item === 'string' ? item : item?.url || item?.src || '')
    } else if (typeof value === 'string') {
      out.push(value)
    }
  }
  return out.map(item => String(item || '').trim()).filter(url => /^https?:\/\//i.test(url))
}

function gearHeight(gear) {
  const match = /(\d{3,4})/.exec(String(gear || ''))
  return match ? Number(match[1]) : 0
}

export function douyinQualityLabel(height = 0) {
  const value = Number(height) || 0
  const found = QUALITY_HEIGHTS.find(item => value >= item[0])
  return found ? found[1] : value ? `${value}P` : '原画'
}

/**
 * 生成「无水印」视频流候选（按浏览器原画质排序）。
 * @param {object} detail web-access readDouyin 的归一化返回（也兼容抖音原始结构）
 * @param {{maxHeight?:number}} [options] maxHeight<=0 表示不限制（原画质）
 * @returns {Array<{url:string,height:number,bitrate:number,isH265:boolean,gear:string,label:string,watermarkFree:boolean,source:string}>}
 */
export function pickDouyinStreams(detail = {}, { maxHeight = 0 } = {}) {
  const video = detail?.video || {}
  const candidates = []
  const seen = new Set()

  const push = entry => {
    const url = String(entry?.url || '').trim()
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    const height = Number(entry.height) || 0
    candidates.push({
      url,
      height,
      bitrate: Number(entry.bitrate) || 0,
      isH265: entry.isH265 === true,
      gear: String(entry.gear || ''),
      label: entry.label || douyinQualityLabel(height),
      watermarkFree: true,
      source: entry.source || 'bit_rate',
    })
  }

  // 1) 归一化后的 qualities（web-access 从 bit_rate 里提取，通常最全）
  for (const item of Array.isArray(video.qualities) ? video.qualities : []) {
    push({
      url: item?.url,
      height: Number(item?.height) || 0,
      bitrate: Number(item?.bitrate) || 0,
      isH265: item?.is_h265 === true || item?.isH265 === true,
      gear: item?.gear || item?.gear_name || '',
      source: 'bit_rate',
    })
  }

  // 2) 原始 bit_rate 结构（没有经过 web-access 归一化时）
  for (const entry of Array.isArray(video.bit_rate) ? video.bit_rate : []) {
    const gear = entry?.gear_name || entry?.gearName || ''
    const height = gearHeight(gear)
    const isH265 = entry?.is_h265 === true || entry?.isH265 === true
    for (const url of readUrlList(entry?.play_addr || entry?.playAddr)) {
      push({ url, height, bitrate: entry?.bit_rate ?? entry?.bitRate, isH265, gear, source: 'bit_rate' })
    }
  }

  // 3) 顶层 play_addr（默认清晰度）：只当作兜底，排在 bit_rate 候选之后
  const fallbacks = [
    ...readUrlList(video.play_addr || video.playAddr),
    ...(Array.isArray(video.url_list) ? video.url_list : []),
    video.url,
  ]
  const hasRealQuality = candidates.some(item => item.height > 0)
  const heightLimit = Number(maxHeight) > 0 ? Number(maxHeight) : 0
  const withinLimit = heightLimit && hasRealQuality
    ? candidates.filter(item => !item.height || item.height <= heightLimit)
    : candidates
  const ranked = (withinLimit.length ? withinLimit : candidates).slice()

  ranked.sort((a, b) => {
    if (a.height && b.height && b.height !== a.height) return b.height - a.height
    if (a.height && !b.height) return -1
    if (!a.height && b.height) return 1
    if (Number(a.isH265) !== Number(b.isH265)) return Number(a.isH265) - Number(b.isH265)
    return b.bitrate - a.bitrate
  })

  for (const url of fallbacks) {
    const clean = String(url || '').trim()
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) continue
    seen.add(clean)
    ranked.push({
      url: clean,
      height: 0,
      bitrate: 0,
      isH265: false,
      gear: '',
      label: '默认清晰度',
      watermarkFree: true,
      source: 'play_addr',
      fallback: true,
    })
  }

  return ranked
}

/** 兼容旧调用：只取最优先的一条候选。 */
export function pickDouyinStream(detail = {}, maxHeight = 0) {
  return pickDouyinStreams(detail, { maxHeight })[0]?.url || ''
}
