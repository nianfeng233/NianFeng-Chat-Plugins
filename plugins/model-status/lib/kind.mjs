/*
 * 念风chat · 扩展插件 · model-status
 * 项目全称：念风 Chat（NianFeng-Chat）
 *
 * 模型状态订阅 · 事件类型中文标签（纯常量，前端 / 后端都可安全加载）。
 * 单独拆出来是为了让面板不必导入 detect.mjs；detect.mjs 现在使用
 * 顶层 await 动态加载后端依赖，不适合进入浏览器模块图。
 */

export const EVENT_KIND_LABELS = {
  incident: '服务异常',
  recovery: '服务恢复',
  maintenance: '计划维护',
  component: '组件状态变化',
  feed: '状态动态',
  test: '测试消息',
}

export function eventKindLabel(kind) {
  return EVENT_KIND_LABELS[String(kind || '')] || '状态更新'
}
