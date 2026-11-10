# Run by the Windows installer (installer.nsh) under Windows PowerShell 5.1, before it
# replaces or removes the installation: ends what still runs from the installation directory.
#
# Keep this file ASCII: PowerShell 5.1 reads a file without a byte order mark in the system
# code page. The installer passes its inputs in the environment, where a path needs no quoting.
#
# Exit codes: 0 the directory is free, 2 Sillage is open and the user has not agreed to close
# it yet, 3 something could not be stopped. Any other code is a failure of this script, and
# the installer then stops Sillage by name instead.

$dir = $env:SILLAGE_SETUP_DIR
# 'update': Sillage started the installer and is quitting. 'ask': someone ran the installer.
# 'close': they agreed to let it close Sillage.
$mode = $env:SILLAGE_SETUP_MODE
$logFile = $env:SILLAGE_SETUP_LOG
if (-not $dir) { exit 1 }
$prefix = $dir.TrimEnd('\') + '\'
$appPath = $prefix + $env:SILLAGE_SETUP_EXE

# An orderly quit stops the server, which ends its sessions, then whatever they left behind.
$QuitSeconds = 20
# A Sillage without a window is finishing its quit, unless it hangs: wait less for it.
$HiddenQuitSeconds = 10
# Nothing is stopping what outlived Sillage: only the time of a process on its way out.
$LeftoverSeconds = 2
$KillSeconds = 10

function Write-SetupLog([string]$message) {
  if (-not $logFile) { return }
  try {
    $folder = Split-Path -Parent $logFile
    if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
    $at = (Get-Date).ToUniversalTime().ToString('o')
    Add-Content -LiteralPath $logFile -Value "$at $message" -Encoding UTF8 -ErrorAction Stop
  } catch {
    # The log is a courtesy: never fail an installation over it.
  }
}

function Format-Processes($processes) {
  ($processes | ForEach-Object { '{0} ({1})' -f $_.Name, $_.ProcessId }) -join ', '
}

# Neither this PowerShell nor the setup program that started it, should it run from the directory.
$self = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
$spared = @($PID, $self.ParentProcessId)

# The executable path is the test, not the name: besides Sillage.exe, the bundled Node of the
# server, of an MCP server or of a CLI keeps files of the directory open just as well.
# CIM rather than Get-Process, which cannot read the path of a 64-bit process from the
# 32-bit PowerShell an installer starts.
function Get-Running {
  Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($prefix, 'OrdinalIgnoreCase') -and
    $spared -notcontains $_.ProcessId
  }
}

# @() at each call: a function returns a lone match as the object itself, and its Count is
# not reliable in PowerShell 5.1. One process left is the usual case here, and it must not
# pass for none.
$found = @(Get-Running)
if ($found.Count -eq 0) { exit 0 }
Write-SetupLog ('{0}: running from {1}: {2}' -f $mode, $dir, (Format-Processes $found))

$ids = @($found | ForEach-Object { [int]$_.ProcessId })
$windows = @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($mode -eq 'ask' -and $windows.Count -gt 0) { exit 2 }

if ($mode -eq 'close') {
  # Closing its window is how Sillage is asked to quit in order. Never kill its process tree
  # instead: after an update, this installer is itself a child of Sillage.
  foreach ($window in $windows) {
    try { [void]$window.CloseMainWindow() } catch { }
  }
}

$grace = $QuitSeconds
if ($mode -eq 'ask') {
  $quitting = @($found | Where-Object { $_.ExecutablePath -ieq $appPath }).Count -gt 0
  if ($quitting) { $grace = $HiddenQuitSeconds } else { $grace = $LeftoverSeconds }
}
$deadline = (Get-Date).AddSeconds($grace)
while ((Get-Date) -lt $deadline -and @(Get-Process -Id $ids -ErrorAction SilentlyContinue).Count -gt 0) {
  Start-Sleep -Milliseconds 250
}

$deadline = (Get-Date).AddSeconds($KillSeconds)
$reported = @()
while ($true) {
  $found = @(Get-Running)
  if ($found.Count -eq 0) {
    # Windows releases the files of a process a moment after it is gone.
    Start-Sleep -Milliseconds 300
    Write-SetupLog 'nothing runs from the directory any more'
    exit 0
  }
  if ((Get-Date) -gt $deadline) { break }
  foreach ($process in $found) {
    if ($reported -notcontains $process.ProcessId) {
      $reported += $process.ProcessId
      Write-SetupLog ('stopping {0} ({1}): {2}' -f $process.Name, $process.ProcessId, $process.ExecutablePath)
    }
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
}
Write-SetupLog ('could not stop: {0}' -f (Format-Processes $found))
exit 3
