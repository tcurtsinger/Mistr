param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outputRoot = [IO.Path]::GetFullPath((Join-Path $root "artifacts\alpha-release\installer"))
$sessionRoot = [IO.Path]::GetFullPath((Join-Path $outputRoot ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString())))
$reportPath = Join-Path $outputRoot "installer-report.json"
$report = [ordered]@{
    status = "FAIL"
    startedAt = [DateTimeOffset]::UtcNow.ToString("o")
    bundles = @()
    nsis = $null
    msi = $null
    cleanMachine = [ordered]@{
        status = "SEPARATE_GATE"
        reason = "Local install mechanics are not clean-machine evidence; run test:alpha:clean-machine separately."
    }
    unsignedMessaging = [ordered]@{
        status = "MANUAL_REQUIRED"
        reason = "Authenticode status is measured, but Windows warning copy depends on download origin and must be inspected interactively."
    }
    failures = @()
}

function Get-MistrInstallations {
    $roots = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    return @(Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "Mistr" })
}

function Invoke-CheckedProcess([string]$FilePath, [string[]]$Arguments, [string]$Label) {
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -notin @(0, 3010)) {
        throw "$Label exited with code $($process.ExitCode)"
    }
    return $process.ExitCode
}

function Test-PackagedLaunch([string]$Executable, [string]$WorkingDirectory, [int]$Port) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        throw "Installed Mistr executable was not found at $Executable"
    }
    $previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
    $env:MISTR_CDP_PORT = "$Port"
    $process = Start-Process -FilePath $Executable -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
    try {
        & node scripts/alpha-installed-smoke-cdp.mjs | Out-Host
        $smokeExitCode = $LASTEXITCODE
        if ($smokeExitCode -ne 0) { throw "Installed first-launch smoke failed" }
        return $true
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

function Assert-SessionPath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = $sessionRoot + [IO.Path]::DirectorySeparatorChar
    if ($resolved -ne $sessionRoot -and -not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Installer escaped the dedicated validation directory: $resolved"
    }
    return $resolved
}

New-Item -ItemType Directory -Force -Path $outputRoot, $sessionRoot | Out-Null
if (@(Get-MistrInstallations).Count -ne 0) {
    throw "A Mistr installation already exists. Installer validation will not modify it."
}

Push-Location $root
try {
    if (-not $SkipBuild) {
        npm run tauri:build
        if ($LASTEXITCODE -ne 0) { throw "Tauri bundle build failed" }
    }

    $configuration = Get-Content -LiteralPath "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
    $version = $configuration.version
    $nsis = Join-Path $root "src-tauri\target\release\bundle\nsis\Mistr_${version}_x64-setup.exe"
    $msi = Join-Path $root "src-tauri\target\release\bundle\msi\Mistr_${version}_x64_en-US.msi"
    $previousNsis = Join-Path $root "artifacts\alpha-release\installer\baseline-0.0.1\Mistr_0.0.1_x64-setup.exe"
    $previousMsi = Join-Path $root "artifacts\alpha-release\installer\baseline-0.0.1\Mistr_0.0.1_x64_en-US.msi"
    foreach ($bundle in @($nsis, $msi)) {
        if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) { throw "Missing bundle: $bundle" }
        $item = Get-Item -LiteralPath $bundle
        $signature = Get-AuthenticodeSignature -FilePath $bundle
        $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $bundle
        $report.bundles += [ordered]@{
            name = $item.Name
            bytes = $item.Length
            sha256 = $hash.Hash
            authenticode = $signature.Status.ToString()
        }
        if ($signature.Status -ne "NotSigned") {
            throw "Local Alpha bundle signature state changed unexpectedly: $($signature.Status)"
        }
    }

    $nsisRoot = Assert-SessionPath (Join-Path $sessionRoot "nsis")
    $nsisUpdated = $false
    if (Test-Path -LiteralPath $previousNsis -PathType Leaf) {
        Invoke-CheckedProcess $previousNsis @("/S", "/D=$nsisRoot") "previous NSIS install" | Out-Null
        $nsisUpdated = $true
    }
    Invoke-CheckedProcess $nsis @("/S", "/D=$nsisRoot") "NSIS install" | Out-Null
    $nsisExecutable = Join-Path $nsisRoot "mistr.exe"
    $nsisLaunch = Test-PackagedLaunch $nsisExecutable $nsisRoot 9343
    $nsisUninstaller = Join-Path $nsisRoot "uninstall.exe"
    if (-not (Test-Path -LiteralPath $nsisUninstaller -PathType Leaf)) {
        throw "NSIS uninstaller was not created"
    }
    Invoke-CheckedProcess $nsisUninstaller @("/S") "NSIS uninstall" | Out-Null
    if (Test-Path -LiteralPath $nsisExecutable) { throw "NSIS uninstall left the application executable behind" }
    $nsisRegistrationDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    do {
        $remainingNsisRegistrations = @(Get-MistrInstallations)
        if ($remainingNsisRegistrations.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $nsisRegistrationDeadline)
    if ($remainingNsisRegistrations.Count -ne 0) { throw "NSIS uninstall left its registration behind" }
    $report.nsis = [ordered]@{ install = "PASS"; updateFrom001 = $nsisUpdated; launch = $nsisLaunch; uninstall = "PASS" }

    $msiRequestedRoot = Assert-SessionPath (Join-Path $sessionRoot "msi")
    $msiLog = Assert-SessionPath (Join-Path $sessionRoot "msi-install.log")
    $msiUpdated = $false
    if (Test-Path -LiteralPath $previousMsi -PathType Leaf) {
        Invoke-CheckedProcess "msiexec.exe" @(
            "/i", "`"$previousMsi`"", "/qn", "/norestart",
            "ALLUSERS=2", "MSIINSTALLPERUSER=1", "INSTALLDIR=`"$msiRequestedRoot`""
        ) "previous MSI install" | Out-Null
        $msiUpdated = $true
    }
    Invoke-CheckedProcess "msiexec.exe" @(
        "/i", "`"$msi`"", "/qn", "/norestart",
        "ALLUSERS=2", "MSIINSTALLPERUSER=1", "INSTALLDIR=`"$msiRequestedRoot`"",
        "/L*v", "`"$msiLog`""
    ) "MSI install" | Out-Null
    $installed = @(Get-MistrInstallations)
    if ($installed.Count -ne 1) { throw "MSI did not register exactly one Mistr installation" }
    if ($installed[0].DisplayVersion -ne $version) { throw "MSI update did not register version $version" }
    $msiRoot = Assert-SessionPath $installed[0].InstallLocation
    $msiExecutable = Join-Path $msiRoot "mistr.exe"
    $msiLaunch = Test-PackagedLaunch $msiExecutable $msiRoot 9344
    Invoke-CheckedProcess "msiexec.exe" @("/x", "`"$msi`"", "/qn", "/norestart") "MSI uninstall" | Out-Null
    if (Test-Path -LiteralPath $msiExecutable) { throw "MSI uninstall left the application executable behind" }
    if (@(Get-MistrInstallations).Count -ne 0) { throw "MSI uninstall left its registration behind" }
    $report.msi = [ordered]@{ install = "PASS"; updateFrom001 = $msiUpdated; launch = $msiLaunch; uninstall = "PASS"; installRoot = $msiRoot }
    $report.status = "PASS_LOCAL_MECHANICS"
}
catch {
    $report.failures += $_.Exception.Message
    throw
}
finally {
    $remaining = @(Get-MistrInstallations)
    foreach ($installation in $remaining) {
        if ($installation.PSChildName -match "^\{[0-9A-Fa-f-]+\}$") {
            Start-Process -FilePath "msiexec.exe" -ArgumentList @("/x", $installation.PSChildName, "/qn", "/norestart") -WindowStyle Hidden -PassThru -Wait | Out-Null
        }
    }
    $report.completedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Pop-Location
}

$report | ConvertTo-Json -Depth 8
