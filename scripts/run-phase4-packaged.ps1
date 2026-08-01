param(
    [switch]$SkipBuild,
    [int]$Port = 9337
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
        node scripts/phase4-packaged-cdp.mjs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Start-Sleep -Seconds 3
        $allProcesses = Get-CimInstance Win32_Process
        $treeIds = [System.Collections.Generic.HashSet[int]]::new()
        [void]$treeIds.Add($process.Id)
        do {
            $priorCount = $treeIds.Count
            foreach ($candidate in $allProcesses) {
                if ($treeIds.Contains([int]$candidate.ParentProcessId)) {
                    [void]$treeIds.Add([int]$candidate.ProcessId)
                }
            }
        } while ($treeIds.Count -gt $priorCount)
        $tree = @(Get-Process | Where-Object { $treeIds.Contains($_.Id) })
        $memory = [pscustomobject]@{
            capturedAt = (Get-Date).ToUniversalTime().ToString("o")
            rootPid = $process.Id
            processCount = $tree.Count
            workingSetBytes = ($tree | Measure-Object WorkingSet64 -Sum).Sum
            privateBytes = ($tree | Measure-Object PrivateMemorySize64 -Sum).Sum
            processes = @($tree | Select-Object Id, ProcessName, WorkingSet64, PrivateMemorySize64)
        }
        $memory | ConvertTo-Json -Depth 5 | Set-Content "artifacts\phase-4\packaged-process-memory.json"
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
