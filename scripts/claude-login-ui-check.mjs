import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Guided Claude sign-ins through success: subscription token, then gauge. Fake CLI
// replays `setup-token`/`auth login` dialogue (probed on 2.1.296), accepting codes
// starting GOOD. Count state rereads: an invalidation loop ran at forty requests
// per second here (October 13, 2026).
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-ui-check-'))
const processes = []
let browser


async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

function run(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'pipe' })
  processes.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
  }
  return child
}

async function ready(url, child) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

const FAKE_CLI = `#!/bin/bash
# Fake claude: setup-token/auth login; everything else acts like a signed-out CLI.
if [ "$1" = "--version" ]; then echo "2.1.296 (Claude Code)"; exit 0; fi
url="https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&scope=user%3Ainference&state=S$RANDOM$RANDOM"
if [ "$1" = "setup-token" ]; then
  printf 'Browser didn'"'"'t open? Use the url below to sign in\\r\\n\\033]8;id=1;%s\\007%s\\033]8;;\\007\\r\\nPaste code here if prompted > ' "$url" "\${url:0:60}"
  # Like the real CLI: rejection waits for Enter, then reopens the prompt.
  while read -r code; do
    if [ "\${code:0:4}" = "GOOD" ]; then
      printf '\\r\\nYour OAuth token (valid for 365 days):\\r\\n\\033[33msk-ant-oat01-%s\\033[39m\\r\\n' "$(printf 'A%.0s' $(seq 1 90))"
      sleep 30; exit 0
    fi
    [ -z "$code" ] && { printf 'Paste code here if prompted > '; continue; }
    printf '\\r\\nOAuth error: Invalid code. Press Enter to retry.\\r\\n'
  done
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "If the browser didn't open, visit: \${url/user%3Ainference/user%3Aprofile+user%3Ainference}"
  printf 'Paste code here if prompted > '
  read -r code
  if [ "\${code:0:4}" = "GOOD" ]; then
    echo '{"claudeAiOauth":{}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
    echo '{"oauthAccount":{"emailAddress":"perso@example.com"}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
    echo "Login successful."; exit 0
  fi
  echo "Login failed: Request failed with status code 400"; exit 1
fi
exit 1
`

try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const fake = join(data, 'claude')
  await writeFile(fake, FAKE_CLI)
  await chmod(fake, 0o755)
  const config = join(data, 'config.toml')
  await writeFile(config, `[agents.claude]\nbinary = "${fake}"\n[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n`)
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
  }
  delete env.NODE_ENV
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const polls = []
  page.on('request', (request) => { if (/\/api\/claude-accounts\/login\//.test(request.url()) && request.method() === 'GET') polls.push(Date.now()) })
  /** Rereads in the last second: a handful, never dozens. */
  const recentPolls = () => polls.filter((at) => at > Date.now() - 1000).length

  await page.goto(`${base}/settings/comptes-claude`)
  await page.getByRole('button', { name: 'Ajouter un compte' }).first().click()
  await page.getByLabel('Nom').fill('Perso')
  await page.getByRole('button', { name: 'Lancer la connexion' }).click()
  await page.getByText("Ouvrir la page d'autorisation").waitFor()

  // Rejected code, then correct code: token read, account created.
  await page.getByLabel('Code', { exact: true }).fill('BAD-' + 'x'.repeat(80))
  await page.getByRole('button', { name: 'Valider le code' }).click()
  await page.getByText(/Invalid code/).waitFor({ timeout: 15000 })
  await page.getByLabel('Code', { exact: true }).fill('GOOD-' + 'x'.repeat(80))
  await page.getByRole('button', { name: 'Valider le code' }).click()
  await page.getByText(/Perso est enregistré/).waitFor({ timeout: 15000 }).catch(async (err) => {
    console.log('PAGE:', (await page.locator('main').innerText()).slice(-900))
    throw err
  })
  await delay(2500)
  assert.ok(recentPolls() <= 2, `Relectures après la fin : ${recentPolls()} en une seconde`)
  await page.getByText('Pas de jauge d\'usage').waitFor()

  // Chained gauge: rejection restarts CLI; correct code enables it.
  await page.getByRole('button', { name: 'Activer la jauge' }).first().click()
  await page.getByText("Jauge d'usage", { exact: true }).waitFor()
  await page.getByLabel('Code', { exact: true }).fill('BAD-' + 'y'.repeat(80))
  await page.getByRole('button', { name: 'Valider le code' }).click()
  await page.getByText(/Code refusé/).waitFor({ timeout: 15000 })
  await page.getByLabel('Code', { exact: true }).fill('GOOD-' + 'y'.repeat(80))
  await page.getByRole('button', { name: 'Valider le code' }).click()
  await page.getByText(/connectée en tant que perso@example.com/).waitFor({ timeout: 15000 })
  await delay(2500)
  assert.ok(recentPolls() <= 2, `Relectures après la jauge : ${recentPolls()} en une seconde`)
  await page.getByText("Jauge d'usage active · perso@example.com").waitFor()
  await page.screenshot({ path: '/tmp/sillage-claude-login-success.png', fullPage: true })

  const accounts = await (await context.request.get(`${base}/api/claude-accounts`)).json()
  assert.deepEqual(accounts.accounts.map((entry) => [entry.label, entry.kind, entry.gauge?.email ?? null]), [['Perso', 'oauth', 'perso@example.com']])
  assert.deepEqual(errors, [])
  console.log(`OK : jeton puis jauge menés au succès, refus repris, ${polls.length} relectures en tout, sans boucle.`)
} finally {
  await browser?.close()
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}
