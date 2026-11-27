import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// The benchmark creation form, its presets and the lineup dialog on disposable Server and
// Desktop instances. Presets go through the real routes; creating or continuing a benchmark is
// intercepted, so the check never launches a model. Catalogs come from the installed CLIs.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(process.env.BENCHMARK_SCRATCH ?? tmpdir(), 'sillage-lineup-'))
const shots = process.env.BENCHMARK_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-lineup-shots-')))
const processes = []
let browser

async function freePort(preferred) {
  for (const port of [...(preferred ?? []), 0]) {
    const socket = createServer()
    const ok = await new Promise((resolve) => {
      socket.once('error', () => resolve(false))
      socket.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (!ok) continue
    const chosen = socket.address().port
    await new Promise((resolve) => socket.close(resolve))
    return chosen
  }
  throw new Error('no free port')
}

function run(args, cwd, env, stdio = 'pipe') {
  const child = spawn(process.execPath, args, { cwd, env, stdio })
  processes.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
  }
  return child
}

async function ready(url, child) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

const claude = (model, extra = {}) => ({
  agent: 'claude', model, effort: 'medium', permissionMode: 'bypassPermissions', additionalDirectories: [], mcpServers: [],
  sillageMcp: true, skillLibrary: true, strictMcp: false, fastMode: false, ultracode: false, outputStyle: '', advisorModel: '',
  maxBudgetUsd: null, maxTurns: null, account: null, ...extra,
})
const codex = (model, extra = {}) => ({
  agent: 'codex', model, reasoningEffort: 'medium', collaborationMode: 'default', askForApproval: 'never', sandbox: 'danger-full-access',
  networkAccess: '', additionalDirectories: [], mcpServers: [], sillageMcp: true, skillLibrary: true, account: null, ...extra,
})

/** Ten variants across two CLIs, written worst-unknown order on purpose: sorting has work to do. */
const TEN = [
  claude('opus'), codex('gpt-6.2-astra'), claude('haiku'), codex('gpt-6.1-terra'), claude('fable'),
  codex('gpt-6-luna'), claude('sonnet'), codex('gpt-6.2-sol'), codex('gpt-6-astra'), codex('gpt-6.1-sol'),
]

/** A finished benchmark as the page reads it, to prefill a copy and to continue it. */
function stubBenchmark() {
  // The Codex variant asks for approvals: its row must say an unattended run would wait.
  const variants = [claude('opus'), claude('sonnet'), codex('gpt-6.1-terra', { askForApproval: 'on-request', sandbox: 'workspace-write' })].map((config, index) => ({
    id: `v${index + 1}`,
    label: index === 1 ? 'Sonnet maison' : ['Opus 5.5', '', 'GPT-6.1 Terra'][index],
    config,
    technicalLabel: ['claude-opus-5-5 · medium', 'Sonnet maison', 'gpt-6.1-terra · medium'][index],
    labelIsCustom: index === 1,
    model: ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-terra'][index],
    listPrice: [{ input: 4, output: 20 }, { input: 2, output: 10 }, { input: 1, output: 5 }][index],
  }))
  return {
    id: 'stub-benchmark', name: 'Transformer Benchmark 2', prompt: 'Écris un parseur de formules.\n\nDétails…', variants,
    comparisons: [{ id: 'c1', title: 'Milieu de gamme', variantIds: ['v2', 'v3'] }],
    repetitions: 1, concurrency: 3, maxDurationMinutes: 30,
    inputs: [{ filename: 'consigne.txt', mimeType: 'text/plain', sizeBytes: 1200 }],
    checkScript: 'test -f index.html\ngrep -q h1 index.html', checkTimeoutSeconds: 60, seriesId: null,
    createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 86_400_000,
    runs: variants.map((variant, index) => ({
      id: `run-${variant.id}`, variantId: variant.id, repetition: 1, status: 'succeeded', conversationId: `conv-${index}`,
      startedAt: 1, finishedAt: 90001, cliVersion: index === 2 ? '0.163.0' : '2.1.325', error: null, check: { passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 10 },
      response: 'ok', previewToken: null, rating: [4, 2, 3][index], ratingNote: null, followUps: [], files: [],
      metrics: { version: 2, durationMs: [400_000, 120_000, 80_000][index], waitingMs: 0, firstTextMs: 5000, inputTokens: 1000, outputTokens: 500,
        cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: [6.9, 2.4, 0.3][index], toolCalls: 4, toolErrors: 0, toolDurationMs: 30,
        assistantMessages: 3, outputChars: 400, contextTokens: 10000, model: variant.model, toolsByName: {} },
    })),
  }
}

const titles = (page) => page.locator('[data-lineup-row] [data-lineup-title]').allTextContents()

/** Names change as each CLI's catalog answers: wait until they hold still before comparing orders. */
async function settledTitles(page) {
  let last = null
  let since = Date.now()
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await delay(250)) {
    const current = JSON.stringify(await titles(page))
    if (current !== last) { last = current; since = Date.now() } else if (Date.now() - since > 2000) break
  }
  return JSON.parse(last)
}

async function checkForm(page, base, profile, request) {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // A preset of ten variants through the real route, then the deep link that loads it.
  const created = await request.post(`${base}/api/benchmark-presets`, { data: {
    name: `Frontier ${profile}`, variants: TEN.map((config) => ({ config })), repetitions: 1, concurrency: 2, maxDurationMinutes: 25,
    comparisons: [{ title: null, variants: [6, 3] }],
  } })
  assert.ok(created.ok(), await created.text())
  const preset = await created.json()

  for (const [size, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport)
    await page.goto(`${base}/benchmarks/new?preset=${preset.id}`)
    await page.locator('[data-lineup-row]').nth(9).waitFor()
    assert.equal(await page.locator('[data-lineup-row]').count(), 10)
    await page.locator('[data-preset-tag]').waitFor()
    await page.locator('[data-lineup-comparison]').first().waitFor()
    // Catalog names land once the CLIs answered: wait for a public name rather than an alias.
    await page.waitForFunction(() => [...document.querySelectorAll('[data-lineup-title]')].some((node) => /Opus|Sonnet|GPT/.test(node.textContent ?? '')), null, { timeout: 60_000 }).catch(() => undefined)
    await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-form.png`), fullPage: size === 'desktop' })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll')

    // One row open at a time; Escape closes it without closing anything else.
    const third = page.locator('[data-lineup-row]').nth(2)
    await third.locator('button[aria-expanded]').first().click()
    await third.locator('[data-lineup-panel]').waitFor()
    await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-expanded.png`) })
    await page.locator('[data-lineup-row]').nth(4).locator('button[aria-expanded]').first().click()
    await page.locator('[data-lineup-row]').nth(4).locator('[data-lineup-panel]').waitFor()
    assert.equal(await page.locator('[data-lineup-panel]').count(), 1, 'accordion: one open row')
    await page.locator('[data-lineup-row]').nth(4).getByRole('textbox', { name: 'Nom affiché', exact: true }).focus()
    await page.keyboard.press('Escape')
    await page.locator('[data-lineup-panel]').waitFor({ state: 'detached' })

    if (size === 'desktop') {
      // Sorting by list price puts the cheapest models first, and can be undone.
      const before = await settledTitles(page)
      await page.getByRole('button', { name: 'Trier les variantes', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Les moins chères d’abord', exact: true }).click()
      await page.locator('[data-lineup-undo]').waitFor()
      const prices = await page.locator('[data-lineup-row] [data-lineup-price]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-lineup-price')))
      const outputs = prices.map((value) => (value === 'none' ? Infinity : Number(value.split('/')[1])))
      assert.deepEqual(outputs, [...outputs].sort((a, b) => a - b), `sorted by output price: ${prices}`)
      await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-sorted.png`) })
      await page.locator('[data-lineup-undo]').getByRole('button', { name: 'Annuler', exact: true }).click()
      assert.deepEqual(await titles(page), before, 'undo restores the order')

      // Dragging the last row by its handle to the top.
      const handle = page.locator('[data-lineup-row]').nth(9).getByRole('button', { name: 'Déplacer la variante 10', exact: true })
      const target = page.locator('[data-lineup-row]').first()
      const from = await handle.boundingBox()
      const to = await target.boundingBox()
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(from.x + from.width / 2, from.y - 20, { steps: 4 })
      await page.mouse.move(to.x + 20, to.y + 4, { steps: 12 })
      await page.mouse.up()
      await delay(300)
      const dragged = await titles(page)
      assert.equal(dragged[0], before[9], 'dragged row leads')
      // The form now differs from the preset it came from.
      assert.match(await page.locator('[data-preset-tag]').textContent(), /modifié/)

      // Save as a new preset from the presets menu, then find it there.
      await page.locator('[data-presets-menu]').click()
      await page.getByRole('menuitem', { name: 'Enregistrer comme preset…', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('[data-preset-save]').waitFor()
      await dialog.getByRole('textbox', { name: 'Nom', exact: true }).fill(`Tri maison ${profile}`)
      await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-save-preset.png`) })
      await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.locator('[data-presets-menu]').click()
      await page.getByRole('menuitem', { name: new RegExp(`Tri maison ${profile}`) }).waitFor()
      await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-presets-menu.png`) })
      await page.getByRole('menuitem', { name: new RegExp(`^Frontier ${profile}`) }).click()
      await page.locator('[data-lineup-undo]').waitFor()
      assert.deepEqual(await settledTitles(page), before, 'loading the preset restores its order')

      await page.locator('[data-presets-menu]').click()
      await page.getByRole('menuitem', { name: 'Gérer les presets…', exact: true }).click()
      await page.locator('[data-presets-manage]').waitFor()
      await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-manage.png`) })
      await page.keyboard.press('Escape')
      await page.locator('[data-presets-manage]').waitFor({ state: 'detached' })

      // Several catalog models at once, up to the room left (10 of 12 here).
      await page.getByRole('button', { name: 'Ajouter des modèles', exact: true }).click()
      const adding = page.locator('[data-add-models]')
      const boxes = adding.locator('[data-add-models-list] input[type="checkbox"]')
      await boxes.first().waitFor({ timeout: 60_000 })
      await boxes.nth(0).check()
      await boxes.nth(1).check()
      assert.ok(await boxes.nth(2).isDisabled(), 'no room beyond the limit')
      await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-add-models.png`) })
      await adding.getByRole('button', { name: 'Ajouter (2)', exact: true }).click()
      await adding.waitFor({ state: 'detached' })
      assert.equal(await page.locator('[data-lineup-row]').count(), 12)
      assert.ok(await page.getByRole('button', { name: 'Ajouter une variante', exact: true }).isDisabled())
    }
  }
  assert.deepEqual(errors, [], 'no page error')
}

async function checkCopyAndContinue(page, base, profile) {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const stub = stubBenchmark()
  let created = null
  let lineup = null
  let posts = 0
  // Milliseconds the lineup save takes, to press keys while it is under way.
  let slowSave = 0
  await page.route('**/api/benchmarks', async (route) => {
    if (route.request().method() === 'POST') {
      posts += 1
      created = route.request().postDataJSON()
      return route.fulfill({ json: { ...stub, id: 'copy', name: created.name, runs: [] } })
    }
    return route.fulfill({ json: created ? [{ ...stub, id: 'copy', name: created.name, runs: [] }, stub] : [stub] })
  })
  await page.route('**/api/benchmarks/stub-benchmark/lineup', async (route) => {
    lineup = route.request().postDataJSON()
    if (slowSave) await delay(slowSave)
    return route.fulfill({ json: stub })
  })

  for (const [size, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport)
    // New from this benchmark: everything prefilled, the starting files kept by reference.
    await page.goto(`${base}/benchmarks/new?from=stub-benchmark`)
    await page.locator('[data-lineup-row]').nth(2).waitFor()
    // Only the copy suffix counts up: a number the user typed may be a model version ("Opus 5").
    assert.equal(await page.getByRole('textbox', { name: 'Nom', exact: true }).inputValue(), 'Transformer Benchmark 2 (2)')
    assert.match(await page.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), /parseur/)
    await page.locator('[data-inherited-inputs]').waitFor()
    assert.equal((await titles(page))[1], 'Sonnet maison', 'written labels travel, automatic ones are recomputed')
    assert.equal(await page.locator('[data-lineup-row]').nth(2).locator('[data-lineup-may-ask]').count(), 1, 'a mode that asks is flagged on its row')
    assert.equal(await page.locator('[data-lineup-row]').first().locator('[data-lineup-may-ask]').count(), 0)
    await page.locator('[data-lineup-comparison]').first().waitFor()
    await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-from.png`), fullPage: size === 'desktop' })

    // The copy is valid at once, and every control of the form is a plain button: none may launch
    // it, and neither may Enter in a field. Launching starts every run, so only Launch does it.
    const launchesBefore = posts
    // Names settle as each CLI's catalog answers: compare orders once they hold still.
    const lineupBefore = await settledTitles(page)
    if (size === 'desktop') {
      const opus = page.locator('[data-lineup-row]').first()
      const opusKey = await opus.getAttribute('data-lineup-row')
      await opus.locator('button[aria-controls]').first().click()
      const panel = page.locator(`[data-lineup-row="${opusKey}"] [data-lineup-panel]`)
      await panel.waitFor()
      await panel.getByRole('button', { name: 'Descendre', exact: true }).click()
      await delay(200)
      // Moving down re-inserts the row's node: focus must follow it, for the next step.
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-lineup-row]')?.getAttribute('data-lineup-row')), opusKey, 'focus stays on the moved row')
      // At the end of the list "Move down" turns disabled: focus goes to "Move up", not to the page.
      await page.keyboard.press('Enter')
      await delay(200)
      assert.equal(await page.evaluate(() => [document.activeElement?.closest('[data-lineup-row]')?.getAttribute('data-lineup-row'), document.activeElement?.getAttribute('data-lineup-move')]).then(String), [opusKey, 'up'].join(','), 'focus moves to the other move control at the end')
      await panel.getByRole('button', { name: 'Monter', exact: true }).click()
      await panel.getByRole('button', { name: 'Monter', exact: true }).click()
      await panel.getByRole('button', { name: 'Dupliquer', exact: true }).click()
      assert.equal(await page.locator('[data-lineup-row]').count(), 4)
      // The copy opens below its source; removing it brings the lineup back.
      await page.locator('[data-lineup-row]').nth(1).locator('[data-lineup-panel]').getByRole('button', { name: 'Retirer', exact: true }).click()
      assert.equal(await page.locator('[data-lineup-row]').count(), 3)
      await page.getByRole('button', { name: 'Trier les variantes', exact: true }).click()
      await page.keyboard.press('Escape')
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Ajouter des fichiers', exact: true }).click()])
      await chooser.setFiles([])
    } else {
      await page.locator('[data-inherited-inputs]').getByRole('button', { name: 'Ne pas reprendre ces fichiers', exact: true }).click()
      await page.locator('[data-inherited-inputs]').waitFor({ state: 'detached' })
    }
    await page.getByRole('textbox', { name: 'Nom', exact: true }).press('Enter')
    await page.getByRole('spinbutton', { name: 'Runs par variante', exact: true }).press('Enter')
    await delay(500)
    assert.equal(posts, launchesBefore, 'no control and no Enter launches the benchmark')
    assert.deepEqual(await settledTitles(page), lineupBefore, 'the lineup is back as it was')

    if (size === 'desktop') {
      await page.getByRole('button', { name: 'Lancer le benchmark', exact: true }).click()
      await page.waitForURL(/\/benchmarks\/copy$/)
      assert.equal(created.inputsFrom, 'stub-benchmark')
      assert.equal(created.variants.length, 3)
      assert.equal(created.variants[1].label, 'Sonnet maison')
      assert.equal(created.variants[0].label, undefined, 'automatic names are not sent')
      assert.deepEqual(created.comparisons, [{ title: 'Milieu de gamme', variants: [1, 2] }])
      assert.equal(created.checkScript, stub.checkScript)
    }

    // Continuing: a new model added after the others, an existing one renamed and moved.
    await page.goto(`${base}/benchmarks/stub-benchmark`)
    await page.locator('[data-benchmark-lineup-edit]').click()
    const dialog = page.locator('[data-benchmark-lineup-dialog]')
    await dialog.waitFor()
    await dialog.locator('[data-lineup-row]').nth(2).waitFor()
    await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-lineup-dialog.png`) })
    const first = dialog.locator('[data-lineup-row]').first()
    await first.locator('button[aria-expanded]').first().click()
    // A variant that ran shows its frozen settings as text, not as fields.
    await first.locator('[data-lineup-panel]').getByText('Ce sont les réglages avec lesquels elle a tourné', { exact: false }).waitFor()
    assert.equal(await first.locator('[data-lineup-panel]').getByRole('combobox').count(), 0)
    await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-lineup-locked.png`) })
    await first.getByRole('textbox', { name: 'Nom affiché', exact: true }).fill('Opus du jour')
    await first.getByRole('button', { name: 'Descendre', exact: true }).click()
    await dialog.getByRole('button', { name: 'Ajouter une variante', exact: true }).click()
    await dialog.locator('[data-lineup-row]').nth(3).locator('[data-lineup-panel]').waitFor()
    await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${size}-lineup-add.png`) })
    assert.match(await dialog.locator('[data-lineup-summary]').textContent(), /1 nouvelle variante · 1 run sera lancé/)
    // Escape closes the open row first, then asks before dropping unsaved edits.
    await page.keyboard.press('Escape')
    await dialog.locator('[data-lineup-panel]').waitFor({ state: 'detached' })
    assert.ok(await dialog.isVisible(), 'the window stays open')
    await page.keyboard.press('Escape')
    const discard = page.getByRole('alertdialog').or(page.getByRole('dialog').filter({ hasText: 'Abandonner tes modifications' }))
    await discard.getByRole('button', { name: 'Annuler', exact: true }).click()
    await discard.waitFor({ state: 'detached' })
    assert.equal(await dialog.locator('[data-lineup-row]').count(), 4, 'edits kept after declining to discard')
    // While the save is under way, Escape neither closes the window nor offers to discard: the
    // edits land whatever happens to the window.
    slowSave = 1500
    await dialog.locator('[data-lineup-save]').click()
    await delay(250)
    await page.keyboard.press('Escape')
    await delay(250)
    assert.equal(await discard.count(), 0, 'Escape during a save asks nothing')
    assert.ok(await dialog.isVisible(), 'the window waits for its save')
    await dialog.waitFor({ state: 'detached' })
    slowSave = 0
    assert.deepEqual(lineup.variants.slice(0, 3), [{ id: 'v2', label: 'Sonnet maison' }, { id: 'v1', label: 'Opus du jour' }, { id: 'v3', label: null }])
    assert.equal(lineup.variants[3].config.agent, 'codex')
    assert.equal(lineup.confirmRemoval, false)
    // The save names the lineup it edited, so a variant added elsewhere meanwhile is not dropped.
    assert.deepEqual(lineup.base, ['v1', 'v2', 'v3'])

    // Removing a variant that ran needs a confirmation, and says what goes with it.
    await page.locator('[data-benchmark-lineup-edit]').click()
    await dialog.waitFor()
    // On a phone the row's own actions live in its opened panel.
    const third = dialog.locator('[data-lineup-row]').nth(2)
    if (size === 'phone') await third.locator('button[aria-expanded]').first().click()
    await (size === 'phone' ? third.locator('[data-lineup-panel]').getByRole('button', { name: 'Retirer', exact: true }) : third.getByRole('button', { name: 'Retirer cette variante', exact: true })).click()
    await dialog.locator('[data-lineup-save]').click()
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog').filter({ hasText: 'Supprimer les résultats' }))
    await confirm.getByRole('button', { name: 'Supprimer et enregistrer', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(lineup.confirmRemoval, true)
    assert.equal(lineup.variants.length, 2)
  }
  await page.unroute('**/api/benchmarks')
  await page.unroute('**/api/benchmarks/stub-benchmark/lineup')
  assert.deepEqual(errors, [], 'no page error')
}

try {
  const apiPort = await freePort([7831])
  const webPort = await freePort([7832])
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n[agents.antigravity]\nenabled = false\n')
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
  }
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)
  await mkdir(shots, { recursive: true })

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const page = await context.newPage()
  await checkForm(page, base, 'server', context.request)
  await checkCopyAndContinue(page, base, 'server')

  if (process.env.BENCHMARK_SKIP_DESKTOP !== '1') {
    const webDist = join(data, 'web-dist')
    const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...env, NODE_ENV: 'production' })
    const [buildCode] = await once(build, 'exit')
    assert.equal(buildCode, 0, build.diagnostics)
    const desktop = run(['--import', 'tsx', 'src/main.ts'], serverDir, {
      ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3',
      SILLAGE_PORT: String(await freePort([7833])), SILLAGE_DATA_DIR: join(data, 'desktop-data'), SILLAGE_WEB_ROOT: webDist,
    }, ['pipe', 'pipe', 'pipe', 'pipe'])
    const handshake = await new Promise((resolve, reject) => {
      let buffer = ''
      desktop.stdio[3].setEncoding('utf8')
      desktop.stdio[3].on('data', (chunk) => {
        buffer += chunk
        const end = buffer.indexOf('\n')
        if (end !== -1) resolve(JSON.parse(buffer.slice(0, end)))
      })
      desktop.once('exit', () => reject(new Error(desktop.diagnostics)))
    })
    const origin = `http://127.0.0.1:${handshake.port}`
    const desktopContext = await browser.newContext({ serviceWorkers: 'block', locale: 'fr-FR' })
    await desktopContext.addInitScript(() => { if (window === window.top) localStorage.setItem('sillage.locale', 'fr') })
    await desktopContext.addCookies([{ name: 'sillage_session', value: handshake.session, url: origin }])
    const settings = await desktopContext.request.patch(`${origin}/api/me/settings`, { data: { onboarding: { pending: false } } })
    assert.ok(settings.ok(), await settings.text())
    const desk = await desktopContext.newPage()
    await checkForm(desk, origin, 'desktop', desktopContext.request)
    await checkCopyAndContinue(desk, origin, 'desktop')
  }
  console.log(`benchmark-lineup-ui-check: ok; screenshots: ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
