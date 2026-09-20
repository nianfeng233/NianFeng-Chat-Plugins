/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * web-access · 设置面板（插件设置按钮 / 设置页共用）。
 * Tavily Key、浏览器路径与无头模式、本机浏览器 Cookie 导入、Cookie 库管理。
 */
import { card, escapeHtml, row, section } from './ui.mjs'

export const PANEL_CSS = `
  .wa-panel{display:flex;flex-direction:column;gap:2px;min-width:0;max-width:100%;}
  .wa-panel,.wa-panel *{box-sizing:border-box;}
  .wa-status{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 12px;}
  .wa-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.45);font-size:12px;color:var(--text-2);max-width:100%;}
  .wa-chip .wa-dot{width:7px;height:7px;border-radius:50%;background:var(--text-4);flex:0 0 auto;}
  .wa-chip.good .wa-dot{background:#49a36f;}
  .wa-chip.bad .wa-dot{background:#c65b5b;}
  .wa-chip.warn .wa-dot{background:#d9a13b;}
  .wa-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--text-3);overflow-wrap:anywhere;word-break:break-all;min-width:0;max-width:100%;}
  .wa-note{margin:10px 2px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.35);border:1px solid var(--border);font-size:12px;line-height:1.7;color:var(--text-3);}
  .wa-note b{color:var(--text-2);}
  .wa-cookie-list{display:flex;flex-direction:column;gap:6px;padding:10px 14px;}
  .wa-cookie-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.35);flex-wrap:wrap;}
  .wa-cookie-main{flex:1 1 220px;min-width:0;}
  .wa-cookie-domain{font-size:12.5px;font-weight:600;color:var(--text-2);}
  .wa-cookie-meta{font-size:11px;color:var(--text-4);margin-top:3px;word-break:break-all;}
  .wa-inline{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0;max-width:100%;}
  .wa-textarea{width:100%;max-width:420px;min-height:74px;resize:vertical;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.55);color:var(--text);font-size:12px;}
  .wa-empty{padding:16px;text-align:center;color:var(--text-4);font-size:12px;}
  .wa-warn{color:#c65b5b;}

  /* 面板里的 setting-row 做响应式覆盖：控制区允许收缩 / 换行，长路径不会把标题挤成一字一行 */
  .wa-panel .setting-row{flex-wrap:wrap;align-items:flex-start;gap:10px 16px;}
  .wa-panel .setting-main{flex:1 1 220px;min-width:180px;}
  .wa-panel .setting-name{word-break:keep-all;}
  .wa-panel .setting-help{overflow-wrap:anywhere;}
  .wa-panel .setting-control{flex:1 1 320px;min-width:0;max-width:100%;flex-wrap:wrap;justify-content:flex-start;}
  .wa-panel .setting-control>*{max-width:100%;}
  .wa-panel .setting-control>.wa-inline{flex:1 1 100%;}
  .wa-panel .wa-inline .wa-inline{flex:0 0 auto;width:100%;}
  .wa-panel .wa-inline>input.setting-input,
  .wa-panel .wa-inline>select.setting-select{flex:1 1 180px;min-width:0;max-width:100%;}
  .wa-panel .wa-inline>button{flex:0 0 auto;}
  .wa-panel .wa-mono{flex:1 1 100%;}

  @media (max-width:760px){
    .wa-panel .setting-row{flex-direction:column;align-items:stretch;gap:9px;}
    .wa-panel .setting-main,
    .wa-panel .setting-control{flex:0 0 auto;width:100%;}
  }
`

export function renderWebAccessPanel(container, { api, toast, modal } = {}) {
  let disposed = false
  let loading = true
  let status = null
  let error = ''
  let busy = false
  let needsRestart = false

  const notify = (kind, message) => {
    try {
      toast?.[kind]?.(message)
    } catch (_) {
      /* ignore */
    }
  }

  const request = async (method, path, body, timeoutMs) => {
    if (!api) throw new Error('后端通道未就绪')
    if (method === 'get') return api.get(path, { timeoutMs: timeoutMs || 20000 })
    if (method === 'put') return api.put(path, body, { timeoutMs: timeoutMs || 20000 })
    return api.post(path, body, { timeoutMs: timeoutMs || 120000 })
  }

  const refresh = async ({ silent = false } = {}) => {
    if (!api) {
      loading = false
      error = '后端通道未就绪（backend-client 插件未启用）'
      render()
      return
    }
    if (!silent) {
      loading = true
      error = ''
      render()
    }
    try {
      const data = await api.get('/web-access/status')
      if (disposed) return
      status = data
      error = ''
      needsRestart = false
    } catch (err) {
      if (disposed) return
      needsRestart = err?.status === 404
      error =
        err?.status === 404
          ? '联网访问后端桥尚未加载：先在插件页点「重新扫描」热加载；如果当前内核版本较旧或不支持热加载，再重启念风后端。'
          : err.message || String(err)
    } finally {
      loading = false
      if (!disposed) render()
    }
  }

  const withBusy = async (fn, options = {}) => {
    if (busy) return null
    busy = true
    render()
    try {
      const result = await fn()
      if (result?.ok === false) {
        notify('error', `${options.errorPrefix || '操作失败'}：${result.error || result.code || ''}`)
      } else if (options.successMessage) {
        notify('success', options.successMessage)
      }
      return result
    } catch (err) {
      notify('error', `${options.errorPrefix || '操作失败'}：${err.message || err}`)
      return null
    } finally {
      busy = false
      if (!disposed) await refresh({ silent: true })
    }
  }

  const val = field => String(container.querySelector(`[data-field="${field}"]`)?.value ?? '')

  const saveConfig = patch =>
    withBusy(() => request('put', '/web-access/config', patch), { successMessage: '设置已保存', errorPrefix: '保存失败' })

  const render = () => {
    if (disposed) return
    if (loading && !status) {
      container.innerHTML = '<div class="wa-panel"><div class="wa-empty">正在读取联网访问状态…</div></div>'
      return
    }
    if (!status) {
      container.innerHTML = `<div class="wa-panel"><div class="wa-note wa-warn">${escapeHtml(error || '无法读取状态')}</div>
        <div class="wa-inline" style="padding:0 2px">
          <button class="outline-btn" data-action="refresh">重试</button>
          ${needsRestart ? '<button class="outline-btn primary-soft" data-action="rescan-plugins">重新扫描插件</button><button class="outline-btn" data-action="restart-backend">重启念风后端</button>' : ''}
        </div></div>`
      bind()
      return
    }

    const tavily = status.tavily || {}
    const browser = status.browser || {}
    const config = status.config || {}
    const cookies = status.cookies || { total: 0, domains: [] }
    const localBrowsers = Array.isArray(status.localBrowsers) ? status.localBrowsers : []
    const selectableBrowsers = localBrowsers.filter(item => item.available)
    const browserChip = browser.available
      ? `<span class="wa-chip good"><span class="wa-dot"></span>${escapeHtml(browser.label || '浏览器')} ${escapeHtml(browser.version || '')}</span>`
      : '<span class="wa-chip bad"><span class="wa-dot"></span>未检测到 Edge / Chrome</span>'
    const runningChip = browser.running
      ? `<span class="wa-chip good"><span class="wa-dot"></span>运行中（${browser.headless ? '无头' : '可见窗口'}）</span>`
      : '<span class="wa-chip"><span class="wa-dot"></span>未运行</span>'
    const tavilyChip = tavily.configured
      ? `<span class="wa-chip good"><span class="wa-dot"></span>Tavily 已配置 ${escapeHtml(tavily.mask || '')}</span>`
      : '<span class="wa-chip warn"><span class="wa-dot"></span>Tavily 未配置</span>'

    const browserOptions = selectableBrowsers.length
      ? selectableBrowsers.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}（${item.profiles} 个配置）</option>`).join('')
      : '<option value="">未检测到浏览器配置</option>'

    const domainRows = cookies.domains?.length
      ? cookies.domains
          .map(
            item => `<div class="wa-cookie-item">
              <div class="wa-cookie-main">
                <div class="wa-cookie-domain">${escapeHtml(item.domain)} · ${item.count} 条</div>
                <div class="wa-cookie-meta">${escapeHtml((item.names || []).join(', '))}${item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleString()}` : ''}</div>
              </div>
              <button class="outline-btn" data-action="cookie-delete" data-domain="${escapeHtml(item.domain)}">删除</button>
            </div>`,
          )
          .join('')
      : '<div class="wa-empty">Cookie 库还是空的。导入本机浏览器 Cookie，或让模型在登录后自动保存。</div>'

    container.innerHTML = `<div class="wa-panel">
      <div class="wa-status">
        ${tavilyChip}${browserChip}${runningChip}
        <span class="wa-chip"><span class="wa-dot"></span>Cookie ${cookies.total || 0} 条 / ${cookies.domains?.length || 0} 个域名</span>
      </div>
      ${error ? `<div class="wa-note wa-warn">${escapeHtml(error)}${needsRestart ? '<div class="wa-inline" style="margin-top:8px"><button class="outline-btn primary-soft" data-action="rescan-plugins">重新扫描插件</button><button class="outline-btn" data-action="restart-backend">重启念风后端</button></div>' : ''}</div>` : ''}

      ${section(
        'Tavily 联网搜索',
        card(
          row(
            'API Key',
            '在 tavily.com 免费申请。Key 只会保存在本机后端（AES-256-GCM 加密），不会进入模型上下文；如本机需要代理，请先在 设置 → 网络 配置全局代理。',
            `<div class="wa-inline">
              <input class="setting-input" type="password" data-field="tavily-key" autocomplete="new-password"
                placeholder="${tavily.configured ? `已配置：${escapeHtml(tavily.mask || '')}（留空不修改）` : 'tvly-...'}" style="width:min(260px,100%)" />
              <button class="outline-btn primary-soft" data-action="tavily-save" ${busy ? 'disabled' : ''}>保存</button>
              <button class="outline-btn" data-action="tavily-clear" ${tavily.configured ? '' : 'disabled'}>清除</button>
              <button class="outline-btn" data-action="tavily-test" ${tavily.configured ? '' : 'disabled'}>测试</button>
            </div>`,
          ) +
            row(
              '默认结果数',
              'web_search 不传 max_results 时使用',
              `<select class="setting-select" data-field="max-results">
                ${[5, 8, 10, 15, 20].map(value => `<option value="${value}" ${Number(tavily.maxResults) === value ? 'selected' : ''}>${value} 条</option>`).join('')}
              </select>`,
            ) +
            row(
              '搜索深度',
              'advanced 更慢但内容更完整',
              `<select class="setting-select" data-field="search-depth">
                <option value="basic" ${tavily.searchDepth !== 'advanced' ? 'selected' : ''}>basic（快速）</option>
                <option value="advanced" ${tavily.searchDepth === 'advanced' ? 'selected' : ''}>advanced（深入）</option>
              </select>`,
            ) +
            row('保存搜索偏好', '结果数与搜索深度', `<button class="outline-btn" data-action="tavily-prefs" ${busy ? 'disabled' : ''}>保存偏好</button>`),
        ),
      )}

      ${section(
        '浏览器自动化',
        card(
          row(
            '浏览器',
            '优先使用本机 Edge，其次 Chrome / Brave；首次使用会创建独立的持久化配置目录，不影响日常浏览器。',
            `${browserChip}${browser.executable ? `<div class="wa-mono">${escapeHtml(browser.executable)}</div>` : ''}`,
          ) +
            row(
              '运行模式',
              '无头 = 后台静默运行；关闭后每次操作都会弹出浏览器窗口，适合登录 / 观察步骤。',
              `<label class="wa-inline"><input type="checkbox" data-field="browser-headless" ${config.browserHeadless ? 'checked' : ''} /> 无头模式</label>`,
            ) +
            row(
              '自定义路径',
              '留空自动探测；也可以填写 msedge.exe / chrome.exe 的完整路径。',
              `<div class="wa-inline">
                <input class="setting-input" data-field="browser-path" value="${escapeHtml(config.browserPath || '')}" placeholder="自动探测" style="width:min(300px,100%)" />
                <button class="outline-btn" data-action="browser-path-save">保存</button>
              </div>`,
            ) +
            row(
              '打开 / 登录',
              '打开页面会复用同一个浏览器配置（Cookie / 登录态自动保留）；交互式登录会在可见窗口里等用户自己扫码或输入。',
              `<div class="wa-inline">
                <input class="setting-input" data-field="browser-url" placeholder="https://..." style="width:min(260px,100%)" />
                <button class="outline-btn primary-soft" data-action="browser-open" ${browser.available ? '' : 'disabled'}>打开页面</button>
                <button class="outline-btn" data-action="browser-login" ${browser.available ? '' : 'disabled'}>交互式登录</button>
                <button class="outline-btn" data-action="browser-sync" ${browser.running ? '' : 'disabled'}>同步 Cookie</button>
                <button class="outline-btn" data-action="browser-close" ${browser.running ? '' : 'disabled'}>关闭浏览器</button>
              </div>
              <div class="wa-inline" style="margin-top:8px">
                <span class="wa-note">快捷登录：</span>
                <button class="outline-btn primary-soft" data-action="quick-login" data-url="https://www.douyin.com/" ${browser.available ? '' : 'disabled'}>登录抖音</button>
                <button class="outline-btn primary-soft" data-action="quick-login" data-url="https://www.bilibili.com/" ${browser.available ? '' : 'disabled'}>登录 B站</button>
                <button class="outline-btn" data-action="cookies-export">导出 cookies.txt</button>
              </div>
              <div class="wa-note" style="margin-top:6px">
                快捷登录会打开独立浏览器窗口：手机扫码 / 验证码完成后回到这里点「同步 Cookie」即可长期复用；cookies.txt 导出给 yt-dlp 等下载器使用（默认导出 B站 + 抖音）。
              </div>`,
            ) +
            row(
              '允许本机 / 内网地址',
              '默认关闭（防止模型借本机后端探测内网服务）。只有明确需要访问 127.0.0.1 / 192.168.x.x 时才开启。',
              `<label class="wa-inline"><input type="checkbox" data-field="allow-private" ${config.allowPrivateNetwork ? 'checked' : ''} /> 允许访问内网</label>`,
            ),
        ),
      )}

      ${section(
        'Cookie 库（登录态自动保存与复用）',
        `${card(
          row(
            '从本机浏览器导入',
            '读取 Edge / Chrome / Firefox 已保存的 Cookie（Chromium 127+ 的 App-Bound 加密条目会被跳过并在结果里说明）。浏览器运行时会锁定数据库，请先完全退出。',
            `<div class="wa-inline">
              <select class="setting-select" data-field="import-browser">${browserOptions}</select>
              <input class="setting-input" data-field="import-domain" placeholder="域名（可留空=全部）" style="width:170px" />
              <button class="outline-btn" data-action="cookie-import" ${selectableBrowsers.length ? '' : 'disabled'}>导入</button>
            </div>`,
          ) +
          row(
            '粘贴 Cookie',
            '支持 Cookie 头、document.cookie、JSON、cookies.txt、cURL 命令。保存后访问该站点会自动携带，无需重复输入。',
            `<div class="wa-inline" style="align-items:flex-start">
              <div class="wa-inline" style="flex-direction:column;align-items:stretch">
                <input class="setting-input" data-field="paste-url" placeholder="网站 URL，例如 https://www.bilibili.com" style="width:min(300px,100%)" />
                <textarea class="wa-textarea" data-field="paste-cookie" placeholder="SESSDATA=...; bili_jct=..."></textarea>
                <button class="outline-btn primary-soft" data-action="cookie-save" style="align-self:flex-start">保存 Cookie</button>
              </div>
            </div>`,
          ),
        )}<div class="wa-cookie-list">
          ${domainRows}
          ${
            cookies.total
              ? '<div class="wa-inline" style="justify-content:flex-end"><button class="outline-btn" data-action="cookie-clear-all">清空 Cookie 库</button></div>'
              : ''
          }
        </div>`,
      )}

      <div class="wa-note">
        <b>给模型的两个工具：</b><br />
        · <b>web_search</b>：Tavily 联网搜索，返回标题 / 链接 / 摘要；需要最新信息时用。<br />
        · <b>browser</b>：打开网页、读取标题与正文、B站 / 抖音视频的点赞与评论、站内搜索、页内关键词检索、点击 / 输入 / 滚动 / 截图 / 下载 / 登录。<br />
        Cookie 在每次浏览器访问后会自动回收保存；遇到登录页时，模型可以让用户在弹出的浏览器窗口里登录，或接收用户提供的 Cookie 后自动填入并复用。
      </div>
      <div class="wa-inline" style="justify-content:flex-end;padding:4px 2px 12px">
        <button class="outline-btn" data-action="refresh">刷新状态</button>
      </div>
    </div>`

    bind()
  }

  const bind = () => {
    container.querySelector('[data-action="refresh"]')?.addEventListener('click', () => refresh())
    container.querySelector('[data-action="rescan-plugins"]')?.addEventListener('click', async () => {
      try {
        await api.rescanPlugins()
        notify('info', '已重新扫描插件与外置后端桥，正在刷新状态…')
        await refresh()
      } catch (err) {
        notify('error', `重新扫描失败：${err.message || err}；可尝试重启念风后端。`)
      }
    })
    container.querySelector('[data-action="restart-backend"]')?.addEventListener('click', async () => {
      try {
        if (typeof window !== 'undefined' && window.windHost?.restart) {
          window.windHost.restart()
          return
        }
        await api.restartSystem()
        notify('info', '正在重启念风后端，请稍候刷新页面（约 3~5 秒）。')
      } catch (err) {
        notify('error', `自动重启不可用：${err.message || err}。请手动 stop 后重新 start。`)
      }
    })
    container.querySelector('[data-action="tavily-save"]')?.addEventListener('click', async () => {
      const key = val('tavily-key').trim()
      if (!key) return notify('warn', '请先填写 Tavily API Key')
      await saveConfig({ tavilyApiKey: key })
    })
    container.querySelector('[data-action="tavily-clear"]')?.addEventListener('click', async () => {
      await saveConfig({ clearTavily: true })
    })
    container.querySelector('[data-action="tavily-prefs"]')?.addEventListener('click', async () => {
      await saveConfig({
        maxResults: Number(container.querySelector('[data-field="max-results"]')?.value) || 8,
        searchDepth: container.querySelector('[data-field="search-depth"]')?.value || 'basic',
      })
    })
    container.querySelector('[data-action="tavily-test"]')?.addEventListener('click', async () => {
      await withBusy(async () => {
        const result = await request('post', '/web-access/search', { query: '念风 Chat AI 聊天客户端', max_results: 1 }, 60000)
        if (result?.ok === false) return result
        const first = result?.results?.[0]
        notify('success', first ? `连通正常：${first.title}` : '连通正常（没有返回结果）')
        return result
      }, { errorPrefix: '联通测试失败' })
    })

    container.querySelector('[data-field="browser-headless"]')?.addEventListener('change', event => {
      saveConfig({ browserHeadless: event.target.checked === true })
    })
    container.querySelector('[data-field="allow-private"]')?.addEventListener('change', event => {
      saveConfig({ allowPrivateNetwork: event.target.checked === true })
    })
    container.querySelector('[data-action="browser-path-save"]')?.addEventListener('click', () => {
      saveConfig({ browserPath: val('browser-path').trim() })
    })
    container.querySelector('[data-action="browser-open"]')?.addEventListener('click', async () => {
      const url = val('browser-url').trim()
      if (!url) return notify('warn', '请先填写要打开的网址')
      await withBusy(() => request('post', '/web-access/browse', { action: 'open', url }, 150000), { successMessage: '已打开页面', errorPrefix: '打开失败' })
    })
    container.querySelector('[data-action="browser-login"]')?.addEventListener('click', async () => {
      const url = val('browser-url').trim()
      if (!url) return notify('warn', '请先填写登录页网址')
      await withBusy(() => request('post', '/web-access/browse', { action: 'login', url, interactive: true }, 150000), {
        successMessage: '登录窗口已打开，请在窗口里完成登录',
        errorPrefix: '打开登录窗口失败',
      })
    })
    container.querySelector('[data-action="browser-sync"]')?.addEventListener('click', async () => {
      await withBusy(() => request('post', '/web-access/cookies', { sync: true }, 60000), { successMessage: '已同步浏览器 Cookie', errorPrefix: '同步失败' })
    })
    container.querySelector('[data-action="browser-close"]')?.addEventListener('click', async () => {
      await withBusy(() => request('post', '/web-access/browse', { action: 'close' }, 60000), { successMessage: '浏览器已关闭', errorPrefix: '关闭失败' })
    })
    for (const button of container.querySelectorAll('[data-action="quick-login"]')) {
      button.addEventListener('click', async () => {
        const url = button.getAttribute('data-url') || ''
        const input = container.querySelector('[data-field="browser-url"]')
        if (input && url) input.value = url
        await withBusy(() => request('post', '/web-access/browse', { action: 'login', url, interactive: true }, 150000), {
          successMessage: `已打开 ${url.includes('douyin') ? '抖音' : 'B站'} 登录窗口，登录完成后点「同步 Cookie」`,
          errorPrefix: '打开登录窗口失败',
        })
      })
    }
    container.querySelector('[data-action="cookies-export"]')?.addEventListener('click', async () => {
      const result = await withBusy(
        () => request('post', '/web-access/cookies', { export: true, domains: ['bilibili.com', 'douyin.com'] }, 60000),
        { errorPrefix: '导出失败' },
      )
      if (result?.ok && result.path) {
        notify('success', `已导出 ${result.count || 0} 条 Cookie：${String(result.path).split(/[\\/]/).pop()}（数据目录 web-access/files 下）`)
      }
    })
    container.querySelector('[data-action="cookie-import"]')?.addEventListener('click', async () => {
      const from = container.querySelector('[data-field="import-browser"]')?.value || ''
      if (!from) return notify('warn', '没有检测到可导入的本机浏览器')
      const domain = val('import-domain').trim()
      await withBusy(
        () => request('post', '/web-access/cookies', { from_browser: from, domain }, 180000),
        { errorPrefix: '导入失败' },
      ).then(result => {
        if (result?.ok) {
          const skipped = Number(result.skippedAppBound) || 0
          notify('success', `已导入 ${result.imported || 0} 条 Cookie${skipped ? `，跳过 ${skipped} 条 App-Bound 加密项` : ''}`)
          if (Array.isArray(result.errors) && result.errors.length) notify('warn', result.errors[0].error || '部分配置读取失败')
        }
      })
    })
    container.querySelector('[data-action="cookie-save"]')?.addEventListener('click', async () => {
      const url = val('paste-url').trim()
      const cookie = val('paste-cookie').trim()
      if (!cookie) return notify('warn', '请先粘贴 Cookie')
      if (!url) return notify('warn', '请填写 Cookie 对应的网站 URL')
      await withBusy(() => request('post', '/web-access/cookies', { url, cookie }, 60000), { successMessage: 'Cookie 已保存并会自动复用' })
    })
    for (const button of container.querySelectorAll('[data-action="cookie-delete"]')) {
      button.addEventListener('click', async () => {
        const domain = button.getAttribute('data-domain') || ''
        await withBusy(() => request('post', '/web-access/cookies', { clear: true, domain }, 30000), { successMessage: `已删除 ${domain} 的 Cookie` })
      })
    }
    container.querySelector('[data-action="cookie-clear-all"]')?.addEventListener('click', async () => {
      let confirmed = true
      if (modal?.confirm) {
        const answer = await modal.confirm('清空 Cookie 库？', '所有站点保存的登录态都会被删除；下次需要重新登录或重新导入。')
        confirmed = !!answer?.ok
      }
      if (!confirmed) return
      await withBusy(() => request('post', '/web-access/cookies', { clear: true }, 30000), { successMessage: 'Cookie 库已清空' })
    })
  }

  render()
  refresh()
  return () => {
    disposed = true
  }
}
