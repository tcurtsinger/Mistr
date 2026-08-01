param(
    [switch]$SkipBuild,
    [int]$Port = 9338
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
    $process = Start-Process -FilePath $executable -WorkingDirectory $root -WindowStyle Hidden -PassThru
    try {
        node scripts/phase5-packaged-cdp.mjs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit()
        }
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
        Remove-Item Env:MISTR_CDP_PORT -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
