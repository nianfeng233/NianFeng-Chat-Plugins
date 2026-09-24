/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * agnes-media · 设置面板（插件设置按钮 / 设置页共用）。
 *
 * 面板内可以配置：
 *   - Agnes API Key、国际站 / 国内站 / 自定义 Base URL；
 *   - 插件专属 http(s) 代理（留空则跟随「设置 → 网络」的全局代理）；
 *   - 图片 / 视频模型的「下拉选择」和「手动填写」两种模式；
 *   - 模型下拉由 /v1/models 自动获取，并在每项后面标注当前免费 / 付费状态；
 *   - 默认尺寸、画幅、时长、自动发送、自动下载等参数；
 *   - 最近生成任务的状态与取消入口。
 */
import { IMAGE_ICON, SPARKLE_ICON, card, escapeHtml, row, section } from './ui.mjs'

export const PANEL_CSS = `
  .am-panel{display:flex;flex-direction:column;gap:2px;min-width:0;max-width:100%;}
  .am-panel,.am-panel *{box-sizing:border-box;}
  .am-status{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 12px;}
  .am-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.45);font-size:12px;color:var(--text-2);max-width:100%;}
  .am-chip .am-dot{width:7px;height:7px;border-radius:50%;background:var(--text-4);flex:0 0 auto;}
  .am-chip.good .am-dot{background:#49a36f;}
  .am-chip.bad .am-dot{background:#c65b5b;}
  .am-chip.warn .am-dot{background:#d9a13b;}
  .am-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--text-3);overflow-wrap:anywhere;word-break:break-all;min-width:0;max-width:100%;}
  .am-note{margin:10px 2px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.35);border:1px solid var(--border);font-size:12px;line-height:1.7;color:var(--text-3);}
  .am-note b{color:var(--text-2);}
  .am-warn{color:#c65b5b;}
  .am-inline{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0;max-width:100%;}
  .am-inline > input.setting-input,
  .am-inline > select.setting-select{flex:1 1 190px;min-width:0;max-width:100%;}
  .am-inline > button{flex:0 0 auto;}
  .am-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;width:100%;}
  .am-field{display:flex;flex-direction:column;gap:4px;min-width:0;}
  .am-field > span{font-size:11.5px;color:var(--text-4);}
  .am-field-wide{grid-column:1 / -1;}
  .am-task-list{display:flex;flex-direction:column;gap:6px;padding:10px 14px;}
  .am-task{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.35);flex-wrap:wrap;}
  .am-task-main{flex:1 1 260px;min-width:0;}
  .am-task-title{font-size:12.5px;font-weight:600;color:var(--text-2);word-break:break-all;}
  .am-task-meta{font-size:11px;color:var(--text-4);margin-top:3px;word-break:break-all;line-height:1.6;}
  .am-task-actions{display:flex;gap:6px;flex-wrap:wrap;}
  .am-empty{padding:16px;text-align:center;color:var(--text-4);font-size:12px;}
  .am-tag{display:inline-block;padding:1px 6px;border-radius:6px;font-size:10.5px;border:1px solid var(--border);color:var(--text-3);}
  .am-tag.free{color:#2f7d52;border-color:rgba(73,163,111,.45);background:rgba(73,163,111,.08);}
  .am-tag.paid{color:#b04f4f;border-color:rgba(198,91,91,.45);background:rgba(198,91,91,.08);}
  .am-panel .setting-row{flex-wrap:wrap;align-items:flex-start;gap:10px 16px;}
  .am-panel .setting-main{flex:1 1 240px;min-width:190px;}
  .am-panel .setting-name{word-break:keep-all;}
  .am-panel .setting-help{overflow-wrap:anywhere;}
  .am-panel .setting-control{flex:1 1 340px;min-width:0;max-width:100%;flex-wrap:wrap;justify-content:flex-start;}
  .am-panel .setting-control>*{max-width:100%;}
  .am-panel .setting-control>.am-inline{flex:1 1 100%;}
  @media (max-width:760px){
    .am-panel .setting-row{flex-direction:column;align-items:stretch;gap:9px;}
    .am-panel .setting-main,
    .am-panel .setting-control{flex:0 0 auto;width:100%;}
  }
`

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</option>`
}

function freeTag(item) {
  if (!item) return ''
  if (item.free === true) return '<span class="am-tag free">免费</span>'
  if (item.free === false) return '<span class="am-tag paid">付费</span>'
  return '<span class="am-tag">免费未知</span>'
}

function modelLabel(item) {
  if (!item) return ''
  const bits = [item.id]
  if (item.label) bits.unshift(item.label)
  if (item.legacy) bits.push('旧版')
  if (item.free === true) bits.push('免费')
  else if (item.free === false) bits.push('付费')
  else bits.push('免费未知')
  return bits.join(' · ')
}

function taskStatusLabel(status) {
  return (
    {
      queued: '排队中',
      running: '生成中',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    }[status] || status || '未知'
  )
}

function shortTime(value) {
  const number = Number(value) || 0
  if (!number) return ''
  try {
    return new Date(number).toLocaleString()
  } catch (_) {
    return ''
  }
}

export function renderAgnesPanel(container, { api, toast } = {}) {
  let disposed = false
  let loading = true
  let busy = false
  let status = null
  let models = null
  let error = ''
  let needsRestart = false

  const notify = (kind, message) => {
    try {
      toast?.[kind]?.(message)
    } catch (_) {
      /* ignore */
    }
  }

  const request = async (method, path, body, timeoutMs) => {
    if (!api) throw new Error('后端通道未就绪')
    if (method === 'get') return api.get(path, { timeoutMs: timeoutMs || 30000 })
    if (method === 'put') return api.put(path, body, { timeoutMs: timeoutMs || 30000 })
    return api.post(path, body, { timeoutMs: timeoutMs || 60000 })
  }

  const refresh = async ({ silent = false } = {}) => {
    if (!api) {
      loading = false
      error = '后端通道未就绪（backend-client 插件未启用或后端未启动）'
      render()
      return
    }
    if (!silent) {
      loading = true
      error = ''
      render()
    }
    try {
      const [nextStatus, nextModels] = await Promise.all([
        api.get('/agnes-media/status'),
        api.get('/agnes-media/models', { timeoutMs: 45000 }).catch(() => null),
      ])
      if (disposed) return
      status = nextStatus
      models = nextModels || status?.catalog || null
      error = ''
      needsRestart = false
    } catch (err) {
      if (disposed) return
      needsRestart = err?.status === 404
      error =
        err?.status === 404
          ? 'Agnes 后端桥尚未加载：先在插件页点「重新扫描」热加载；如果当前内核不支持热加载，再重启念风后端。'
          : err?.message || String(err)
    } finally {
      loading = false
      if (!disposed) render()
    }
  }

  const withBusy = async (fn, options = {}) => {
    if (busy) return null
    busy = true
    render()
    try {
      const result = await fn()
      if (result?.ok === false) notify('error', `${options.errorPrefix || '操作失败'}：${result.error || result.code || ''}`)
      else if (options.successMessage) notify('success', options.successMessage)
      return result
    } catch (err) {
      notify('error', `${options.errorPrefix || '操作失败'}：${err?.message || err}`)
      return null
    } finally {
      busy = false
      if (!disposed) await refresh({ silent: true })
    }
  }

  const val = field => String(container.querySelector(`[data-field="${field}"]`)?.value ?? '')
  const checked = field => container.querySelector(`[data-field="${field}"]`)?.checked === true
  const activeTag = item => (String(item) === String(status?.base?.basePreset) ? ' selected' : '')

  const modelOptions = (list, selected, fallbackList) => {
    const source = Array.isArray(list) && list.length ? list : Array.isArray(fallbackList) ? fallbackList : []
    const seen = new Set()
    const rows = []
    for (const item of source) {
      const id = String(typeof item === 'string' ? item : item?.id || '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      const normalized = typeof item === 'string' ? { id, free: null } : item
      rows.push(option(id, modelLabel(normalized), selected))
    }
    if (selected && !seen.has(String(selected))) rows.unshift(option(selected, `${selected} · 当前保存值`, selected))
    return rows.join('')
  }

  const catalogFallback = payload => {
    const catalog = payload?.catalog || {}
    const list = Array.isArray(catalog.models) ? catalog.models : []
    return {
      image: list.filter(item => item.kind === 'image'),
      video: list.filter(item => item.kind === 'video'),
    }
  }

  const render = () => {
    if (disposed) return
    if (loading && !status) {
      container.innerHTML = '<div class="am-panel"><div class="am-empty">正在读取 Agnes 设置与模型列表…</div></div>'
      return
    }
    if (!status) {
      container.innerHTML = `<div class="am-panel"><div class="am-note am-warn">${escapeHtml(error || '无法读取状态')}</div>
        <div class="am-inline" style="padding:0 2px">
          <button class="outline-btn" data-action="refresh">重试</button>
          ${needsRestart ? '<button class="outline-btn primary-soft" data-action="rescan-plugins">重新扫描插件</button><button class="outline-btn" data-action="restart-backend">重启念风后端</button>' : ''}
        </div>
        <div class="am-note">安装后如果 404，通常是外部 bridge 还没被后端扫描到：点「重新扫描插件」即可。</div></div>`
      bind()
      return
    }

    const configured = status.apiKey?.configured
    const settings = status.settings || {}
    const proxy = status.proxy || {}
    const counts = status.counts || {}
    const fallback = catalogFallback(status)
    const imageList = models?.imageOptions || fallback.image
    const videoList = models?.videoOptions || fallback.video
    const imageSize = status.options?.imageSizes || ['1K', '2K', '3K', '4K']
    const ratios = status.options?.ratios || ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']
    const videoSizes = status.options?.videoSizes || ['720P', '1080P', '1K', '2K']
    const videoModes = status.options?.videoModes || ['text', 'keyframe', 'reference']
    const tasks = Array.isArray(status.recentTasks) ? status.recentTasks : []
    const modelsInfo = models?.ok
      ? `${models.total || 0} 个模型（${models.fetched_at ? shortTime(models.fetched_at) : '刚刚'}）`
      : '内置目录（未联网获取）'

    const taskHtml = tasks.length
      ? tasks
          .map(task => {
            const result = task.result || {}
            const links = []
            if (result.local_url) links.push(`<a href="${escapeHtml(result.local_url)}" target="_blank" rel="noreferrer">本地文件</a>`)
            if (result.remote_url) links.push(`<a href="${escapeHtml(result.remote_url)}" target="_blank" rel="noreferrer">原始链接</a>`)
            const canStop = ['queued', 'running'].includes(task.status)
            return `<div class="am-task">
              <div class="am-task-main">
                <div class="am-task-title">${escapeHtml(`${task.id} · ${task.kind === 'image' ? '图片' : '视频'} · ${taskStatusLabel(task.status)}${task.status === 'running' ? ` ${Number(task.progress) || 0}%` : ''}`)}</div>
                <div class="am-task-meta">${escapeHtml((task.prompt || '').slice(0, 120))}<br />模型：${escapeHtml(task.model || '')}${task.error ? ` · <span class="am-warn">${escapeHtml(task.error)}</span>` : ''}${task.send?.sent_at ? ' · 已自动发送' : task.auto_send ? ' · 将自动发送' : ''}</div>
                ${links.length ? `<div class="am-task-meta">${links.join(' · ')}</div>` : ''}
              </div>
              <div class="am-task-actions">
                ${canStop ? `<button class="outline-btn" data-action="task-cancel" data-task="${escapeHtml(task.id)}" ${busy ? 'disabled' : ''}>取消</button>` : ''}
              </div>
            </div>`
          })
          .join('')
      : '<div class="am-empty">还没有生成任务。让模型调用 agnes_generate_image / agnes_generate_video 试试。</div>'

    container.innerHTML = `<div class="am-panel">
      <div class="am-status">
        <span class="am-chip ${configured ? 'good' : 'warn'}"><span class="am-dot"></span>${configured ? `API Key 已配置 ${escapeHtml(status.apiKey.mask || '')}` : 'API Key 未配置'}</span>
        <span class="am-chip"><span class="am-dot"></span>${escapeHtml(status.base?.baseUrl || '')}</span>
        <span class="am-chip ${proxy.effective ? 'good' : ''}"><span class="am-dot"></span>代理：${escapeHtml(proxy.effective || '直连')}</span>
        <span class="am-chip"><span class="am-dot"></span>${escapeHtml(modelsInfo)}</span>
        <span class="am-chip"><span class="am-dot"></span>任务：运行 ${counts.running || 0} / 排队 ${counts.queued || 0} / 完成 ${counts.completed || 0} / 失败 ${counts.failed || 0}</span>
      </div>
      ${error ? `<div class="am-note am-warn">${escapeHtml(error)}${needsRestart ? '<div class="am-inline" style="margin-top:8px"><button class="outline-btn primary-soft" data-action="rescan-plugins">重新扫描插件</button><button class="outline-btn" data-action="restart-backend">重启念风后端</button></div>' : ''}</div>` : ''}

      ${section('基本设置', card(`
        ${row('Agnes API Key', `保存在本机数据目录并 AES-256-GCM 加密；只用于 Agnes API。<br />国际站 / 国内站账号与 Key 不互通，请按站点填写。`, `<div class="am-inline" style="width:100%">
          <input class="setting-input" type="password" data-field="api-key" autocomplete="new-password" placeholder="${configured ? '已配置，留空则保持不变' : 'sk-...'}" />
          <button class="outline-btn primary-soft" data-action="save-key" ${busy ? 'disabled' : ''}>保存</button>
          <button class="outline-btn" data-action="clear-key" ${configured ? '' : 'disabled'}>清除</button>
          <button class="outline-btn" data-action="test-key" ${configured ? '' : 'disabled'}>测试连接</button>
        </div>`)}
        ${row('API 站点', '国际站：apihub.agnes-ai.com；国内站：apihub.agnes-ai.cn。自定义适合自建反代。', `<div class="am-grid">
          <label class="am-field"><span>预设</span><select class="setting-select" data-field="base-preset">
            ${option('international', '国际站（推荐）', status.base?.basePreset)}
            ${option('china', '国内站（国内网络更稳）', status.base?.basePreset)}
            ${option('custom', '自定义 Base URL', status.base?.basePreset)}
          </select></label>
          <label class="am-field am-field-wide"><span>Base URL（自定义时生效，需以 /v1 结尾）</span><input class="setting-input" data-field="base-url" value="${escapeHtml(status.base?.baseUrl || '')}" placeholder="https://apihub.agnes-ai.com/v1" /></label>
          <div class="am-field"><span>&nbsp;</span><button class="outline-btn primary-soft" data-action="save-base" ${busy ? 'disabled' : ''}>保存站点</button></div>
        </div>`)}
        ${row('插件专属代理', '只影响 Agnes 插件；留空表示跟随「设置 → 网络」的全局代理。支持 http:// 与 https:// 代理。', `<div class="am-inline" style="width:100%">
          <input class="setting-input" data-field="proxy" value="${escapeHtml(proxy.value || '')}" placeholder="例如 http://127.0.0.1:7890（留空=跟随全局）" />
          <button class="outline-btn primary-soft" data-action="save-proxy" ${busy ? 'disabled' : ''}>保存代理</button>
        </div>`)}
        <div class="am-note">当前实际代理：<span class="am-mono">${escapeHtml(proxy.effective || '直连（无代理）')}</span>${proxy.hint ? `<br />${escapeHtml(proxy.hint)}` : ''}</div>
      `))}

      ${section('图片模型', card(`
        ${row('选择方式', '推荐「下拉选择」：模型列表通过 GET /v1/models 自动获取；没有 Key / 网络异常时仍可切到手动填写。', `<select class="setting-select" data-field="image-model-mode">
          ${option('select', '从模型列表选择', settings.imageModelMode)}
          ${option('manual', '手动填写模型名', settings.imageModelMode)}
        </select>`)}
        ${row('图片模型', '下拉里每一项都标注了当前免费 / 付费状态（来源：Agnes 官方定价页，可能随活动调整）。', `<div class="am-inline" style="width:100%">
          <select class="setting-select" data-field="image-model-select" style="flex:2 1 260px">
            ${modelOptions(imageList, settings.imageModel, fallback.image)}
          </select>
          <input class="setting-input" data-field="image-model-manual" value="${escapeHtml(settings.imageModel || '')}" placeholder="手动填写，例如 agnes-image-2.5-flash" style="flex:1 1 220px" />
        </div>`)}
        ${row('默认图片参数', 'Agnes 推荐用 1K/2K/3K/4K + ratio；精确尺寸（如 1024x768）需宽高都能被 16 整除。', `<div class="am-grid">
          <label class="am-field"><span>size</span><select class="setting-select" data-field="image-size">${imageSize.map(item => option(item, item, settings.imageSize)).join('')}</select></label>
          <label class="am-field"><span>ratio</span><select class="setting-select" data-field="image-ratio">${ratios.map(item => option(item, item, settings.imageRatio)).join('')}</select></label>
          <label class="am-field"><span>输出</span><select class="setting-select" data-field="image-format">
            ${option('url', 'URL（推荐）', settings.imageResponseFormat)}
            ${option('b64_json', 'Base64 JSON', settings.imageResponseFormat)}
          </select></label>
          <div class="am-field"><span>&nbsp;</span><button class="outline-btn primary-soft" data-action="save-image" ${busy ? 'disabled' : ''}>保存图片设置</button></div>
        </div>`)}
      `))}

      ${section('视频模型', card(`
        ${row('选择方式', '视频同样支持「下拉选择」和「手动填写」；下拉会按模型 ID 尽量分类，识别不了的模型会同时出现在图片 / 视频列表里。', `<select class="setting-select" data-field="video-model-mode">
          ${option('select', '从模型列表选择', settings.videoModelMode)}
          ${option('manual', '手动填写模型名', settings.videoModelMode)}
        </select>`)}
        ${row('视频模型', '免费状态会直接标注在选项后面：agnes-video-2.5-flash 限时免费，agnes-video-2.5 为付费高清。', `<div class="am-inline" style="width:100%">
          <select class="setting-select" data-field="video-model-select" style="flex:2 1 260px">
            ${modelOptions(videoList, settings.videoModel, fallback.video)}
          </select>
          <input class="setting-input" data-field="video-model-manual" value="${escapeHtml(settings.videoModel || '')}" placeholder="手动填写，例如 agnes-video-2.5-flash" style="flex:1 1 220px" />
        </div>`)}
        ${row('默认视频参数', '2.5 Flash 固定 720P；2.5 支持 720P / 1080P / 1K / 2K；旧版 V2.0 的参数由模型侧按 num_frames / frame_rate 传入。', `<div class="am-grid">
          <label class="am-field"><span>size</span><select class="setting-select" data-field="video-size">${videoSizes.map(item => option(item, item, settings.videoSize)).join('')}</select></label>
          <label class="am-field"><span>画幅</span><select class="setting-select" data-field="video-aspect">${ratios.map(item => option(item, item, settings.videoAspect)).join('')}</select></label>
          <label class="am-field"><span>时长（秒）</span><select class="setting-select" data-field="video-seconds">${['4', '5', '6', '8', '10', '12'].map(item => option(item, `${item} 秒`, settings.videoSeconds)).join('')}</select></label>
          <label class="am-field"><span>默认模式</span><select class="setting-select" data-field="video-mode">${videoModes.map(item => option(item, item, settings.videoMode)).join('')}</select></label>
          <div class="am-field"><span>&nbsp;</span><button class="outline-btn primary-soft" data-action="save-video" ${busy ? 'disabled' : ''}>保存视频设置</button></div>
        </div>`)}
      `))}

      ${section('任务与自动发送', card(`
        ${row('自动发送', '生成完成后由插件自动发到发起任务时的会话；图片按图片消息发送，视频发送播放 / 下载链接（并保留 meta.video 供后续扩展）。', `<div class="am-inline">
          <label><input type="checkbox" data-field="auto-send" ${settings.autoSend !== false ? 'checked' : ''} /> 生成完成后自动发送</label>
          <label><input type="checkbox" data-field="auto-download" ${settings.autoDownload !== false ? 'checked' : ''} /> 结果下载到本机（推荐）</label>
        </div>`)}
        ${row('高级', '轮询间隔与被下载结果的大小限制；参考图默认会先下载成 Data URI 再交给 Agnes。', `<div class="am-grid">
          <label class="am-field"><span>视频轮询间隔 ms</span><input class="setting-input" type="number" min="1000" max="60000" data-field="video-poll" value="${escapeHtml(settings.videoPollMs || 3000)}" /></label>
          <label class="am-field"><span>图片超时 ms</span><input class="setting-input" type="number" min="60000" max="900000" data-field="image-timeout" value="${escapeHtml(settings.imageTimeoutMs || 360000)}" /></label>
          <label class="am-field"><span>单张参考图 MB</span><input class="setting-input" type="number" min="1" max="50" data-field="max-reference" value="${escapeHtml(settings.maxReferenceMB || 12)}" /></label>
          <label class="am-field"><span>最大视频结果 MB</span><input class="setting-input" type="number" min="1" max="2048" data-field="max-video" value="${escapeHtml(settings.maxVideoMB || 300)}" /></label>
          <label class="am-field am-field-wide"><span>兼容选项</span>
            <span class="am-inline">
              <label><input type="checkbox" data-field="fallback-remote" ${settings.referenceFallbackRemote !== false ? 'checked' : ''} /> 参考图下载失败时退回原 URL</label>
              <label><input type="checkbox" data-field="allow-private" ${settings.allowPrivateNetwork === true ? 'checked' : ''} /> 允许参考图访问内网（默认关闭）</label>
            </span>
          </label>
          <div class="am-field"><span>&nbsp;</span><button class="outline-btn primary-soft" data-action="save-advanced" ${busy ? 'disabled' : ''}>保存高级设置</button></div>
        </div>`)}
      `))}

      ${section('最近任务', `<div class="am-task-list">${taskHtml}</div>
        <div class="am-inline" style="justify-content:flex-end;padding:4px 2px 12px">
          <button class="outline-btn" data-action="refresh-models" ${busy ? 'disabled' : ''}>刷新模型列表</button>
          <button class="outline-btn" data-action="refresh">刷新状态</button>
        </div>`)}
    </div>`

    bind()
  }

  const saveConfig = patch => withBusy(() => request('put', '/agnes-media/config', patch), { successMessage: '设置已保存' })

  const bind = () => {
    container.querySelector('[data-action="refresh"]')?.addEventListener('click', () => refresh())
    container.querySelector('[data-action="refresh-models"]')?.addEventListener('click', () =>
      withBusy(() => request('get', '/agnes-media/models?force=1', undefined, 45000), { successMessage: '模型列表已刷新' }),
    )
    container.querySelector('[data-action="rescan-plugins"]')?.addEventListener('click', async () => {
      try {
        await api?.rescanPlugins?.()
        notify('success', '已请求重新扫描插件')
        await refresh()
      } catch (err) {
        notify('error', `重新扫描失败：${err?.message || err}`)
      }
    })
    container.querySelector('[data-action="restart-backend"]')?.addEventListener('click', async () => {
      try {
        await api?.restartSystem?.()
      } catch (err) {
        notify('error', `重启请求失败：${err?.message || err}`)
      }
    })
    container.querySelector('[data-action="save-key"]')?.addEventListener('click', async () => {
      const apiKey = val('api-key')
      if (!apiKey.trim()) return notify('warn', '请输入 Agnes API Key')
      await saveConfig({ apiKey })
    })
    container.querySelector('[data-action="clear-key"]')?.addEventListener('click', () => saveConfig({ clearApiKey: true }))
    container.querySelector('[data-action="test-key"]')?.addEventListener('click', () =>
      withBusy(() => request('post', '/agnes-media/test', {}), { successMessage: '连接成功，模型列表已刷新' }),
    )
    container.querySelector('[data-action="save-base"]')?.addEventListener('click', () =>
      saveConfig({ basePreset: val('base-preset'), baseUrl: val('base-url') }),
    )
    container.querySelector('[data-action="save-proxy"]')?.addEventListener('click', () => saveConfig({ proxy: val('proxy') }))
    container.querySelector('[data-action="save-image"]')?.addEventListener('click', () => {
      const manual = val('image-model-manual')
      const mode = val('image-model-mode')
      const imageModel = mode === 'manual' ? manual : val('image-model-select') || manual
      return saveConfig({
        imageModelMode: mode,
        imageModel,
        imageSize: val('image-size'),
        imageRatio: val('image-ratio'),
        imageResponseFormat: val('image-format'),
      })
    })
    container.querySelector('[data-action="save-video"]')?.addEventListener('click', () => {
      const manual = val('video-model-manual')
      const mode = val('video-model-mode')
      const videoModel = mode === 'manual' ? manual : val('video-model-select') || manual
      return saveConfig({
        videoModelMode: mode,
        videoModel,
        videoSize: val('video-size'),
        videoAspect: val('video-aspect'),
        videoSeconds: val('video-seconds'),
        videoMode: val('video-mode'),
      })
    })
    container.querySelector('[data-action="save-advanced"]')?.addEventListener('click', () =>
      saveConfig({
        autoSend: checked('auto-send'),
        autoDownload: checked('auto-download'),
        videoPollMs: Number(val('video-poll')) || 3000,
        imageTimeoutMs: Number(val('image-timeout')) || 360000,
        maxReferenceMB: Number(val('max-reference')) || 12,
        maxVideoMB: Number(val('max-video')) || 300,
        referenceFallbackRemote: checked('fallback-remote'),
        allowPrivateNetwork: checked('allow-private'),
      }),
    )
    container.querySelectorAll('[data-action="task-cancel"]').forEach(button => {
      button.addEventListener('click', () => {
        const taskId = String(button.getAttribute('data-task') || '')
        if (!taskId) return
        withBusy(() => request('post', `/agnes-media/tasks/${encodeURIComponent(taskId)}/cancel`, {}), { successMessage: '已请求取消任务' })
      })
    })
  }

  refresh()
  return () => {
    disposed = true
  }
}
