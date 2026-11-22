<#
修复 profile 的 pnpm store 冲突（v10 -> v11），并可顺带放宽插件管理器的 GitHub 探测超时。

背景：pnpm 10 与 11 的 store 格式不同（v11 改成 SQLite 索引），无法共用。
profile 的 node_modules 若是 pnpm 10 建的，而 DSH 运行时用 pnpm 11 安装插件，
就会报 ERR_PNPM_UNEXPECTED_STORE。官方修法只有一条：用目标版本重装一次。

用法（重装必须在 DSH 关闭时）：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-profile-store.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-profile-store.ps1 -SetGitHubTimeout
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-profile-store.ps1 -PatchOnly -SetGitHubTimeout

-PatchOnly 只处理 cordis.patch.yml（可在 DSH 运行时安全执行），用于单独追加配置。

关于编码：本脚本存为 UTF-8 with BOM。Windows PowerShell 5.1 读无 BOM 的 UTF-8
会把中文按 ANSI 解码，进而报出并不存在的语法错误；同理，脚本内部读写文件一律走
[System.IO.File] + 显式 UTF8，而不是依赖 Get-Content/Add-Content 的默认编码。
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [switch]$KeepBackup,
  [switch]$SetGitHubTimeout,
  [switch]$PatchOnly
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$message) {
  Write-Host "FAILED: $message" -ForegroundColor Red
  exit 1
}

function Note([string]$message) {
  Write-Host $message
}

if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) { Fail "profile not found: $ProfileDir" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ── 1. 重装（-PatchOnly 时跳过） ─────────────────────────────────────────────
if (-not $PatchOnly) {
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' })
  if ($running.Count -gt 0) {
    Write-Host 'DeepSeek Harness is still running. Quit it completely, then rerun.' -ForegroundColor Yellow
    $running | Select-Object Id, ProcessName | Format-Table -AutoSize
    exit 1
  }

  $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $pnpm) { Fail 'pnpm not found on PATH. Install it with: npm i -g pnpm@11' }
  $version = (& $pnpm --version) -join ''
  if ([int]($version.Split('.')[0]) -lt 11) {
    Fail "pnpm on PATH is $version; the profile must be rebuilt with pnpm 11. Run: npm i -g pnpm@11"
  }
  Note "pnpm $version  ($pnpm)"

  foreach ($name in 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') {
    $source = Join-Path $ProfileDir $name
    if (Test-Path $source) { Copy-Item $source "$source.bak-store-$stamp" -Force }
  }
  Note "backup suffix: .bak-store-$stamp"

  $modules = Join-Path $ProfileDir 'node_modules'
  $modulesBackup = Join-Path $ProfileDir "node_modules.bak-store-$stamp"
  if (Test-Path $modules) {
    Rename-Item -Path $modules -NewName (Split-Path $modulesBackup -Leaf)
    Note "node_modules renamed to $(Split-Path $modulesBackup -Leaf)"
  }

  Push-Location $ProfileDir
  try {
    & $pnpm install --ignore-scripts --no-frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install exited with $LASTEXITCODE" }

    $modulesYaml = Join-Path $ProfileDir 'node_modules\.modules.yaml'
    if (-not (Test-Path $modulesYaml)) { throw 'node_modules/.modules.yaml is missing after install' }
    $storeLine = (Select-String -Path $modulesYaml -Pattern '"storeDir"' | Select-Object -First 1).Line
    Note $storeLine.Trim()
    if ($storeLine -notmatch 'v11') { throw 'storeDir does not point at v11; the install may have used a stale store' }

    Write-Host 'OK: profile rebuilt against the v11 store.' -ForegroundColor Green
    if (-not $KeepBackup) {
      Remove-Item $modulesBackup -Recurse -Force -ErrorAction SilentlyContinue
      Note 'old node_modules backup removed (use -KeepBackup to keep it)'
    } else {
      Note "old node_modules kept at $(Split-Path $modulesBackup -Leaf)"
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
}

# ── 2. 可选：放宽插件管理器的 GitHub 探测超时 ────────────────────────────────
# 默认 5000ms。github.com 走代理时 ls-remote 实测可到 7.7s，会误判成 spec-host 失败。
if ($SetGitHubTimeout) {
  $patch = Join-Path $ProfileDir 'cordis.patch.yml'
  $template = Join-Path $PSScriptRoot 'profile-github-timeout.patch.yml'

  if (-not (Test-Path $patch)) {
    Note "skip: no cordis.patch.yml in $ProfileDir"
  } elseif (-not (Test-Path $template)) {
    Note "skip: template missing at $template"
  } else {
    $existing = [System.IO.File]::ReadAllText($patch)
    if ($existing -match 'id:\s*plugin-manager') {
      Note 'plugin-manager already configured in cordis.patch.yml; left untouched'
    } else {
      Copy-Item $patch "$patch.bak-$stamp" -Force
      $addition = [System.IO.File]::ReadAllText($template)
      if (-not $existing.EndsWith("`n")) { $addition = "`r`n" + $addition }

      # 显式 UTF-8 无 BOM 追加：不依赖 Get-Content/Add-Content 的默认编码，
      # 否则 5.1 会把模板里的中文按 ANSI 读坏，写进 YAML 后直接让 DSH 起不来。
      [System.IO.File]::AppendAllText($patch, $addition, $utf8NoBom)

      # 追加后自检：三行关键内容必须以正确的缩进出现，否则回滚。
      $tail = ([System.IO.File]::ReadAllText($patch) -split "`n" | Select-Object -Last 12) -join "`n"
      $ok = ($tail -match '(?m)^- id: plugin-manager') -and
            ($tail -match "(?m)^  name: '@deepseek-ai/dsh-plugin-manager'") -and
            ($tail -match '(?m)^    githubConnectionTimeoutMs: 20000')
      if (-not $ok) {
        Copy-Item "$patch.bak-$stamp" $patch -Force
        Fail 'appended YAML failed its self-check; cordis.patch.yml restored'
      }
      Note 'added githubConnectionTimeoutMs: 20000 to cordis.patch.yml'
    }
  }
}
