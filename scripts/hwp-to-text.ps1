# Extract the full body text of a .hwp file using Hancom Office (COM). Read-only.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\hwp-to-text.ps1 -Hwp "C:\path\file.hwp" -Out eval\sets\name\input.txt
param([Parameter(Mandatory=$true)][string]$Hwp, [Parameter(Mandatory=$true)][string]$Out)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not (Test-Path -LiteralPath $Hwp)) { throw "not found: $Hwp" }
$h = New-Object -ComObject HWPFrame.HwpObject
try { $h.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule') | Out-Null } catch {}
if (-not $h.Open($Hwp, 'HWP', 'forceopen:true')) { throw "cannot open $Hwp" }
$text = $h.GetTextFile('TEXT', '')
$h.Quit()
New-Item -ItemType Directory -Force -Path (Split-Path $Out -Parent) | Out-Null
[IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))
"wrote $Out ($($text.Length) chars)"
