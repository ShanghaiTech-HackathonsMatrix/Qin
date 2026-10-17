# 构建 Matrix Android APK
#
# 用法：powershell -ExecutionPolicy Bypass -File tools/build-apk.ps1 [-Variant debug|release] [-NoInternet]
#
# 依次完成：前置检查 → vite build → cap sync → gradle assemble → 收集 APK 到 dist-apk/
#
# 同 setup-android-toolchain.ps1：脚本含中文，PS 5.1 需要 BOM 才能正确解析。

param(
  [ValidateSet('debug', 'release')]
  [string]$Variant = 'debug',

  # 构建时临时移除 android.permission.INTERNET，用于在真机上验证
  # 「应用不依赖任何网络权限」这条设计主张。产物名为 matrix-nonet.apk。
  [switch]$NoInternet
)

$ErrorActionPreference = 'Stop'

$Root       = Split-Path -Parent $PSScriptRoot
$AppDir     = Join-Path $Root 'apps\shell'
$AndroidDir = Join-Path $AppDir 'android'
$OutDir     = Join-Path $Root 'dist-apk'
$Manifest   = Join-Path $AndroidDir 'app\src\main\AndroidManifest.xml'

$ToolRoot = 'D:\android-toolchain'
$JdkDir   = Join-Path $ToolRoot 'jdk-21'
$SdkDir   = Join-Path $ToolRoot 'sdk'

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }

# 见 setup-android-toolchain.ps1 里的说明：原生命令写 stderr 会打断 Stop 模式
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

function Show($text, $tail = 25) {
  if (-not $text) { return }
  ($text -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last $tail) |
    ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

# ---------------------------------------------------------------- 0. 前置检查

Step '0/4  前置检查'

if (-not (Test-Path -LiteralPath (Join-Path $JdkDir 'bin\javac.exe'))) {
  throw "JDK 21 未就绪：$JdkDir`n先运行 tools/setup-android-toolchain.ps1"
}
if (-not (Test-Path -LiteralPath (Join-Path $SdkDir 'platforms\android-36\android.jar'))) {
  throw "Android SDK (platform 36) 未就绪：$SdkDir`n先运行 tools/setup-android-toolchain.ps1"
}
if (-not (Test-Path -LiteralPath (Join-Path $AndroidDir 'gradlew.bat'))) {
  throw 'android 工程不存在，先在 apps/shell 里跑 npx cap add android'
}

# 本项目自带工具链，不改动系统 PATH / JAVA_HOME
$env:JAVA_HOME        = $JdkDir
$env:ANDROID_HOME     = $SdkDir
$env:ANDROID_SDK_ROOT = $SdkDir
$env:PATH             = "$JdkDir\bin;$SdkDir\platform-tools;$env:PATH"

Ok "JAVA_HOME    = $JdkDir"
Ok "ANDROID_HOME = $SdkDir"
$jv = Invoke-Native (Join-Path $JdkDir 'bin\javac.exe') @('-version')
Ok "javac $($jv.Out)"

# ---------------------------------------------------------------- 1~2. 前端 + 同步

Step '1/4  构建前端（vite build）'
Push-Location $AppDir
try {
  $r = Invoke-Native 'npm.cmd' @('run', 'build')
  Show $r.Out 18
  if ($r.Code -ne 0) { throw "vite build 失败 (exit $($r.Code))" }
  Ok 'vite build 完成'

  Step '2/4  同步到 Android 工程（cap sync）'
  $r2 = Invoke-Native 'npx.cmd' @('cap', 'sync', 'android')
  Show $r2.Out 20
  if ($r2.Code -ne 0) { throw "cap sync 失败 (exit $($r2.Code))" }
  Ok 'cap sync 完成'
} finally {
  Pop-Location
}

# ---------------------------------------------------------------- 3. Gradle

$manifestBackup = $null
if ($NoInternet) {
  # 临时摘掉 INTERNET 权限，构建完立即还原。
  # 用 .NET 写文件而不是 Set-Content：PS 5.1 的 -Encoding UTF8 会写 BOM，
  # 带 BOM 的 AndroidManifest.xml 会让 manifest merger 出错。
  Copy-Item -LiteralPath $Manifest -Destination "$Manifest.nonet-bak" -Force
  $manifestBackup = "$Manifest.nonet-bak"

  $text = [System.IO.File]::ReadAllText($Manifest, [System.Text.UTF8Encoding]::new($false))
  $patched = [regex]::Replace(
    $text,
    '\s*<uses-permission\s+android:name="android\.permission\.INTERNET"\s*/>',
    ''
  )
  if ($patched -eq $text) { Warn '未在清单里找到 INTERNET 权限，可能已移除' }
  [System.IO.File]::WriteAllText($Manifest, $patched, [System.Text.UTF8Encoding]::new($false))
  Ok '已临时移除 android.permission.INTERNET'
}

try {
  Step "3/4  Gradle assemble（$Variant）"
  $task = if ($Variant -eq 'release') { 'assembleRelease' } else { 'assembleDebug' }

  Push-Location $AndroidDir
  try {
    # --no-daemon：本机可用内存偏紧，不留常驻 JVM
    $r3 = Invoke-Native '.\gradlew.bat' @($task, '--no-daemon', '--console=plain')
    Show $r3.Out 60
    if ($r3.Code -ne 0) { throw "gradle $task 失败 (exit $($r3.Code))" }
    Ok "gradle $task 完成"
  } finally {
    Pop-Location
  }
} finally {
  if ($manifestBackup -and (Test-Path -LiteralPath $manifestBackup)) {
    Move-Item -LiteralPath $manifestBackup -Destination $Manifest -Force
    Ok 'AndroidManifest.xml 已还原'
  }
}

# ---------------------------------------------------------------- 4. 产物

Step '4/4  收集产物'
$apk = Join-Path $AndroidDir "app\build\outputs\apk\$Variant\app-$Variant.apk"
if (-not (Test-Path -LiteralPath $apk)) { throw "找不到 APK：$apk" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$name = if ($NoInternet) { 'matrix-nonet.apk' } else { "matrix-$Variant.apk" }
$dest = Join-Path $OutDir $name
Copy-Item -LiteralPath $apk -Destination $dest -Force

$sizeMb = [math]::Round((Get-Item -LiteralPath $dest).Length / 1MB, 2)
Ok "APK: $dest  ($sizeMb MB)"

# 顺带核对产物里的权限，避免"以为改了其实没改"
$bt = Join-Path $SdkDir 'build-tools\36.0.0\aapt2.exe'
if (Test-Path -LiteralPath $bt) {
  $badge = Invoke-Native $bt @('dump', 'badging', $dest)
  $perms = ($badge.Out -split "`n" | Where-Object { $_ -match '^uses-permission' }) -join ' , '
  Ok "权限: $perms"
}

Write-Host "`n----------------------------------------" -ForegroundColor Cyan
Write-Host '构建完成' -ForegroundColor Green
Write-Host "安装到已连接的手机：`"$SdkDir\platform-tools\adb.exe`" install -r `"$dest`""
Write-Host '或把 APK 传到手机手动安装（需允许安装未知来源应用）'
exit 0
