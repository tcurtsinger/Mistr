param([ValidateRange(2, 15)][int]$TimeoutMinutes = 8)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bundleRoot = [IO.Path]::GetFullPath((Join-Path $root "src-tauri\target\release\bundle"))
$evidenceRoot = [IO.Path]::GetFullPath((Join-Path $root "artifacts\alpha-release\clean-machine"))
$sandboxCommand = (Get-Command WindowsSandbox.exe -ErrorAction SilentlyContinue).Source
if (-not $sandboxCommand -or -not (Test-Path -LiteralPath $sandboxCommand -PathType Leaf)) {
    throw "Windows Sandbox is not enabled. Enable the Windows Sandbox optional feature or run the installers on another clean Windows 11 machine."
}
if (-not (Test-Path -LiteralPath $bundleRoot -PathType Container)) {
    throw "Installer bundles are unavailable. Run npm run tauri:build first."
}
$bundleVersion = (Get-Content -LiteralPath (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version
$nsisBundleName = "Mistr_${bundleVersion}_x64-setup.exe"
$msiBundleName = "Mistr_${bundleVersion}_x64_en-US.msi"
foreach ($bundle in @(
    (Join-Path $bundleRoot "nsis\$nsisBundleName"),
    (Join-Path $bundleRoot "msi\$msiBundleName")
)) {
    if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) {
        throw "Configured installer bundle is unavailable: $bundle"
    }
}

New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
$guestScript = Join-Path $evidenceRoot "validate-installers.ps1"
$configuration = Join-Path $evidenceRoot "mistr-clean-machine.wsb"
$reportPath = Join-Path $evidenceRoot "clean-machine-report.json"
Remove-Item -LiteralPath $reportPath -ErrorAction SilentlyContinue

$guestTemplate = @'
$ErrorActionPreference = "Stop"
$report = [ordered]@{ status = "FAIL"; os = $null; version = "__VERSION__"; nsis = $null; msi = $null; failures = @() }
function Run([string]$file, [string[]]$arguments, [string]$label) {
    $process = Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -notin @(0, 3010)) { throw "$label exited with $($process.ExitCode)" }
}
function Smoke([string]$executable, [string]$workingDirectory) {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Missing installed executable $executable" }
    $process = Start-Process -FilePath $executable -WorkingDirectory $workingDirectory -WindowStyle Hidden -PassThru
    try {
        Start-Sleep -Seconds 15
        if ($process.HasExited) { throw "Installed Mistr exited with $($process.ExitCode)" }
    } finally {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
    }
}
try {
    $report.os = (Get-CimInstance Win32_OperatingSystem).Caption
    $nsis = Join-Path "C:\Bundles\nsis" "__NSIS_BUNDLE__"
    $msi = Join-Path "C:\Bundles\msi" "__MSI_BUNDLE__"
    if (-not (Test-Path -LiteralPath $nsis -PathType Leaf)) { throw "Missing exact NSIS bundle $nsis" }
    if (-not (Test-Path -LiteralPath $msi -PathType Leaf)) { throw "Missing exact MSI bundle $msi" }
    $nsisRoot = "C:\MistrAlphaValidation"
    Run $nsis @("/S", "/D=$nsisRoot") "NSIS install"
    Smoke (Join-Path $nsisRoot "mistr.exe") $nsisRoot
    Run (Join-Path $nsisRoot "uninstall.exe") @("/S") "NSIS uninstall"
    if (Test-Path -LiteralPath (Join-Path $nsisRoot "mistr.exe")) { throw "NSIS executable remained after uninstall" }
    $report.nsis = "PASS"

    Run "msiexec.exe" @("/i", "`"$msi`"", "/qn", "/norestart", "ALLUSERS=2", "MSIINSTALLPERUSER=1") "MSI install"
    $installed = @(Get-ItemProperty "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "Mistr" })
    if ($installed.Count -ne 1) { throw "MSI registration was not found" }
    if ($installed[0].DisplayVersion -ne "__VERSION__") { throw "MSI registered the wrong version $($installed[0].DisplayVersion)" }
    $msiRoot = $installed[0].InstallLocation
    Smoke (Join-Path $msiRoot "mistr.exe") $msiRoot
    Run "msiexec.exe" @("/x", "`"$msi`"", "/qn", "/norestart") "MSI uninstall"
    if (Test-Path -LiteralPath (Join-Path $msiRoot "mistr.exe")) { throw "MSI executable remained after uninstall" }
    $report.msi = "PASS"
    $report.status = "PASS"
} catch {
    $report.failures += $_.Exception.Message
} finally {
    $report.completedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "C:\Evidence\clean-machine-report.json" -Encoding UTF8
    Start-Sleep -Seconds 2
    shutdown.exe /s /t 0
}
'@
$guestTemplate.Replace("__VERSION__", $bundleVersion).Replace("__NSIS_BUNDLE__", $nsisBundleName).Replace("__MSI_BUNDLE__", $msiBundleName) |
    Set-Content -LiteralPath $guestScript -Encoding UTF8

$bundleXml = [Security.SecurityElement]::Escape($bundleRoot)
$evidenceXml = [Security.SecurityElement]::Escape($evidenceRoot)
@"
<Configuration>
  <MappedFolders>
    <MappedFolder><HostFolder>$bundleXml</HostFolder><SandboxFolder>C:\Bundles</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$evidenceXml</HostFolder><SandboxFolder>C:\Evidence</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <Networking>Enable</Networking>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Evidence\validate-installers.ps1</Command></LogonCommand>
</Configuration>
"@ | Set-Content -LiteralPath $configuration -Encoding UTF8

$sandbox = Start-Process -FilePath $sandboxCommand -ArgumentList "`"$configuration`"" -WindowStyle Hidden -PassThru
$deadline = [DateTimeOffset]::UtcNow.AddMinutes($TimeoutMinutes)
while ([DateTimeOffset]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    Start-Sleep -Seconds 2
}
if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    if (-not $sandbox.HasExited) { Stop-Process -Id $sandbox.Id -Force }
    throw "Windows Sandbox clean-machine validation timed out"
}
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
if (-not $sandbox.HasExited) {
    [void]$sandbox.WaitForExit(30000)
    if (-not $sandbox.HasExited) {
        Stop-Process -Id $sandbox.Id -Force
        $sandbox.WaitForExit()
    }
}
$remainingSessions = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "WindowsSandboxRemoteSession.exe" -and
    $_.CommandLine -like "*$configuration*"
})
foreach ($session in $remainingSessions) {
    Stop-Process -Id $session.ProcessId -Force
}
$report | ConvertTo-Json -Depth 6
if ($report.status -ne "PASS") { throw "Clean-machine validation failed: $($report.failures -join '; ')" }
