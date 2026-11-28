# Run by the Windows installer (installer.nsh) under Windows PowerShell 5.1, before it
# replaces or removes the installation: ends what still runs from the installation directory.
#
# Keep this file ASCII: PowerShell 5.1 reads a file without a byte order mark in the system
# code page. The installer passes its inputs in the environment, where a path needs no quoting.
#
# What runs from the directory is one half. The other is what holds it from outside: a process
# installed elsewhere that works in it (anything the server started without naming a working
# directory inherits the server's own) or keeps one of its files open. The removal of the old
# version then fails on that file, or leaves a directory Windows cannot finish deleting and
# nothing can be copied into, and the installer asks to close a Sillage that is long gone.
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
# For what holds the directory from outside to go once stopped. Past that the installation
# goes on: a holder this script cannot name must not make installing impossible.
$HolderSeconds = 10

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

# Native calls, as nothing in PowerShell tells who holds a file or where a process works.
$holderSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class SillageSetup {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int kind, ref ProcessBasicInformation info, int size, out int returned);

  [StructLayout(LayoutKind.Sequential)]
  struct ProcessBasicInformation {
    public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFrom;
  }

  // Files and directories of the tree that cannot be renamed or deleted right now: someone
  // has them open without sharing that right, which is what a working directory does too.
  public static string[] Busy(string root) {
    List<string> busy = new List<string>();
    Stack<string> pending = new Stack<string>();
    pending.Push(root);
    while (pending.Count > 0) {
      string dir = pending.Pop();
      if (Held(dir)) busy.Add(dir);
      try {
        foreach (string file in Directory.GetFiles(dir)) if (Held(file)) busy.Add(file);
        foreach (string sub in Directory.GetDirectories(dir)) pending.Push(sub);
      } catch (Exception) { }
    }
    return busy.ToArray();
  }

  static bool Held(string path) {
    // DELETE access, sharing everything; FILE_FLAG_BACKUP_SEMANTICS opens directories too.
    IntPtr handle = CreateFile(path, 0x00010000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (handle != new IntPtr(-1)) { CloseHandle(handle); return false; }
    return Marshal.GetLastWin32Error() == 32; // ERROR_SHARING_VIOLATION
  }

  // The directory a process works in, read from its own memory: Windows offers no call for it.
  // Null when the process is not ours to read, or 64-bit seen from a 32-bit PowerShell.
  public static string WorkingDirectory(int pid) {
    IntPtr process = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
    if (process == IntPtr.Zero) return null;
    try {
      ProcessBasicInformation info = new ProcessBasicInformation();
      int returned;
      if (NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(typeof(ProcessBasicInformation)), out returned) != 0) return null;
      if (info.PebBaseAddress == IntPtr.Zero) return null;
      bool wide = IntPtr.Size == 8;
      // PEB.ProcessParameters, then RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath.
      byte[] pointer = Read(process, IntPtr.Add(info.PebBaseAddress, wide ? 0x20 : 0x10), IntPtr.Size);
      if (pointer == null) return null;
      IntPtr parameters = wide ? new IntPtr(BitConverter.ToInt64(pointer, 0)) : new IntPtr(BitConverter.ToInt32(pointer, 0));
      if (parameters == IntPtr.Zero) return null;
      byte[] path = Read(process, IntPtr.Add(parameters, wide ? 0x38 : 0x24), wide ? 16 : 8);
      if (path == null) return null;
      int length = BitConverter.ToUInt16(path, 0);
      IntPtr buffer = wide ? new IntPtr(BitConverter.ToInt64(path, 8)) : new IntPtr(BitConverter.ToInt32(path, 4));
      if (length == 0 || buffer == IntPtr.Zero) return null;
      byte[] text = Read(process, buffer, length);
      return text == null ? null : Encoding.Unicode.GetString(text);
    } finally {
      CloseHandle(process);
    }
  }

  static byte[] Read(IntPtr process, IntPtr address, int size) {
    byte[] buffer = new byte[size];
    IntPtr read;
    if (!ReadProcessMemory(process, address, buffer, new IntPtr(size), out read) || read.ToInt64() != size) return null;
    return buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct RmUniqueProcess {
    public int ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RmProcessInfo {
    public RmUniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint session);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint session, uint fileCount, string[] files, uint appCount, IntPtr apps, uint serviceCount, string[] services);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] RmProcessInfo[] apps, ref uint reasons);

  // Who has these files open, by the Restart Manager, which installers are meant to ask.
  public static int[] Holders(string[] files) {
    List<int> pids = new List<int>();
    uint session;
    if (RmStartSession(out session, 0, new StringBuilder(64)) != 0) return pids.ToArray();
    try {
      if (RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, null) != 0) return pids.ToArray();
      uint needed, count = 0, reasons = 0;
      int result = RmGetList(session, out needed, ref count, null, ref reasons);
      if (result != 234 || needed == 0) return pids.ToArray(); // ERROR_MORE_DATA
      RmProcessInfo[] apps = new RmProcessInfo[needed];
      count = needed;
      if (RmGetList(session, out needed, ref count, apps, ref reasons) != 0) return pids.ToArray();
      for (int i = 0; i < count; i++) pids.Add(apps[i].Process.ProcessId);
    } finally {
      RmEndSession(session);
    }
    return pids.ToArray();
  }
}
'@

# Explorer shows the directory when someone browses it: closing the desktop is no way to install.
$neverStopped = @('explorer.exe')

# Stops what holds the directory from outside, and returns once nothing does or after
# $HolderSeconds. Never fails the installation: at worst the installer does as before.
function Clear-Holders {
  try {
    # This PowerShell inherited its working directory, which may be the one to free.
    [Environment]::CurrentDirectory = $env:SystemRoot
    Add-Type -TypeDefinition $holderSource -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds($HolderSeconds)
    $reported = @()
    while ($true) {
      $busy = @([SillageSetup]::Busy($dir))
      if ($busy.Count -eq 0) {
        if ($reported.Count -gt 0) { Write-SetupLog 'nothing holds the directory any more' }
        return
      }
      $ids = @()
      $files = @($busy | Where-Object { -not [IO.Directory]::Exists($_) } | Select-Object -First 200)
      if ($files.Count -gt 0) { $ids += @([SillageSetup]::Holders([string[]]$files)) }
      $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
      foreach ($process in $all) {
        $cwd = [SillageSetup]::WorkingDirectory([int]$process.ProcessId)
        if ($cwd -and ($cwd.TrimEnd('\') + '\').StartsWith($prefix, 'OrdinalIgnoreCase')) { $ids += [int]$process.ProcessId }
      }
      $holders = @($all | Where-Object { $ids -contains $_.ProcessId -and $spared -notcontains $_.ProcessId -and $neverStopped -notcontains $_.Name })
      if ((Get-Date) -gt $deadline) {
        Write-SetupLog ('still held, going on: {0}; by: {1}' -f (($busy | Select-Object -First 5) -join ', '), (Format-Processes $holders))
        return
      }
      foreach ($process in $holders) {
        if ($reported -notcontains $process.ProcessId) {
          $reported += $process.ProcessId
          Write-SetupLog ('stopping {0} ({1}), which holds {2}: {3}' -f $process.Name, $process.ProcessId, $busy[0], $process.ExecutablePath)
        }
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
      }
      if ($holders.Count -eq 0 -and $reported -notcontains 0) {
        $reported += 0
        Write-SetupLog ('held by a process this script cannot name: {0}' -f (($busy | Select-Object -First 5) -join ', '))
      }
      Start-Sleep -Milliseconds 500
    }
  } catch {
    Write-SetupLog ('holders not checked: {0}' -f $_)
  }
}

# @() at each call: a function returns a lone match as the object itself, and its Count is
# not reliable in PowerShell 5.1. One process left is the usual case here, and it must not
# pass for none.
$found = @(Get-Running)
if ($found.Count -eq 0) {
  Clear-Holders
  exit 0
}
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
    Clear-Holders
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
