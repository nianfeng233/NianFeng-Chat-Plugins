/*
 * bilibili · 协议优先 / 浏览器兜底的请求通道
 *
 * 常态走 Node 协议请求；命中风控码、Cookie 失效或网络异常时，
 * 自动降级到「每渠道独立 Edge 的页面上下文」里执行同一个请求
 * （页面 origin 与官方页面一致，带上浏览器自己的 Cookie 与指纹）。
 * 评论属于公开发言、风控影响最大，即使配置为 auto 也优先走浏览器；
 * 浏览器不可用时保持协议错误，不吞异常。
 */
export function isNetworkError(err) {
  if (!err) return false
  if (err.name === 'AbortError') return /超时|timeout|aborted/i.test(String(err.message || '')) || !err.message
  if (err instanceof TypeError) return true
  return /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|disconnected|WebSocket/i.test(String(err.message || ''))
}

const FORBIDDEN_PAGE_HEADERS = new Set(['cookie', 'user-agent', 'origin', 'referer', 'host', 'content-length'])

function originPageFor(host) {
  if (String(host || '').includes('passport.bilibili.com')) return 'https://passport.bilibili.com/login'
  if (String(host || '').includes('message.bilibili.com') || String(host || '').includes('api.vc.bilibili.com')) {
    return 'https://message.bilibili.com/'
  }
  return 'https://www.bilibili.com/'
}

export function createTransport({
  client,
  ensureBrowser,
  settingsRef = () => ({}),
  logger = null,
  onRisk = null,
  onBrowserUnavailable = null,
} = {}) {
  const risk = { until: 0, code: 0, message: '', at: 0 }
  let browserReady = false

  const noteRisk = err => {
    risk.until = Date.now() + 15 * 60 * 1000
    risk.code = Number(err?.biliCode) || 0
    risk.message = String(err?.message || err || '').slice(0, 300)
    risk.at = Date.now()
    logger?.warn?.(`[bilibili] 命中风控（${risk.code || 'HTTP'}），暂停协议请求并尝试浏览器兜底：${risk.message}`)
    try {
      onRisk?.({ ...risk })
    } catch (_) {
      /* 通知失败不影响主流程 */
    }
  }

  const syncCookiesFromBrowser = async controller => {
    if (!controller?.running) return 0
    let list = []
    try {
      list = await controller.allCookies()
    } catch (_) {
      return 0
    }
    const mapped = (Array.isArray(list) ? list : [])
      .filter(cookie => String(cookie?.domain || '').includes('bilibili'))
      .map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: String(cookie.domain || 'bilibili.com').replace(/^\./, ''),
        path: cookie.path || '/',
        expires: Number(cookie.expires) > 0 ? Number(cookie.expires) * 1000 : 0,
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly === true,
      }))
    return client.jar.upsert(mapped) ? mapped.length : 0
  }

  const injectCookies = async controller => {
    const cookies = client.jar.toJSON().map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: (() => {
        const domain = String(cookie.domain || 'bilibili.com').replace(/^\./, '')
        return domain === 'bilibili.com' ? '.bilibili.com' : domain
      })(),
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: cookie.httpOnly === true,
      ...(cookie.expires ? { expires: Math.floor(cookie.expires / 1000) } : {}),
    }))
    if (!cookies.length) return 0
    return controller.setCookies(cookies).catch(() => 0)
  }

  let browserChain = Promise.resolve()
  const withBrowser = task => {
    const next = browserChain.then(task, task)
    browserChain = next.catch(() => {})
    return next
  }

  const pageFetch = controller => (url, init = {}) =>
    withBrowser(async () => {
      const target = new URL(String(url))
      const pageUrl = originPageFor(target.hostname)
      // 每次兜底都开一个临时标签执行，避免把常驻的实时私信标签页导航走；
      // 串行化也保证并发轮询不会互相抢当前 target。
      const targetId = await controller.newPage('about:blank')
      try {
        await controller.navigate(pageUrl, { timeoutMs: 30000, waitMs: 800 })
        const headers = {}
        for (const [key, value] of Object.entries(init.headers || {})) {
          if (FORBIDDEN_PAGE_HEADERS.has(String(key).toLowerCase())) continue
          headers[key] = String(value)
        }
        const payload = {
          url: target.href,
          method: String(init.method || 'GET').toUpperCase(),
          body: typeof init.body === 'string' ? init.body : undefined,
          headers,
        }
        const script = `(async () => {
          const res = await fetch(${JSON.stringify(payload.url)}, {
            method: ${JSON.stringify(payload.method)},
            credentials: 'include',
            headers: ${JSON.stringify(payload.headers)},
            ...(${JSON.stringify(payload.body)} !== undefined ? { body: ${JSON.stringify(payload.body)} } : {}),
          });
          const text = await res.text();
          return { status: res.status, url: res.url, text };
        })()`
        const result = await controller.evaluate(script, { timeoutMs: 40000 })
        logger?.debug?.(`[bilibili] 浏览器兜底 ${payload.method} ${target.pathname} → HTTP ${result?.status}`)
        return {
          status: Number(result?.status) || 0,
          url: String(result?.url || target.href),
          headers: { get: () => null, getSetCookie: () => [] },
          text: async () => String(result?.text ?? ''),
        }
      } finally {
        await controller.closeTab(targetId).catch(() => {})
      }
    })

  // 写操作：走浏览器页面上下文时更接近真人操作（TLS / 指纹 / 页面同源请求），
  // 对 B站的风控更友好，可显著降低评论被仅自己可见 / 折叠的概率。
  // 评论属于公开发言，风险最高：即使配置是 auto（协议优先），commentAdd 也优先走浏览器；
  // 私信 / 点赞 / 投币 / 收藏仍遵循 sendVia 配置（browser=全部浏览器优先，auto=协议优先）。
  const WRITE_METHODS = new Set(['dmSend', 'commentAdd', 'videoLike', 'videoCoin', 'videoFavorite'])

  const callViaBrowser = async (method, args, { settings = {}, fallbackError = null } = {}) => {
    let controller = null
    try {
      controller = await ensureBrowser({ headless: settings.browserHeadless !== false })
    } catch (browserErr) {
      onBrowserUnavailable?.(browserErr)
      throw fallbackError || browserErr
    }
    if (!controller) throw fallbackError || new Error('浏览器不可用')
    await injectCookies(controller)
    const previous = client.fetchImpl
    client.fetchImpl = pageFetch(controller)
    try {
      const result = await client[method](...args)
      await syncCookiesFromBrowser(controller)
      return result
    } finally {
      client.fetchImpl = previous
    }
  }

  const call = async (method, args = []) => {
    if (typeof client[method] !== 'function') throw new Error(`未知的 B站接口方法：${method}`)
    const settings = settingsRef() || {}
    const browserAllowed = settings.browserFallback !== false
    const preferBrowser =
      browserAllowed &&
      WRITE_METHODS.has(method) &&
      (settings.sendVia === 'browser' || method === 'commentAdd')
    if (preferBrowser) {
      try {
        return await callViaBrowser(method, args, { settings })
      } catch (err) {
        logger?.debug?.(`[bilibili] 浏览器优先发送失败，改用协议请求：${err?.message || err}`)
        if (err?.risk) noteRisk(err)
      }
    }
    const cooling = risk.until > Date.now()
    try {
      return await client[method](...args)
    } catch (err) {
      const retryable = err?.risk || err?.needLogin || isNetworkError(err)
      if (err?.risk) noteRisk(err)
      if (!retryable || !browserAllowed) throw err
      // Cookie 过期时先看看托管浏览器里有没有新登录态，能同步就直接重试协议。
      if (err?.needLogin) {
        try {
          const controller = await ensureBrowser({ headless: settings.browserHeadless !== false })
          if (controller) {
            const changed = await syncCookiesFromBrowser(controller)
            if (changed) {
              try {
                return await client[method](...args)
              } catch (_) {
                /* 继续走页面兜底 */
              }
            }
          }
        } catch (_) {
          /* ignore */
        }
      }
      if (cooling && Date.now() < risk.until) {
        logger?.debug?.(`[bilibili] 风控冷却中，等待 ${Math.ceil((risk.until - Date.now()) / 1000)}s 后走浏览器兜底`)
        await new Promise(resolve => setTimeout(resolve, Math.min(risk.until - Date.now(), 60000)))
      }
      return callViaBrowser(method, args, { settings, fallbackError: err })
    }
  }

  return {
    call,
    /** 浏览器操作互斥入口：实时标签页与兜底临时标签页共用，避免互相抢当前 target。 */
    withBrowser,
    risk: () => ({ ...risk }),
    clearRisk: () => {
      risk.until = 0
      risk.code = 0
      risk.message = ''
    },
    browserReady: () => browserReady,
    markBrowserReady: value => {
      browserReady = !!value
    },
    syncCookiesFromBrowser,
  }
}
