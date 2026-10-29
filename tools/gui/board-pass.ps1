#requires -Version 5.1
<#
.SYNOPSIS
  Stage 0 of the day-trader funnel: read the visible top rows of the Fomo 24H
  leaderboard from the operator's normal desktop Chrome and emit board.json.

.DESCRIPTION
  Policy: fomo.family is ONLY read through the operator's desktop Chrome.
  This script never types credentials, never opens its own browser, and never
  clicks anything except a leaderboard row.

  Method (proven): at 100% zoom the visible rows sit at fixed screen heights.
  For each row: click it, copy the address-bar URL (Ctrl+L / Ctrl+C), go back.
  Identifiers come from the clipboard only — never from OCR, because OCR
  misread handles (econcar/econoar, monke3655/monke365) in earlier runs.

  No scrolling: the board rotates daily, so the visible top rows are enough
  and back-navigation cannot desync the row positions.

  Output: board.json = [{ rank, handle, profileUrl }] with ranks strictly
  sequential. Rows whose clipboard content is not a profile URL are skipped
  with a warning (fail-closed: nothing is invented).

.PARAMETER RowYs
  Screen heights (px) of the visible leaderboard rows at 100% zoom.
  Calibrate once per display: they must start below the table header.

.PARAMETER X
  Horizontal click point inside the row (right half keeps clear of avatars).

.EXAMPLE
  ./board-pass.ps1 -OutFile C:\temp\board.json
#>
param(
  [string]$OutFile = "$env:TEMP\fomo-board.json",
  [int[]]$RowYs = @(610, 663, 717, 770, 823, 877, 930),
  [int]$X = 1150,
  [int]$Rows = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class GuiBoard {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@

if ($Rows -gt 0) { $RowYs = $RowYs[0..([Math]::Min($Rows, $RowYs.Count) - 1)] }

function Get-ProfileSlug([string]$url) {
  if ($url -match 'fomo\.family/profile/([^?\s]+)') { return $Matches[1] }
  return $null
}

Write-Host 'Focus the Chrome window showing https://fomo.family/leaderboard?range=24h'
Write-Host 'Reading the visible rows now (do not type or move the mouse)…'

$entries = New-Object System.Collections.ArrayList
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$rank = 0

foreach ($y in $RowYs) {
  [GuiBoard]::SetCursorPos($X, $y) | Out-Null
  Start-Sleep -Milliseconds 250
  [GuiBoard]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [GuiBoard]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 2600

  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('^c')
  Start-Sleep -Milliseconds 350
  $url = (Get-Clipboard) -as [string]

  [System.Windows.Forms.SendKeys]::SendWait('%{LEFT}')
  Start-Sleep -Milliseconds 2000

  $slug = Get-ProfileSlug $url
  if (-not $slug) {
    Write-Warning ("row at y={0}: not a profile URL ({1}) - skipped" -f $y, ($url -replace '\s+', ' '))
    continue
  }
  if (-not $seen.Add($slug)) {
    Write-Warning ("row at y={0}: duplicate slug {1} - skipped" -f $y, $slug)
    continue
  }
  $rank++
  [void]$entries.Add([pscustomobject]@{
      rank       = $rank
      handle     = $slug
      profileUrl = ('https://fomo.family/profile/' + $slug)
    })
  Write-Host ("{0,2}. {1}" -f $rank, $slug)
}

if ($entries.Count -eq 0) {
  Write-Error 'No profile URLs captured. Is the leaderboard visible at 100% zoom?'
  exit 1
}

$json = ConvertTo-Json -InputObject @($entries) -Depth 4
Set-Content -LiteralPath $OutFile -Value $json -Encoding UTF8
Write-Host ("wrote {0} rows -> {1}" -f $entries.Count, $OutFile)
Write-Host 'Next: ./profile-stats.ps1 -Board <that file>'
