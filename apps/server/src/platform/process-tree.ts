import { spawnSync } from 'node:child_process'

/** Stops processes and their descendants. Linux/macOS target groups, requiring `detached` group leaders. Windows has no such groups and detached launching would open separate consoles; `taskkill /T` walks trees and supports only definitive termination. */
export function killTree(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    // Already terminated.
  }
}
