<#
修复 profile 的 pnpm store 冲突（v10 -> v11）。

背景：pnpm 10 与 11 的 store 格式不同（v11 改成 SQLite 索引），无法共用。
profile 的 node_modules 若是 pnpm 10 建的，而 DSH 运行时用 pnpm 11 安装插件，
就会报 ERR_PNPM_UNEXPECTED_STORE。官方修法只有一条：用目标版本重装一次。

本脚本做四件事，失败会回滚：
  1. 确认 DeepSeek Harness 已关闭（node_modules 被占用时无法重装）
  2. 备份 package.json / pnpm-lock.yaml，并把 node_modules 改名保留
  3. 用 pnpm >= 11 重装
  4. 校验 node_modules/.modules.yaml 的 storeDir 指向 v11

用法（必须在 DSH 关闭时，在普通终端里）：
  powershell -ExecutionPolicy Bypass -File scripts\fix-profile-store.ps1
  powershell -ExecutionPolicy Bypass -File scripts\fix-profile-store.ps1 -KeepBackup

若中文显示乱码（Windows PowerShell 5.1 读无 BOM 文件），不影响执行。
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [switch]$KeepBackup,
  [switch]$SetGitHubTimeout
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  Write-Host "FAILED: $message" -ForegroundColor Red
  exit 1
}

# ── 1. DSH 必须已关闭 ────────────────────────────────────────────────────────
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' })
if ($running.Count -gt 0) {
  Write-Host 'DeepSeek Harness is still running. Quit it completely, then rerun.' -ForegroundColor Yellow
  $running | Select-Object Id, ProcessName | Format-Table -AutoSize
  exit 1
}

if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) { Fail "profile not found: $ProfileDir" }

# ── 2. 选一个 pnpm >= 11 ─────────────────────────────────────────────────────
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $pnpm) { Fail 'pnpm not found on PATH. Install it with: npm i -g pnpm@11' }
$version = (& $pnpm --version) -join ''
$major = [int]($version.Split('.')[0])
if ($major -lt 11) {
  Fail "pnpm on PATH is $version; the profile must be rebuilt with pnpm 11. Run: npm i -g pnpm@11"
}
Write-Host "pnpm $version  ($pnpm)"

# ── 3. 备份 ──────────────────────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$modules = Join-Path $ProfileDir 'node_modules'
$modulesBackup = Join-Path $ProfileDir "node_modules.bak-store-$stamp"

foreach ($name in 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') {
  $source = Join-Path $ProfileDir $name
  if (Test-Path $source) { Copy-Item $source "$source.bak-store-$stamp" -Force }
}
Write-Host "backup suffix: .bak-store-$stamp"

if (Test-Path $modules) {
  Rename-Item -Path $modules -NewName (Split-Path $modulesBackup -Leaf)
  Write-Host "node_modules renamed to $(Split-Path $modulesBackup -Leaf)"
}

# ── 3b. 可选：放宽插件管理器的 GitHub 探测超时 ───────────────────────────────
# 默认 5000ms。github.com 走代理时 ls-remote 实测可到 7.7s，会误判成 spec-host 失败。
if ($SetGitHubTimeout) {
  $patch = Join-Path $ProfileDir 'cordis.patch.yml'
  $template = Join-Path $PSScriptRoot 'profile-github-timeout.patch.yml'
  if (-not (Test-Path $patch)) {
    Write-Host "skip: no cordis.patch.yml at $ProfileDir" -ForegroundColor Yellow
  } elseif (-not (Test-Path $template)) {
    Write-Host "skip: template missing at $template" -ForegroundColor Yellow
  } elseif ((Get-Content $patch -Raw) -match 'id:\s*plugin-manager') {
    Write-Host 'plugin-manager already configured in cordis.patch.yml; left untouched'
  } else {
    Copy-Item $patch "$patch.bak-store-$stamp" -Force
    Add-Content -Path $patch -Value (Get-Content $template -Raw) -Encoding utf8
    Write-Host 'added githubConnectionTimeoutMs: 20000 to cordis.patch.yml'
  }
}

# ── 4. 重装并校验 ────────────────────────────────────────────────────────────
Push-Location $ProfileDir
try {
  & $pnpm install --ignore-scripts --no-frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "pnpm install exited with $LASTEXITCODE" }

  $modulesYaml = Join-Path $ProfileDir 'node_modules\.modules.yaml'
  if (-not (Test-Path $modulesYaml)) { throw 'node_modules/.modules.yaml is missing after install' }
  $storeLine = (Select-String -Path $modulesYaml -Pattern '"storeDir"' | Select-Object -First 1).Line
  Write-Host $storeLine.Trim()
  if ($storeLine -notmatch 'v11') {
    throw 'storeDir does not point at v11; the install may have used a stale store'
  }

  Write-Host 'OK: profile rebuilt against the v11 store.' -ForegroundColor Green
  if (-not $KeepBackup) {
    Remove-Item $modulesBackup -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'old node_modules backup removed (use -KeepBackup to keep it)'
  } else {
    Write-Host "old node_modules kept at $(Split-Path $modulesBackup -Leaf)"
  }
} catch {
  Write-Host "ROLLING BACK: $($_.Exception.Message)" -ForegroundColor Yellow
  $failedModules = Join-Path $ProfileDir 'node_modules'
  if (Test-Path $failedModules) { Remove-Item $failedModules -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $modulesBackup) { Rename-Item -Path $modulesBackup -NewName 'node_modules' }
  foreach ($name in 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') {
    $backup = Join-Path $ProfileDir "$name.bak-store-$stamp"
    if (Test-Path $backup) { Copy-Item $backup (Join-Path $ProfileDir $name) -Force }
  }
  Fail 'profile restored to its previous state'
} finally {
  Pop-Location
}
