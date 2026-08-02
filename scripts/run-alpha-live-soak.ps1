param(
    [switch]$SkipBuild,
    [ValidateRange(4, 20)][int]$Frames = 4,
    [ValidateRange(900, 7200)][int]$TimeoutSeconds = 2700,
    [int]$Port = 9341
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $root "src-tauri\target\release\mistr.exe"

Push-Location $root
try {
    npm run fixture:verify:phase4
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if (-not $SkipBuild) {
        npm run tauri:build -- --no-bundle
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (-not (Test-Path -LiteralPath $executable)) {
        throw "Packaged executable not found at $executable"
    }

    $previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
    $env:MISTR_CDP_PORT = "$Port"
    $env:MISTR_ALPHA_SOAK_FRAMES = "$Frames"
    $env:MISTR_ALPHA_SOAK_TIMEOUT_SECONDS = "$TimeoutSeconds"
    $process = Start-Process -FilePath $executable -WorkingDirectory $root -WindowStyle Hidden -PassThru
    try {
        node scripts/alpha-live-soak-cdp.mjs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit()
        }
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
        Remove-Item Env:MISTR_CDP_PORT -ErrorAction SilentlyContinue
        Remove-Item Env:MISTR_ALPHA_SOAK_FRAMES -ErrorAction SilentlyContinue
        Remove-Item Env:MISTR_ALPHA_SOAK_TIMEOUT_SECONDS -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
