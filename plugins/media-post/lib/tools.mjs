/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * media-post · 外部工具管理（yt-dlp / ffmpeg）
 *
 * 设计：
 *   - 先探测（用户配置路径 → 数据目录 tools → 系统 PATH → Python 模块），能用自己的就用；
 *   - 需要时提供「一键安装」：
 *       ffmpeg：从 npm 镜像下载 @ffmpeg-installer/<平台包>，解包出 ffmpeg(.exe)；
 *       yt-dlp：优先用本机 Python + PyPI 镜像 pip --target 安装（不需要 GitHub）；
 *               没有 Python 时再尝试 GitHub 官方 exe（国内可能失败，如实报错）。
 *   - 所有安装都放到 <数据目录>/media-post/tools/，不污染系统。
 */
import { spawn } from 'node:child_process'
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { delimiter, join, dirname } from 'node:path'

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''

export const FFMPEG_NPM_PACKAGE = IS_WIN
  ? '@ffmpeg-installer/win32-x64'
  : process.platform === 'darwin'
    ? (process.arch === 'arm64' ? '@ffmpeg-installer/darwin-arm64' : '@ffmpeg-installer/darwin-x64')
    : process.arch === 'arm64'
      ? '@ffmpeg-installer/linux-arm64'
      : '@ffmpeg-installer/linux-x64'

export function run(command, args = [], { cwd, env = {}, timeoutMs = 120000, input } = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true })
    } catch (error) {
      return resolve({ code: -1, stdout: '', stderr: '', error: error.message })
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch (_) { /* ignore */ }
      resolve({ code: -1, stdout, stderr, error: `命令超时（${timeoutMs}ms）` })
    }, Math.max(1000, Number(timeoutMs) || 120000))
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr, error: error.message })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: Number.isFinite(code) ? code : -1, stdout, stderr })
    })
    if (input !== undefined) {
      try { child.stdin?.write(String(input)); child.stdin?.end() } catch (_) { /* ignore */ }
    } else {
      try { child.stdin?.end() } catch (_) { /* ignore */ }
    }
  })
}

/** 在 PATH 里找可执行文件（不依赖 where/which 的本地化输出）。 */
export function findOnPath(name) {
  const candidates = IS_WIN ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name]
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const candidate of candidates) {
      const full = join(dir, candidate)
      if (existsSync(full)) return full
    }
  }
  return ''
}

async function fileExists(path) {
  if (!path) return false
  try { return (await stat(path)).isFile() } catch { return false }
}

/* ---------------- ffmpeg ---------------- */

export async function detectFfmpeg({ dataDir, config = {} } = {}) {
  const candidates = []
  if (config.ffmpegPath) candidates.push({ path: String(config.ffmpegPath), label: '插件配置' })
  candidates.push({ path: join(dataDir || '.', 'media-post', 'tools', `ffmpeg${EXE}`), label: '媒体插件目录' })
  const onPath = findOnPath('ffmpeg')
  if (onPath) candidates.push({ path: onPath, label: '系统 PATH' })

  for (const candidate of candidates) {
    if (!(await fileExists(candidate.path))) continue
    const result = await run(candidate.path, ['-hide_banner', '-version'], { timeoutMs: 8000 })
    const version = (String(result.stdout || '').match(/ffmpeg version\s+(\S+)/i) || [])[1] || ''
    if (result.code === 0 || version) return { available: true, path: candidate.path, label: candidate.label, version, kind: 'binary' }
  }
  return { available: false, path: '', label: '', version: '', kind: '' }
}

/* ---------------- yt-dlp ---------------- */

const PYTHON_CANDIDATES = ['py', 'python', 'python3']

export async function detectPython({ config = {} } = {}) {
  const candidates = []
  if (config.pythonPath) candidates.push(String(config.pythonPath))
  candidates.push(...(IS_WIN ? ['py', 'python', 'python3'] : ['python3', 'python']))
  const tried = new Set()
  for (const candidate of candidates) {
    const key = String(candidate).toLowerCase()
    if (!key || tried.has(key)) continue
    tried.add(key)
    const args = /(^|[\\/])py(\.exe)?$/i.test(candidate) ? ['-3', '--version'] : ['--version']
    const result = await run(candidate, args, { timeoutMs: 8000 })
    const text = `${result.stdout || ''} ${result.stderr || ''}`
    const version = (text.match(/Python\s+(\d+\.\d+(\.\d+)?)/i) || [])[1] || ''
    if (result.code === 0 && version) return { available: true, command: candidate, version, moduleArgs: /(^|[\\/])py(\.exe)?$/i.test(candidate) ? ['-3'] : [] }
  }
  return { available: false, command: '', version: '', moduleArgs: [] }
}

export async function detectYtDlp({ dataDir, config = {}, python = null } = {}) {
  const binaryCandidates = []
  if (config.ytdlpPath) binaryCandidates.push({ path: String(config.ytdlpPath), label: '插件配置' })
  binaryCandidates.push({ path: join(dataDir || '.', 'media-post', 'tools', `yt-dlp${EXE}`), label: '媒体插件目录' })
  const onPath = findOnPath('yt-dlp')
  if (onPath) binaryCandidates.push({ path: onPath, label: '系统 PATH' })

  for (const candidate of binaryCandidates) {
    if (!(await fileExists(candidate.path))) continue
    const result = await run(candidate.path, ['--version'], { timeoutMs: 10000 })
    const version = String(result.stdout || '').trim().split('\n')[0]
    if (result.code === 0 && version) return { available: true, kind: 'binary', path: candidate.path, label: candidate.label, version }
  }

  const pythonInfo = python || await detectPython({ config })
  if (pythonInfo.available) {
    const pyTarget = join(dataDir || '.', 'media-post', 'tools', 'ytdlp-py')
    const env = { PYTHONPATH: [pyTarget, process.env.PYTHONPATH].filter(Boolean).join(delimiter) }
    const args = [...pythonInfo.moduleArgs, '-m', 'yt_dlp', '--version']
    const result = await run(pythonInfo.command, args, { env, timeoutMs: 12000 })
    const version = String(result.stdout || '').trim().split('\n')[0]
    if (result.code === 0 && version) {
      return { available: true, kind: 'python', path: pythonInfo.command, python: pythonInfo.command, moduleArgs: pythonInfo.moduleArgs, pythonPath: pyTarget, label: `Python（${pythonInfo.version}）`, version }
    }
  }
  return { available: false, kind: '', path: '', label: '', version: '' }
}

/* ---------------- 下载 / 解包 ---------------- */

export async function downloadFile(url, dest, { timeoutMs = 300000, maxBytes = 256 * 1024 * 1024, onProgress = null } = {}) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${url}`)
  const total = Number(response.headers.get('content-length')) || 0
  if (total && total > maxBytes) throw new Error(`文件超过大小上限（${Math.round(total / 1024 / 1024)}MB）`)
  const chunks = []
  let received = 0
  const reader = response.body?.getReader?.()
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (received > maxBytes) throw new Error('文件超过大小上限')
      chunks.push(Buffer.from(value))
      if (onProgress) onProgress({ received, total })
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer())
    chunks.push(buffer)
  }
  const buffer = Buffer.concat(chunks)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, buffer)
  return { bytes: buffer.length, path: dest }
}

async function registryTarballUrl(pkg) {
  const encoded = pkg.replace('/', '%2f')
  const registries = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
  let lastError = null
  for (const registry of registries) {
    try {
      const response = await fetch(`${registry}/${encoded}`, { signal: AbortSignal.timeout(20000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const meta = await response.json()
      const latest = meta['dist-tags']?.latest || Object.keys(meta.versions || {}).pop()
      const url = meta.versions?.[latest]?.dist?.tarball
      if (url) return { url, version: latest }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`无法获取 ${pkg} 的下载地址：${lastError?.message || '未知错误'}`)
}

async function extractTarGz(archive, destDir) {
  await mkdir(destDir, { recursive: true })
  const result = await run('tar', ['-xf', archive, '-C', destDir], { timeoutMs: 180000 })
  if (result.code !== 0) throw new Error(`解包失败：${(result.stderr || result.error || '').trim().slice(0, 200)}`)
}

/**
 * 安装 ffmpeg：从 npm 平台包解出 ffmpeg(.exe) 放到 <数据目录>/media-post/tools/。
 * 已存在系统 ffmpeg 时调用方应先探测，这里只在需要时调用。
 */
export async function installFfmpeg({ dataDir, onProgress = null } = {}) {
  const toolsDir = join(dataDir || '.', 'media-post', 'tools')
  await mkdir(toolsDir, { recursive: true })
  const { url, version } = await registryTarballUrl(FFMPEG_NPM_PACKAGE)
  onProgress?.({ phase: 'download', url, version })
  const archive = join(toolsDir, `ffmpeg-${version}.tgz`)
  await downloadFile(url, archive, { timeoutMs: 600000, maxBytes: 256 * 1024 * 1024 })
  const rawDir = join(toolsDir, 'ffmpeg-raw')
  await rm(rawDir, { recursive: true, force: true }).catch(() => {})
  onProgress?.({ phase: 'extract' })
  await extractTarGz(archive, rawDir)
  const packed = join(rawDir, 'package', `ffmpeg${EXE}`)
  if (!(await fileExists(packed))) throw new Error('解包后没有找到 ffmpeg 可执行文件')
  const target = join(toolsDir, `ffmpeg${EXE}`)
  await rm(target, { force: true }).catch(() => {})
  await rename(packed, target)
  await chmod(target, 0o755).catch(() => {})
  await rm(archive, { force: true }).catch(() => {})
  await rm(rawDir, { recursive: true, force: true }).catch(() => {})
  const detected = await detectFfmpeg({ dataDir })
  return { ...detected, installed: true, packageVersion: version }
}

/**
 * 安装 yt-dlp：
 *   1. 有 Python：pip 从镜像安装到 <数据目录>/media-post/tools/ytdlp-py（推荐，国内可达）；
 *   2. 没有 Python：尝试 GitHub 官方 exe（可能被墙，失败时给出明确提示）。
 */
export async function installYtDlp({ dataDir, python = null, pipMirror = 'https://pypi.tuna.tsinghua.edu.cn/simple', onProgress = null } = {}) {
  const toolsDir = join(dataDir || '.', 'media-post', 'tools')
  await mkdir(toolsDir, { recursive: true })
  const pythonInfo = python || await detectPython({})

  if (pythonInfo.available) {
    const pyTarget = join(toolsDir, 'ytdlp-py')
    onProgress?.({ phase: 'pip', mirror: pipMirror })
    const args = [
      ...pythonInfo.moduleArgs,
      '-m', 'pip', 'install',
      '--disable-pip-version-check',
      '--no-warn-script-location',
      '--upgrade',
      '--target', pyTarget,
      '-i', pipMirror,
      'yt-dlp',
    ]
    const result = await run(pythonInfo.command, args, { timeoutMs: 600000 })
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || result.error || '').trim().split('\n').slice(-3).join(' ')
      throw new Error(`pip 安装 yt-dlp 失败：${detail.slice(0, 300)}`)
    }
    const detected = await detectYtDlp({ dataDir, python: pythonInfo })
    if (detected.available) return { ...detected, installed: true, via: 'pip' }
    throw new Error('pip 安装完成但没有检测到可用的 yt-dlp 模块')
  }

  onProgress?.({ phase: 'github' })
  const target = join(toolsDir, `yt-dlp${EXE}`)
  const url = IS_WIN
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
  await downloadFile(url, target, { timeoutMs: 300000, maxBytes: 128 * 1024 * 1024 })
  await chmod(target, 0o755).catch(() => {})
  const detected = await detectYtDlp({ dataDir, python: { available: false } })
  if (detected.available) return { ...detected, installed: true, via: 'github' }
  throw new Error('已下载 yt-dlp，但没有检测到可执行（可能被安全软件拦截）')
}

/** 汇总当前工具状态。 */
export async function toolStatus({ dataDir, config = {} } = {}) {
  const python = await detectPython({ config })
  const [ffmpeg, ytdlp] = await Promise.all([
    detectFfmpeg({ dataDir, config }),
    detectYtDlp({ dataDir, config, python }),
  ])
  return { ffmpeg, ytdlp, python }
}
