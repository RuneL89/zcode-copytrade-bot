#requires -Version 5.1
<#
.SYNOPSIS
  Stage 1 of the day-trader funnel: for each board slug, open the Fomo profile
  in the operator's desktop Chrome and read the stats line (avg. hold, trades).

.DESCRIPTION
  Policy: fomo.family is ONLY read through the operator's desktop Chrome.

  Method: navigate directly to each profile URL (Ctrl+L / type / Enter), scroll
  to top, then triple-click the stats line and copy it. Profiles are visited by
  URL rather than by clicking board rows, so the board's reset-to-top behaviour
  cannot desync anything.

  The stats line looks like "1d 9h avg. hold   3.6K trades" (7D scope when the
  profile's scope selector is 7D). A capture that does not contain "avg. hold"
  is rejected (fail-closed) — a mis-click never produces invented numbers.

  Emits entries.json ready for fomo-import: existing board fields plus
  avgHoldHours (decimal hours) and trades7d (count).

.PARAMETER Board
  board.json produced by ./board-pass.ps1

.PARAMETER StatsY
  Screen height of the stats line at 100% zoom (default 437; calibrate once).

.EXAMPLE
  ./profile-stats.ps1 -Board C:\temp\fomo-board.json -OutFile C:\temp\entries.json
#>
param(
  [Parameter(Mandatory = $true)][string]$Board,
  [string]$OutFile = "$env:TEMP\fomo-entries.json",
  [int]$StatsY = 437,
  [int]$StatsX = 600
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class GuiProfile {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@

function ConvertTo-Hours([string]$text) {
  $days = 0; $hours = 0; $mins = 0
  $m = [regex]::Match($text, '(\d+)\s*d\b')
  if ($m.Success) { $days = [int]$m.Groups[1].Value }
  $m = [regex]::Match($text, '(\d+)\s*h\b')
  if ($m.Success) { $hours = [int]$m.Groups[1].Value }
  $m = [regex]::Match($text, '(\d+)\s*m\b')
  if ($m.Success) { $mins = [int]$m.Groups[1].Value }
  if ($days -eq 0 -and $hours -eq 0 -and $mins -eq 0) { return $null }
  return [math]::Round($days * 24 + $hours + $mins / 60, 2)
}

function ConvertTo-Count([string]$text) {
  $m = [regex]::Match($text, '([\d.,]+)\s*([KMB])?\s*trades', 'IgnoreCase')
  if (-not $m.Success) { return $null }
  $n = [double]($m.Groups[1].Value -replace ',', '')
  switch ($m.Groups[2].Value.ToUpper()) {
    'K' { $n = $n * 1000 }
    'M' { $n = $n * 1000000 }
    'B' { $n = $n * 1000000000 }
  }
  return [int][math]::Round($n)
}

$rows = Get-Content -LiteralPath $Board -Raw | ConvertFrom-Json
if (-not $rows) { Write-Error "empty board file: $Board"; exit 1 }

Write-Host ("Reading stats for {0} profile(s) - leave Chrome focused and hands off…" -f @($rows).Count)

$out = New-Object System.Collections.ArrayList
foreach ($row in @($rows)) {
  $slug = $row.handle
  $url = $row.profileUrl

  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait($url)
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 4200
  [System.Windows.Forms.SendKeys]::SendWait('^{HOME}')
  Start-Sleep -Milliseconds 600

  # triple-click selects the stats line; clipboard is the source of truth
  [GuiProfile]::SetCursorPos($StatsX, $StatsY) | Out-Null
  Start-Sleep -Milliseconds 200
  for ($i = 0; $i -lt 3; $i++) {
    [GuiProfile]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [GuiProfile]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 70
  }
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('^c')
  Start-Sleep -Milliseconds 350
  $statsText = (Get-Clipboard) -as [string]

  if (-not $statsText -or $statsText -notmatch 'avg\.\s*hold') {
    Write-Warning ("{0}: stats line not captured ('{1}') - skipped" -f $slug, (($statsText -as [string]) -replace '\s+', ' '))
    [void]$out.Add([pscustomobject]@{
        handle = $slug; rank = $row.rank; profileUrl = $url
        avgHoldHours = $null; trades7d = $null
      })
    continue
  }

  $flat = ($statsText -replace "`r?`n", ' ') -replace '\s+', ' '
  $avgHold = (ConvertTo-Hours $flat)
  $trades = (ConvertTo-Count $flat)
  Write-Host ("{0,-16} avgHold={1}h trades7d={2}   [{3}]" -f $slug, $avgHold, $trades, $flat.Trim())

  [void]$out.Add([pscustomobject]@{
      handle       = $slug
      rank         = $row.rank
      profileUrl   = $url
      avgHoldHours = $avgHold
      trades7d     = $trades
    })
}

$json = ConvertTo-Json -InputObject @($out) -Depth 4
Set-Content -LiteralPath $OutFile -Value $json -Encoding UTF8
Write-Host ("wrote {0} entries -> {1}" -f $out.Count, $OutFile)
Write-Host 'Next: fomo-import (apps/server): pnpm exec tsx src/cli/fomo-import.ts <that file>'
