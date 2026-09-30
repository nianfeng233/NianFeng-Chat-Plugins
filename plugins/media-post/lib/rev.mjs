/*
 * media-post · 热更新缓存穿透
 *
 * 内核热重载只会给 bridge.mjs 附带 ?v=revision；如果 lib 文件之间继续静态
 * import，新版 bridge / lib 仍会命中原进程里的旧 ESM 模块缓存，出现
 * 「新 bridge + 旧 lib」的半加载状态（典型：视频下载编码逻辑修了但没生效）。
 *
 * 约定：bridge.mjs 在导入 lib 前把 revision 写到 globalThis.__MEDIA_POST_BRIDGE_REV；
 * lib 之间一律用 libUrl() 动态 import，保证一次热重载换掉整棵模块图。
 * 本文件必须保持零依赖、逻辑稳定，避免它自己被缓存后行为漂移。
 */
export const bridgeRevision = () => {
  try {
    return String(globalThis.__MEDIA_POST_BRIDGE_REV || '')
  } catch (_) {
    return ''
  }
}

export const libUrl = file => {
  const revision = bridgeRevision()
  return `./${String(file).replace(/^\.\//, '')}${revision ? `?v=${encodeURIComponent(revision)}` : ''}`
}
