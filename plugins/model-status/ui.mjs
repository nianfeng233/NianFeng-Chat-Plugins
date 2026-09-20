/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 模型状态订阅 · 前端自包含 UI 工具与样式。
 * 不依赖本体 src，安装到任意外部插件目录后都能用。
 */

const styleRegistry = new Map()

export function useStyle(ctx, css, { id = 'model-status' } = {}) {
  if (!css) return () => {}
  if (typeof document === 'undefined') return () => {}
  const pluginId = id || 'model-status'
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

export const MODEL_STATUS_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.9 4.9a10 10 0 0 1 14.2 0"/><path d="M7.8 7.8a6 6 0 0 1 8.4 0"/><path d="M10.6 10.6a2.4 2.4 0 0 1 2.8 0"/><circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none"/><path d="M12 15.2V20"/><path d="M8.5 20h7"/></svg>'

export const badge = (text, { tone = 'gray' } = {}) => `<span class="ms-badge ${escapeHtml(tone)}">${escapeHtml(text)}</span>`

export const button = (label, action, { variant = '', disabled = false, title = '', dataset = null, field = '' } = {}) => {
  const attrs = dataset && typeof dataset === 'object'
    ? Object.entries(dataset)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => ` data-${String(key).replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}="${escapeHtml(value)}"`)
        .join('')
    : ''
  const fieldAttr = field ? ` data-field="${escapeHtml(field)}"` : ''
  return `<button class="ms-btn ${variant}" type="button" data-action="${escapeHtml(action)}"${fieldAttr}${attrs}${disabled ? ' disabled' : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</button>`
}

export const switchButton = (text, action, on, dataset = null) => {
  const attrs = dataset && typeof dataset === 'object'
    ? Object.entries(dataset)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => ` data-${String(key).replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}="${escapeHtml(value)}"`)
        .join('')
    : ''
  return `<button class="ms-switch ${on ? 'on' : ''}" type="button" data-action="${escapeHtml(action)}" role="switch" aria-checked="${on ? 'true' : 'false'}"${attrs}><span></span>${escapeHtml(text)}</button>`
}

export const input = (field, value, { type = 'text', placeholder = '', width = 240, disabled = false, min = '', max = '' } = {}) =>
  `<input class="ms-input" type="${escapeHtml(type)}" data-field="${escapeHtml(field)}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}" style="width:${Number(width) || 240}px"${min !== '' ? ` min="${escapeHtml(min)}"` : ''}${max !== '' ? ` max="${escapeHtml(max)}"` : ''}${disabled ? ' disabled' : ''} />`

export const select = (field, value, options, { width = 240, data = null } = {}) => {
  const list = (Array.isArray(options) ? options : []).map(option => ({ value: String(option.value ?? option), label: String(option.label ?? option.value ?? option) }))
  const attrs = data && typeof data === 'object'
    ? Object.entries(data)
        .filter(([, item]) => item !== undefined && item !== null && item !== '')
        .map(([key, item]) => ` data-${String(key).replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}="${escapeHtml(item)}"`)
        .join('')
    : ''
  return `<select class="ms-select" data-field="${escapeHtml(field)}"${attrs} style="width:${Number(width) || 240}px">${list
    .map(option => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(value ?? '') ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('')}</select>`
}

export const fieldValue = (container, field) => {
  const element = container.querySelector(`[data-field="${String(field).replace(/"/g, '\\"')}"]`)
  if (!element) return undefined
  if (element.type === 'checkbox') return element.checked
  if (element.classList?.contains('ms-switch')) return element.getAttribute('aria-checked') === 'true'
  return element.value
}

export const setFieldValue = (container, field, value) => {
  const element = container.querySelector(`[data-field="${String(field).replace(/"/g, '\\"')}"]`)
  if (!element) return
  if (element.classList?.contains('ms-switch')) {
    element.classList.toggle('on', value === true)
    element.setAttribute('aria-checked', value === true ? 'true' : 'false')
  } else {
    element.value = value ?? ''
  }
}

export const card = (title, desc, content) => `<div class="ms-card">
  ${title ? `<div class="ms-card-head"><div><div class="ms-card-title">${escapeHtml(title)}</div>${desc ? `<div class="ms-card-desc">${escapeHtml(desc)}</div>` : ''}</div></div>` : ''}
  <div class="ms-card-body">${content}</div>
</div>`

export const row = (name, help, control) => `<div class="ms-row">
  <div class="ms-row-main"><div class="ms-row-name">${escapeHtml(name)}</div>${help ? `<div class="ms-row-help">${help}</div>` : ''}</div>
  <div class="ms-row-control">${control}</div>
</div>`

export const PANEL_CSS = `
.ms-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.ms-title-row { margin-bottom:6px; }
.ms-title { font-size:18px; font-weight:700; color:var(--text-color,#1f2328); }
.ms-desc { font-size:12.5px; color:var(--text-dim,#6e7781); margin-top:3px; line-height:1.6; }
.ms-actions { display:flex; gap:8px; flex-wrap:wrap; }
.ms-btn { border:1px solid var(--border-color,#d0d7de); background:var(--btn-bg,#f6f8fa); color:var(--text-color,#1f2328); border-radius:8px; padding:6px 11px; font-size:13px; cursor:pointer; line-height:1.4; font-family:inherit; }
.ms-btn:hover:not(:disabled) { border-color:var(--accent-color,#70a15a); color:var(--accent-color,#70a15a); }
.ms-btn.primary { background:var(--accent-color,#4f8f3f); border-color:var(--accent-color,#4f8f3f); color:#fff; }
.ms-btn.primary:hover:not(:disabled) { color:#fff; opacity:.92; }
.ms-btn.danger { color:#cf222e; border-color:rgba(207,34,46,.4); background:rgba(207,34,46,.06); }
.ms-btn.small { padding:3px 8px; font-size:12px; border-radius:7px; }
.ms-btn:disabled { opacity:.55; cursor:not-allowed; }
.ms-switch { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--border-color,#d0d7de); background:var(--btn-bg,#f6f8fa); color:var(--text-color,#1f2328); border-radius:999px; padding:4px 11px 4px 5px; font-size:12.5px; cursor:pointer; font-family:inherit; }
.ms-switch span { width:28px; height:17px; border-radius:999px; background:#c6cbd1; position:relative; transition:.18s; flex:none; }
.ms-switch span::after { content:''; position:absolute; width:13px; height:13px; border-radius:50%; background:#fff; top:2px; left:2px; transition:.18s; }
.ms-switch.on span { background:var(--accent-color,#4f8f3f); }
.ms-switch.on span::after { left:13px; }
.ms-input, .ms-select, .ms-textarea { border:1px solid var(--border-color,#d0d7de); background:var(--input-bg,#fff); color:var(--text-color,#1f2328); border-radius:8px; padding:6px 9px; font-size:13px; font-family:inherit; box-sizing:border-box; max-width:100%; }
.ms-textarea { resize:vertical; line-height:1.5; }
.ms-input:focus, .ms-select:focus, .ms-textarea:focus { outline:2px solid color-mix(in srgb, var(--accent-color,#4f8f3f) 36%, transparent); outline-offset:0; }
.ms-badge { display:inline-flex; align-items:center; border-radius:999px; padding:2px 8px; font-size:11.5px; border:1px solid transparent; line-height:1.7; }
.ms-badge.gray { background:rgba(110,119,129,.12); color:#57606a; }
.ms-badge.green { background:rgba(26,127,55,.12); color:#1a7f37; }
.ms-badge.blue { background:rgba(9,105,218,.12); color:#0969da; }
.ms-badge.orange { background:rgba(154,103,0,.14); color:#9a6700; }
.ms-badge.red { background:rgba(207,34,46,.12); color:#cf222e; }
.ms-badge.purple { background:rgba(130,80,223,.14); color:#8250df; }
.ms-dim { color:var(--text-dim,#6e7781); font-size:12px; line-height:1.55; }
.ms-card { border:1px solid var(--border-color,#d0d7de); border-radius:12px; padding:12px; margin:12px 0; background:var(--card-bg,rgba(255,255,255,.55)); }
.ms-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:8px; }
.ms-card-title { font-size:14px; font-weight:700; }
.ms-card-desc { font-size:12px; color:var(--text-dim,#6e7781); margin-top:2px; line-height:1.5; }
.ms-row { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:7px 0; border-top:1px solid var(--border-color,#eaeef2); flex-wrap:wrap; }
.ms-row:first-child { border-top:none; }
.ms-row-main { min-width:200px; flex:1 1 260px; }
.ms-row-name { font-size:13px; font-weight:600; }
.ms-row-help { font-size:12px; color:var(--text-dim,#6e7781); margin-top:2px; line-height:1.5; }
.ms-row-control { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; flex:1 1 auto; max-width:100%; }
.ms-custom-form { border-top:1px dashed var(--border-color,#d0d7de); margin-top:10px; padding-top:10px; }
.ms-custom-form .ms-toolbar { margin:7px 0 0; }
.ms-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:10px 0; }
.ms-status { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:8px 0 2px; }
.ms-channel { border:1px solid var(--border-color,#d0d7de); border-radius:12px; padding:11px; margin:10px 0; background:var(--card-bg,rgba(255,255,255,.55)); }
.ms-channel-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.ms-channel-name { font-size:13.5px; font-weight:700; }
.ms-dot { width:8px; height:8px; border-radius:50%; background:#c6cbd1; flex:none; }
.ms-dot.online { background:#1a7f37; box-shadow:0 0 0 3px rgba(26,127,55,.15); }
.ms-dot.error { background:#cf222e; }
.ms-dot.connecting { background:#bf8700; }
.ms-source { border:1px dashed var(--border-color,#d0d7de); border-radius:10px; padding:8px 10px; margin-top:8px; }
.ms-source-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ms-source-name { font-size:13px; font-weight:650; }
.ms-events { display:flex; gap:10px; flex-wrap:wrap; margin-top:6px; }
.ms-evt { display:inline-flex; gap:5px; align-items:center; font-size:12px; color:var(--text-dim,#6e7781); cursor:pointer; }
.ms-evt input { accent-color:var(--accent-color,#4f8f3f); }
.ms-components { border-top:1px dashed var(--border-color,#d0d7de); margin-top:8px; padding-top:8px; display:flex; flex-direction:column; gap:5px; max-height:240px; overflow:auto; }
.ms-component-item { display:flex; align-items:center; gap:7px; font-size:12.5px; padding:3px 5px; border-radius:7px; cursor:pointer; }
.ms-component-item:hover { background:rgba(110,119,129,.08); }
.ms-component-item input { accent-color:var(--accent-color,#4f8f3f); }
.ms-add { display:flex; gap:6px; align-items:center; margin-top:9px; flex-wrap:wrap; }
.ms-empty { color:var(--text-dim,#6e7781); font-size:13px; padding:8px 0; }
.ms-list-item { display:flex; gap:10px; align-items:flex-start; padding:9px 0; border-top:1px solid var(--border-color,#eaeef2); }
.ms-list-item:first-child { border-top:none; }
.ms-list-main { flex:1; min-width:0; }
.ms-list-title { font-size:13.5px; font-weight:650; word-break:break-word; }
.ms-list-summary { font-size:12.5px; color:var(--text-dim,#6e7781); margin-top:3px; white-space:pre-wrap; word-break:break-word; }
.ms-list-time { font-size:11.5px; color:var(--text-dim,#6e7781); white-space:nowrap; }
.ms-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:8px; }
.ms-source-item { border:1px solid var(--border-color,#d0d7de); border-radius:10px; padding:9px; display:flex; gap:8px; align-items:flex-start; }
.ms-source-emoji { font-size:19px; line-height:1.2; flex:none; }
.ms-source-info { min-width:0; flex:1; }
.ms-source-title { font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ms-source-desc { font-size:11.5px; color:var(--text-dim,#6e7781); margin-top:2px; line-height:1.45; }
.ms-chip { display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:3px 8px; font-size:12px; background:rgba(9,105,218,.1); color:#0969da; }
.ms-note { font-size:12px; color:var(--text-dim,#6e7781); line-height:1.55; }
.ms-mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11.5px; }
.ms-error { color:#cf222e; font-size:13px; padding:8px 0; }
.ms-loading { padding:16px; color:var(--text-dim,#6e7781); }
.ms-section-gap { margin-top:14px; }
@media (max-width:640px) {
  .ms-row { flex-direction:column; gap:6px; }
  .ms-row-control { justify-content:flex-start; }
  .ms-input, .ms-select { width:100% !important; }
  .ms-grid { grid-template-columns:1fr; }
}
`
