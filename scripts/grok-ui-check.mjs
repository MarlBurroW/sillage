import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { chromium } from 'playwright'

// Check thread rendering of Grok Build adapter journal: tools under journal names
// (including MCP via `use_tool`), permission, title-keyed question, plan with next
// modes. Mocked API, no real conversation.
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
  // Full Chromium is covered by server's AppArmor profile.
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
    await page.route('**/__grok_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="fr"><body><main id="check" style="max-width:720px;margin:24px auto;padding:16px"></main></body></html>' }))
    await page.goto(`${origin}/__grok_check`)
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
      // Tool cards read output through React Query. Provider must come from same module
      // as components, served by Vite at versioned URL read from an importing module.
      const source = await (await fetch('/src/lib/tool-output.ts')).text()
      const queryModule = /from "([^"]*react-query[^"]*)"/.exec(source)[1]
      const { QueryClient, QueryClientProvider } = await import(queryModule)
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const { ChatThread } = await import('/src/components/chat/ChatThread.tsx')
      // Bubbles have tooltips (copy button): app wraps them with this provider at root
      // (main.tsx); harness must do the same.
      const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
      const { TurnActivity } = await import('/src/components/chat/TurnActivity.tsx')
      const { applyEvent, emptyChatState } = await import('/src/lib/chat-fold.ts')
      const { buildRows } = await import('/src/lib/tool-rows.ts')
      const root = createRoot(document.getElementById('check'))
      let state = emptyChatState()
      let seq = 0
      window.appendEvent = (event) => {
        state = applyEvent(state, ++seq, Date.now(), event)
        root.render(React.createElement(QueryClientProvider, { client: queryClient },
          React.createElement(TooltipProvider, null,
            React.createElement(ChatThread, { rows: buildRows(state.items), conversationId: 'fixture', canDecide: true }),
            state.turnRunning ? React.createElement(TurnActivity, { label: 'Travail en cours' }) : null,
          ),
        ))
      }
      // Events as emitted by `apps/server/src/agents/grok/` (probed on 1.0.62).
      window.appendEvent({ type: 'turn.started' })
      window.appendEvent({ type: 'message.completed', messageId: 'think', role: 'assistant', blocks: [{ type: 'thinking', text: 'Je lis le fichier.' }], parentToolCallId: null })
      window.appendEvent({ type: 'tool.started', toolCallId: 'read', name: 'Read', input: { file_path: 'calc.py' }, parentToolCallId: null })
      window.appendEvent({ type: 'tool.completed', toolCallId: 'read', output: '1→def add(a, b):\n    return a - b\n', isError: false, durationMs: 2 })
      window.appendEvent({ type: 'tool.started', toolCallId: 'bash', name: 'Bash', input: { command: 'python3 -c "print(5)"', description: 'Vérifier' }, parentToolCallId: null })
      window.appendEvent({ type: 'tool.output_delta', toolCallId: 'bash', chunk: '5\n' })
      window.appendEvent({ type: 'tool.completed', toolCallId: 'bash', output: '5\n', isError: false, durationMs: 340 })
      window.appendEvent({ type: 'tool.started', toolCallId: 'mcp', name: 'sillage/read_card', input: { number: 45 }, parentToolCallId: null })
      window.appendEvent({ type: 'tool.completed', toolCallId: 'mcp', output: 'Carte #45', isError: false, durationMs: 12 })
      window.appendEvent({ type: 'tool.started', toolCallId: 'edit', name: 'Edit', input: { file_path: 'calc.py', old_string: '    return a - b', new_string: '    return a + b', replace_all: false }, parentToolCallId: null })
      window.appendEvent({ type: 'permission.requested', requestId: 'permission', toolName: 'Edit', input: { file_path: 'calc.py', old_string: '    return a - b', new_string: '    return a + b' },
        title: 'Edit `calc.py`', description: null, displayName: null, suggestions: [
          { id: 'allow-once', label: 'Autoriser', scope: 'once', behavior: 'allow' },
          { id: 'allow-session', label: 'Autoriser pour la session', scope: 'session', behavior: 'allow' },
          { id: 'deny', label: 'Refuser', scope: 'once', behavior: 'deny' },
        ] })
      window.appendEvent({ type: 'question.requested', requestId: 'question', blocking: true, questions: [
        { id: 'Chats ou chiens ?', header: '', question: 'Chats ou chiens ?', multiSelect: false, secret: false, allowOther: true,
          options: [{ label: 'Chats', description: 'Les chats', preview: null }, { label: 'Chiens', description: 'Les chiens', preview: null }] },
      ] })
      window.appendEvent({ type: 'plan.review_requested', requestId: 'plan', plan: '# Ajouter un README\n1. Rédiger\n2. Ajouter à la racine', followUpOptions: [
        { id: 'default', label: 'Valider et demander', hint: 'Chaque écriture et chaque commande restent soumises à ton accord' },
        { id: 'auto', label: 'Valider et laisser décider', hint: "Grok n'interrompt que pour ce qui lui paraît risqué" },
      ] })
    })
    await page.getByText('calc.py', { exact: false }).first().waitFor()
    // Consecutive completed calls collapse into one line naming them.
    await page.getByText('3 outils', { exact: true }).click()
    // Like Claude, command row shows model-written description.
    await page.getByText('Vérifier', { exact: true }).first().waitFor()
    await page.getByText('sillage/read_card', { exact: false }).first().waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'le fil ne déborde pas')

    // Permission: send decision with selected scope, then close card.
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/permissions/permission')),
      page.getByRole('button', { name: 'Autoriser pour la session', exact: true }).click(),
    ])
    assert.deepEqual(submissions.at(-1), { decision: 'allowed', scope: 'session' })
    await page.evaluate(() => {
      window.appendEvent({ type: 'permission.resolved', requestId: 'permission', decision: 'allowed', scope: 'session', decidedBy: 'test' })
      window.appendEvent({ type: 'tool.completed', toolCallId: 'edit', output: 'The file calc.py has been updated successfully.', isError: false, durationMs: 3 })
      window.appendEvent({ type: 'file.edited', toolCallId: 'edit', path: 'calc.py', action: 'modified' })
    })
    await page.getByText('Autorisé', { exact: true }).waitFor()

    // Question: Grok expects answers keyed by title.
    await page.getByText('Chats ou chiens ?', { exact: true }).waitFor()
    await page.locator('button[aria-pressed]', { hasText: 'Chats' }).click()
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/questions/question')),
      page.getByRole('button', { name: 'Envoyer', exact: true }).click(),
    ])
    assert.deepEqual(submissions.at(-1), { status: 'answered', answers: { 'Chats ou chiens ?': ['Chats'] } })
    await page.evaluate(() => {
      window.appendEvent({ type: 'question.resolved', requestId: 'question', status: 'answered', answers: { 'Chats ou chiens ?': ['Chats'] }, decidedBy: 'test' })
    })

    // Plan: both adapter-proposed continuations; “let agent decide” sends `auto`.
    await page.getByText('Ajouter un README', { exact: false }).first().waitFor()
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/plans/plan')),
      page.getByRole('button', { name: 'Valider et laisser décider', exact: true }).click(),
    ])
    assert.equal(submissions.at(-1).followUpMode, 'auto')
    await page.evaluate(() => {
      window.appendEvent({ type: 'plan.review_resolved', requestId: 'plan', decision: 'approved', followUpMode: 'auto', decidedBy: 'test' })
      window.appendEvent({ type: 'message.completed', messageId: 'final', role: 'assistant', blocks: [{ type: 'text', text: 'Corrigé : add() renvoie a + b.' }], parentToolCallId: null })
      window.appendEvent({ type: 'turn.completed', stopReason: 'completed', costUsd: 0.03, inputTokens: 10, outputTokens: 2 })
    })
    await page.getByText('Corrigé : add() renvoie a + b.', { exact: true }).last().waitFor()
    assert.equal(await page.getByText('Travail en cours', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(`OK : outils Grok, MCP, permission, question et plan (${viewport.width}px).`)
    await page.close()
  }
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  if (vite.exitCode === null) await once(vite, 'exit')
}
