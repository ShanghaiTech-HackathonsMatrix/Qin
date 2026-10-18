# Generates the small widget texture without an external model or image service.
Add-Type -AssemblyName System.Drawing
$haloBitmap = [System.Drawing.Bitmap]::new(120, 120)
try {
    for ($haloY = 0; $haloY -lt 120; $haloY++) {
        for ($haloX = 0; $haloX -lt 120; $haloX++) {
            $haloRadius = [Math]::Sqrt([Math]::Pow($haloX - 59.5, 2) + [Math]::Pow($haloY - 59.5, 2))
            $haloDistance = $haloRadius - 40
            $haloCore = [Math]::Exp(-$haloDistance * $haloDistance / 7)
            $haloGlow = [Math]::Exp(-$haloDistance * $haloDistance / 95)
            $haloAlpha = [Math]::Min(255, [Math]::Round(235 * $haloCore + 120 * $haloGlow))
            $haloColor = [System.Drawing.Color]::FromArgb([int]$haloAlpha, [int](35 + 175 * $haloCore), [int](200 + 50 * $haloCore), 255)
            $haloBitmap.SetPixel($haloX, $haloY, $haloColor)
        }
    }
    $haloPath = Join-Path $PSScriptRoot 'Widget/Assets.xcassets/MatrixRefreshHalo.imageset/halo.png'
    $haloBitmap.Save($haloPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $haloBitmap.Dispose()
}
