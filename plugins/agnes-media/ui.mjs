/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * agnes-media · 前端 UI 小工具（自包含，不依赖本体 src）。
 */

const styleRegistry = new Map()

export function useStyle(ctx, css, { id = 'agnes-media' } = {}) {
  if (!css || typeof document === 'undefined') return () => {}
  const pluginId = id || 'agnes-media'
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

export const IMAGE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m5.5 17 4.2-4.2a1.5 1.5 0 0 1 2.1 0l1.3 1.3 2.1-2.1a1.5 1.5 0 0 1 2.1 0l1.2 1.2"/></svg>'

export const SPARKLE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.8 4.9L19 9.7l-5.2 1.8L12 17l-1.8-5.5L5 9.7l5.2-1.8L12 3z"/><path d="M19 15.5 20 18l2.5 1-2.5 1-1 2.5-1-2.5L15.5 19l2.5-1 1-2.5z"/></svg>'
