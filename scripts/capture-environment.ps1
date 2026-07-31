[CmdletBinding()]
param(
  [string]$OutputPath = "diagnostics/environment.json"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$resolvedOutput = Join-Path $root $OutputPath
$outputDirectory = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

function Invoke-Version([string]$Command, [string[]]$Arguments) {
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& $Command @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
  } catch {
    return "unavailable"
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }

  $firstLine = $output | Where-Object { $_ } | Select-Object -First 1
  if ($exitCode -ne 0 -or -not $firstLine) { return "unavailable" }
  return $firstLine.ToString().Trim()
}

function Get-WebView2Version {
  $registrations = @(
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*"
  )

  $versions = foreach ($registration in $registrations) {
    Get-ItemProperty $registration -ErrorAction SilentlyContinue |
      Where-Object { $_.name -like "*WebView2*" -and $_.pv } |
      ForEach-Object { $_.pv.ToString() }
  }

  $detected = $versions |
    Sort-Object { try { [version]$_ } catch { [version]"0.0.0.0" } } -Descending |
    Select-Object -First 1

  if ($detected) { return $detected }
  return "unavailable"
}

$gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [ordered]@{
    name = $_.Name
    driverVersion = $_.DriverVersion
  }
})
$operatingSystem = Get-CimInstance Win32_OperatingSystem

$snapshot = [ordered]@{
  schemaVersion = 1
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  note = "Generated locally; ignored by Git because it contains machine details."
  operatingSystem = [ordered]@{
    caption = $operatingSystem.Caption
    version = [System.Environment]::OSVersion.Version.ToString()
    architecture = $operatingSystem.OSArchitecture
  }
  runtimes = [ordered]@{
    node = Invoke-Version "node" @("--version")
    npm = Invoke-Version "npm" @("--version")
    rustc = Invoke-Version "rustc" @("--version")
    cargo = Invoke-Version "cargo" @("--version")
    webView2 = Get-WebView2Version
    powershell = $PSVersionTable.PSVersion.ToString()
  }
  gpu = $gpu
}

$snapshot | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resolvedOutput -Encoding UTF8
Write-Host "Wrote environment snapshot to $resolvedOutput"
