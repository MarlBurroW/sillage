import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * TEMPORARY, to be removed once read: how long a Node process holding a ConPTY shell takes
 * to exit on a real Windows, by the way that shell is ended first. Run with the Node and
 * the node-pty of the packaged app, since that pair is what stops slowly.
 */

const CHILD = `
const pty = require(process.argv[2])
const { spawnSync } = require('node:child_process')
const variant = process.argv[3]
const started = Date.now()
const log = (what) => console.log('+' + (Date.now() - started) + ' ms ' + what)
const term = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
term.onData(() => {})
term.onExit(({ exitCode }) => log('exit event of the shell (' + exitCode + ')'))
setTimeout(() => {
  log('shell ' + term.pid)
  const steps = variant.split('+')
  for (const step of steps) {
    if (step === 'taskkill') {
      const result = spawnSync('taskkill', ['/pid', String(term.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
      log('taskkill: status ' + result.status + ' ' + (result.error ? result.error.message : '') + ' ' + ((result.stdout || '') + (result.stderr || '')).trim().replace(/\\s+/g, ' '))
    } else if (step === 'kill') {
      try { process.kill(term.pid); log('process.kill done') } catch (err) { log('process.kill failed: ' + err.message) }
    } else if (step === 'ptykill') {
      try { term.kill(); log('pty.kill returned') } catch (err) { log('pty.kill failed: ' + err.message) }
    }
  }
  const leave = () => { log('process.exit'); process.exit(0) }
  if (steps.includes('wait')) setTimeout(leave, 300)
  else leave()
}, 3000)
`

const VARIANTS = ['none', 'ptykill', 'ptykill+wait', 'taskkill+wait', 'taskkill+ptykill+wait', 'kill+wait', 'kill+ptykill+wait']
const CAP_MS = 30_000

function alive(pid) {
  const listed = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })
  return (listed.stdout ?? '').includes(`"${pid}"`)
}

function run(node, script, module, variant) {
  return new Promise((resolve) => {
    const began = Date.now()
    const child = spawn(node, [script, module, variant], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const cap = setTimeout(() => {
      output += `still running after ${CAP_MS} ms: killed\n`
      child.kill()
    }, CAP_MS)
    child.once('exit', (code) => {
      clearTimeout(cap)
      const took = Date.now() - began
      const shell = /shell (\d+)/.exec(output)?.[1]
      const asked = Number(/\+(\d+) ms process\.exit/.exec(output)?.[1] ?? NaN)
      // Leave the output a moment to arrive, and the shell a moment to be gone.
      setTimeout(() => {
        const lines = output.trim().split(/\r?\n/).map((line) => `      ${line}`).join('\n')
        resolve(`  ${variant}: process gone after ${took} ms (code ${code}), ${Number.isNaN(asked) ? 'exit never asked' : `exit asked at +${asked} ms`}, shell ${shell ? (alive(shell) ? 'STILL ALIVE' : 'gone') : 'unknown'}\n${lines}`)
      }, 500)
    })
  })
}

export async function probe(executable) {
  const node = join(dirname(executable), 'resources', 'node', 'node.exe')
  const module = join(dirname(executable), 'resources', 'sillage', 'node_modules', 'node-pty')
  if (!existsSync(node) || !existsSync(module)) {
    console.log(`pty stop probe: skipped, ${node} or ${module} is missing`)
    return
  }
  const scratch = await mkdtemp(join(tmpdir(), 'sillage-pty-probe-'))
  const script = join(scratch, 'probe.cjs')
  await writeFile(script, CHILD)
  console.log('pty stop probe (shell started, ended 3 s later as named, then process.exit):')
  // One after the other: side by side, their shells would share the machine's patience.
  for (const variant of VARIANTS) console.log(await run(node, script, module, variant))
  await rm(scratch, { recursive: true, force: true }).catch(() => {})
}
