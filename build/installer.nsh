; Keep the speech-recognition models (asr-models) in the install folder when the app is
; upgraded / reinstalled, so users do not have to download them again.
; A real uninstall still removes everything.
!macro customRemoveFiles
  ${if} ${isUpdated}
    FindFirst $R0 $R1 "$INSTDIR\*.*"
    pdkeep_loop:
      StrCmp $R1 "" pdkeep_done
      StrCmp $R1 "." pdkeep_next
      StrCmp $R1 ".." pdkeep_next
      StrCmp $R1 "asr-models" pdkeep_next
      IfFileExists "$INSTDIR\$R1\*.*" 0 pdkeep_file
        RMDir /r "$INSTDIR\$R1"
        Goto pdkeep_next
      pdkeep_file:
        Delete "$INSTDIR\$R1"
    pdkeep_next:
      FindNext $R0 $R1
      Goto pdkeep_loop
    pdkeep_done:
    FindClose $R0
  ${else}
    RMDir /r "$INSTDIR"
  ${endif}
!macroend
