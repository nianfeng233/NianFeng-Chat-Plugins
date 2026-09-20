# 念风chat · 扩展插件安装脚本 · GitHub 助手（github-hub）
#
# 用法（在任意目录均可执行）：
#   powershell -ExecutionPolicy Bypass -File .\extensions\github-hub\install.ps1
#   .\extensions\github-hub\install.ps1 -DataDir "D:\nianfeng-data"
#   .\extensions\github-hub\install.ps1 -PluginsDir "D:\my-plugins" -Force
#
# 脚本会把前端插件 + 后端桥 + lib/ 复制到念风的外部插件目录
# （默认 <数据目录>/plugins/github-hub）。
# 安装后回到「设置 → 插件」点一次「重新扫描」即可（新版内核会同时热加载 bridge.mjs）。
param(
  [string]$DataDir = '',
  [string]$PluginsDir = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$sourceDir = $PSScriptRoot
$repoRoot = Split-Path (Split-Path $sourceDir -Parent) -Parent

function Resolve-DefaultDataDir {
  param([string]$Root)
  $localDir = Join-Path $Root 'user_data'
  $localInstance = Join-Path $localDir 'instance.json'
  if (Test-Path $localInstance) {
    try {
      $parsed = Get-Content $localInstance -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($parsed.dataDir) { return [string]$parsed.dataDir }
    } catch { }
  }
  $appPointer = Join-Path $env:APPDATA 'nianfeng\instance.json'
  if (Test-Path $appPointer) {
    try {
      $parsed = Get-Content $appPointer -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($parsed.dataDir) { return [string]$parsed.dataDir }
    } catch { }
  }
  return $localDir
}

if ($PluginsDir) {
  $targetDir = Join-Path $PluginsDir 'github-hub'
  $label = '插件目录 -PluginsDir'
} else {
  $resolvedDataDir = if ($DataDir) { $DataDir } else { Resolve-DefaultDataDir -Root $repoRoot }
  $targetDir = Join-Path (Join-Path $resolvedDataDir 'plugins') 'github-hub'
  $label = '数据目录 plugins'
}

Write-Host '念风 · GitHub 助手 安装'
Write-Host "  来源：$sourceDir"
Write-Host "  目标：$targetDir  （$label）"

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $targetDir 'lib') | Out-Null

$files = @('index.mjs', 'panel.mjs', 'ui.mjs', 'bridge.mjs', 'manifest.json', 'README.md')
$libFiles = @(Get-ChildItem -Path (Join-Path $sourceDir 'lib') -Filter '*.mjs' -File)

foreach ($name in $files) {
  $from = Join-Path $sourceDir $name
  if (-not (Test-Path $from)) { throw "缺少文件：$from" }
  $to = Join-Path $targetDir $name
  if ((Test-Path $to) -and -not $Force) {
    throw "目标已存在：$to`n如果确认要覆盖，请在命令后加 -Force 参数。"
  }
}
foreach ($lib in $libFiles) {
  $to = Join-Path (Join-Path $targetDir 'lib') $lib.Name
  if ((Test-Path $to) -and -not $Force) {
    throw "目标已存在：$to`n如果确认要覆盖，请在命令后加 -Force 参数。"
  }
}

foreach ($name in $files) {
  Copy-Item -Path (Join-Path $sourceDir $name) -Destination (Join-Path $targetDir $name) -Force
  Write-Host "  ✔ 已写入 $name"
}
foreach ($lib in $libFiles) {
  Copy-Item -Path $lib.FullName -Destination (Join-Path (Join-Path $targetDir 'lib') $lib.Name) -Force
  Write-Host "  ✔ 已写入 lib\$($lib.Name)"
}

Write-Host ''
Write-Host '安装完成。接下来：'
Write-Host '  1. 回到念风 → 设置 → 插件 → 点「重新扫描」；新版内核会同时热加载后端桥，无需重启。'
Write-Host '  2. 打开「设置 → GitHub 助手」（或插件条目后的「设置」）。'
Write-Host '  3. 可选：填写 GitHub Token（只读公开仓库可不填；自动回复 Issue 必须填）。'
Write-Host '  4. 在「渠道订阅」里给每个渠道添加要监控的 owner/repo，并勾选事件类型。'
Write-Host '  5. 在「自动回复」里开启草稿模式并选择模型，新 Issue 会自动分析并通知。'
Write-Host ''
Write-Host "提示：如果念风的数据目录不在 $repoRoot\user_data，请用 -DataDir 指定，"
Write-Host '      或在 设置 → 插件 里查看当前外部插件目录后用 -PluginsDir 指定。'
