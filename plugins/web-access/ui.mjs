/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * web-access · 前端 UI 小工具（自包含，不依赖本体 src）。
 * 样式注入语义与内置插件的 useStyle 保持一致；settings-* 类名沿用全局设置页样式。
 */

const styleRegistry = new Map()

export function useStyle(ctx, css, { id = 'web-access' } = {}) {
  if (!css) return () => {}
  if (typeof document === 'undefined') return () => {}
  const pluginId = id || 'web-access'
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

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[match])
}

export function page(title, desc, html) {
  return `<div class="settings-title-row">
      <div><div class="settings-title">${escapeHtml(title)}</div><div class="settings-desc">${escapeHtml(desc || '')}</div></div>
    </div>${html}`
}

export function section(title, content, { className = '' } = {}) {
  return `<div class="settings-section ${className}">${title ? `<div class="settings-section-title">${escapeHtml(title)}</div>` : ''}${content}</div>`
}

export function card(rows) {
  return `<div class="settings-card">${rows}</div>`
}

export function row(name, help, control) {
  return `<div class="setting-row">
      <div class="setting-main"><div class="setting-name">${escapeHtml(name)}</div>${help ? `<div class="setting-help">${help}</div>` : ''}</div>
      <div class="setting-control">${control}</div>
    </div>`
}

export const GLOBE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.3 2.5 3.5 5.5 3.5 9s-1.2 6.5-3.5 9c-2.3-2.5-3.5-5.5-3.5-9S9.7 5.5 12 3z"/></svg>'
