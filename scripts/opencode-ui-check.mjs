import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { chromium } from 'playwright'

// Vérifie que le fil rend ce que l'adaptateur opencode journalise : outils sous leurs noms
// du journal, sous-agent, permission et question. API simulée, aucune conversation réelle.
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
    await page.route('**/__opencode_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="fr"><body><main id="check" style="max-width:720px;margin:24px auto;padding:16px"></main></body></html>' }))
    await page.goto(`${origin}/__opencode_check`)
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
      // Les cartes d'outils lisent leur sortie par React Query. Le fournisseur doit venir
      // du même module que celui des composants, que Vite sert sous une URL versionnée :
      // elle se lit dans un module qui l'importe.
      const source = await (await fetch('/src/lib/tool-output.ts')).text()
      const queryModule = /from "([^"]*react-query[^"]*)"/.exec(source)[1]
      const { QueryClient, QueryClientProvider } = await import(queryModule)
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const { ChatThread } = await import('/src/components/chat/ChatThread.tsx')
      const { TurnActivity } = await import('/src/components/chat/TurnActivity.tsx')
      const { applyEvent, emptyChatState } = await import('/src/lib/chat-fold.ts')
      const { buildRows } = await import('/src/lib/tool-rows.ts')
      const root = createRoot(document.getElementById('check'))
      let state = emptyChatState()
      let seq = 0
      window.appendEvent = (event) => {
        state = applyEvent(state, ++seq, Date.now(), event)
        root.render(React.createElement(QueryClientProvider, { client: queryClient },
          React.createElement(ChatThread, { rows: buildRows(state.items), conversationId: 'fixture', canDecide: true }),
          state.turnRunning ? React.createElement(TurnActivity, { label: 'Travail en cours' }) : null,
        ))
      }
      // Les événements tels que `apps/server/src/agents/opencode/` les émet.
      window.appendEvent({ type: 'turn.started' })
      window.appendEvent({ type: 'tool.started', toolCallId: 'read', name: 'Read', input: { file_path: 'src/note.txt' }, parentToolCallId: null })
      window.appendEvent({ type: 'tool.completed', toolCallId: 'read', output: '<content>\n1: hello\n</content>', isError: false, durationMs: 4 })
      window.appendEvent({ type: 'tool.started', toolCallId: 'bash', name: 'Bash', input: {}, parentToolCallId: null })
      window.appendEvent({ type: 'tool.input_updated', toolCallId: 'bash', input: { command: 'echo sortie-en-flux' } })
      window.appendEvent({ type: 'tool.output_delta', toolCallId: 'bash', chunk: 'sortie-en-flux\n' })
      window.appendEvent({ type: 'tool.completed', toolCallId: 'bash', output: 'sortie-en-flux\n', isError: false, durationMs: 12 })
      window.appendEvent({ type: 'tool.started', toolCallId: 'task', name: 'Agent', input: { description: 'Explorer le dossier', prompt: 'Liste les fichiers', subagent_type: 'explore' }, parentToolCallId: null })
      window.appendEvent({ type: 'tool.started', toolCallId: 'inner', name: 'Glob', input: { pattern: '**/*.txt' }, parentToolCallId: 'task' })
      window.appendEvent({ type: 'tool.completed', toolCallId: 'inner', output: 'src/note.txt', isError: false, durationMs: 2 })
      window.appendEvent({ type: 'tool.completed', toolCallId: 'task', output: 'Un fichier trouvé.', isError: false, durationMs: 40 })
      window.appendEvent({ type: 'tool.started', toolCallId: 'edit', name: 'Edit', input: { file_path: 'src/note.txt', old_string: 'hello', new_string: 'hello world' }, parentToolCallId: null })
      window.appendEvent({ type: 'permission.requested', requestId: 'permission', toolName: 'Edit', input: { file_path: 'src/note.txt', diff: '@@ -1 +1 @@\n-hello\n+hello world' },
        title: null, description: null, displayName: null, suggestions: [
          { id: 'allow-once', label: 'Autoriser', scope: 'once', behavior: 'allow' },
          { id: 'allow-session', label: 'Autoriser pour la session', scope: 'session', behavior: 'allow' },
          { id: 'deny', label: 'Refuser', scope: 'once', behavior: 'deny' },
        ] })
      window.appendEvent({ type: 'question.requested', requestId: 'question', blocking: true, questions: [
        { id: '0', header: 'Casse', question: 'Majuscules ou minuscules ?', multiSelect: false, secret: false, allowOther: true,
          options: [{ label: 'Majuscules', description: 'NOTE.TXT', preview: null }, { label: 'Minuscules', description: 'note.txt', preview: null }] },
      ] })
    })
    await page.getByText('src/note.txt', { exact: false }).first().waitFor()
    await page.getByText('Explorer le dossier', { exact: false }).first().waitFor()
    // Deux appels terminés à la suite se replient en une ligne, qui les nomme.
    await page.getByText('2 outils', { exact: true }).click()
    await page.getByText('echo sortie-en-flux', { exact: false }).first().waitFor()
    await page.getByText('Voir le fil du sous-agent', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'le fil ne déborde pas')

    // Permission : la décision part avec la portée choisie, puis la carte se referme.
    await page.getByText('Edit demande une autorisation', { exact: true }).waitFor()
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/permissions/permission')),
      page.getByRole('button', { name: 'Autoriser pour la session', exact: true }).click(),
    ])
    assert.deepEqual(submissions.at(-1), { decision: 'allowed', scope: 'session' })
    await page.evaluate(() => {
      window.appendEvent({ type: 'permission.resolved', requestId: 'permission', decision: 'allowed', scope: 'session', decidedBy: 'test' })
      window.appendEvent({ type: 'tool.completed', toolCallId: 'edit', output: 'Edit applied successfully.', isError: false, durationMs: 3 })
      window.appendEvent({ type: 'file.edited', toolCallId: 'edit', path: 'src/note.txt', action: 'modified' })
    })
    await page.getByText('Autorisé', { exact: true }).waitFor()

    // Question : opencode attend les réponses dans l'ordre, la clé est le rang.
    await page.getByText('Majuscules ou minuscules ?', { exact: true }).waitFor()
    await page.locator('button[aria-pressed]', { hasText: 'Majuscules' }).click()
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/questions/question')),
      page.getByRole('button', { name: 'Envoyer', exact: true }).click(),
    ])
    assert.deepEqual(submissions.at(-1), { status: 'answered', answers: { '0': ['Majuscules'] } })
    await page.evaluate(() => {
      window.appendEvent({ type: 'question.resolved', requestId: 'question', status: 'answered', answers: { '0': ['Majuscules'] }, decidedBy: 'test' })
      window.appendEvent({ type: 'message.completed', messageId: 'final', role: 'assistant', blocks: [{ type: 'text', text: 'NOTE.TXT' }], parentToolCallId: null })
      window.appendEvent({ type: 'turn.completed', stopReason: 'completed', costUsd: 0, inputTokens: 10, outputTokens: 2 })
    })
    await page.getByText('NOTE.TXT', { exact: true }).last().waitFor()
    assert.equal(await page.getByText('Travail en cours', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(`OK : outils opencode, sous-agent, permission et question (${viewport.width}px).`)
    await page.close()
  }
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  if (vite.exitCode === null) await once(vite, 'exit')
}
