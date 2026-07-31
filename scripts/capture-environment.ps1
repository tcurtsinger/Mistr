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
  try {
    return (& $Command @Arguments 2>&1 | Select-Object -First 1).ToString().Trim()
  } catch {
    return "unavailable"
  }
}

$webView = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*" -ErrorAction SilentlyContinue |
  Where-Object { $_.name -like "*WebView2*" } |
  Select-Object -First 1

$gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [ordered]@{
    name = $_.Name
    driverVersion = $_.DriverVersion
    adapterRamBytes = [uint64]$_.AdapterRAM
  }
})

$snapshot = [ordered]@{
  schemaVersion = 1
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  note = "Generated locally; ignored by Git because it contains machine details."
  operatingSystem = [ordered]@{
    caption = (Get-CimInstance Win32_OperatingSystem).Caption
    version = [System.Environment]::OSVersion.Version.ToString()
    architecture = $env:PROCESSOR_ARCHITECTURE
  }
  runtimes = [ordered]@{
    node = Invoke-Version "node" @("--version")
    npm = Invoke-Version "npm" @("--version")
    rustc = Invoke-Version "rustc" @("--version")
    cargo = Invoke-Version "cargo" @("--version")
    webView2 = if ($webView) { $webView.pv } else { "unavailable" }
    powershell = $PSVersionTable.PSVersion.ToString()
  }
  gpu = $gpu
}

$snapshot | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resolvedOutput -Encoding UTF8
Write-Host "Wrote environment snapshot to $resolvedOutput"
