/*
 * 念风chat · 扩展插件 · github-hub
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * GitHub 助手 · 前端自包含 UI 工具与样式。
 * 不依赖本体 src，安装到任意外部插件目录后都能用。
 */

const styleRegistry = new Map()

export function useStyle(ctx, css, { id = 'github-hub' } = {}) {
  if (!css) return () => {}
  if (typeof document === 'undefined') return () => {}
  const pluginId = id || 'github-hub'
  const style = document.createElement('style')
  style.dataset.plugin = pluginId
  style.textContent = css
  document.head.appendChild(style)
  const entry = { style, count: (styleRegistry.get(pluginId)?.count || 0) + 1 }
  styleRegistry.set(pluginId, entry)
  try {
    return ctx.effect(() => {
      style.remove()
      const current = styleRegistry.get(pluginId)
      if (current === entry) styleRegistry.delete(pluginId)
    })
  } catch (_) {
    return () => style.remove()
  }
}

export const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[match])

export const GITHUB_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A12.02 12.02 0 0 0 24 12c0-6.27-5.37-11.5-12-11.5z"/></svg>'

export const page = (title, desc, html) => `<div class="settings-title-row">
  <div><div class="settings-title">${escapeHtml(title)}</div><div class="settings-desc">${escapeHtml(desc || '')}</div></div>
</div>${html}`

export const section = (title, content, { className = '' } = {}) =>
  `<div class="settings-section ${className}">${title ? `<div class="settings-section-title">${escapeHtml(title)}</div>` : ''}${content}</div>`

export const card = rows => `<div class="settings-card">${rows}</div>`

export const row = (name, help, control) => `<div class="setting-row">
  <div class="setting-main"><div class="setting-name">${escapeHtml(name)}</div>${help ? `<div class="setting-help">${help}</div>` : ''}</div>
  <div class="setting-control">${control}</div>
</div>`

export const button = (label, action, { variant = '', disabled = false, title = '', dataset = null } = {}) => {
  const attrs = dataset && typeof dataset === 'object'
    ? Object.entries(dataset)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => ` data-${String(key).replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}="${escapeHtml(value)}"`)
        .join('')
    : ''
  return `<button class="ghh-btn ${variant}" data-action="${escapeHtml(action)}"${attrs}${disabled ? ' disabled' : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</button>`
}

export const switchButton = (text, field, on) =>
  `<button class="ghh-switch ${on ? 'on' : ''}" data-field="${escapeHtml(field)}" type="button" role="switch" aria-checked="${on ? 'true' : 'false'}"><span></span>${escapeHtml(text)}</button>`

export const input = (field, value, { type = 'text', placeholder = '', width = 220, disabled = false } = {}) =>
  `<input class="ghh-input" type="${escapeHtml(type)}" data-field="${escapeHtml(field)}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}" style="width:${Number(width) || 220}px"${disabled ? ' disabled' : ''} />`

export const textarea = (field, value, { placeholder = '', rows = 4, width = 100 } = {}) =>
  `<textarea class="ghh-textarea" data-field="${escapeHtml(field)}" rows="${Number(rows) || 4}" placeholder="${escapeHtml(placeholder)}" style="width:${Number(width) || 100}%">${escapeHtml(value ?? '')}</textarea>`

export const select = (field, value, options, { width = 190 } = {}) => {
  const list = (Array.isArray(options) ? options : []).map(option => ({ value: String(option.value ?? option), label: String(option.label ?? option.value ?? option) }))
  return `<select class="ghh-select" data-field="${escapeHtml(field)}" style="width:${Number(width) || 190}px">${list
    .map(option => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(value ?? '') ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('')}</select>`
}

export const badge = (text, { tone = 'gray' } = {}) => `<span class="ghh-badge ${escapeHtml(tone)}">${escapeHtml(text)}</span>`

export const fieldValue = (container, field) => {
  const element = container.querySelector(`[data-field="${String(field).replace(/"/g, '\\"')}"]`)
  if (!element) return undefined
  if (element.type === 'checkbox') return element.checked
  if (element.classList?.contains('ghh-switch')) return element.getAttribute('aria-checked') === 'true'
  return element.value
}

export const setFieldValue = (container, field, value) => {
  const element = container.querySelector(`[data-field="${String(field).replace(/"/g, '\\"')}"]`)
  if (!element) return
  if (element.classList?.contains('ghh-switch')) {
    element.classList.toggle('on', value === true)
    element.setAttribute('aria-checked', value === true ? 'true' : 'false')
  } else {
    element.value = value ?? ''
  }
}

export const PANEL_CSS = `
.ghh-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.ghh-actions { display:flex; gap:8px; flex-wrap:wrap; }
.ghh-btn { border:1px solid var(--border-color, #d0d7de); background:var(--btn-bg, #f6f8fa); color:var(--text-color, #1f2328); border-radius:8px; padding:6px 12px; font-size:13px; cursor:pointer; line-height:1.4; }
.ghh-btn:hover:not(:disabled) { border-color:var(--accent-color, #70a15a); color:var(--accent-color, #70a15a); }
.ghh-btn.primary { background:var(--accent-color, #4f8f3f); border-color:var(--accent-color, #4f8f3f); color:#fff; }
.ghh-btn.danger { color:#cf222e; border-color:rgba(207,34,46,.4); background:rgba(207,34,46,.06); }
.ghh-btn:disabled { opacity:.55; cursor:not-allowed; }
.ghh-switch { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--border-color,#d0d7de); background:var(--btn-bg,#f6f8fa); color:var(--text-color,#1f2328); border-radius:999px; padding:5px 12px 5px 6px; font-size:13px; cursor:pointer; }
.ghh-switch span { width:30px; height:18px; border-radius:999px; background:#c6cbd1; position:relative; transition:.18s; flex:none; }
.ghh-switch span::after { content:''; position:absolute; width:14px; height:14px; border-radius:50%; background:#fff; top:2px; left:2px; transition:.18s; }
.ghh-switch.on span { background:var(--accent-color,#4f8f3f); }
.ghh-switch.on span::after { left:14px; }
.ghh-input, .ghh-select, .ghh-textarea { border:1px solid var(--border-color,#d0d7de); background:var(--input-bg,#fff); color:var(--text-color,#1f2328); border-radius:8px; padding:6px 9px; font-size:13px; font-family:inherit; box-sizing:border-box; max-width:100%; }
.ghh-textarea { resize:vertical; line-height:1.5; }
.ghh-input:focus, .ghh-select:focus, .ghh-textarea:focus { outline:2px solid color-mix(in srgb, var(--accent-color,#4f8f3f) 36%, transparent); outline-offset:0; }
.ghh-status { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:10px 0 4px; }
.ghh-badge { display:inline-flex; align-items:center; border-radius:999px; padding:2px 9px; font-size:12px; border:1px solid transparent; }
.ghh-badge.gray { background:rgba(110,119,129,.12); color:#57606a; }
.ghh-badge.green { background:rgba(26,127,55,.12); color:#1a7f37; }
.ghh-badge.blue { background:rgba(9,105,218,.12); color:#0969da; }
.ghh-badge.orange { background:rgba(154,103,0,.14); color:#9a6700; }
.ghh-badge.red { background:rgba(207,34,46,.12); color:#cf222e; }
.ghh-dim { color:var(--text-dim,#6e7781); font-size:12px; }
.ghh-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:10px 0; }
.ghh-channel { border:1px solid var(--border-color,#d0d7de); border-radius:12px; padding:12px; margin:10px 0; background:var(--card-bg,rgba(255,255,255,.55)); }
.ghh-channel-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.ghh-dot { width:8px; height:8px; border-radius:50%; background:#c6cbd1; flex:none; }
.ghh-dot.online { background:#1a7f37; box-shadow:0 0 0 3px rgba(26,127,55,.15); }
.ghh-dot.error { background:#cf222e; }
.ghh-dot.connecting { background:#bf8700; }
.ghh-repos { margin-top:10px; display:flex; flex-direction:column; gap:8px; }
.ghh-repo { border:1px dashed var(--border-color,#d0d7de); border-radius:10px; padding:8px 10px; }
.ghh-repo-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ghh-repo-name { font-size:13px; font-weight:650; }
.ghh-events { display:flex; gap:10px; flex-wrap:wrap; margin-top:6px; }
.ghh-evt { display:inline-flex; gap:5px; align-items:center; font-size:12px; color:var(--text-dim,#6e7781); cursor:pointer; }
.ghh-evt input { accent-color:var(--accent-color,#4f8f3f); }
.ghh-add { display:flex; gap:6px; align-items:center; margin-top:8px; }
.ghh-empty { color:var(--text-dim,#6e7781); font-size:13px; padding:8px 0; }
.ghh-list-item { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-top:1px solid var(--border-color,#eaeef2); }
.ghh-list-item:first-child { border-top:none; }
.ghh-list-main { flex:1; min-width:0; }
.ghh-list-title { font-size:13.5px; font-weight:650; word-break:break-word; }
.ghh-list-summary { font-size:12.5px; color:var(--text-dim,#6e7781); margin-top:3px; white-space:pre-wrap; word-break:break-word; }
.ghh-list-time { font-size:11.5px; color:var(--text-dim,#6e7781); white-space:nowrap; }
.ghh-chip { display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:3px 8px; font-size:12px; background:rgba(9,105,218,.1); color:#0969da; }
.ghh-chip button { border:none; background:none; color:inherit; cursor:pointer; padding:0; font-size:13px; line-height:1; }
.ghh-note { font-size:12px; color:var(--text-dim,#6e7781); line-height:1.55; }
.ghh-mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
.ghh-loading { padding:18px; color:var(--text-dim,#6e7781); }
.ghh-error { color:#cf222e; font-size:13px; padding:8px 0; }
.ghh-section-gap { margin-top:14px; }
.ghh-scope-options { border-top:1px solid var(--border-color,#eaeef2); margin-top:10px; padding-top:10px; }
.ghh-scope-group { margin-bottom:12px; }
.ghh-scope-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
.ghh-scope-title { font-size:12.5px; font-weight:650; }
.ghh-scope-list { display:flex; flex-direction:column; gap:4px; max-height:220px; overflow:auto; padding:2px; }
.ghh-scope-item { display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:8px; cursor:pointer; font-size:12.5px; }
.ghh-scope-item:hover { background:rgba(110,119,129,.08); }
.ghh-scope-item input { accent-color:var(--accent-color,#4f8f3f); flex:none; }
.ghh-scope-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
`

export const formatNumber = value => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '0'
  if (Math.abs(num) >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (Math.abs(num) >= 10000) return `${(num / 1000).toFixed(1)}k`
  return String(num)
}
