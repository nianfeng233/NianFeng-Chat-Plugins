/*
 * bilibili · 外发串行队列（每个渠道、每类动作各一条）
 *
 * 负责：严格串行、随机间隔、每小时 / 每日上限、风控冷却暂停。
 * 私信、评论各自使用独立队列，互不阻塞。
 */
import { libUrl } from './rev.mjs'

const { sleep } = await import(libUrl('util.mjs'))

const hourKey = () => Math.floor(Date.now() / 3600000)
const dayKey = () => new Date().toISOString().slice(0, 10)

export class RateLimitedQueue {
  constructor({ name = 'queue', minIntervalMs = 2500, jitterMs = 1500, perHour = 0, perDay = 0, logger = null } = {}) {
    this.name = name
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0)
    this.jitterMs = Math.max(0, Number(jitterMs) || 0)
    this.perHour = Math.max(0, Number(perHour) || 0)
    this.perDay = Math.max(0, Number(perDay) || 0)
    this.logger = logger
    this.chain = Promise.resolve()
    this.pausedUntil = 0
    this.pauseReason = ''
    this.hour = { key: hourKey(), count: 0 }
    this.day = { key: dayKey(), count: 0 }
    this.lastAt = 0
  }

  configure({ minIntervalMs, jitterMs, perHour, perDay } = {}) {
    if (minIntervalMs !== undefined) this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0)
    if (jitterMs !== undefined) this.jitterMs = Math.max(0, Number(jitterMs) || 0)
    if (perHour !== undefined) this.perHour = Math.max(0, Number(perHour) || 0)
    if (perDay !== undefined) this.perDay = Math.max(0, Number(perDay) || 0)
  }

  pause(ms, reason = 'risk') {
    const until = Date.now() + Math.max(0, Number(ms) || 0)
    if (until > this.pausedUntil) {
      this.pausedUntil = until
      this.pauseReason = reason
    }
    return this.pausedUntil
  }

  resume() {
    this.pausedUntil = 0
    this.pauseReason = ''
  }

  rollCounters() {
    if (this.hour.key !== hourKey()) this.hour = { key: hourKey(), count: 0 }
    if (this.day.key !== dayKey()) this.day = { key: dayKey(), count: 0 }
  }

  checkLimit() {
    this.rollCounters()
    if (this.perHour && this.hour.count >= this.perHour) throw new Error(`每小时上限 ${this.perHour} 条，已暂停到下一个整点`)
    if (this.perDay && this.day.count >= this.perDay) throw new Error(`每日上限 ${this.perDay} 条，已暂停到明天`)
  }

  record() {
    this.rollCounters()
    this.hour.count += 1
    this.day.count += 1
    this.lastAt = Date.now()
  }

  stats() {
    this.rollCounters()
    return {
      pausedUntil: this.pausedUntil,
      pauseReason: this.pauseReason,
      hourCount: this.hour.count,
      dayCount: this.day.count,
      perHour: this.perHour,
      perDay: this.perDay,
      minIntervalMs: this.minIntervalMs,
    }
  }

  /** 串行执行；调用方不需要自己排队。 */
  push(task) {
    const run = async () => {
      const waitPause = this.pausedUntil - Date.now()
      if (waitPause > 0) {
        this.logger?.debug?.(`[bilibili] ${this.name} 风控冷却中，等待 ${Math.ceil(waitPause / 1000)}s`)
        await sleep(Math.min(waitPause, 60000))
      }
      this.checkLimit()
      const sinceLast = Date.now() - this.lastAt
      const gap = this.minIntervalMs + Math.floor(Math.random() * Math.max(0, this.jitterMs))
      if (this.lastAt && sinceLast < gap) await sleep(gap - sinceLast)
      const result = await task()
      this.record()
      return result
    }
    const next = this.chain.catch(() => {}).then(run)
    this.chain = next.catch(() => {})
    return next
  }
}
