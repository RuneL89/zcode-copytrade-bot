powershell -NoProfile -ExecutionPolicy Bypass -File Temp/list-chrome.ps1
__zcode_status=$?
if [ "$__zcode_status" -eq 0 ]; then pwd -P > '/c/Users/atavi/AppData/Local/Temp/zcode-0cd93ff2-421f-406f-a1d0-e19be33ab0e6-cwd'; fi
exit "$__zcode_status"
