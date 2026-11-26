; Custom steps for the Windows installer (tauri.conf.json -> bundle.windows.nsis.installerHooks)

; Versions before 1.3 were called "Tuition Invoice Maker". Installing Cikgu Pay removes that old copy, so the
; user doesn't end up with two apps and two shortcuts. Only the program is removed: the invoices, settings and
; backups in Documents\Tuition Invoices are not touched (Cikgu Pay keeps using that folder).
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Tuition Invoice Maker" "InstallLocation"
  ${If} $R0 != ""
    StrCpy $R0 $R0 -1 1                       ; the value is stored in quotes: "C:\...\Tuition Invoice Maker"
    ${If} ${FileExists} "$R0\uninstall.exe"
      DetailPrint "Removing the old Tuition Invoice Maker (your data is kept)"
      ExecWait '"$R0\uninstall.exe" /S _?=$R0'   ; _?= makes it run in place, so ExecWait really waits
      Delete "$R0\uninstall.exe"
      RMDir "$R0"
    ${EndIf}
  ${EndIf}
!macroend
