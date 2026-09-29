/*
 * bilibili · 视频互动模块（点赞 / 投币 / 收藏 / 一键三连）
 *
 * 与私信、评论发送互相独立：自己的串行队列 + 频率 / 每日上限。
 * 这些都是高风控动作，默认给很保守的间隔和日上限，调用方（模型工具）也会拿到明确提示。
 */
import { libUrl } from './rev.mjs'

const { RateLimitedQueue } = await import(libUrl('queue.mjs'))

export class VideoModule {
  constructor({ transport, getSettings, logger = null } = {}) {
    this.transport = transport
    this.getSettings = getSettings || (() => ({}))
    this.logger = logger
    this.queue = new RateLimitedQueue({ name: 'video', logger })
  }

  applyLimits() {
    const limits = this.getSettings()?.limits || {}
    this.queue.configure({
      minIntervalMs: limits.videoMinIntervalMs,
      jitterMs: Math.max(2000, Number(limits.videoMinIntervalMs) || 5000),
      perHour: limits.videoPerHour,
      perDay: limits.videoPerDay,
    })
  }

  like(target, options = {}) {
    this.applyLimits()
    return this.queue.push(() => this.transport.call('videoLike', [target, options]))
  }

  coin(target, options = {}) {
    this.applyLimits()
    return this.queue.push(() => this.transport.call('videoCoin', [target, options]))
  }

  favorite(target, options = {}) {
    this.applyLimits()
    return this.queue.push(() => this.transport.call('videoFavorite', [target, options]))
  }

  /**
   * 一键三连：点赞 + 2 币 + 收藏同一个视频。
   * 每一步单独容错：像“重复点赞 / 已投过币 / 已在收藏夹”这类结果标记 already 并继续，
   * 不再让整组三连因为一次重复操作直接失败。
   */
  async triple(target) {
    this.applyLimits()
    const runStep = async task => {
      try {
        return { ok: true, data: await task() }
      } catch (err) {
        const message = String(err?.message || err)
        const code = Number(err?.biliCode) || 0
        const already =
          [65006, 34005, 34003, 11201, -104].includes(code) || /重复|已经在|已投过|已收藏|超过.*上限/.test(message)
        return { ok: false, code, already, error: message }
      }
    }
    return {
      target,
      like: await runStep(() => this.queue.push(() => this.transport.call('videoLike', [target, { like: true }]))),
      coin: await runStep(() => this.queue.push(() => this.transport.call('videoCoin', [target, { count: 2, alsoLike: false }]))),
      favorite: await runStep(() => this.queue.push(() => this.transport.call('videoFavorite', [target, {}]))),
      at: Date.now(),
    }
  }

  stats() {
    return this.queue.stats()
  }
}
