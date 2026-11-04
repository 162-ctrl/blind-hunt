# 《盲猎》一键更新并上传
# 用法：双击项目根目录的「更新并上传.bat」
#   或命令行：powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1
#   可选参数：-Message "这次改了什么"
param(
    [string]$Message = "",
    [switch]$SkipDist
)

# 用 Continue：git 的原生 stderr 在 Windows PowerShell 5.1 里会变成 ErrorRecord，
# 用 Stop 会误判为致命错误；每一步都显式检查 $LASTEXITCODE / 显式 throw。
$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Step($text) { Write-Host "`n== $text ==" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !   $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "  X   $text" -ForegroundColor Red }

Write-Host ''
Write-Host '  《盲猎》更新并上传' -ForegroundColor White
Write-Host '  ------------------------------' -ForegroundColor DarkGray

# ---------- 1. 代理（GitHub 直连会超时，必须走系统代理） ----------
Step '检查网络代理'
$proxy = $null
try {
    $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    if ($ie.ProxyEnable -eq 1 -and $ie.ProxyServer) { $proxy = 'http://' + $ie.ProxyServer }
} catch { }
if (-not $proxy) {
    # 系统代理开关被关掉、但代理软件仍在监听时，也直接用它
    $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($probe) { $proxy = 'http://127.0.0.1:7897'; Ok '系统代理未开启，但检测到 127.0.0.1:7897 在监听，使用它' }
}
if ($proxy) {
    $env:HTTP_PROXY = $proxy
    $env:HTTPS_PROXY = $proxy
    Ok "使用代理 $proxy"
} else {
    Warn '没检测到系统代理。git push 可能连不上，会自动改用 GitHub API 备用通道'
}

# 解析 node（打包与 API 备用通道都要用）
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
elseif (Test-Path 'D:\node.exe') { $node = 'D:\node.exe' }

# ---------- 2. 检查仓库 ----------
Step '检查仓库'
if (-not (Test-Path (Join-Path $repoRoot '.git'))) { throw "这里不是 git 仓库：$repoRoot" }
$remote = (git remote get-url origin 2>$null)
if (-not $remote) { throw '没有配置 origin 远端' }
Ok "远端 $remote"

# ---------- 3. 重新打包单文件版（方便离线分享） ----------
if (-not $SkipDist) {
    Step '打包单文件版（dist\盲猎.html）'
    if ($node) {
        & $node (Join-Path $repoRoot 'tools\build-dist.mjs') | Out-Null
        if ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $repoRoot 'dist\盲猎.html'))) {
            $kb = [math]::Round((Get-Item (Join-Path $repoRoot 'dist\盲猎.html')).Length / 1KB, 1)
            Ok "单文件版已更新：dist\盲猎.html（$kb KB）"
        } else {
            Warn '单文件版打包失败（不影响上传，可忽略）'
        }
    } else {
        Warn '没找到 node，跳过单文件打包'
    }
}

# ---------- 4. 收集改动并提交 ----------
Step '收集改动'
git add -A
if ($LASTEXITCODE -ne 0) { throw 'git add 失败' }
$staged = @(git diff --cached --name-only)
if ($staged.Count -gt 0) {
    Write-Host ('  本次改动 ' + $staged.Count + ' 个文件：') -ForegroundColor Gray
    $staged | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    if ($staged.Count -gt 20) { Write-Host ('    ... 还有 ' + ($staged.Count - 20) + ' 个') -ForegroundColor Gray }

    if (-not $Message) { $Message = '更新：' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
    git commit -m $Message | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'git commit 失败' }
    Ok "已提交：$Message"
} else {
    Ok '没有新改动，检查是否有之前没上传成功的提交'
}

# ---------- 5. 推送 ----------
Step '推送到 GitHub'
$pushed = $false
$pushOut = @(git push origin main 2>&1)
$pushText = ($pushOut -join "`n")
if ($LASTEXITCODE -eq 0) {
    if ($pushText -match 'Everything up-to-date') {
        Ok '已是最新，GitHub 上就是当前版本'
    } else {
        Ok '已推送'
    }
    $pushed = $true
} else {
    Write-Host $pushText -ForegroundColor DarkGray
    Warn 'git push 连不上 github.com（常见于代理没开），尝试 API 备用通道…'
    if ($node -and (Test-Path (Join-Path $repoRoot 'tools\push-api.mjs'))) {
        & $node (Join-Path $repoRoot 'tools\push-api.mjs') $Message
        if ($LASTEXITCODE -eq 0) {
            Ok '已通过 GitHub API 上传（内容与 git push 等价，Pages 会自动重建）'
            Write-Host '      （本地 git 历史与远端会略有分叉，内容一致；以后继续用本脚本上传即可）' -ForegroundColor DarkGray
            $pushed = $true
        }
    }
    if (-not $pushed) {
        Fail '上传失败。常见原因与解决：'
        Write-Host '   1) 代理没开 / 端口变了：先启动代理软件（通常 127.0.0.1:7897），再双击本脚本' -ForegroundColor Yellow
        Write-Host '   2) GitHub 登录过期：运行下面的命令重新授权，再双击本脚本' -ForegroundColor Yellow
        Write-Host '      & "C:\Program Files\GitHub CLI\gh.exe" auth login --hostname github.com --git-protocol https --web' -ForegroundColor Gray
        Write-Host '   3) 网络抖动：过一会儿再双击一次' -ForegroundColor Yellow
        exit 1
    }
}

# ---------- 6. 结果 ----------
Write-Host ''
Write-Host '  完成。' -ForegroundColor Green
Write-Host '  在线版（1~2 分钟后自动重建完成）：' -ForegroundColor White
Write-Host '    https://162-ctrl.github.io/blind-hunt/' -ForegroundColor Cyan
Write-Host '  源码仓库：' -ForegroundColor White
Write-Host '    https://github.com/162-ctrl/blind-hunt' -ForegroundColor Cyan
Write-Host ''
