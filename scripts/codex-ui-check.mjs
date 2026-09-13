import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { chromium } from 'playwright'

// Vérifie les vrais composants avec une API simulée ; aucune conversation réelle.
const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: web, stdio: 'pipe',
})
let diagnostics = ''
vite.stderr.on('data', (chunk) => { diagnostics += chunk.toString() })
vite.stdout.resume()
let browser
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(origin).then((response) => response.ok).catch(() => false)) { ready = true; break }
    await setTimeout(100)
  }
  assert.ok(ready, diagnostics || 'Vite failed to start')
  // Le Chromium complet est couvert par le profil AppArmor du serveur.
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, locale: 'fr-FR' })
    const errors = []
    const submissions = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/api/**', async (route) => {
      submissions.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await page.route('**/__codex_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="fr"><body><main id="check" style="max-width:720px;margin:24px auto;padding:16px"></main></body></html>' }))
    await page.goto(`${origin}/__codex_check`)
    await page.evaluate(async () => {
      const refresh = (await import('/@react-refresh')).default
      refresh.injectIntoGlobalHook(window)
      window.$RefreshReg$ = () => {}
      window.$RefreshSig$ = () => (type) => type
      window.__vite_plugin_react_preamble_installed__ = true
      localStorage.setItem('sillage.locale', 'fr')
      await import('/src/styles/index.css')
      const React = (await import('/node_modules/.vite/deps/react.js')).default
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
      const { ChatThread } = await import('/src/components/chat/ChatThread.tsx')
      const { TurnActivity } = await import('/src/components/chat/TurnActivity.tsx')
      const { applyEvent, emptyChatState } = await import('/src/lib/chat-fold.ts')
      const { buildRows } = await import('/src/lib/tool-rows.ts')
      const root = createRoot(document.getElementById('check'))
      let state = emptyChatState()
      let seq = 0
      window.appendEvent = (event) => {
        state = applyEvent(state, ++seq, Date.now(), event)
        root.render(React.createElement(React.Fragment, null,
          React.createElement(ChatThread, { rows: buildRows(state.items), conversationId: 'fixture', canDecide: true }),
          state.turnRunning ? React.createElement(TurnActivity, { label: 'Travail en cours' }) : null,
        ))
      }
      window.appendEvent({ type: 'turn.started' })
      window.appendEvent({ type: 'plan.updated', items: [{ text: 'Vérifier les interactions', status: 'in_progress' }] })
      window.appendEvent({ type: 'diff.updated', files: [], patch: '--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+after' })
      window.appendEvent({ type: 'question.requested', requestId: 'request', blocking: false, questions: [
        { id: '0', header: '', question: 'Quelle couleur ?', multiSelect: false, secret: false, allowOther: true,
          options: [{ label: 'Bleu', description: '', preview: null }, { label: 'Vert', description: '', preview: null }] },
        { id: '1', header: '', question: 'Des contraintes ?', multiSelect: false, secret: false, allowOther: true, options: [] },
      ] })
      window.appendEvent({ type: 'agent.notice', code: 'test', level: 'info', message: 'Un événement reste consultable.', details: { preserved: true } })
    })
    await page.getByText("L'agent te pose une question", { exact: true }).waitFor()
    await page.getByText('Vérifier les interactions', { exact: true }).waitFor()
    await page.getByText('Changements du tour', { exact: true }).click()
    await page.getByText('+after', { exact: false }).waitFor()
    assert.equal(submissions.length, 0)
    assert.equal(await page.getByRole('button', { name: 'Vert', exact: true }).getAttribute('aria-pressed'), 'false')
    const submit = page.getByRole('button', { name: 'Envoyer', exact: true })
    assert.equal(await submit.isDisabled(), true)
    await page.getByRole('button', { name: 'Vert', exact: true }).click()
    await page.getByRole('textbox', { name: 'Des contraintes ?' }).fill('Lisible sur mobile')
    assert.equal(await submit.isEnabled(), true)
    assert.equal(await page.getByText('Travail en cours', { exact: true }).isVisible(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByText('Détails', { exact: true }).click()
    await page.getByText('"preserved": true', { exact: false }).waitFor()
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/questions/request')),
      submit.click(),
    ])
    assert.deepEqual(submissions, [{ status: 'answered', answers: { '0': ['Vert'], '1': ['Lisible sur mobile'] } }])
    await page.evaluate(() => window.appendEvent({ type: 'question.resolved', requestId: 'request', status: 'answered', answers: { '0': ['Vert'], '1': ['Lisible sur mobile'] }, decidedBy: 'test' }))
    await page.getByText('Lisible sur mobile', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    console.log(`OK : questions interactives, activité, réponse libre et détails (${viewport.width}px).`)
    await page.close()
  }
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  if (vite.exitCode === null) await once(vite, 'exit')
}
