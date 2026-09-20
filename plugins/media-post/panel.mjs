/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · 设置面板 / 点歌台
 *
 * 视觉与「联网访问」设置页保持一致：复用全局 settings-* / setting-* / outline-btn 样式，
 * 只有媒体库列表用一小段自定义 CSS。
 */
export const PANEL_CSS = `
.mp-media-list{display:flex;flex-direction:column;gap:8px;max-height:320px;overflow:auto;}
.mp-media-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.35);}
.mp-media-main{flex:1;min-width:0;}
.mp-media-name{font-size:12.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mp-media-meta{font-size:11px;color:var(--text-4);margin-top:2px;}
.mp-note{font-size:11.5px;line-height:1.7;color:var(--text-4);margin-top:6px;}
.mp-note.warn{color:#b26a00;}
.mp-note.ok{color:#248a3d;}
.mp-note.err{color:#c0392b;}
`

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

const page = (title, desc, html) =>
  `<div class="settings-title-row">
    <div><div class="settings-title">${escapeHtml(title)}</div><div class="settings-desc">${escapeHtml(desc || '')}</div></div>
  </div>${html}`

const section = (title, content) =>
  `<div class="settings-section">${title ? `<div class="settings-section-title">${escapeHtml(title)}</div>` : ''}${content}</div>`

const card = rows => `<div class="settings-card">${rows}</div>`

const TONE_COLORS = {
  good: 'color:#248a3d;border-color:rgba(52,199,89,.45)',
  warn: 'color:#b26a00;border-color:rgba(255,159,10,.45)',
  bad: 'color:#c0392b;border-color:rgba(255,59,48,.35)',
}

const chip = (text, tone = '') =>
  `<span class="outline-btn" style="cursor:default;border-radius:999px;padding:4px 10px;font-size:12px;${TONE_COLORS[tone] || ''}">${escapeHtml(text)}</span>`

const chips = list => `<div style="display:flex;flex-wrap:wrap;gap:8px">${list.filter(Boolean).join('')}</div>`

const bytes = value => {
  const size = Number(value) || 0
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)}GB`
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
  if (size >= 1024) return `${Math.round(size / 1024)}KB`
  return `${size}B`
}

const duration = seconds => {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * @param {HTMLElement} container
 * @param {{ api?: any, toast?: any }} services
 */
export function renderMediaPanel(container, services = {}) {
  const api = services.api
  const toast = services.toast
  let status = null
  let library = []
  let busy = false
  let formState = {}
  let testResult = ''

  const notify = (kind, message) => {
    try {
      if (kind === 'error') toast?.warn?.(message)
      else toast?.[kind]?.(message)
    } catch (_) {
      /* ignore */
    }
    console[kind === 'error' ? 'warn' : 'log'](`[media-post] ${message}`)
  }

  const request = async (method, path, body, timeoutMs = 60000) => {
    if (!api) throw new Error('本地后端未连接')
    if (method === 'get') return api.get(path, { timeoutMs })
    if (method === 'del') return api.del(path, { timeoutMs })
    return api.post(path, body, { timeoutMs })
  }

  const loadStatus = async () => {
    try {
      status = await request('get', '/media/status', undefined, 40000)
    } catch (error) {
      status = { ok: false, error: error?.message || String(error) }
    }
  }

  const loadLibrary = async () => {
    try {
      const result = await request('get', '/media/library?limit=30', undefined, 30000)
      library = Array.isArray(result?.items) ? result.items : []
    } catch (_) {
      library = []
    }
  }

  const withBusy = async (fn, label) => {
    busy = true
    render()
    try {
      return await fn()
    } catch (error) {
      notify('error', `${label || '操作'}失败：${error?.message || error}`)
      return null
    } finally {
      busy = false
      await Promise.all([loadStatus(), loadLibrary()])
      render()
    }
  }

  const statusHtml = () => {
    if (!status) return '<div class="mp-note">正在读取后端状态…</div>'
    if (status.ok === false) {
      return `<div class="mp-note err">无法读取后端状态：${escapeHtml(status?.error || 'media-post 后端桥尚未加载')}。
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button class="outline-btn primary-soft" data-action="rescan" ${busy ? 'disabled' : ''}>重新扫描插件</button>
          <button class="outline-btn" data-action="restart" ${busy ? 'disabled' : ''}>重启念风后端</button>
        </div>
      </div>`
    }
    const tools = status.tools || {}
    const accessChip = status.webAccess
      ? chip(`联网访问 ${status.webAccessVersion ? 'v' + status.webAccessVersion : ''}${status.webAccessMode === 'http' ? '（HTTP 兼容模式）' : ''}`.trim(), 'good')
      : chip('缺少「联网访问」后端', 'bad')
    const ffmpegChip = tools.ffmpeg?.available ? chip(`ffmpeg ${tools.ffmpeg.version || ''}`.trim(), 'good') : chip('未检测到 ffmpeg', 'bad')
    const ytdlpChip = tools.ytdlp?.available ? chip(`yt-dlp ${tools.ytdlp.version || ''}`.trim(), 'good') : chip('未检测到 yt-dlp', 'warn')
    const pythonChip = tools.python?.available ? chip(`Python ${tools.python.version || ''}`.trim()) : chip('没有 Python', 'warn')
    const cookies = status.cookies || {}
    const cookieChip = key => {
      const item = cookies[key] || {}
      const label = key === 'douyin' ? '抖音' : 'B站'
      return item.hasCookies ? chip(`${label} Cookie ${item.count} 条`, 'good') : chip(`${label} 未登录`, 'warn')
    }
    const napcatChip = status.napcat
      ? chip(`NapCat 可用 · ${Array.isArray(status.napcatChannels) ? status.napcatChannels.length : 0} 个渠道`, 'good')
      : chip('未检测到 NapCat', 'bad')
    const qqbotChip = status.qqbot
      ? chip(`QQ 官方语音可用${status.qqbotVoice === false ? '（服务未上报）' : '（SILK）'}`, 'good')
      : chip('未检测到 QQ 官方机器人', 'warn')
    const cache = status.cache || {}
    const config = status.config || {}
    return `
      ${chips([accessChip, ffmpegChip, ytdlpChip, pythonChip])}
      <div style="height:8px"></div>
      ${chips([cookieChip('bilibili'), cookieChip('douyin'), napcatChip, qqbotChip])}
      <div class="mp-note">媒体库 ${cache.count || 0} 个 · ${bytes(cache.bytes || 0)}；上限 ${config.keep || 200} 个 / ${bytes(config.maxBytes || 0)}。</div>
      ${status.webAccessHint ? `<div class="mp-note warn">${escapeHtml(status.webAccessHint)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button class="outline-btn primary-soft" data-action="rescan" ${busy ? 'disabled' : ''}>重新扫描插件</button>
          <button class="outline-btn" data-action="restart" ${busy ? 'disabled' : ''}>重启念风后端</button>
        </div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="outline-btn primary-soft" data-action="install-tools" ${busy ? 'disabled' : ''}>一键安装缺失工具</button>
        <button class="outline-btn" data-action="refresh" ${busy ? 'disabled' : ''}>刷新状态</button>
        <button class="outline-btn" data-action="prune" ${busy ? 'disabled' : ''}>立即清理缓存</button>
      </div>`
  }

  const toolsHtml = () =>
    `<div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="outline-btn primary-soft" data-action="install-ffmpeg" ${busy ? 'disabled' : ''}>安装 / 修复 ffmpeg</button>
      <button class="outline-btn primary-soft" data-action="install-ytdlp" ${busy ? 'disabled' : ''}>安装 / 修复 yt-dlp</button>
    </div>
    <div class="mp-note">ffmpeg 从 npm 镜像（npmmirror）下载；yt-dlp 优先用本机 Python + PyPI 镜像安装，没有 Python 时再尝试 GitHub（国内可能失败，失败原因会写进日志）。</div>`

  const loginHtml = () =>
    `<div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="outline-btn primary-soft" data-action="login" data-site="douyin" ${busy || !status?.webAccess ? 'disabled' : ''}>登录抖音</button>
      <button class="outline-btn primary-soft" data-action="login" data-site="bilibili" ${busy || !status?.webAccess ? 'disabled' : ''}>登录 B站</button>
      <button class="outline-btn" data-action="sync-cookies" ${busy || !status?.webAccess ? 'disabled' : ''}>同步 Cookie 并导出</button>
    </div>
    <div class="mp-note">与「联网访问」共用同一个 Cookie 库和独立浏览器配置：<b>如果你已经在联网访问里登录过，这里点一次「同步 Cookie 并导出」即可，不需要重复登录</b>。Cookie 过期后再点一次登录窗口即可。</div>`

  const behaviorHtml = () => {
    const config = status?.config || {}
    const voice = formState.voiceFormat || config.voiceFormat || 'mp3'
    const maxHeight = Number(formState.maxHeight || config.maxHeight) || 720
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select class="setting-input" data-field="voiceFormat" style="width:auto">
        <option value="mp3" ${voice === 'amr' ? '' : 'selected'}>mp3（兼容性最好）</option>
        <option value="amr" ${voice === 'amr' ? 'selected' : ''}>amr（更小，更像 QQ 语音）</option>
      </select>
      <select class="setting-input" data-field="maxHeight" style="width:auto">
        ${[360, 480, 720, 1080].map(height => `<option value="${height}" ${maxHeight === height ? 'selected' : ''}>视频 ${height}P</option>`).join('')}
      </select>
      <input class="setting-input" data-field="maxVideoMB" style="width:80px" value="${escapeHtml(formState.maxVideoMB ?? config.maxVideoMB ?? 150)}" title="单视频上限(MB)" />
      <span style="font-size:12px;color:var(--text-4)">MB</span>
    </div>
    <div class="mp-note">NapCat 使用上面的语音格式；QQ 官方机器人会自动用 ffmpeg + silk-wasm 转 SILK，不受此选项影响。</div>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input class="setting-input" data-field="fileBaseUrl" style="min-width:260px;flex:1" placeholder="媒体直链地址：远程 NapCat 时填 http://局域网IP:8788，本机留空" value="${escapeHtml(formState.fileBaseUrl ?? config.fileBaseUrl ?? '')}" />
    </div>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span style="font-size:12px;color:var(--text-4)">缓存上限</span>
      <input class="setting-input" data-field="keep" style="width:80px" value="${escapeHtml(formState.keep ?? config.keep ?? 200)}" /> <span style="font-size:12px;color:var(--text-4)">个</span>
      <input class="setting-input" data-field="maxBytes" style="width:60px" value="${Math.round((Number(formState.maxBytes) || Number(config.maxBytes) || 0) / 1024 / 1024 / 1024)}" /> <span style="font-size:12px;color:var(--text-4)">GB</span>
      <input class="setting-input" data-field="ttlDays" style="width:60px" value="${escapeHtml(formState.ttlDays ?? config.ttlDays ?? 7)}" /> <span style="font-size:12px;color:var(--text-4)">天</span>
      <button class="outline-btn primary-soft" data-action="save-config" ${busy ? 'disabled' : ''}>保存</button>
    </div>`
  }

  const mediaListHtml = () => {
    if (!library.length) return '<div class="mp-note">媒体库还是空的。在上面粘贴一个 B站 / 抖音链接试一下。</div>'
    return `<div class="mp-media-list">${library
      .map(item => {
        const meta = [
          item.kind === 'audio' ? '音频' : item.kind === 'video' ? '视频' : item.kind === 'image' ? '图片' : '文件',
          bytes(item.size),
          item.duration ? duration(item.duration) : '',
          item.author || '',
        ].filter(Boolean).join(' · ')
        const playable = item.kind === 'audio' || item.kind === 'video'
        return `<div class="mp-media-item" data-id="${escapeHtml(item.id)}">
          <div class="mp-media-main">
            <div class="mp-media-name">${escapeHtml(item.title || item.file || item.id)}</div>
            <div class="mp-media-meta">${escapeHtml(meta)}</div>
          </div>
          ${playable ? `<button class="outline-btn" data-action="play-media" data-file="/api/media/file/${escapeHtml(item.id)}/${escapeHtml(item.secret || '')}/${escapeHtml(item.file || '')}">试听</button>` : ''}
          <button class="outline-btn" data-action="delete-media" data-id="${escapeHtml(item.id)}">删除</button>
        </div>`
      })
      .join('')}</div>`
  }

  const captureForm = () => {
    for (const field of ['voiceFormat', 'maxHeight', 'maxVideoMB', 'fileBaseUrl', 'keep', 'maxBytes', 'ttlDays', 'test-url', 'test-kind']) {
      const element = container.querySelector(`[data-field="${field}"]`)
      if (element) formState[field] = element.value
    }
  }

  const render = () => {
    captureForm()
    container.innerHTML = `<div class="mp-panel">
      ${page('点歌台 · 媒体放映机', 'B站 / 抖音视频与图文：点歌发 QQ 语音（NapCat / QQ 官方机器人 SILK）、发视频 / 图文，其它渠道降级为文件或链接。', '')}
      ${section('状态', card(statusHtml()))}
      ${section('工具', card(toolsHtml()))}
      ${section('登录 / Cookie', card(loginHtml()))}
      ${section('默认行为', card(behaviorHtml()))}
      ${section('解析测试', card(`
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input class="setting-input" data-field="test-url" style="flex:1;min-width:260px" placeholder="粘贴 b23.tv / bilibili.com / v.douyin.com / 抖音分享链接" value="${escapeHtml(formState['test-url'] ?? '')}" />
          <select class="setting-input" data-field="test-kind" style="width:auto">
            <option value="video" ${(formState['test-kind'] || 'video') === 'video' ? 'selected' : ''}>视频</option>
            <option value="audio" ${formState['test-kind'] === 'audio' ? 'selected' : ''}>音频</option>
            <option value="images" ${formState['test-kind'] === 'images' ? 'selected' : ''}>图文</option>
          </select>
          <button class="outline-btn primary-soft" data-action="test-prepare" ${busy ? 'disabled' : ''}>下载到媒体库</button>
        </div>
        <div class="mp-note" data-role="test-result">${testResult || '下载只入库、不发送；用来确认解析和工具链是否正常。'}</div>
      `))}
      ${section('媒体库', card(mediaListHtml()))}
    </div>`
    bind()
  }

  const rescanPlugins = async () => {
    if (api?.rescanPlugins) return api.rescanPlugins()
    return request('post', '/plugins/rescan', {}, 60000)
  }

  const restartBackend = async () => {
    if (api?.restartSystem) return api.restartSystem()
    return request('post', '/system/restart', {}, 8000)
  }

  const bind = () => {
    container.querySelector('[data-action="refresh"]')?.addEventListener('click', () => withBusy(async () => { await Promise.all([loadStatus(), loadLibrary()]) }, '刷新'))
    container.querySelector('[data-action="rescan"]')?.addEventListener('click', () => withBusy(async () => {
      await rescanPlugins()
      notify('info', '已触发插件重新扫描；若状态仍旧，请等几秒刷新，或重启念风后端。')
    }, '重新扫描'))
    container.querySelector('[data-action="restart"]')?.addEventListener('click', () => withBusy(async () => {
      await restartBackend()
      notify('info', '正在重启念风后端…')
    }, '重启后端'))
    container.querySelector('[data-action="install-tools"]')?.addEventListener('click', () => withBusy(async () => {
      const result = await request('post', '/media/tools/install', { target: 'auto' }, 1200000)
      notify(result?.ok ? 'info' : 'error', result?.ok ? '工具安装完成' : result?.error || '工具安装失败')
    }, '安装工具'))
    container.querySelector('[data-action="install-ffmpeg"]')?.addEventListener('click', () => withBusy(async () => {
      const result = await request('post', '/media/tools/install', { target: 'ffmpeg' }, 1200000)
      notify(result?.ok ? 'info' : 'error', result?.ok ? 'ffmpeg 安装完成' : result?.error || 'ffmpeg 安装失败')
    }, '安装 ffmpeg'))
    container.querySelector('[data-action="install-ytdlp"]')?.addEventListener('click', () => withBusy(async () => {
      const result = await request('post', '/media/tools/install', { target: 'ytdlp' }, 1200000)
      notify(result?.ok ? 'info' : 'error', result?.ok ? 'yt-dlp 安装完成' : result?.error || 'yt-dlp 安装失败')
    }, '安装 yt-dlp'))
    container.querySelector('[data-action="prune"]')?.addEventListener('click', () => withBusy(async () => {
      const result = await request('post', '/media/prune', {}, 60000)
      notify('info', `已清理 ${result?.removed || 0} 个缓存文件`)
    }, '清理缓存'))
    for (const button of container.querySelectorAll('[data-action="login"]')) {
      button.addEventListener('click', () => withBusy(async () => {
        const site = button.getAttribute('data-site')
        const url = site === 'douyin' ? 'https://www.douyin.com/' : 'https://www.bilibili.com/'
        const result = await request('post', '/web-access/browse', { action: 'login', url, interactive: true }, 150000)
        if (result?.ok) notify('info', `已打开${site === 'douyin' ? '抖音' : 'B站'}登录窗口：扫码完成后回到这里点「同步 Cookie 并导出」`)
        else notify('error', result?.error || '打开登录窗口失败')
      }, '打开登录窗口'))
    }
    container.querySelector('[data-action="sync-cookies"]')?.addEventListener('click', () => withBusy(async () => {
      await request('post', '/web-access/cookies', { sync: true }, 60000)
      const result = await request('post', '/media/cookies/sync', {}, 60000)
      if (result?.ok === false) {
        notify('error', `${result.error || '同步失败'}${result.hint ? `（${result.hint}）` : ''}`)
        return
      }
      const lines = ['bilibili', 'douyin'].map(site => {
        const item = result?.cookies?.[site]
        return `${site === 'douyin' ? '抖音' : 'B站'} ${item?.hasCookies ? `${item.count} 条` : '未登录'}`
      })
      notify('info', `Cookie 状态：${lines.join(' · ')}`)
    }, '同步 Cookie'))
    container.querySelector('[data-action="save-config"]')?.addEventListener('click', () => {
      const value = field => container.querySelector(`[data-field="${field}"]`)?.value
      for (const field of ['voiceFormat', 'maxHeight', 'maxVideoMB', 'fileBaseUrl', 'keep', 'maxBytes', 'ttlDays']) formState[field] = value(field)
      const payload = {
        voiceFormat: formState.voiceFormat,
        maxHeight: Number(formState.maxHeight) || 720,
        maxVideoMB: Number(formState.maxVideoMB) || 150,
        fileBaseUrl: String(formState.fileBaseUrl || '').trim(),
        keep: Number(formState.keep) || 200,
        maxBytes: Math.max(1, Number(formState.maxBytes) || 2) * 1024 * 1024 * 1024,
        ttlDays: Number(formState.ttlDays) || 7,
      }
      return withBusy(async () => {
        await request('post', '/media/config', payload, 30000)
        notify('info', '默认设置已保存')
      }, '保存设置')
    })
    container.querySelector('[data-action="test-prepare"]')?.addEventListener('click', () => {
      formState['test-url'] = String(container.querySelector('[data-field="test-url"]')?.value || '').trim()
      formState['test-kind'] = container.querySelector('[data-field="test-kind"]')?.value || 'video'
      const url = formState['test-url']
      const kind = formState['test-kind']
      if (!url) {
        testResult = '<span class="mp-note err">请先填链接</span>'
        render()
        return
      }
      return withBusy(async () => {
        testResult = '<span class="mp-note">正在下载…</span>'
        const result = await request('post', '/media/prepare', { url, kind }, 900000)
        if (!result?.ok) {
          testResult = `<span class="mp-note err">失败：${escapeHtml(result?.error || '未知错误')}${result?.hint ? '（' + escapeHtml(result.hint) + '）' : ''}</span>`
          return
        }
        const media = result.media || {}
        const title = media.title || (media.items?.[0]?.title ?? '')
        const size = media.size || (media.items || []).reduce((sum, item) => sum + (Number(item.size) || 0), 0)
        testResult = `<span class="mp-note ok">下载完成：${escapeHtml(title || media.file || media.id || '')} · ${bytes(size)}${media.duration ? ' · ' + duration(media.duration) : ''}</span>`
      }, '解析下载')
    })
    for (const button of container.querySelectorAll('[data-action="delete-media"]')) {
      button.addEventListener('click', () => withBusy(async () => {
        await request('del', `/media/${encodeURIComponent(button.getAttribute('data-id'))}`, undefined, 30000)
      }, '删除'))
    }
    for (const button of container.querySelectorAll('[data-action="play-media"]')) {
      button.addEventListener('click', () => {
        try {
          const audio = new Audio(button.getAttribute('data-file'))
          audio.play().catch(() => notify('error', '试听失败：文件可能已被清理'))
        } catch (_) {
          notify('error', '当前环境不支持试听')
        }
      })
    }
  }

  render()
  withBusy(async () => { await Promise.all([loadStatus(), loadLibrary()]) }, '加载')
}
