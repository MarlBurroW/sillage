import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { UpdateExecutor } from '../src/update/executor.js'

/** An in-app update switches to a release only after it has started and answered, on a directory of its own. */

async function release(t: TestContext, main: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-update-probe-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'server'))
  await writeFile(join(dir, 'server', 'main.js'), main)
  return dir
}

function executor() {
  const logger = { info() {}, warn() {}, error() {} }
  const instance = new UpdateExecutor({} as never, logger as never)
  return instance as unknown as { proveStarts(dir: string): Promise<void>; getStatus(): { log: string[] } }
}

test('a release that starts and answers its health route is accepted, isolated from the live service', async (t) => {
  // Records what it was given: the probe must never point at the running service's settings.
  const dir = await release(t, `
    const http = require('node:http')
    const fs = require('node:fs')
    const path = require('node:path')
    const env = process.env
    fs.writeFileSync(path.join(__dirname, '..', 'seen.json'), JSON.stringify({
      data: env.SILLAGE_DATA_DIR, config: env.SILLAGE_CONFIG, profile: env.SILLAGE_PROFILE ?? null,
      webRoot: env.SILLAGE_WEB_ROOT ?? null, node: env.NODE_ENV,
    }))
    http.createServer((request, response) => response.end('{"status":"ok"}')).listen(Number(env.SILLAGE_PORT), env.SILLAGE_HOST)
  `)
  process.env.SILLAGE_PROFILE = 'desktop'
  process.env.SILLAGE_WEB_ROOT = '/live/web'
  t.after(() => { delete process.env.SILLAGE_PROFILE; delete process.env.SILLAGE_WEB_ROOT })
  const probe = executor()
  await probe.proveStarts(dir)
  assert.match(probe.getStatus().log.at(-1) ?? '', /répond/)
  const seen = JSON.parse(await readFile(join(dir, 'seen.json'), 'utf8'))
  assert.equal(seen.node, 'production')
  assert.equal(seen.profile, null)
  assert.equal(seen.webRoot, null)
  assert.ok(seen.data.startsWith(tmpdir()) && seen.data.includes('sillage-update-probe-'), seen.data)
  assert.ok(seen.config.startsWith(tmpdir()), seen.config)
})

test('a release that crashes at boot is refused with its last words', async (t) => {
  const dir = await release(t, `console.error('Cannot find module "fastify"'); process.exit(1)`)
  await assert.rejects(executor().proveStarts(dir), /ne démarre pas.*Cannot find module "fastify".*La version en place est conservée/s)
})
