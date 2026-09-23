/*
 * 念风官方插件仓库 · 清单生成脚本
 * 用法：node scripts/build-market.mjs
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGINS_DIR = join(ROOT, 'plugins')
const REPO_URL = process.env.MARKET_REPO_URL || "https://github.com/nianfeng233/NianFeng-Chat-Plugins"
const BRANCH = process.env.MARKET_REPO_BRANCH || "main"
// 可选：把插件压缩包固定到某个 commit，避免国内镜像缓存 main 分支旧压缩包导致
// 市场清单已经是新哈希、下载到的却是旧内容。
// 用法：先提交插件改动，再以 MARKET_COMMIT=<该提交> node scripts/build-market.mjs
const MARKET_COMMIT = String(process.env.MARKET_COMMIT || '').trim()

async function walkFiles(dir, base = dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.DS_Store') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(full, base, out)
    else if (entry.isFile()) out.push({ full, rel: relative(base, full).split(sep).join('/') })
  }
  return out
}

async function hashFileEntries(entries) {
  const hash = createHash('sha256')
  const files = [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const file of files) {
    const data = await readFile(file.full)
    hash.update(`file:${file.rel}\n`)
    hash.update(`size:${data.length}\n`)
    hash.update(data)
    hash.update('\n')
  }
  return hash.digest('hex')
}

async function main() {
  const entries = await readdir(PLUGINS_DIR, { withFileTypes: true })
  const plugins = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(PLUGINS_DIR, entry.name)
    let manifest = {}
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    } catch (_) {
      manifest = {}
    }
    const id = String(manifest.id || entry.name).trim()
    const files = await walkFiles(dir)
    const hash = await hashFileEntries(files, dir)
    plugins.push({
      id,
      name: String(manifest.displayName || manifest.name || id),
      displayName: String(manifest.displayName || manifest.name || id),
      version: String(manifest.version || '0.0.0'),
      description: String(manifest.description || ''),
      author: String(manifest.author || ''),
      icon: String(manifest.icon || ''),
      license: String(manifest.license || 'Apache-2.0'),
      path: `plugins/${entry.name}`,
      entry: String(manifest.entry || 'index.mjs').replace(/^\.?\//, '') || 'index.mjs',
      scope: String(manifest.scope || 'both'),
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      tags: Array.isArray(manifest.tags) ? manifest.tags : [],
      minAppVersion: String(manifest.minAppVersion || '2.0.0'),
      hashType: 'content-sha256',
      sha256: hash,
      updatedAt: new Date().toISOString(),
      repo: REPO_URL,
      branch: BRANCH,
      commit: MARKET_COMMIT,
      homepage: `${REPO_URL}/tree/${BRANCH}/${'plugins/' + entry.name}`,
      release: null,
    })
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id))
  const market = {
    version: 1,
    name: '念风官方插件仓库',
    repo: REPO_URL,
    branch: BRANCH,
    updatedAt: new Date().toISOString(),
    plugins,
  }
  await writeFile(join(ROOT, 'market.json'), JSON.stringify(market, null, 2) + '\n', 'utf8')
  const index = {
    version: 1,
    updatedAt: new Date().toISOString(),
    repos: [{ name: market.name, url: REPO_URL, branch: BRANCH, manifest: 'market.json', official: true }],
  }
  await writeFile(join(ROOT, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')
  console.log(`✔ 已生成 market.json / index.json（${plugins.length} 个插件）`)
  for (const plugin of plugins) console.log(`  · ${plugin.id.padEnd(24)} v${plugin.version}  ${plugin.sha256.slice(0, 12)}…`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
