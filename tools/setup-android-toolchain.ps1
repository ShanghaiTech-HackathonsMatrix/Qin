# 下载并安装 Android 构建工具链到 D:\android-toolchain（不改动系统 PATH / 注册表）
#
# 用法：powershell -ExecutionPolicy Bypass -File tools/setup-android-toolchain.ps1
#
# 幂等：已装好的组件会跳过；下载文件会做 zip 完整性校验，残缺则自动重下。
#
# 踩过的坑（都已在下面处理）：
#   1. 脚本含中文 → PS 5.1 按 ANSI 读无 BOM 的 UTF-8 会解析失败，必须带 BOM
#   2. PS 5.1 的 Invoke-WebRequest 拉大文件很慢 → 改用 curl.exe
#   3. 镜像差异巨大：GitHub 资产约 0.06 MB/s，清华镜像约 7.9 MB/s
#   4. $ErrorActionPreference='Stop' 下原生命令写 stderr 会中断脚本 → Invoke-Native
#   5. 子作用域不会把 $LASTEXITCODE 传回调用方 → Invoke-Native 显式返回退出码

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root   = 'D:\android-toolchain'
$JdkDir = Join-Path $Root 'jdk-21'
$SdkDir = Join-Path $Root 'sdk'
$DlDir  = Join-Path $Root 'downloads'

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Info($m) { Write-Host "  ... $m" }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 基础工具

Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force -Path $Root, $DlDir, $SdkDir | Out-Null

<#
  调用外部程序，返回 @{ Out = 文本; Code = 退出码 }。

  PS 5.1 在 $ErrorActionPreference='Stop' 下，原生命令只要往 stderr 写任何东西
  （java -version、curl 的重试提示、sdkmanager 的进度…）就会被当成终止错误。
  这里临时切回 Continue，并把退出码显式带回 —— 子作用域的 $LASTEXITCODE
  不会自动传回调用方。
#>
function Invoke-Native {
  param([string]$Exe, [string[]]$Argv = @())
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Exe @Argv 2>&1 | Out-String
    return [pscustomobject]@{ Out = $out.Trim(); Code = $LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Test-Zip($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  if ((Get-Item -LiteralPath $path).Length -le 0) { return $false }
  try {
    $z = [System.IO.Compression.ZipFile]::OpenRead($path)
    $n = $z.Entries.Count
    $z.Dispose()
    return ($n -gt 0)
  } catch {
    return $false
  }
}

# 按优先级尝试多个源；只有 zip 校验通过才算成功
function Get-File($urls, $dest) {
  if (Test-Zip $dest) {
    $sz = (Get-Item -LiteralPath $dest).Length
    Info "已存在且完整，跳过下载: $(Split-Path $dest -Leaf)  ($([math]::Round($sz / 1MB, 1)) MB)"
    return
  }
  if (Test-Path -LiteralPath $dest) {
    Warn "已有文件不完整（$([math]::Round((Get-Item -LiteralPath $dest).Length / 1MB, 1)) MB），删除重下"
    Remove-Item -LiteralPath $dest -Force
  }

  if ($urls -is [string]) { $urls = @($urls) }

  foreach ($u in $urls) {
    Info "下载 $u"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Native 'curl.exe' @(
      '-L', '--fail', '--retry', '2', '--retry-delay', '2',
      '--connect-timeout', '30', '--max-time', '3600', '-sS', '-o', $dest, $u
    )
    $sw.Stop()

    if ($r.Code -eq 0 -and (Test-Zip $dest)) {
      $len = (Get-Item -LiteralPath $dest).Length
      Ok "$(Split-Path $dest -Leaf)  $([math]::Round($len / 1MB, 1)) MB  用时 $([math]::Round($sw.Elapsed.TotalSeconds, 1))s"
      return
    }

    Warn "该源失败 (exit $($r.Code))，换下一个源"
    if ($r.Out) { Info $r.Out }
    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
  }

  throw "所有候选源都下载失败: $($urls -join ' , ')"
}

function Expand-Zip($zip, $dest) {
  Info "解压 $(Split-Path $zip -Leaf) → $dest"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
  Ok '解压完成'
}

# ---------------------------------------------------------------- 1. JDK 21

Step '1/4  Temurin JDK 21'
if (Test-Path -LiteralPath (Join-Path $JdkDir 'bin\javac.exe')) {
  Ok 'JDK 21 已就绪'
} else {
  $jdkZip = Join-Path $DlDir 'temurin21.zip'
  # 镜像优先：实测 GitHub 资产约 0.06 MB/s，清华镜像约 7.9 MB/s
  # 注意：镜像上的文件名带具体版本号，升级 JDK 时要同步改这里
  Get-File @(
    'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
    'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse'
  ) $jdkZip

  $tmp = Join-Path $Root '_jdk_tmp'
  if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  Expand-Zip $jdkZip $tmp

  # zip 内是一层 jdk-21.x.y+z 目录，拍平到 $JdkDir
  $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  if (-not $inner) { throw "解压后没找到 JDK 目录: $tmp" }
  if (Test-Path $JdkDir) { Remove-Item -LiteralPath $JdkDir -Recurse -Force }
  Move-Item -LiteralPath $inner.FullName -Destination $JdkDir
  Remove-Item -LiteralPath $tmp -Recurse -Force

  if (-not (Test-Path (Join-Path $JdkDir 'bin\javac.exe'))) { throw 'JDK 安装后仍找不到 javac' }
  Ok "JDK 21 → $JdkDir"
}
$jv = Invoke-Native (Join-Path $JdkDir 'bin\java.exe') @('-version')
Info (($jv.Out -split "`n")[0])

# ---------------------------------------------------------------- 2. cmdline-tools

Step '2/4  Android cmdline-tools'
$SmDir = Join-Path $SdkDir 'cmdline-tools\latest'
$SdkManager = Join-Path $SmDir 'bin\sdkmanager.bat'

if (Test-Path -LiteralPath $SdkManager) {
  Ok 'cmdline-tools 已就绪'
} else {
  Info '解析 repository2-3.xml 取最新 commandlinetools-win 包'
  $xml = [xml](Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/repository2-3.xml' `
                                 -UseBasicParsing -TimeoutSec 120).Content
  # 根元素名是 sdk-repository（带连字符），必须加引号才能点号访问
  $pkg = $xml.'sdk-repository'.remotePackage | Where-Object { $_.path -eq 'cmdline-tools;latest' }
  if (-not $pkg) { throw '在 repository2-3.xml 中找不到 cmdline-tools;latest' }

  $url = $pkg.archives.archive |
         Where-Object { $_.'host-os' -eq 'windows' } |
         ForEach-Object { $_.complete.url } |
         Select-Object -First 1
  if (-not $url) { throw '找不到 windows 版 cmdline-tools 归档' }
  if ($url -notmatch '^https?://') { $url = 'https://dl.google.com/android/repository/' + $url }
  Info "包地址: $url"

  $ctZip = Join-Path $DlDir 'cmdline-tools.zip'
  Get-File $url $ctZip

  $tmp = Join-Path $Root '_ct_tmp'
  if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  Expand-Zip $ctZip $tmp

  # zip 内是 cmdline-tools/，需要变成 <sdk>/cmdline-tools/latest/
  $inner = Join-Path $tmp 'cmdline-tools'
  if (-not (Test-Path $inner)) {
    $inner = (Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $SmDir -Parent) | Out-Null
  if (Test-Path $SmDir) { Remove-Item -LiteralPath $SmDir -Recurse -Force }
  Move-Item -LiteralPath $inner -Destination $SmDir
  Remove-Item -LiteralPath $tmp -Recurse -Force
  Ok "cmdline-tools → $SmDir"
}

# ---------------------------------------------------------------- 3. SDK 包

Step '3/4  Android SDK 包'
$env:JAVA_HOME        = $JdkDir
$env:ANDROID_HOME     = $SdkDir
$env:ANDROID_SDK_ROOT = $SdkDir

<#
  重要：cmdline-tools 23.0.0 起，sdkmanager.bat 已被**弃用**，它把工作转交给新的
  Android CLI（cmdline-tools/latest/bin/android.exe）。实测其转交是坏的 ——
  `sdkmanager "platforms;android-36"` 会返回 exit 0 并打印 "已安装"，
  但磁盘上什么都没落地，只有 `android sdk install` 才真正生效。

  所以这里直接调用新的 android.exe。sdkmanager 作为旧版 cmdline-tools 的兜底。
#>
$AndroidCli = Join-Path $SmDir 'bin\android.exe'

function Invoke-SdkTool {
  param([string[]]$Argv)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if (Test-Path -LiteralPath $AndroidCli) {
      $out = & $AndroidCli "--sdk=$SdkDir" 'sdk' 'install' @Argv 2>&1 | Out-String
    } else {
      # 旧版：需要从 stdin 反复喂 'y' 接受许可
      $yes = ((1..400) | ForEach-Object { 'y' }) -join "`n"
      $out = $yes | & $SdkManager "--sdk_root=$SdkDir" @Argv 2>&1 | Out-String
    }
    return [pscustomobject]@{ Out = $out.Trim(); Code = $LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $prev
  }
}

foreach ($p in @('platform-tools', 'platforms;android-36', 'build-tools;36.0.0')) {
  Info "安装 $p"
  $r = Invoke-SdkTool @($p)
  if ($r.Code -ne 0) {
    ($r.Out -split "`n" | Select-Object -Last 8) | ForEach-Object { if ($_.Trim()) { Info $_.Trim() } }
    throw "安装 $p 失败 (exit $($r.Code))"
  }
  Ok "$p 已安装"
}

# ---------------------------------------------------------------- 4. 校验

Step '4/4  校验'
$checks = [ordered]@{
  'javac'       = Join-Path $JdkDir 'bin\javac.exe'
  'sdkmanager'  = $SdkManager
  'adb'         = Join-Path $SdkDir 'platform-tools\adb.exe'
  'android-36'  = Join-Path $SdkDir 'platforms\android-36\android.jar'
  'build-tools' = Join-Path $SdkDir 'build-tools\36.0.0\aapt2.exe'
}
$allOk = $true
foreach ($k in $checks.Keys) {
  if (Test-Path -LiteralPath $checks[$k]) {
    Ok $k
  } else {
    Write-Host "  [MISSING] $k → $($checks[$k])" -ForegroundColor Red
    $allOk = $false
  }
}

Write-Host "`n----------------------------------------" -ForegroundColor Cyan
if ($allOk) {
  Write-Host '工具链就绪' -ForegroundColor Green
  Write-Host "JAVA_HOME    = $JdkDir"
  Write-Host "ANDROID_HOME = $SdkDir"
  exit 0
}
Write-Host '工具链不完整' -ForegroundColor Red
exit 1
