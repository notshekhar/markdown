# md installer (Windows PowerShell) — downloads a prebuilt binary tarball
# from GitHub Releases. No runtime required.
#
#   irm https://raw.githubusercontent.com/notshekhar/markdown/main/install.ps1 | iex
#
# Layout after install:
#   $env:USERPROFILE\.md-bin\
#     ├── markdown.exe
#     ├── md.cmd          (alias shim — `md` is not a builtin on Windows)
#     └── package.json    (version metadata)
#   Adds $env:USERPROFILE\.md-bin to user PATH (and the current session).
#
# Env knobs:
#   $env:MD_REPO_SLUG  notshekhar/markdown
#   $env:MD_VERSION    vX.Y.Z       pin a specific tag
#   $env:MD_HOME       %USERPROFILE%\.md-bin
#   $env:MD_FORCE      1            skip "already up to date" gate
#   $env:MD_UNINSTALL  1            remove the install + PATH entry and exit

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 on older .NET defaults may lack TLS 1.2, which GitHub
# requires — opt in without clobbering anything newer (no-op on PowerShell 7+).
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
} catch {}

function Bold($msg) { Write-Host $msg -ForegroundColor White }
function Dim($msg)  { Write-Host $msg -ForegroundColor DarkGray }
function Err($msg)  { Write-Host $msg -ForegroundColor Red }

$RepoSlug   = if ($env:MD_REPO_SLUG) { $env:MD_REPO_SLUG } else { "notshekhar/markdown" }
$MdHome     = if ($env:MD_HOME)      { $env:MD_HOME }      else { Join-Path $env:USERPROFILE ".md-bin" }
$Force      = $env:MD_FORCE -eq "1"
$PinVersion = $env:MD_VERSION

# ── Uninstall ─────────────────────────────────────────────────────────────
if ($env:MD_UNINSTALL -eq "1") {
    Bold "▶ Uninstalling markdown"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath) {
        $newPath = ($userPath.Split(";") | Where-Object { $_ -and $_ -ne $MdHome }) -join ";"
        if ($newPath -ne $userPath) {
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            Dim "  removed $MdHome from user PATH"
        }
    }
    if (Test-Path $MdHome) {
        Remove-Item -Recurse -Force $MdHome -ErrorAction SilentlyContinue
        Dim "  removed $MdHome"
    }
    Get-ChildItem -Path (Split-Path $MdHome -Parent) -Filter "$(Split-Path $MdHome -Leaf).old.*" -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
    Bold "✓ Uninstalled. UI state in ~\.markdown was kept;"
    Dim  "  remove it with: Remove-Item -Recurse -Force `"$env:USERPROFILE\.markdown`""
    exit 0
}

# ── Detect arch ───────────────────────────────────────────────────────────
if (-not [Environment]::Is64BitOperatingSystem) {
    Err "32-bit Windows not supported."
    exit 1
}
$target = "windows-x64"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
    # No native windows-arm64 release yet; the x64 build runs fine under
    # Windows 11's x64 emulation.
    Dim "  Windows on ARM detected — installing the x64 build (runs emulated)."
}
Dim "  target: $target"

# ── Resolve target version ────────────────────────────────────────────────
# Prefer the releases/latest redirect — it isn't subject to the anonymous
# GitHub API rate limit. Fall back to the API.
function Resolve-LatestTag {
    try {
        $resp = Invoke-WebRequest "https://github.com/$RepoSlug/releases/latest" `
                                  -Method Head -MaximumRedirection 5 -UseBasicParsing
        $final = $resp.BaseResponse.ResponseUri  # Windows PowerShell 5.x
        if (-not $final) { $final = $resp.BaseResponse.RequestMessage.RequestUri }  # PowerShell 7+
        $tag = ([string]$final).Split("/")[-1]
        if ($tag -match "^v[0-9]") { return $tag }
    } catch {}
    try {
        $resp = Invoke-RestMethod "https://api.github.com/repos/$RepoSlug/releases/latest" `
                                  -Headers @{ "User-Agent" = "md-installer" }
        return $resp.tag_name
    } catch {
        return $null
    }
}

$latest = $PinVersion
if (-not $latest) {
    Bold "▶ Resolving latest release"
    $latest = Resolve-LatestTag
    if (-not $latest) {
        Err "Could not resolve latest release tag from $RepoSlug."
        Err "  Set `$env:MD_VERSION = 'vX.Y.Z' to pin."
        exit 1
    }
}
if (-not $latest.StartsWith("v")) { $latest = "v$latest" }

# ── Detect installed version ──────────────────────────────────────────────
$installed = ""
$installedPkgJson = Join-Path $MdHome "package.json"
if (Test-Path $installedPkgJson) {
    try {
        $installed = (Get-Content $installedPkgJson -Raw | ConvertFrom-Json).version
    } catch {}
}
if (-not $Force -and $installed) {
    $latestSemver    = [version]($latest.TrimStart("v"))
    $installedSemver = [version]($installed.TrimStart("v"))
    if ($latestSemver -le $installedSemver) {
        Bold "✓ Up to date (installed $installed, latest $latest)"
        Dim  "  Set `$env:MD_FORCE = '1' to reinstall."
        exit 0
    }
    Dim "  update: $installed → $latest"
} else {
    Dim "  installing $latest"
}

# ── Download tarball + verify sha256 ─────────────────────────────────────
$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "md-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

$base = "https://github.com/$RepoSlug/releases/download/$latest"
$url  = "$base/md-$target.tar.gz"
$tar  = Join-Path $tmpRoot "md.tar.gz"

# Streamed download with a live ■■■･･･ 42% bar (opencode-style). Throws on
# HTTP errors; the caller falls back to Invoke-WebRequest on any failure
# (older hosts, redirected console, missing System.Net.Http, …).
function Download-WithProgress {
    param([string]$Url, [string]$OutFile)

    # Windows PowerShell 5.1 needs the assembly loaded explicitly.
    try { Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue } catch {}

    $client = [System.Net.Http.HttpClient]::new()
    $client.DefaultRequestHeaders.UserAgent.ParseAdd("md-installer")
    $stream = $null
    $file = $null
    try {
        $resp = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode)" }
        $total  = $resp.Content.Headers.ContentLength
        $stream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $file   = [System.IO.File]::Create($OutFile)

        $buf = New-Object byte[] 262144
        $done = 0
        $width = 50
        $lastPct = -1
        try { [Console]::CursorVisible = $false } catch {}
        while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
            $file.Write($buf, 0, $n)
            $done += $n
            if ($total) {
                $pct = [int][math]::Min(100, ($done * 100 / $total))
                if ($pct -ne $lastPct) {
                    $on  = [int]($pct * $width / 100)
                    # "·" (U+00B7) over opencode's "･": it exists in the legacy
                    # conhost codepages, so old terminals degrade gracefully.
                    $bar = ("■" * $on) + ("·" * ($width - $on))
                    Write-Host -NoNewline ("`r$bar {0,3}%" -f $pct) -ForegroundColor DarkYellow
                    $lastPct = $pct
                }
            }
        }
        if ($lastPct -ge 0) { Write-Host "" }
    } finally {
        try { [Console]::CursorVisible = $true } catch {}
        if ($file)   { $file.Dispose() }
        if ($stream) { $stream.Dispose() }
        $client.Dispose()
    }
}

Bold "▶ Downloading $($url.Split('/')[-1])"
$downloaded = $false
if (-not [Console]::IsOutputRedirected) {
    try {
        Download-WithProgress -Url $url -OutFile $tar
        $downloaded = $true
    } catch {
        Remove-Item $tar -Force -ErrorAction SilentlyContinue
    }
}
if (-not $downloaded) {
    try {
        Invoke-WebRequest -Uri $url -OutFile $tar -UseBasicParsing
    } catch {
        Err "download failed: $url"
        Err "  release may not have $target asset"
        exit 1
    }
}

try {
    $sumUrl = "$url.sha256"
    $resp = Invoke-WebRequest -Uri $sumUrl -UseBasicParsing
    # .Content is byte[] when server sends application/octet-stream — decode.
    $sumTxt = if ($resp.Content -is [byte[]]) {
        [System.Text.Encoding]::ASCII.GetString($resp.Content)
    } else {
        [string]$resp.Content
    }
    $expected = ($sumTxt.Trim() -split '\s+')[0]
    $got = (Get-FileHash -Algorithm SHA256 -Path $tar).Hash.ToLower()
    if ($expected.ToLower() -ne $got) {
        Err "sha256 mismatch (expected $expected, got $got)"
        exit 1
    }
    Dim "  sha256 ok"
} catch {
    Dim "  sha256 file missing — skipping verify"
}

# ── Extract (tar.exe ships with Windows 10 1803+) ─────────────────────────
Bold "▶ Extracting"
Push-Location $tmpRoot
tar -xzf "md.tar.gz"
Pop-Location

$srcDir = Join-Path $tmpRoot $target
$binExe = Join-Path $srcDir "markdown.exe"
if (-not (Test-Path $binExe)) {
    Err "tarball missing $target\markdown.exe"
    exit 1
}

# `md` alias: Windows has no symlinks without elevation, so ship a shim.
Set-Content -Path (Join-Path $srcDir "md.cmd") -Value "@echo off`r`n`"%~dp0markdown.exe`" %*"

# ── Swap into place ───────────────────────────────────────────────────────
Bold "▶ Installing to $MdHome"
$parent = Split-Path $MdHome -Parent
if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

# Sweep backup dirs left by earlier updates (a running markdown.exe can't be
# deleted at update time, only renamed — by now those locks are gone).
Get-ChildItem -Path $parent -Filter "$(Split-Path $MdHome -Leaf).old.*" -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

# A running markdown.exe locks deletion but allows renames — move the old dir
# aside, place the new one, then best-effort clean.
if (Test-Path $MdHome) {
    $backup = "$MdHome.old.$(Get-Random)"
    Move-Item -Force $MdHome $backup
    try { Remove-Item -Recurse -Force $backup -ErrorAction SilentlyContinue } catch {}
}
Move-Item -Force $srcDir $MdHome

Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue

# ── Add to PATH: user (persistent) + current session (works right now) ───
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$paths = $userPath.Split(";") | Where-Object { $_ -ne "" }
if ($paths -notcontains $MdHome) {
    Bold "▶ Adding $MdHome to user PATH"
    $newPath = if ($userPath) { "$userPath;$MdHome" } else { $MdHome }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}
$sessionPaths = $env:Path.Split(";") | Where-Object { $_ -ne "" }
if ($sessionPaths -notcontains $MdHome) {
    $env:Path = "$env:Path;$MdHome"
    Dim "  PATH updated for this session too — ``markdown`` works right away."
}

# ── Smoke test: the binary must actually run ──────────────────────────────
try {
    $v = & (Join-Path $MdHome "markdown.exe") --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE`: $v" }
    Dim "  verified: markdown v$v"
} catch {
    Err "installed binary failed to run: $_"
    exit 1
}

Bold "✓ Installed $latest"
Write-Host "  markdown: $(Join-Path $MdHome 'markdown.exe')"
Write-Host "  target:   $MdHome"
Write-Host ""
Dim "Run ``markdown <file.md>`` to render, or ``markdown serve`` for the browser UI."
Dim "First-run SmartScreen warning: click 'More info' → 'Run anyway'."
