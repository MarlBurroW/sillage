import { writeFile } from 'node:fs/promises'
import { arch, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { app, dialog, ipcMain, Menu, MenuItem } from 'electron'
import { DiagnosticLog, diagnosticRecord } from './diagnostic-log'
import { sampleProcessTree } from './process-memory'
import { text } from './texts'
import { DIAGNOSTIC_CHANNELS } from './ipc'

export function setupDiagnostics(options: { logDir: string; serverPid: () => number | undefined; origin: () => string; isAppUrl: (url: string) => boolean }) {
  const log = new DiagnosticLog(join(options.logDir, 'performance.jsonl'))
  let sampling: Promise<void> | null = null
  const sample = (): Promise<void> => {
    if (sampling) return sampling
    sampling = (async () => {
      const memory = { mainRssBytes: 0, rendererRssBytes: 0, gpuRssBytes: 0, otherRssBytes: 0 }
      for (const metric of app.getAppMetrics()) {
        const key = metric.type === 'Browser' ? 'mainRssBytes' : metric.type === 'Tab' ? 'rendererRssBytes' : metric.type === 'GPU' ? 'gpuRssBytes' : 'otherRssBytes'
        memory[key] += metric.memory.workingSetSize * 1024
      }
      const pid = options.serverPid()
      try {
        const server = pid ? await sampleProcessTree(pid) : {}
        let heap = {}
        if (options.origin()) {
          try {
            const health = await fetch(`${options.origin()}/api/health`, { signal: AbortSignal.timeout(2000) }).then((response) => response.json()) as { heapUsedMb?: number }
            if (typeof health.heapUsedMb === 'number') heap = { serverHeapBytes: health.heapUsedMb * 1024 * 1024 }
          } catch { /* RSS remains available when the daemon cannot answer. */ }
        }
        log.add('memory', { ...memory, ...server, ...heap })
      } catch { log.add('memory', memory); log.add('memory-unavailable') }
    })().catch(() => { log.add('memory-unavailable') }).finally(() => { sampling = null })
    return sampling
  }
  const report = async () => {
    await sample()
    return { format: 1, version: app.getVersion(), platform: process.platform, osRelease: release(), arch: arch(),
      electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome,
      totalMemoryBytes: totalmem(), records: log.snapshot() }
  }
  const exportReport = async (): Promise<void> => {
    const choice = await dialog.showSaveDialog({ title: text('diagnostics'), defaultPath: 'sillage-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (choice.canceled || !choice.filePath) return
    await writeFile(choice.filePath, JSON.stringify(await report(), null, 2), { mode: 0o600 })
  }
  ipcMain.handle(DIAGNOSTIC_CHANNELS.export, async (event) => {
    if (!options.isAppUrl(event.senderFrame?.url ?? '') || event.senderFrame !== event.sender.mainFrame) throw Error('refused')
    await exportReport()
  })
  let recordWindow = 0, recorded = 0
  ipcMain.on(DIAGNOSTIC_CHANNELS.record, (event, stage: unknown, metrics: unknown) => {
    if (!options.isAppUrl(event.senderFrame?.url ?? '') || event.senderFrame !== event.sender.mainFrame) return
    // Bound event volume even if a renderer loops. Never persist arbitrary IPC payloads.
    if (Date.now() - recordWindow >= 1000) { recordWindow = Date.now(); recorded = 0 }
    if (recorded >= 20) return
    const value = diagnosticRecord(stage, metrics)
    if (value) { recorded++; log.add(value.stage, value.metrics) }
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.on('unresponsive', () => log.add('unresponsive'))
    contents.on('responsive', () => log.add('responsive'))
    contents.on('render-process-gone', (_event, details) => log.add('renderer-exit', { exitCode: details.exitCode, oom: Number(details.reason === 'oom') }))
  })
  app.on('child-process-gone', (_event, details) => log.add('child-exit', { exitCode: details.exitCode, oom: Number(details.reason === 'oom') }))
  const timer = setInterval(() => void sample(), 30_000)
  timer.unref()
  app.once('will-quit', () => clearInterval(timer))
  // Keep export reachable through the native menu even when the renderer is unresponsive.
  const menu = Menu.getApplicationMenu() ?? Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ])
  menu.append(new MenuItem({ label: text('diagnostics'), click: () => { void exportReport().catch(() => dialog.showErrorBox(text('diagnostics'), text('diagnosticsFailed'))) } }))
  Menu.setApplicationMenu(menu)
  log.add('startup')
  void sample()
  return log
}
