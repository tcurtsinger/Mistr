[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$forbiddenTrackedPatterns = @(
  "(^|/)\.env($|\.(?!example$))",
  "\.(pem|key|pfx|p12|cer|crt)$",
  "\.(nexrad|ar2v)$",
  "(^|/)K[A-Z0-9]{3}[0-9]{8}_[0-9]{6}_V[0-9]{2}(\.gz)?$",
  "(^|/)(diagnostics|artifacts|benchmark-results|debug-bundles)/",
  "^fixtures/cache/.+"
)

$hasGitIndex = Test-Path -LiteralPath ".git"
$trackedLookup = @{}
$candidateFiles = @()
if ($hasGitIndex) {
  $trackedFiles = @(git ls-files --cached)
  $untrackedFiles = @(git ls-files --others --exclude-standard)
  foreach ($file in $trackedFiles) { $trackedLookup[$file] = $true }
  $candidateFiles += $trackedFiles
  $candidateFiles += $untrackedFiles
} else {
  $candidateFiles += @(Get-ChildItem -Recurse -File | ForEach-Object {
    $_.FullName.Substring($root.Length + 1).Replace("\", "/")
  })
}
$candidateFiles = @($candidateFiles | Sort-Object -Unique)

$violations = New-Object System.Collections.Generic.List[string]
foreach ($file in $candidateFiles) {
  $normalized = $file.Replace("\", "/")
  foreach ($pattern in $forbiddenTrackedPatterns) {
    if ($normalized -match $pattern -and $normalized -ne "fixtures/cache/.gitkeep") {
      $violations.Add("forbidden path: $normalized")
    }
  }
}

$secretPatterns = @(
  ("-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?" + "PRIVATE KEY-----"),
  ("-----BEGIN PGP " + "PRIVATE KEY BLOCK-----"),
  "AKIA[0-9A-Z]{16}",
  "gh[pousr]_[A-Za-z0-9_]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "npm_[A-Za-z0-9]{20,}",
  '(?i)["'']?(password|secret|api[_-]?key|access[_-]?token|_authToken)["'']?\s*[:=]\s*["''](?!\$\{|<)[^"''\r\n]{8,}["'']',
  '(?i)["'']?(password|secret|api[_-]?key|access[_-]?token|_authToken)["'']?\s*[:=]\s*(?!\$\{|<)[A-Za-z0-9_./+=-]{8,}'
)

$binaryExtensions = @(".7z", ".dll", ".exe", ".gif", ".gz", ".ico", ".icns", ".jpeg", ".jpg", ".msi", ".nexrad", ".pdf", ".png", ".webp", ".zip")
$maximumPublicFileBytes = 1MB

function Get-IndexText([string]$File) {
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $lines = @(& git show ":$File" 2>$null)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($exitCode -ne 0) { throw "Could not read staged content for $File" }
  return [string]::Join("`n", $lines)
}

function Get-IndexSize([string]$File) {
  $size = & git cat-file -s ":$File" 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Could not read staged size for $File" }
  return [int64]$size
}

function Test-SecretContent([string]$Label, [string]$Content) {
  foreach ($pattern in $secretPatterns) {
    if ($Content -match $pattern) {
      $violations.Add("possible secret pattern in: $Label")
    }
  }
}

foreach ($file in $candidateFiles) {
  $isTracked = $hasGitIndex -and $trackedLookup.ContainsKey($file)
  if ($isTracked) {
    $fileSize = Get-IndexSize $file
  } elseif (Test-Path -LiteralPath $file -PathType Leaf) {
    $fileSize = (Get-Item -LiteralPath $file).Length
  } else {
    continue
  }

  if ($fileSize -gt $maximumPublicFileBytes) {
    $violations.Add("oversized public artifact: $file ($fileSize bytes)")
    continue
  }
  if ($binaryExtensions -contains [IO.Path]::GetExtension($file).ToLowerInvariant()) { continue }

  if ($isTracked) {
    Test-SecretContent "$file (index)" (Get-IndexText $file)
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      Test-SecretContent "$file (working tree)" (Get-Content -LiteralPath $file -Raw)
    }
  } else {
    Test-SecretContent $file (Get-Content -LiteralPath $file -Raw)
  }
}

if ($violations.Count -gt 0) {
  $violations | Sort-Object -Unique | ForEach-Object { Write-Error $_ }
  throw "Public-repository check failed."
}

Write-Host "Public-repository check passed for $($candidateFiles.Count) candidate file(s)."
