[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$forbiddenTrackedPatterns = @(
  "(^|/)\.env($|\.)",
  "\.(pem|key|pfx|p12|cer|crt)$",
  "(^|/)(diagnostics|artifacts|benchmark-results|debug-bundles)/",
  "^fixtures/cache/.+"
)

$candidateFiles = @()
if (Test-Path -LiteralPath ".git") {
  $candidateFiles += @(git ls-files --cached --others --exclude-standard)
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
  "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
  "AKIA[0-9A-Z]{16}",
  "gh[pousr]_[A-Za-z0-9_]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "npm_[A-Za-z0-9]{20,}",
  '(?i)(password|secret|api[_-]?key|access[_-]?token|_authToken)\s*[:=]\s*["''][^"''\r\n]{8,}["'']',
  '(?i)(password|secret|api[_-]?key|access[_-]?token|_authToken)\s*[:=]\s*(?!\$\{)[A-Za-z0-9_./+=-]{8,}'
)

$binaryExtensions = @(".7z", ".dll", ".exe", ".gif", ".gz", ".ico", ".icns", ".jpeg", ".jpg", ".msi", ".nexrad", ".pdf", ".png", ".webp", ".zip")
foreach ($file in $candidateFiles) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
  if ($binaryExtensions -contains [IO.Path]::GetExtension($file).ToLowerInvariant()) { continue }
  $content = Get-Content -LiteralPath $file -Raw
  foreach ($pattern in $secretPatterns) {
    if ($content -match $pattern) {
      $violations.Add("possible secret pattern in: $file")
    }
  }
}

if ($violations.Count -gt 0) {
  $violations | Sort-Object -Unique | ForEach-Object { Write-Error $_ }
  throw "Public-repository check failed."
}

Write-Host "Public-repository check passed for $($candidateFiles.Count) candidate file(s)."
