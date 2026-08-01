param(
    [switch]$SkipBuild,
    [int]$Port = 9340,
    [ValidateRange(1, 3)][int]$RestartPasses = 2
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $root "src-tauri\target\release\mistr.exe"

Push-Location $root
try {
    npm run fixture:verify:phase4
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm run fixture:verify:phase6
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if (-not $SkipBuild) {
        npm run tauri:build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (-not (Test-Path -LiteralPath $executable)) {
        throw "Packaged executable not found at $executable"
    }

    $previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
    $env:MISTR_CDP_PORT = "$Port"
    for ($pass = 1; $pass -le $RestartPasses; $pass++) {
        $env:MISTR_PHASE6_PASS = "$pass"
        $process = Start-Process -FilePath $executable -WorkingDirectory $root -WindowStyle Hidden -PassThru
        try {
            node scripts/phase6-packaged-cdp.mjs
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        finally {
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force
                $process.WaitForExit()
            }
        }
        Start-Sleep -Milliseconds 750
    }
}
finally {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
    Remove-Item Env:MISTR_CDP_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:MISTR_PHASE6_PASS -ErrorAction SilentlyContinue
    Pop-Location
}
