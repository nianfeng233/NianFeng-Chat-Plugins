/*
 * bilibili · 后端桥（外部插件，独立目录，不进入本体）
 *
 * 职责：
 *   - 每渠道独立的协议客户端 / 轮询接收 / 独立发送队列 / 独立 Edge profile；
 *   - 登录（应用内二维码 / Edge 托管 / 手动 Cookie）、状态与 SSE 广播；
 *   - 私信、消息中心、评论的 HTTP 路由，供前端渠道插件与模型工具调用。
 *
 * 持久化：<数据目录>/bilibili.json（Cookie 值 AES-256-GCM 加密）
 * 浏览器：<数据目录>/bilibili/<channelId>/browser-profile（每渠道独立，--remote-debugging-pipe）
 */
const __revision = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || ''
  } catch (_) {
    return ''
  }
})()
// 让整棵 lib 依赖链（rev.mjs 读取）一起换 revision，避免热更新后新旧模块混用。
globalThis.__BILIBILI_BRIDGE_REV = __revision
const libUrl = file => `./lib/${String(file).replace(/^\.\//, '')}${__revision ? `?v=${encodeURIComponent(__revision)}` : ''}`

const { AccountRuntime } = await import(libUrl('runtime.mjs'))
const { createStateStore, defaultAccountState } = await import(libUrl('store.mjs'))
const { sleep } = await import(libUrl('util.mjs'))

export const name = 'bilibili-bridge'
export const version = '1.6.0'
export const displayName = '哔哩哔哩后端桥'
export const description = 'B站渠道后端：协议 + Edge 兜底登录、私信 / 消息中心 / 评论收发与黑白名单所需数据通道。'
export const core = false
export const inject = ['settings', 'hub', 'httpApi']
export const provides = [{ name: 'bilibili', type: 'singleton' }]

export function apply(ctx) {
  const settings = ctx.settings
  const hub = ctx.hub
  const httpApi = ctx.httpApi
  const dataDir = String(settings?.dataDir || process.cwd())
  const store = createStateStore({ dataDir, logger: ctx.logger })
  const runtimes = new Map()
  const disposers = []

  const broadcast = (event, data) => {
    try {
      hub.broadcast(event, data)
    } catch (_) {
      /* SSE 广播失败不影响业务 */
    }
  }

  const runtimeFor = channelId => {
    const id = String(channelId || '').trim()
    if (!id) throw Object.assign(new Error('缺少 channelId'), { status: 400 })
    let runtime = runtimes.get(id)
    if (!runtime) {
      runtime = new AccountRuntime({
        channelId: id,
        dataDir,
        store,
        logger: ctx.logger,
        broadcast,
      })
      runtimes.set(id, runtime)
    }
    return runtime
  }

  const readBody = async (req, limit = 1024 * 1024) => {
    try {
      return (await httpApi.readBody(req, limit)) || {}
    } catch (_) {
      return {}
    }
  }

  const requireText = (value, label) => {
    const text = String(value ?? '').trim()
    if (!text) throw Object.assign(new Error(`缺少 ${label}`), { status: 400 })
    return text
  }

  const route = (method, path, handler) => {
    disposers.push(
      httpApi.route(method, path, async (req, res, params, url) => {
        try {
          await handler({ req, res, params, url })
        } catch (err) {
          const status = Number(err?.status) || (err?.risk ? 429 : 400)
          const message = String(err?.message || err || '请求失败').slice(0, 500)
          ctx.logger?.warn?.(`[bilibili] ${method} ${path} 失败：${message}`)
          httpApi.sendError(res, status, message)
        }
      }),
    )
  }

  /* ---------------- 状态 / 配置 ---------------- */

  route('GET', '/api/bilibili/status', async ({ res, url }) => {
    const channelId = requireText(url.searchParams.get('channelId'), 'channelId')
    const runtime = runtimeFor(channelId)
    httpApi.sendJson(res, 200, { ok: true, ...runtime.statusPayload() })
  })

  route('POST', '/api/bilibili/channels/config', async ({ req, res }) => {
    const body = await readBody(req)
    const channelId = requireText(body.channelId, 'channelId')
    const runtime = runtimeFor(channelId)
    if (body.name) runtime.channelName = String(body.name).slice(0, 60)
    if (body.settings) runtime.applyConfig(body.settings)
    httpApi.sendJson(res, 200, { ok: true, ...runtime.statusPayload() })
  })

  route('DELETE', '/api/bilibili/channels/:channelId', async ({ res, params }) => {
    const channelId = requireText(params.channelId, 'channelId')
    const runtime = runtimes.get(channelId)
    if (runtime) {
      await runtime.stop()
      runtimes.delete(channelId)
    }
    store.removeAccount(channelId)
    httpApi.sendJson(res, 200, { ok: true, channelId })
  })

  route('GET', '/api/bilibili/inbox', async ({ res, url }) => {
    const channelId = requireText(url.searchParams.get('channelId'), 'channelId')
    const after = Number(url.searchParams.get('after')) || 0
    const runtime = runtimeFor(channelId)
    const items = runtime.inbox(after).slice(-200)
    httpApi.sendJson(res, 200, { ok: true, channelId, items, maxSeq: items.at(-1)?.seq || after })
  })

  route('POST', '/api/bilibili/inbox/ack', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const removed = runtime.ackInbox(body.seq)
    httpApi.sendJson(res, 200, { ok: true, removed })
  })

  /* ---------------- 登录 ---------------- */

  route('POST', '/api/bilibili/login/qrcode', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const qr = await runtime.startQrLogin()
    httpApi.sendJson(res, 200, { ok: true, ...qr })
  })

  route('GET', '/api/bilibili/login/qrcode', async ({ res, url }) => {
    const runtime = runtimeFor(requireText(url.searchParams.get('channelId'), 'channelId'))
    const result = await runtime.pollQrLogin(url.searchParams.get('key'))
    httpApi.sendJson(res, 200, { ok: true, ...result })
  })

  route('POST', '/api/bilibili/login/cookie', async ({ req, res }) => {
    const body = await readBody(req, 512 * 1024)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const profile = await runtime.loginWithCookie(body.cookie)
    httpApi.sendJson(res, 200, { ok: true, status: 'success', profile })
  })

  route('POST', '/api/bilibili/login/browser', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const browser = await runtime.startBrowserLogin({ headless: body.headless === true })
    httpApi.sendJson(res, 200, { ok: true, browser, message: '已打开登录窗口，请在浏览器里完成登录' })
  })

  route('GET', '/api/bilibili/login/browser', async ({ res, url }) => {
    const runtime = runtimeFor(requireText(url.searchParams.get('channelId'), 'channelId'))
    const result = await runtime.pollBrowserLogin()
    httpApi.sendJson(res, 200, { ok: true, ...result })
  })

  route('POST', '/api/bilibili/logout', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    await runtime.logout({ clearBrowser: body.clearBrowser !== false })
    httpApi.sendJson(res, 200, { ok: true, status: 'offline' })
  })

  route('POST', '/api/bilibili/browser/close', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    await runtime.closeBrowser()
    httpApi.sendJson(res, 200, { ok: true, status: 'closed' })
  })

  /* ---------------- 私信 ---------------- */

  route('POST', '/api/bilibili/dm/send', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const peerUid = requireText(body.peerUid, 'peerUid')
    const text = requireText(body.text, 'text')
    const data = await runtime.sendDm(peerUid, text)
    httpApi.sendJson(res, 200, { ok: true, data, peerUid })
  })

  route('GET', '/api/bilibili/dm/sessions', async ({ res, url }) => {
    const runtime = runtimeFor(requireText(url.searchParams.get('channelId'), 'channelId'))
    const sessions = await runtime.dm.listSessions()
    httpApi.sendJson(res, 200, { ok: true, sessions })
  })

  route('GET', '/api/bilibili/dm/messages', async ({ res, url }) => {
    const runtime = runtimeFor(requireText(url.searchParams.get('channelId'), 'channelId'))
    const peerUid = requireText(url.searchParams.get('peerUid'), 'peerUid')
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20))
    const messages = await runtime.dm.messages(peerUid, limit)
    httpApi.sendJson(res, 200, { ok: true, peerUid, messages })
  })

  /* ---------------- 消息中心 ---------------- */

  route('GET', '/api/bilibili/notice/list', async ({ res, url }) => {
    const runtime = runtimeFor(requireText(url.searchParams.get('channelId'), 'channelId'))
    const kind = String(url.searchParams.get('kind') || 'reply')
    const items = await runtime.notice.list(kind)
    httpApi.sendJson(res, 200, { ok: true, kind, items })
  })

  route('POST', '/api/bilibili/notice/refresh', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const result = await runtime.notice.pollOnce()
    httpApi.sendJson(res, 200, { ok: true, ...result })
  })

  /* ---------------- 评论 ---------------- */

  route('POST', '/api/bilibili/comment/post', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const targetValue = String(body.target || body.video || body.url || body.bvid || '').trim()
    const target = targetValue ? targetValue : { oid: requireText(body.oid, 'oid'), type: Number(body.type) || 1, bvid: body.bvid }
    const text = requireText(body.text || body.content || body.message, 'text')
    const data = await runtime.postComment(target, text)
    httpApi.sendJson(res, 200, { ok: true, data })
  })

  route('POST', '/api/bilibili/comment/reply', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const targetValue = String(body.target || body.video || body.url || body.bvid || '').trim()
    const target = targetValue ? targetValue : { oid: requireText(body.oid, 'oid'), type: Number(body.type) || 1, bvid: body.bvid }
    const rpid = requireText(body.rpid || body.comment_id || body.reply_id, 'rpid')
    const text = requireText(body.text || body.content || body.message, 'text')
    const data = await runtime.replyComment(target, rpid, text, { root: body.root, parent: body.parent })
    httpApi.sendJson(res, 200, { ok: true, data })
  })

  /* ---------------- 视频互动（点赞 / 投币 / 收藏） ---------------- */

  route('POST', '/api/bilibili/video/like', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const target = requireText(body.target || body.video || body.url || body.bvid, 'target')
    const data = await runtime.video.like(target, { like: body.like !== false })
    httpApi.sendJson(res, 200, { ok: true, action: 'like', data })
  })

  route('POST', '/api/bilibili/video/coin', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const target = requireText(body.target || body.video || body.url || body.bvid, 'target')
    const count = Number(body.count) >= 2 ? 2 : 1
    const data = await runtime.video.coin(target, { count, alsoLike: body.alsoLike === true })
    httpApi.sendJson(res, 200, { ok: true, action: 'coin', count, data })
  })

  route('POST', '/api/bilibili/video/favorite', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const target = requireText(body.target || body.video || body.url || body.bvid, 'target')
    const data = await runtime.video.favorite(target, { folderId: String(body.folderId || '') })
    httpApi.sendJson(res, 200, { ok: true, action: 'favorite', data })
  })

  route('POST', '/api/bilibili/video/triple', async ({ req, res }) => {
    const body = await readBody(req)
    const runtime = runtimeFor(requireText(body.channelId, 'channelId'))
    const target = requireText(body.target || body.video || body.url || body.bvid, 'target')
    const data = await runtime.video.triple(target)
    httpApi.sendJson(res, 200, { ok: true, action: 'triple', data })
  })

  route('GET', '/api/bilibili/comment/list', async ({ res, url }) => {
    const runtime = runtimeFor(requireText(url.searchParams.get('channelId'), 'channelId'))
    const targetParam = String(url.searchParams.get('target') || '').trim()
    const target = targetParam || { oid: requireText(url.searchParams.get('oid'), 'oid'), type: Number(url.searchParams.get('type')) || 1, bvid: url.searchParams.get('bvid') || '' }
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20))
    const items = await runtime.comment.list(target, limit)
    httpApi.sendJson(res, 200, { ok: true, items })
  })

  ctx.effect(() => () => {
    for (const runtime of runtimes.values()) runtime.stop().catch(() => {})
    runtimes.clear()
    store.flush().catch(() => {})
    store.dispose()
    while (disposers.length) {
      const dispose = disposers.pop()
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
  })

  const service = {
    name: 'bilibili',
    version,
    runtimeFor,
    status: channelId => runtimeFor(channelId).statusPayload(),
    sendDm: (channelId, peerUid, text) => runtimeFor(channelId).sendDm(peerUid, text),
    postComment: (channelId, target, text) => runtimeFor(channelId).postComment(target, text),
    replyComment: (channelId, target, rpid, text, extra) => runtimeFor(channelId).replyComment(target, rpid, text, extra),
    dataDir,
  }
  ctx.provide('bilibili', service)

  // 加载完成后自动接管上次已登录的渠道，保证不开 WebUI 也能收到消息（服务端代聊）。
  store.ready
    .then(async () => {
      await sleep(50)
      for (const [channelId, account] of Object.entries(store.state().accounts || {})) {
        if (!account.cookies?.some(cookie => cookie.name === 'SESSDATA' && cookie.value)) continue
        try {
          const runtime = runtimeFor(channelId)
          runtime.startPollers()
          // 即使 WebUI 不打开，服务端代聊也能享受实时私信；失败自动退回轮询。
          runtime.syncRealtime().catch(() => {})
          ctx.logger.info(`[bilibili] 渠道 ${channelId} 已恢复轮询（${account.profile?.nickname || account.profile?.uid || '未知账号'}）`)
        } catch (err) {
          ctx.logger.warn(`[bilibili] 渠道 ${channelId} 恢复失败：${err?.message || err}`)
        }
      }
    })
    .catch(err => ctx.logger.error(`[bilibili] 状态加载失败：${err?.message || err}`))

  ctx.logger.info(`B站后端桥就绪 · 数据目录 ${dataDir}`)
}
