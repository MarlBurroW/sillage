import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

// Linux source/staging harness: use an Electron executable covered by the host's sandbox profile.
const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp('/var/tmp/sillage-diagnostics-ui-')
let app
try {
  app = await electron.launch({
    executablePath: join(root, 'apps/desktop/release/linux-unpacked/sillage'),
    args: [join(root, 'apps/desktop')], chromiumSandbox: true,
    env: { ...process.env, SILLAGE_DESKTOP_USER_DATA: join(scratch, 'profile') }, timeout: 120000,
  })
  const page = await app.firstWindow({ timeout: 120000 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForURL(/\/bienvenue$/, { timeout: 60000 })
  await page.getByRole('button', { name: /Passer la visite|Skip the tour/ }).click()
  await page.getByRole('button', { name: /Créer mon premier projet|Create my first project/ }).click()
  await page.waitForURL(/\/projects\/new$/)
  const origin = new URL(page.url()).origin
  const reportFile = join(scratch, 'report.json')
  await app.evaluate(({ dialog, BrowserWindow }, reportFile) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: reportFile })
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.emit('unresponsive')
    contents.emit('responsive')
    contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 })
  }, reportFile)
  await page.evaluate(() => {
    window.sillageDesktop.diagnostics.record('thread-ready', { ms: 42, prompt: 'PRIVATE_MARKER', path: '/private/path', heapBytes: Infinity })
    window.sillageDesktop.diagnostics.record('PRIVATE_MARKER', { ms: 1 })
  })
  await page.goto(`${origin}/settings/a-propos`)
  await page.getByRole('button', { name: /Exporter le rapport|Export report/ }).click()
  let report
  for (let n = 0; n < 100; n++) {
    report = await readFile(reportFile, 'utf8').then(JSON.parse).catch(() => null)
    if (report) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(report.platform, 'linux')
  assert.equal(report.electron, '44.9.0')
  assert.ok(report.records.some((entry) => entry.stage === 'renderer-exit' && entry.metrics.oom === 1))
  assert.ok(report.records.some((entry) => entry.stage === 'unresponsive'))
  assert.ok(report.records.some((entry) => entry.stage === 'thread-ready' && entry.metrics.ms === 42))
  const memory = report.records.findLast((entry) => entry.stage === 'memory').metrics
  assert.ok(memory.mainRssBytes > 0 && memory.rendererRssBytes > 0 && memory.serverRssBytes > 0)
  assert.ok(!JSON.stringify(report).includes('PRIVATE_MARKER') && !JSON.stringify(report).includes('/private/path'))
  assert.ok(!report.records.some((entry) => 'heapBytes' in entry.metrics && entry.metrics.heapBytes === null))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ electron: report.electron, platform: report.platform, records: report.records.length, memory, export: 'passed', redaction: 'passed', simulatedLifecycleEvents: 'passed' }))
} finally {
  await app?.close()
  await rm(scratch, { recursive: true, force: true })
}
