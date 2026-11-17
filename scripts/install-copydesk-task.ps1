# Creates (or replaces) only the "Copydesk" scheduled task. Does not modify
# "Copydesk watchdog" or "ZCode Quota Auto-Reset".
$ErrorActionPreference = 'Stop'
$taskName = 'Copydesk'
$forbidden = @('Copydesk watchdog', 'ZCode Quota Auto-Reset')
if ($forbidden -contains $taskName) { throw 'refusing to modify a protected task name' }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\atavi\Documents\projects\copydesk\scripts\copydesk-service.ps1" start' -WorkingDirectory 'C:\Users\atavi\Documents\projects\copydesk'
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $(if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME })),
    (New-ScheduledTaskTrigger -AtStartup)
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal | Out-Null
$t = Get-ScheduledTask -TaskName $taskName
Write-Output "registered task='$($t.TaskName)' state=$($t.State) triggers=$(($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ',')"
# Confirm the protected tasks were not changed
Get-ScheduledTask | Where-Object { $forbidden -contains $_.TaskName } | ForEach-Object {
    Write-Output "protected still present: $($_.TaskName) state=$($_.State)"
}
