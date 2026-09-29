param([string]$Label = "run", [int]$Runs = 2, [int]$Port = 9344)
# Launches the release app fresh for each run and records the National load and
# regional-playback benchmark. Build first: npm run tauri:build -- --no-bundle.
# A priming launch first stores National as the start source.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $root "src-tauri\target\release\mistr.exe"
if (-not (Test-Path -LiteralPath $executable)) { throw "Release executable not found at $executable" }
# Run 0 only primes the start source; runs 1..n are measured.
for ($run = 0; $run -le $Runs; $run++) {
    Get-Process mistr -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
    $env:MISTR_CDP_PORT = "$Port"
    $process = Start-Process -FilePath $executable -WorkingDirectory $root -PassThru
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
    try {
        for ($i = 0; $i -lt 100; $i++) {
            try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/json/list" -TimeoutSec 1 | Out-Null; break }
            catch { Start-Sleep -Milliseconds 100 }
        }
        Start-Sleep -Seconds 2
        $runLabel = if ($run -eq 0) { "--prime" } else { "$Label-$run" }
        node (Join-Path $PSScriptRoot "national-load-bench.mjs") $runLabel
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        # Close the window, not the process, so the stored camera is flushed.
        if (-not $process.HasExited) {
            $null = $process.CloseMainWindow()
            if (-not $process.WaitForExit(15000)) { Stop-Process -Id $process.Id -Force }
        }
        Remove-Item Env:MISTR_CDP_PORT -ErrorAction SilentlyContinue
    }
}
