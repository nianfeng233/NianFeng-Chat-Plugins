/*
 * 念风chat · 扩展插件 · napcat-group-guard 服务端档案图渲染器
 *
 * 给「服务端代聊 / headless」实例用：headless 里没有浏览器 Canvas，
 * 前端 Canvas 版档案图生成不了。这里用 Windows 自带的 PowerShell +
 * System.Drawing 在服务端把同一张暗色档案卡画出来（思路等同于 AstrBot
 * 用 Python PIL 在服务端生成图片）。
 *
 * 如果当前环境不允许拉起 powershell.exe（EPERM / ENOENT / 安全软件拦截），
 * 会自动降级到 render-fallback.mjs 的纯 Node PNG 渲染，保证服务端仍然
 * 有图可发，因此群管助手不再依赖 WebUI 页面常驻。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renderNodeDossierCard } from './render-fallback.mjs'

const RENDER_DIR = join(tmpdir(), 'nianfeng-group-guard', 'render')
const PS_TIMEOUT_MS = 15000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * PowerShell 被安全策略 / 沙箱 / 精简系统拒绝一次后就不再重试，
 * 直接走纯 Node PNG 渲染，避免每条事件都白等一次 30 秒超时。
 */
let powerShellUnavailableReason = ''
let fallbackWarningEmitted = false
const PERMANENT_SPAWN_CODES = new Set(['EPERM', 'ENOENT', 'EACCES', 'ENOSYS', 'UNKNOWN'])

function isPermanentPowerShellFailure(err) {
  const code = String(err?.code || '').toUpperCase()
  const message = String(err?.message || err || '').toUpperCase()
  return PERMANENT_SPAWN_CODES.has(code) || /\b(EPERM|ENOENT|EACCES|ENOSYS|UNKNOWN)\b/.test(message)
}

function renderWithFallback(payload, reason = '') {
  const fallback = renderNodeDossierCard(payload)
  if (fallback.ok) {
    const warning = reason && !fallbackWarningEmitted ? `${reason}；已自动降级为纯 Node 档案图。` : ''
    fallbackWarningEmitted = true
    return { ...fallback, warning }
  }
  return {
    ok: false,
    code: fallback.code || 'RENDER_FALLBACK_FAILED',
    error: reason ? `${reason}；${fallback.error}` : fallback.error,
  }
}

function shouldUseNodeFallback(options = {}) {
  if (options?.renderer === 'node' || options?.forceFallback === true) return true
  return String(process.env.NIANFENG_GROUP_GUARD_FORCE_NODE_RENDER || '').trim() === '1'
}

/**
 * 这段 PowerShell 脚本通过 -File <script> <payload.json> 调用。
 * payload 里带 profile 文本字段、头像本地路径、输出 PNG 路径。
 */
export const POWERSHELL_RENDER_SCRIPT = [
  'param([string]$PayloadPath)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Drawing',
  '$p = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json',
  '$w = 760; $h = 486',
  '$bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  '$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias',
  '$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
  'function C([int]$r, [int]$gg, [int]$b) { return [System.Drawing.Color]::FromArgb($r, $gg, $b) }',
  '$bg = C 11 18 32',
  '$panel = C 17 28 49',
  '$teal = C 94 234 212',
  '$white = C 226 232 240',
  '$muted = C 148 163 184',
  '$g.FillRectangle((New-Object System.Drawing.SolidBrush -ArgumentList $bg), 0, 0, $w, $h)',
  '$g.FillRectangle((New-Object System.Drawing.SolidBrush -ArgumentList $panel), 22, 22, ($w - 44), ($h - 44))',
  '$pen = New-Object System.Drawing.Pen -ArgumentList $teal, 3',
  '$g.DrawRectangle($pen, 22, 22, ($w - 45), ($h - 45))',
  '$titleFont = New-Object System.Drawing.Font -ArgumentList "Microsoft YaHei", 17, ([System.Drawing.FontStyle]::Bold)',
  '$labelFont = New-Object System.Drawing.Font -ArgumentList "Microsoft YaHei", 12, ([System.Drawing.FontStyle]::Bold)',
  '$nameFont = New-Object System.Drawing.Font -ArgumentList "Microsoft YaHei", 22, ([System.Drawing.FontStyle]::Bold)',
  '$smallFont = New-Object System.Drawing.Font -ArgumentList "Microsoft YaHei", 10',
  '$tealBrush = New-Object System.Drawing.SolidBrush -ArgumentList $teal',
  '$whiteBrush = New-Object System.Drawing.SolidBrush -ArgumentList $white',
  '$mutedBrush = New-Object System.Drawing.SolidBrush -ArgumentList $muted',
  '$g.DrawString("QQ 资料档案 · PROFILE DOSSIER", $titleFont, $tealBrush, 42, 38)',
  '$eventLabel = "入群"',
  'if ($p.eventType -eq "leave") { $eventLabel = "退群" } elseif ($p.eventType -eq "kick") { $eventLabel = "移出" } elseif ($p.eventType -eq "request") { $eventLabel = "进群申请" }',
  '$g.DrawString($eventLabel, $labelFont, $tealBrush, 660, 40)',
  'if ($p.avatarPath -and (Test-Path -LiteralPath $p.avatarPath)) {',
  '  $avatar = [System.Drawing.Image]::FromFile([string]$p.avatarPath)',
  '  $g.DrawImage($avatar, 46, 100, 148, 148)',
  '  $avatar.Dispose()',
  '} else {',
  '  $g.FillRectangle((New-Object System.Drawing.SolidBrush -ArgumentList (C 15 118 110)), 46, 100, 148, 148)',
  '  $initial = "?"',
  '  if ($p.nickname) { $initial = [string]$p.nickname; if ($initial.Length -gt 1) { $initial = $initial.Substring(0, 1) } }',
  '  $initialFont = New-Object System.Drawing.Font -ArgumentList "Microsoft YaHei", 42, ([System.Drawing.FontStyle]::Bold)',
  '  $g.DrawString($initial, $initialFont, $whiteBrush, 86, 138)',
  '}',
  '$nickname = "未知"',
  'if ($p.nickname) { $nickname = [string]$p.nickname }',
  '$g.DrawString($nickname, $nameFont, $whiteBrush, 226, 112)',
  '$qq = ""',
  'if ($p.qq) { $qq = [string]$p.qq }',
  '$g.DrawString(("QQ " + $qq), $labelFont, $tealBrush, 228, 158)',
  '$sig = "这个人很神秘，什么都没有写。"',
  'if ($p.signature) { $sig = [string]$p.signature }',
  'if ($sig.Length -gt 34) { $sig = $sig.Substring(0, 34) + "..." }',
  '$g.DrawString($sig, $smallFont, $mutedBrush, 228, 190)',
  '$level = "隐藏"',
  'if ($null -ne $p.level) { $level = [string]$p.level }',
  '$vip = "无"',
  'if ($p.vip) { $vip = "Lv." + [string]$p.vipLevel }',
  '$g.DrawString(("等级 " + $level), $smallFont, $mutedBrush, 228, 232)',
  '$g.DrawString(("VIP " + $vip), $smallFont, $mutedBrush, 348, 232)',
  '$g.FillRectangle((New-Object System.Drawing.SolidBrush -ArgumentList (C 9 15 27)), 46, 300, ($w - 92), 150)',
  '$g.DrawString("群成员资料", $labelFont, $tealBrush, 64, 314)',
  '$member = $p.member',
  '$lines1 = @()',
  '$lines2 = @()',
  'if ($member) {',
  '  $lines1 += ("群名片：" + [string]$member.card)',
  '  $lines1 += ("角色：" + [string]$member.role)',
  '  $lines1 += ("群等级：" + [string]$member.level)',
  '  $lines2 += ("头衔：" + [string]$member.title)',
  '  $lines2 += ("入群：" + [string]$member.join_time)',
  '  $lines2 += ("最后发言：" + [string]$member.last_sent_time)',
  '} else {',
  '  $lines1 += "未读取到群成员资料（可能已不在群内，或 NapCat 未返回）。"',
  '}',
  '$yy = 346',
  'foreach ($line in $lines1) { $g.DrawString($line, $smallFont, $whiteBrush, 64, $yy); $yy += 24 }',
  '$yy = 346',
  'foreach ($line in $lines2) { $g.DrawString($line, $smallFont, $whiteBrush, 430, $yy); $yy += 24 }',
  '$g.DrawString("由 念风 · 群管助手 服务端渲染", $smallFont, $mutedBrush, 46, 458)',
  '$g.Dispose()',
  '$bmp.Save([string]$p.outputPath, [System.Drawing.Imaging.ImageFormat]::Png)',
  '$bmp.Dispose()',
].join('\r\n')

function safeText(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max)
}

function normalizeMember(member) {
  if (!member || typeof member !== 'object') return null
  return {
    card: safeText(member.card, 60),
    role: safeText(member.role, 30),
    level: safeText(member.level, 20),
    title: safeText(member.title, 60),
    join_time: safeText(member.join_time, 40),
    last_sent_time: safeText(member.last_sent_time, 40),
  }
}

/**
 * 服务端渲染一张档案图。
 * 优先使用 PowerShell + System.Drawing；不可用时自动降级到纯 Node PNG。
 * @param {object} payload { profile, eventType, groupName }
 * @param {object} options { fetchAvatar(qq) => { buffer, contentType }, renderer?: 'node' }
 * @returns {Promise<{ok:boolean, error?:string, base64?:string, dataUrl?:string, bytes?:number, renderer?:string}>}
 */
export async function renderDossierCard(payload = {}, { fetchAvatar, renderer, forceFallback } = {}) {
  if (powerShellUnavailableReason) {
    return renderWithFallback(payload, powerShellUnavailableReason)
  }
  if (shouldUseNodeFallback({ renderer, forceFallback })) {
    return renderWithFallback(payload, '当前配置要求使用纯 Node 档案图')
  }

  const paths = {
    avatar: '',
    payload: '',
    script: '',
    output: '',
  }
  const cleanup = () => {
    for (const file of Object.values(paths)) {
      if (!file) continue
      try {
        rmSync(file, { force: true })
      } catch (_) {
        /* ignore */
      }
    }
  }

  try {
    mkdirSync(RENDER_DIR, { recursive: true })
  } catch (err) {
    return renderWithFallback(payload, `服务端渲染目录不可用：${err?.message || err}`)
  }

  const id = randomUUID().replace(/-/g, '')
  paths.payload = join(RENDER_DIR, `${id}.json`)
  paths.script = join(RENDER_DIR, `${id}.ps1`)
  paths.output = join(RENDER_DIR, `${id}.png`)

  try {
    const profile = payload?.profile && typeof payload.profile === 'object' ? payload.profile : {}
    const qq = safeText(profile.qq, 20)
    let avatarPath = ''
    if (/^\d{5,12}$/.test(qq) && typeof fetchAvatar === 'function') {
      try {
        const avatar = await fetchAvatar(qq)
        if (avatar?.buffer?.length) {
          paths.avatar = join(RENDER_DIR, `${id}.jpg`)
          writeFileSync(paths.avatar, avatar.buffer)
          avatarPath = paths.avatar
        }
      } catch (err) {
        // 头像失败不阻塞档案图渲染，PowerShell 会用占位字母。
      }
    }

    const body = {
      qq,
      nickname: safeText(profile.nickname, 60),
      level: profile.level === undefined ? null : profile.level,
      signature: safeText(profile.signature, 160),
      vip: !!profile.vip,
      vipLevel: Number(profile.vipLevel) || 0,
      eventType: safeText(payload.eventType || 'join', 20),
      groupName: safeText(payload.groupName, 80),
      member: normalizeMember(profile.member),
      avatarPath,
      outputPath: paths.output,
    }
    // Windows PowerShell 5.1 默认按 ANSI 读取无 BOM 的 .ps1，中文会乱码；
    // 这里给脚本加 UTF-8 BOM，保证中文标签 / 字体名正常解析。
    writeFileSync(paths.payload, JSON.stringify(body), 'utf8')
    writeFileSync(paths.script, `\ufeff${POWERSHELL_RENDER_SCRIPT}`, 'utf8')

    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.script, paths.payload],
        { windowsHide: true, timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe'] },
      )
    } catch (err) {
      const stderr = String(err?.stderr || '').trim()
      const reason = `PowerShell 渲染失败：${err?.message || err}${stderr ? ` · ${stderr.slice(0, 400)}` : ''}`
      if (isPermanentPowerShellFailure(err)) powerShellUnavailableReason = reason
      return renderWithFallback(payload, reason)
    }

    if (!existsSync(paths.output)) {
      return renderWithFallback(payload, 'PowerShell 未生成档案图文件')
    }
    const buffer = readFileSync(paths.output)
    if (!buffer.length || buffer.length > MAX_OUTPUT_BYTES) {
      return renderWithFallback(payload, `档案图输出异常（${buffer.length} 字节）`)
    }
    const base64 = buffer.toString('base64')
    return {
      ok: true,
      renderer: 'powershell-system-drawing',
      mime: 'image/png',
      bytes: buffer.length,
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
    }
  } catch (err) {
    const reason = `服务端档案图渲染失败：${err?.message || err}`
    return renderWithFallback(payload, reason)
  } finally {
    cleanup()
  }
}
