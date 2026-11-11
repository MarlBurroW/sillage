# Additions to electron-builder's NSIS installer (`nsis.include` in electron-builder.yml).

!macro sillageSetupEnv NAME VALUE
  # Through a register: the System plugin would otherwise parse the value itself.
  StrCpy $R2 "${VALUE}"
  System::Call 'kernel32::SetEnvironmentVariable(t "${NAME}", t R2)'
!macroend

# Without a working PowerShell (removed, or blocked by policy): what electron-builder does
# in that case, by the name of the executable. An installer renamed to that name is left alone.
!macro sillageStopByName
  ${if} $EXEFILE != "${APP_EXECUTABLE_FILENAME}"
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    ${if} $R0 == 0
      ${ifNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
        Quit
      ${endIf}
      nsExec::Exec `"$CmdPath" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
      Pop $R0
      Sleep 2000
    ${endIf}
  ${endIf}
!macroend

# Replaces electron-builder's check for a running application, in the installer and in the
# uninstaller. Installing over a Sillage that had just quit often waited in silence, then
# asked to close an application nobody could see ("cannot be closed, Retry"): something
# still ran from the directory (the server ending, an MCP server, a CLI under the bundled
# Node), their check let it pass or did not stop it, and the removal of the old version
# stumbled on a file in use, five tries long.
#
# installer-running-app.ps1 does it in one run: it waits for a Sillage that is quitting,
# asks before closing one that is open, stops the rest and returns once the directory is free.
!macro customCheckAppRunning
  Push $R0
  Push $R1
  Push $R2
  InitPluginsDir
  File /oname=$PLUGINSDIR\installer-running-app.ps1 "${BUILD_RESOURCES_DIR}\installer-running-app.ps1"
  !insertmacro sillageSetupEnv "SILLAGE_SETUP_SCRIPT" "$PLUGINSDIR\installer-running-app.ps1"
  !insertmacro sillageSetupEnv "SILLAGE_SETUP_DIR" "$INSTDIR"
  !insertmacro sillageSetupEnv "SILLAGE_SETUP_EXE" "${APP_EXECUTABLE_FILENAME}"
  # Beside the application's own logs (`userData` in src/main.ts).
  !insertmacro sillageSetupEnv "SILLAGE_SETUP_LOG" "$LOCALAPPDATA\${PRODUCT_NAME}\logs\installer.log"

  ${if} ${isUpdated}
    StrCpy $R1 "update"
  ${else}
    StrCpy $R1 "ask"
  ${endIf}
  ${Do}
    !insertmacro sillageSetupEnv "SILLAGE_SETUP_MODE" "$R1"
    # The script as a command rather than a file: no execution policy applies to it.
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Invoke-Expression (Get-Content -Raw -LiteralPath $$env:SILLAGE_SETUP_SCRIPT)"`
    Pop $R0
    ${if} $R0 == 2
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
      Quit
      StrCpy $R1 "close"
    ${elseIf} $R0 == 3
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
      Quit
    ${else}
      ${if} $R0 != 0
        !insertmacro sillageStopByName
      ${endIf}
      ${ExitDo}
    ${endIf}
  ${Loop}
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
