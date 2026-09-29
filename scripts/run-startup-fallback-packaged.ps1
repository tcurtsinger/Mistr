param(
    [switch]$SkipBuild,
    [int]$Port = 9344
)

# The bundled startup scan is a bridge, not a prerequisite. Launches the
# packaged app with the scan bundled, missing, and corrupt, and checks each
# launch still reaches current radar for its restored camera.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $root "src-tauri\target\release\mistr.exe"
$output = Join-Path $root "artifacts\startup-fallback"
$fallbackName = "KTLX20240520_230512_V06"

Push-Location $root
try {
    if (-not $SkipBuild) {
        npm run tauri:build -- --no-bundle
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (-not (Test-Path -LiteralPath $executable)) {
        throw "Packaged executable not found at $executable"
    }
    $missing = Join-Path $output "missing-cache"
    $corrupt = Join-Path $output "corrupt-cache"
    New-Item -ItemType Directory -Force -Path $output, $missing, $corrupt | Out-Null
    Get-ChildItem -LiteralPath $missing -File | ForEach-Object { $_.Delete() }
    [System.IO.File]::WriteAllBytes((Join-Path $corrupt $fallbackName), [byte[]](1..255))

    $cases = @(
        @{ Name = "bundled"; Cache = $null; Camera = @("-97.2778", "35.3331", "9.5") },
        @{ Name = "missing"; Cache = $missing; Camera = @("-97.2778", "35.3331", "9.5") },
        @{ Name = "corrupt"; Cache = $corrupt; Camera = @("-98.5", "39.5", "4.5") }
    )
    $previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $previousCache = $env:MISTR_PHASE4_FIXTURE_CACHE_DIR
    $failed = @()
    function Invoke-Launch([string]$Cache, [string[]]$Arguments) {
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
        $env:MISTR_CDP_PORT = "$Port"
        $env:MISTR_PHASE4_FIXTURE_CACHE_DIR = $Cache
        $process = Start-Process -FilePath $executable -WorkingDirectory $root -WindowStyle Hidden -PassThru
        try {
            node scripts/startup-fallback-cdp.mjs @Arguments | Out-Host
            return $LASTEXITCODE
        }
        finally {
            # Close the window, not the process, so the stored camera is flushed.
            if (-not $process.HasExited) {
                $null = $process.CloseMainWindow()
                if (-not $process.WaitForExit(15000)) { Stop-Process -Id $process.Id -Force }
            }
            $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
            $env:MISTR_PHASE4_FIXTURE_CACHE_DIR = $previousCache
            $env:MISTR_CDP_PORT = $null
            Start-Sleep -Seconds 2
        }
    }
    foreach ($case in $cases) {
        $primed = Invoke-Launch $null (@("prime") + $case.Camera)
        if ($primed -ne 0) { throw "Could not store the camera for $($case.Name)" }
        $checked = Invoke-Launch $case.Cache @($case.Name)
        if ($checked -ne 0) { $failed += $case.Name }
    }
    if ($failed.Count -gt 0) {
        Write-Output "FAIL: $($failed -join ', ')"
        exit 1
    }
    Write-Output "PASS: startup reaches current radar with the startup scan bundled, missing, and corrupt"
}
finally {
    Pop-Location
}
