import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * TEMPORARY, to be removed once read. On Windows the packaged server calls `process.exit`
 * 50 ms after it began to stop and is still there 15 s later when a terminal was open.
 * This starts that server the way the app does, opens a terminal, asks for the stop and
 * times it, for each way of leaving the server knows under SILLAGE_STOP_PROBE.
 */

const VARIANTS = process.env.SILLAGE_STOP_PROBE_ONLY?.split(',') ?? ['default', 'nokill', 'killpid', 'waitexit', 'delay100', 'delay300', 'delay1500', 'hard', 'really']
const RUNS = 2
const CAP_MS = 10_000

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function terminal(origin, headers, workspace) {
  const post = (path, body) =>
    fetch(`${origin}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json())
  const project = await post('/api/projects', { name: 'Probe', workspacePath: workspace })
  if (!project.id) return `no project: ${JSON.stringify(project).slice(0, 200)}`
  const opened = await post(`/api/projects/${project.id}/terminals`, {})
  if (!opened.id) return `no terminal: ${JSON.stringify(opened).slice(0, 200)}`
  // As the launch check does through the page: a command typed, its output read, the view closed.
  return await new Promise((resolve) => {
    let output = ''
    let socket
    const done = (what) => {
      clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        // Never opened.
      }
      resolve(what)
    }
    const timer = setTimeout(() => done(`terminal open, no output read (${output.length} bytes)`), 15_000)
    try {
      socket = new WebSocket(`${origin.replace('http', 'ws')}/api/projects/${project.id}/terminal?terminalId=${opened.id}`, { headers })
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.t === 'ready') socket.send(JSON.stringify({ t: 'input', data: 'Write-Output ("sillage-" + (40 + 2))\r' }))
        if (message.t === 'output') output += message.data
        if (output.includes('sillage-42')) done('terminal open, command run')
      }
      socket.onerror = () => done('terminal open, socket refused')
    } catch (err) {
      done(`terminal open, no socket: ${err.message}`)
    }
  })
}

async function run(node, runtime, variant) {
  const scratch = await mkdtemp(join(tmpdir(), 'sillage-stop-probe-'))
  const workspace = join(scratch, 'workspace')
  await mkdir(workspace)
  const logFile = join(scratch, 'server.log')
  const log = openSync(logFile, 'a')
  const port = await freePort()
  const child = spawn(node, [join(runtime, 'server', 'main.js')], {
    cwd: runtime,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SILLAGE_PROFILE: 'desktop',
      SILLAGE_HANDSHAKE_FD: '3',
      SILLAGE_DATA_DIR: join(scratch, 'data'),
      SILLAGE_CONFIG: join(scratch, 'config.toml'),
      SILLAGE_WEB_ROOT: join(runtime, 'web'),
      SILLAGE_HOST: '127.0.0.1',
      SILLAGE_PORT: String(port),
      SILLAGE_STOP_PROBE: variant,
    },
    stdio: ['pipe', log, log, 'pipe'],
    windowsHide: true,
  })
  closeSync(log)
  child.stdin.on('error', () => {})
  const gone = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)))

  let state = 'no handshake'
  try {
    const handshake = await Promise.race([
      new Promise((resolve, reject) => {
        let buffer = ''
        child.stdio[3].setEncoding('utf8')
        child.stdio[3].on('data', (chunk) => {
          buffer += chunk
          if (buffer.includes('\n')) resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
        })
        child.once('exit', () => reject(new Error('the server exited while starting')))
      }),
      delay(60_000).then(() => {
        throw new Error('no handshake in 60 s')
      }),
    ])
    state = await terminal(`http://127.0.0.1:${handshake.port}`, { cookie: `sillage_session=${handshake.session}` }, workspace)
    await delay(1000)
  } catch (err) {
    state = `failed before the stop: ${err.message}`
  }

  const asked = Date.now()
  child.stdin.end()
  const code = await Promise.race([gone, delay(CAP_MS, 'capped')])
  const took = Date.now() - asked
  if (code === 'capped') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  await Promise.race([gone, delay(3000)])

  // The stages the server logged while stopping, in short.
  const stages = existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('PROBE stop')).map((line) => {
        const { probe, ms } = JSON.parse(line)
        return `${probe}@${ms}`
      }).join(', ')
    : 'no log'
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  return `  ${variant}: ${code === 'capped' ? `STILL RUNNING after ${CAP_MS} ms` : `gone in ${took} ms (code ${code})`} — ${state} — ${stages}`
}

export async function probe(executable) {
  const node = join(dirname(executable), 'resources', 'node', 'node.exe')
  const runtime = join(dirname(executable), 'resources', 'sillage')
  if (!existsSync(node) || !existsSync(join(runtime, 'server', 'main.js'))) {
    console.log(`stop probe: skipped, ${node} or ${runtime} is missing`)
    return
  }
  console.log('stop probe (packaged server, a terminal open, stop asked as the app does):')
  for (let pass = 0; pass < RUNS; pass++) {
    for (const variant of VARIANTS) console.log(await run(node, runtime, variant))
  }
}
