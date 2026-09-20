/*
 * social-bridge · 邮箱后端桥（精简版）
 *
 * 只保留 IMAP / SMTP 邮箱能力，不再加载 B站 / 抖音 / 访客等相关代码。
 * 数据仍复用 <dataDir>/social-bridge.json 里的 mail 配置，升级后旧邮箱配置不会丢。
 */
import { createStore } from './lib/store.mjs'
import { imapList, imapRead, smtpSend, imapTest, smtpTest } from './lib/mail.mjs'

export const name = 'social-bridge-bridge'
export const version = '2.0.1'
export const build = '2026-09-19-email-encoding'
export const displayName = '邮箱后端桥'
export const description = 'IMAP / SMTP 邮箱工具后端（GBK / GB2312 / Big5 等编码自动识别）'
export const core = false
export const inject = ['settings', 'httpApi']
export const provides = [{ name: 'email-bridge', type: 'singleton' }]

function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra }
}

export function apply(ctx) {
  const settings = ctx.settings
  const httpApi = ctx.httpApi
  const dataDir = () => String(settings?.dataDir || process.cwd())
  const store = createStore(dataDir(), ctx.logger)
  let ready = false
  let readyError = ''

  const readyPromise = (async () => {
    await store.load()
    if (store.pruneSocialState()) ctx.logger.info('[email] 已清理旧版社媒 / 访客状态，仅保留邮箱配置')
    ready = true
    ctx.logger.info(`[email] 邮箱后端 v${version}(${build}) 就绪：${store.mailConfig().user || '未配置账号'}`)
  })().catch(error => {
    readyError = error?.message || String(error)
    ctx.logger.warn(`[email] 初始化失败：${readyError}`)
  })

  const afterReady = async () => {
    await readyPromise
    if (!ready) throw new Error(readyError || '邮箱后端未就绪')
  }

  const mailStatus = () => {
    const mail = store.mailConfig()
    return {
      configured: !!mail.user && !!mail.authCode,
      hasAuthCode: !!mail.authCode,
      user: mail.user || '',
      fromName: mail.fromName || '',
      imapHost: mail.imapHost || 'imap.qq.com',
      imapPort: Number(mail.imapPort) || 993,
      smtpHost: mail.smtpHost || 'smtp.qq.com',
      smtpPort: Number(mail.smtpPort) || 465,
      secure: mail.secure !== false,
    }
  }

  async function mailAction(body = {}) {
    const action = String(body.action || 'status').toLowerCase()
    const config = { ...store.mailConfig(), ...(body.config || {}) }
    if (action === 'status') return { ok: true, mail: mailStatus(), build }
    if (action === 'save') {
      store.patchMailConfig(body.config || {})
      return { ok: true, saved: true, mail: mailStatus() }
    }
    if (!config.user || !config.authCode) return fail('MAIL_NOT_CONFIGURED', '请先填写邮箱账号和 IMAP/SMTP 授权码。')
    if (action === 'list') {
      return imapList(config, {
        folder: body.folder || 'INBOX',
        limit: body.limit || store.config().mailPageSize,
        unreadOnly: body.unreadOnly === true,
      })
    }
    if (action === 'read') return imapRead(config, body.uid, { folder: body.folder || 'INBOX' })
    if (action === 'send' || action === 'reply') {
      return smtpSend(config, {
        to: body.to,
        cc: body.cc,
        subject: body.subject || '(无主题)',
        text: body.text || body.content || '',
        inReplyTo: body.inReplyTo || '',
        references: body.references || '',
      })
    }
    if (action === 'test') {
      const [imap, smtp] = await Promise.allSettled([imapTest(config), smtpTest(config)])
      return {
        ok: imap.status === 'fulfilled' && smtp.status === 'fulfilled',
        imap: imap.status === 'fulfilled' ? imap.value : { ok: false, error: imap.reason?.message || String(imap.reason) },
        smtp: smtp.status === 'fulfilled' ? smtp.value : { ok: false, error: smtp.reason?.message || String(smtp.reason) },
      }
    }
    return fail('INVALID_ARGS', `未知邮箱动作：${action}`)
  }

  const route = (method, path, handler) => httpApi.route(method, path, async (req, res, params, url) => {
    try {
      await afterReady()
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? (await httpApi.readBody(req, 4 * 1024 * 1024)) || {} : {}
      const result = await handler({ body, params, url, req, res })
      if (res.headersSent) return
      httpApi.sendJson(res, 200, result ?? { ok: true })
    } catch (error) {
      ctx.logger.warn(`[email] ${req.method} ${url?.pathname || path} 失败：${error?.message || error}`)
      if (!res.headersSent) httpApi.sendJson(res, 200, fail(error.code || 'EMAIL_ERROR', error?.message || String(error)))
      else res.end()
    }
  })

  const disposers = [
    route('GET', '/api/email/status', async () => ({ ok: true, ready, error: readyError, build, mail: mailStatus() })),
    route('POST', '/api/email/action', async ({ body }) => mailAction(body)),
    // 兼容旧版前端缓存：邮箱工具原来的接口照常保留。
    route('GET', '/api/social/status', async () => ({ ok: true, ready, error: readyError, build, mail: mailStatus() })),
    route('POST', '/api/social/email/action', async ({ body }) => mailAction(body)),
  ]

  ctx.effect(() => async () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose?.() } catch (_) { /* ignore */ }
    }
  })

  ctx.logger.info(`[email] 邮箱后端桥 v${version}(${build}) 已挂载`)
}