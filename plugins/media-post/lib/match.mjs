/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · 候选视频打分器（纯函数，便于单测）
 *
 * 用途：B站 / 抖音搜索会返回一堆候选，模型需要按「像不像原曲」挑一个。
 * 这里把常见特征（标题匹配、时长、合集 / 短剧 / 教学干扰词、播放量）折算成分数与理由，
 * 返回给模型参考；模型仍然可以按用户意图改选。
 */

const FULLWIDTH_MAP = {
  '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>', '「': '"', '」': '"',
  '“': '"', '”': '"', '‘': "'", '’': "'", '，': ',', '。': '.', '、': ',', '！': '!', '？': '?',
  '：': ':', '；': ';', '～': '~', '—': '-', '－': '-', '　': ' ',
}

/** 标题归一化：去 HTML、数学粗体/装饰字母折叠成 ASCII、全角转半角、去 emoji。 */
export function normalizeTitle(input) {
  let text = String(input || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, ch => {
      // 数学字母数字符号 → ASCII（B站标题里常见的 𝐇𝐢-𝐑𝐞𝐬）
      const code = ch.codePointAt(0)
      const blocks = [
        [0x1d400, 0x1d419, 'A'], [0x1d41a, 0x1d433, 'a'],
        [0x1d434, 0x1d44d, 'A'], [0x1d44e, 0x1d467, 'a'],
        [0x1d468, 0x1d481, 'A'], [0x1d482, 0x1d49b, 'a'],
        [0x1d49c, 0x1d4b5, 'A'], [0x1d4b6, 0x1d4cf, 'a'],
        [0x1d4d0, 0x1d4e9, 'A'], [0x1d4ea, 0x1d503, 'a'],
        [0x1d504, 0x1d51d, 'A'], [0x1d51e, 0x1d537, 'a'],
        [0x1d538, 0x1d551, 'A'], [0x1d552, 0x1d56b, 'a'],
        [0x1d56c, 0x1d585, 'A'], [0x1d586, 0x1d59f, 'a'],
        [0x1d5a0, 0x1d5b9, 'A'], [0x1d5ba, 0x1d5d3, 'a'],
        [0x1d5d4, 0x1d5ed, 'A'], [0x1d5ee, 0x1d607, 'a'],
        [0x1d608, 0x1d621, 'A'], [0x1d622, 0x1d63b, 'a'],
        [0x1d63c, 0x1d655, 'A'], [0x1d656, 0x1d66f, 'a'],
        [0x1d670, 0x1d689, 'A'], [0x1d68a, 0x1d6a3, 'a'],
      ]
      for (const [start, end, base] of blocks) {
        if (code >= start && code <= end) return String.fromCharCode(base.charCodeAt(0) + (code - start))
      }
      return ' '
    })
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
  text = [...text].map(ch => FULLWIDTH_MAP[ch] || ch).join('')
  text = text.replace(/[\s_·•|/\\]+/g, ' ').trim()
  return text
}

/** 关键词归一化：小写、去空格与标点，方便“来不及爱你”匹配 “[Hi-Res] 来不及爱你 - h3R3”。 */
export function normalizeKeyword(input) {
  return normalizeTitle(input)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 把 "3:26" / "133:2" / 206 / "1:02:03" 统一成秒；解析不了返回 0。 */
export function parseDuration(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, Math.round(input))
  const text = String(input || '').trim()
  if (!text) return 0
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.round(Number(text)))
  const parts = text.split(':').map(part => Number(part.trim()))
  if (parts.some(part => !Number.isFinite(part) || part < 0)) return 0
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1])
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
  return 0
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** 干扰项：短剧 / 合集 / 教学 / 直播回放等，出现越多扣得越狠。 */
const NEGATIVE_PATTERNS = [
  { re: /短剧|全集|合集|抢先看|第\d+集|大结局/i, weight: -45, label: '短剧/合集' },
  { re: /预告|花絮|reaction|剪辑|混剪|盘点|解说|影评|吐槽/i, weight: -35, label: '二创/剪辑' },
  { re: /教学|教程|翻唱|伴奏|钢琴|吉他|尤克里里|指弹|谱/i, weight: -25, label: '教学/翻唱/伴奏' },
  { re: /直播回放|直播录屏|完整直播|连麦/i, weight: -40, label: '直播回放' },
  { re: /鬼畜|搞笑|整活|恶搞/i, weight: -20, label: '鬼畜/搞笑' },
]

/** 加分项：无损 / 官方 / 原曲 / 完整版 / MV 等，越像“纯放歌”越好。 */
const POSITIVE_PATTERNS = [
  { re: /hi-?res|无损|高音质|hifi|flac|320k/i, weight: 18, label: '无损/高音质' },
  { re: /纯音乐|纯歌|干音|原声|音频|单曲|歌曲|music/i, weight: 14, label: '纯歌/原声' },
  { re: /官方|official|原唱|原曲|正式版/i, weight: 12, label: '官方/原唱' },
  { re: /mv|完整版|full\s*ver|完整/i, weight: 8, label: 'MV/完整版' },
  { re: /歌词|lyrics|动态歌词/i, weight: 6, label: '歌词版' },
  { re: /[《「【][^》」】]{2,}[》」】]/, weight: 4, label: '标题带书名号' },
]

/**
 * 给一个候选打分。
 * @param {{ title?:string, author?:string, duration?:string|number, play?:number, description?:string, url?:string }} candidate
 * @param {string} query
 * @returns {{ score:number, reasons:string[], durationSeconds:number }}
 */
export function scoreCandidate(candidate, query) {
  const rawTitle = String(candidate?.title || '')
  const title = normalizeTitle(rawTitle)
  const text = `${rawTitle} ${candidate?.description || ''}`.trim()
  const keyword = normalizeKeyword(query)
  const titleKeyword = normalizeKeyword(title)
  const reasons = []
  let score = 0

  if (keyword) {
    if (titleKeyword.includes(keyword)) {
      score += 60
      reasons.push(`标题包含完整关键词「${query}」`)
    } else {
      const chars = [...new Set(keyword)].filter(ch => titleKeyword.includes(ch))
      const ratio = chars.length / Math.max(1, new Set(keyword).size)
      if (ratio >= 0.6) {
        score += Math.round(20 * ratio)
        reasons.push(`标题匹配关键词约 ${Math.round(ratio * 100)}%`)
      } else {
        reasons.push('标题与关键词匹配度低')
      }
    }
  }

  const durationSeconds = parseDuration(candidate?.duration)
  if (durationSeconds > 0) {
    if (durationSeconds >= 120 && durationSeconds <= 390) {
      score += 30
      reasons.push(`时长 ${formatDuration(durationSeconds)}，像一首歌`)
    } else if (durationSeconds > 60 && durationSeconds < 120) {
      score += 8
      reasons.push(`时长 ${formatDuration(durationSeconds)} 偏短`)
    } else if (durationSeconds > 390 && durationSeconds <= 900) {
      score -= 15
      reasons.push(`时长 ${formatDuration(durationSeconds)} 偏长`)
    } else if (durationSeconds > 900) {
      score -= 40
      reasons.push(`时长 ${formatDuration(durationSeconds)}，多半是合集/长视频`)
    } else if (durationSeconds > 0 && durationSeconds < 30) {
      score -= 30
      reasons.push('时长过短，可能是切片')
    }
  }

  for (const { re, weight, label } of NEGATIVE_PATTERNS) {
    if (re.test(text)) {
      score += weight
      reasons.push(`命中干扰特征：${label}`)
    }
  }
  for (const { re, weight, label } of POSITIVE_PATTERNS) {
    if (re.test(text)) {
      score += weight
      reasons.push(`命中优质特征：${label}`)
    }
  }

  const play = Number(candidate?.play) || 0
  if (play > 0) {
    const bonus = Math.min(25, Math.round(Math.log10(play + 1) * 5))
    score += bonus
    reasons.push(`播放量 ${play}`)
  }
  if (String(candidate?.author || '').trim()) score += 3

  return { score, reasons, durationSeconds }
}

/** 批量打分并排序（不修改入参）。 */
export function rankCandidates(candidates, query) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => {
      const { score, reasons, durationSeconds } = scoreCandidate(candidate, query)
      return { ...candidate, score, reasons, duration_seconds: durationSeconds || candidate?.duration_seconds || 0 }
    })
    .sort((a, b) => b.score - a.score)
}
