param(
    [switch]$SkipBuild,
    [int]$Port = 9344
)

# A launch paints current radar for its restored camera and no bundled
# archive scan; a fresh profile opens National. Each case follows a separate
# launch that stores (or clears) its camera.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $root "src-tauri\target\release\mistr.exe"

Push-Location $root
try {
    if (-not $SkipBuild) {
        npm run tauri:build -- --no-bundle
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (-not (Test-Path -LiteralPath $executable)) {
        throw "Packaged executable not found at $executable"
    }
    $ktlx = @("-97.2778", "35.3331", "9.5")
    $country = @("-98.5", "39.5", "4.5")
    $cases = @(
        @{ Name = "fresh"; Camera = @("clear") },
        @{ Name = "national"; Camera = $country },
        @{ Name = "site"; Camera = $ktlx },
        @{ Name = "reload"; Camera = $ktlx },
        @{ Name = "kfws"; Camera = @("-97.3031", "32.5731", "9.5") },
        @{ Name = "national-archive"; Camera = $country }
    )
    $previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $failed = @()
    function Invoke-Launch([string[]]$Arguments) {
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
        $env:MISTR_CDP_PORT = "$Port"
        $process = Start-Process -FilePath $executable -WorkingDirectory $root -WindowStyle Hidden -PassThru
        try {
            node scripts/startup-cdp.mjs @Arguments | Out-Host
            return $LASTEXITCODE
        }
        finally {
            # Close the window, not the process, so the stored camera is flushed.
            if (-not $process.HasExited) {
                $null = $process.CloseMainWindow()
                if (-not $process.WaitForExit(15000)) { Stop-Process -Id $process.Id -Force }
            }
            $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
            $env:MISTR_CDP_PORT = $null
            Start-Sleep -Seconds 2
        }
    }
    foreach ($case in $cases) {
        $primed = Invoke-Launch (@("prime") + $case.Camera)
        if ($primed -ne 0) { throw "Could not store the camera for $($case.Name)" }
        $checked = Invoke-Launch @($case.Name)
        if ($checked -ne 0) { $failed += $case.Name }
    }
    if ($failed.Count -gt 0) {
        Write-Output "FAIL: $($failed -join ', ')"
        exit 1
    }
    Write-Output "PASS: every launch reaches current radar for its camera with no bundled scan, a fresh profile opens National, and diagnostics hydrate the archive loop"
}
finally {
    Pop-Location
}
