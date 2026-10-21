# Export a human-made EA project (.eap/.qea) to a gold JSON for the LLM scoreboard.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\ea-export-gold.ps1 -Eap "C:\path\file.EAP" -Out eval\gold\name.json
# Needs Enterprise Architect installed (uses its COM API). Read-only: never writes to the EAP.
param([Parameter(Mandatory=$true)][string]$Eap, [Parameter(Mandatory=$true)][string]$Out)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$r = New-Object -ComObject EA.Repository
if (-not $r.OpenFile($Eap)) { throw "cannot open $Eap" }

$gold = [ordered]@{ source = (Split-Path $Eap -Leaf); exportedAt = (Get-Date -Format s); actors = @(); packages = @() }
$byId = @{}

function Collect($pkg) {
    foreach ($e in $pkg.Elements) {
        $byId[$e.ElementID] = $e
        if ($e.Type -eq 'Actor') { $script:gold.actors += [ordered]@{ name = $e.Name; notes = $e.Notes } }
    }
    $ucs = @($pkg.Elements | Where-Object { $_.Type -eq 'UseCase' })
    if ($ucs.Count -gt 0) {
        $p = [ordered]@{ name = $pkg.Name; usecases = @(); diagrams = @() }
        foreach ($u in $ucs) {
            $p.usecases += [ordered]@{ id = $u.ElementID; name = $u.Name; notes = $u.Notes; actors = @(); includes = @(); extends = @() }
        }
        foreach ($d in $pkg.Diagrams) { $p.diagrams += [ordered]@{ name = $d.Name; elements = $d.DiagramObjects.Count } }
        $script:gold.packages += $p
    }
    foreach ($c in $pkg.Packages) { Collect $c }
}
foreach ($m in $r.Models) { Collect $m }

# second pass: relations (need all elements known first)
foreach ($p in $gold.packages) {
    foreach ($u in $p.usecases) {
        $e = $byId[$u.id]
        foreach ($c in $e.Connectors) {
            $other = if ($c.ClientID -eq $e.ElementID) { $byId[$c.SupplierID] } else { $byId[$c.ClientID] }
            if (-not $other) { continue }
            if ($other.Type -eq 'Actor') { $u.actors += $other.Name }
            elseif ($c.Type -eq 'Dependency' -or $c.Type -eq 'UseCase') {
                $st = $c.Stereotype
                if ($st -match 'include' -and $c.ClientID -eq $e.ElementID) { $u.includes += $other.Name }
                elseif ($st -match 'extend' -and $c.ClientID -eq $e.ElementID) { $u.extends += $other.Name }
            }
        }
        $u.Remove('id')
    }
}
$r.CloseFile(); $r.Exit()

New-Item -ItemType Directory -Force -Path (Split-Path $Out -Parent) | Out-Null
$gold | ConvertTo-Json -Depth 8 | Set-Content -Path $Out -Encoding UTF8
"wrote $Out : actors=$($gold.actors.Count) packages=$($gold.packages.Count) usecases=$(($gold.packages | ForEach-Object { $_.usecases.Count } | Measure-Object -Sum).Sum)"
