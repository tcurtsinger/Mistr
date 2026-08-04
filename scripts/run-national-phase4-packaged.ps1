param(
    [switch]$SkipBuild,
    [switch]$ChromeOnly,
    [int]$Port = 9344
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
    $previousChromeOnly = $env:MISTR_NATIONAL_CHROME_ONLY
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
    $env:MISTR_CDP_PORT = "$Port"
    if ($ChromeOnly) { $env:MISTR_NATIONAL_CHROME_ONLY = "1" }
    else { Remove-Item Env:MISTR_NATIONAL_CHROME_ONLY -ErrorAction SilentlyContinue }
    $process = Start-Process -FilePath $executable -WorkingDirectory $root -WindowStyle Hidden -PassThru
    try {
        node scripts/national-phase4-packaged-cdp.mjs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit()
        }
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
        if ($null -eq $previousChromeOnly) { Remove-Item Env:MISTR_NATIONAL_CHROME_ONLY -ErrorAction SilentlyContinue }
        else { $env:MISTR_NATIONAL_CHROME_ONLY = $previousChromeOnly }
        Remove-Item Env:MISTR_CDP_PORT -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
