/*
 * social-bridge · 邮箱前端插件（精简版）
 *
 * 只保留一个 email 模型工具 + 邮箱设置面板。
 * B站 / 抖音渠道、访客工具、自动轮询等代码已全部移除。
 */
export const name = 'social-bridge'
export const version = '2.0.1'
export const scope = 'both'
export const displayName = '邮箱'
export const description = 'IMAP / SMTP 邮箱工具：查看配置、列邮件、读邮件、发送与回复；修复中文邮件乱码。'
export const author = '念风扩展'
export const icon = '📧'
export const core = false
export const enabled = true
export const depends = {
  'tool-registry': '^1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'plugin-manager': '>=1.0.0',
  'settings-container': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const inject = ['tool-registry', 'plugin-manager?', 'api?', 'toast?', 'settings-container?']
export const provides = []

export function apply(ctx) {
  const registry = ctx.inject('tool-registry')
  const manager = ctx.inject('plugin-manager?')
  const toast = ctx.inject('toast?')
  const pages = ctx.inject('settings-container?') || ctx.registry.get('settings-container')
  const api = () => ctx.registry.get('api')

  const notify = (kind, message) => {
    try {
      const fn = kind === 'error' ? toast?.warn : toast?.[kind]
      fn?.(message)
    } catch (_) {
      /* ignore */
    }
  }

  const callApi = async (method, path, body, timeoutMs = 120000) => {
    const client = api()
    if (!client) return { ok: false, code: 'BACKEND_OFFLINE', error: '本地后端未连接（backend-client 未启用或后端未启动）。' }
    try {
      if (method === 'get') return await client.get(path, { timeoutMs })
      if (method === 'del') return await client.del(path, { timeoutMs })
      return await client.post(path, body || {}, { timeoutMs })
    } catch (error) {
      return {
        ok: false,
        code: error?.status === 404 ? 'BRIDGE_NOT_LOADED' : 'BACKEND_ERROR',
        error: error?.message || String(error),
      }
    }
  }

  const EMAIL_PARAMS = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'save', 'list', 'read', 'send', 'reply', 'test'], description: '邮箱动作。' },
      uid: { type: 'string', description: 'read 时的邮件 UID。' },
      folder: { type: 'string', description: '邮件夹，默认 INBOX。' },
      limit: { type: 'number', description: 'list 条数。' },
      unreadOnly: { type: 'boolean', description: '只看未读。' },
      to: { type: 'string', description: 'send/reply 收件人。' },
      subject: { type: 'string' },
      text: { type: 'string', description: '正文。' },
      inReplyTo: { type: 'string' },
      references: { type: 'string' },
      config: {
        type: 'object',
        description: 'save / 临时覆盖配置：imapHost/imapPort/smtpHost/smtpPort/user/authCode/fromName。',
      },
    },
    required: ['action'],
  }

  const emailTool = registry.register('email', {
    description: '邮箱工具：查看配置、列邮件、读邮件、发送 / 回复邮件。QQ 邮箱使用 IMAP/SMTP 授权码，与网页登录可同时存在。',
    parameters: EMAIL_PARAMS,
  }, async args => callApi('post', '/email/action', args, 180000))

  function renderPanel(container) {
    let status = null
    let disposed = false
    const paint = async () => {
      const result = await callApi('get', '/email/status', undefined, 60000)
      if (disposed) return
      status = result?.mail || null
      container.innerHTML = `
        <div class="settings-section">
          <div class="settings-section-title">📧 邮箱</div>
          <div class="settings-section-body settings-card">
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">IMAP 服务器</div><div class="setting-help">QQ 邮箱默认：imap.qq.com:993（SSL）</div></div>
              <div class="setting-control"><input class="setting-input" data-email="imapHost" value="${escapeAttr(status?.imapHost || 'imap.qq.com')}" /></div>
            </div>
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">IMAP 端口</div></div>
              <div class="setting-control"><input class="setting-input" data-email="imapPort" value="${escapeAttr(status?.imapPort || 993)}" /></div>
            </div>
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">SMTP 服务器</div><div class="setting-help">QQ 邮箱默认：smtp.qq.com:465（SSL）</div></div>
              <div class="setting-control"><input class="setting-input" data-email="smtpHost" value="${escapeAttr(status?.smtpHost || 'smtp.qq.com')}" /></div>
            </div>
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">SMTP 端口</div></div>
              <div class="setting-control"><input class="setting-input" data-email="smtpPort" value="${escapeAttr(status?.smtpPort || 465)}" /></div>
            </div>
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">邮箱账号</div></div>
              <div class="setting-control"><input class="setting-input" data-email="user" value="${escapeAttr(status?.user || '')}" placeholder="xxx@qq.com" /></div>
            </div>
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">IMAP / SMTP 授权码</div><div class="setting-help">${status?.hasAuthCode ? '已保存；留空表示不修改' : 'QQ 邮箱设置 → 账户 → 开启 IMAP/SMTP 后生成'}</div></div>
              <div class="setting-control"><input class="setting-input" type="password" data-email="authCode" value="" placeholder="${status?.hasAuthCode ? '已保存，留空不修改' : '请输入授权码'}" /></div>
            </div>
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">发件人名称</div></div>
              <div class="setting-control"><input class="setting-input" data-email="fromName" value="${escapeAttr(status?.fromName || '')}" placeholder="念风" /></div>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;padding:10px 15px 14px">
            <button class="outline-btn primary-soft" data-email-action="save">保存</button>
            <button class="outline-btn" data-email-action="test">测试 IMAP / SMTP</button>
          </div>
          <div class="settings-note" data-email-note style="padding:0 15px 14px;font-size:12px;line-height:1.6;color:var(--text-3)">
            ${status?.configured ? '邮箱已配置。' : '邮箱未配置。'}${status?.user ? ` 当前账号：${escapeHtml(status.user)}` : ''}
          </div>
        </div>`
    }

    const readConfig = () => {
      const config = {}
      for (const input of container.querySelectorAll('[data-email]')) {
        const key = input.dataset.email
        const value = String(input.value || '').trim()
        if (!key) continue
        if (key === 'authCode' && !value) continue
        if (key === 'imapPort' || key === 'smtpPort') config[key] = Number(value) || (key === 'imapPort' ? 993 : 465)
        else config[key] = value
      }
      return config
    }

    const onClick = async event => {
      const button = event.target.closest?.('[data-email-action]')
      if (!button) return
      const action = button.dataset.emailAction
      button.disabled = true
      try {
        const result = action === 'save'
          ? await callApi('post', '/email/action', { action: 'save', config: readConfig() }, 60000)
          : await callApi('post', '/email/action', { action: 'test', config: readConfig() }, 120000)
        if (result?.ok === false) notify('error', result.error || '操作失败')
        else if (action === 'save') {
          notify('success', '邮箱配置已保存')
          await paint()
        } else {
          const imapOk = result?.imap?.ok !== false
          const smtpOk = result?.smtp?.ok !== false
          notify(imapOk && smtpOk ? 'success' : 'warn', `IMAP：${imapOk ? '正常' : '失败'}，SMTP：${smtpOk ? '正常' : '失败'}`)
        }
      } catch (error) {
        notify('error', error?.message || String(error))
      } finally {
        button.disabled = false
      }
    }

    container.addEventListener('click', onClick)
    const cleanup = () => {
      disposed = true
      container.removeEventListener('click', onClick)
    }
    paint().catch(error => notify('error', error?.message || String(error)))
    return cleanup
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
  const escapeAttr = escapeHtml

  if (manager?.registerSettings) {
    try {
      const dispose = manager.registerSettings({
        id: 'social-bridge',
        title: '邮箱',
        description: 'IMAP / SMTP 邮箱账号配置与连通性测试。',
        render: container => renderPanel(container),
      })
      ctx.effect(() => () => dispose?.())
    } catch (error) {
      ctx.logger.warn(`[email] 注册插件设置面板失败：${error?.message || error}`)
    }
  }

  if (pages?.register) {
    try {
      const dispose = pages.register({
        id: 'social-bridge',
        group: '功能',
        groupOrder: 50,
        label: '邮箱',
        icon: '📧',
        order: 80,
        render(container) {
          return renderPanel(container)
        },
      })
      ctx.effect(() => () => dispose?.())
    } catch (error) {
      ctx.logger.warn(`[email] 注册设置页失败：${error?.message || error}`)
    }
  }

  ctx.effect(() => () => emailTool?.())
  ctx.logger.info(`邮箱插件 v${version} 已启用（仅邮箱工具）`)
}