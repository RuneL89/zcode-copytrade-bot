' Runs a command with no visible window. The scheduled tasks use this so the
' watchdog and the logon start do not flash a console every 5 minutes.
' Usage: wscript run-hidden.vbs <script-to-run>
If WScript.Arguments.Count < 1 Then WScript.Quit 1
CreateObject("WScript.Shell").Run """" & WScript.Arguments(0) & """", 0, False
