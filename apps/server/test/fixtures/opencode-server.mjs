#!/usr/bin/env node
// Faux `opencode serve` déterministe : aucun modèle, réseau ou accès à la base d'opencode.
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

if (process.argv.includes('--version')) {
  console.log('1.18.25')
  process.exit(0)
}

// Ce que le runner a injecté au lancement, pour que les tests le relisent.
writeFileSync('launch.json', JSON.stringify({
  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'),
  disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
  pid: process.pid,
}))

const password = process.env.OPENCODE_SERVER_PASSWORD
const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const streams = new Set()
let nextEvent = 1

const emit = (event) => {
  const frame = `data: ${JSON.stringify({ id: `evt_${nextEvent++}`, ...event })}\n\n`
  for (const stream of streams) stream.write(frame)
}

const session = (id) => ({
  id, slug: 'fixture', projectID: 'global', directory: process.cwd(), title: 'New session - 2026-01-01T00:00:00.000Z',
  version: '1.18.25', time: { created: 1, updated: 1 },
})

/** Messages rendus par `GET /session/:id/message`, que le test de fork peut remplacer. */
let messages = ['msg_1', 'msg_2', 'msg_3', 'msg_4'].map((id) => ({ info: { id }, parts: [] }))

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = createServer((request, response) => {
  if (request.headers.authorization !== expected) return json(response, 401, { message: 'Unauthorized' })

  const { pathname } = new URL(request.url, 'http://fixture')
  if (request.method === 'GET' && pathname === '/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    streams.add(response)
    request.on('close', () => streams.delete(response))
    emit({ type: 'server.connected', properties: {} })
    return
  }

  let raw = ''
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    const body = raw ? JSON.parse(raw) : null
    appendFileSync('http.jsonl', `${JSON.stringify({ method: request.method, path: pathname, body })}\n`)
    const route = `${request.method} ${pathname}`

    if (route === 'POST /session') return json(response, 200, session('ses_root'))
    // Comme le vrai : les flux ouverts restent branchés mais ne reçoivent plus rien.
    if (route === 'POST /instance/dispose') {
      streams.clear()
      return json(response, 200, true)
    }
    if (route === 'GET /config') return json(response, 200, {})
    if (route === 'GET /mcp') return json(response, 200, { declared: { status: 'connected' }, stray: { status: 'failed', error: 'boom' } })
    if (route === 'GET /command') {
      return json(response, 200, [
        { name: 'review', description: 'review changes', source: 'command', template: '', hints: ['$ARGUMENTS'] },
        { name: 'lib-skill', description: 'Library skill', source: 'skill', template: '', hints: [] },
      ])
    }
    if (route === 'GET /session/status') return json(response, 200, {})
    if (route === 'GET /config/providers') {
      return json(response, 200, {
        providers: [{ id: 'fixture', name: 'Fixture', models: { small: { id: 'small', name: 'Small', limit: { context: 1000, output: 100 }, variants: { low: {}, high: {} } } } }],
        default: { fixture: 'small' },
      })
    }
    if (route === 'GET /agent') {
      return json(response, 200, [
        { name: 'build', mode: 'primary', description: 'Default agent', permission: [], options: {} },
        { name: 'title', mode: 'primary', hidden: true, permission: [], options: {} },
        { name: 'explore', mode: 'subagent', description: 'Explores', permission: [], options: {} },
      ])
    }

    const match = /^\/session\/([^/]+)(?:\/(.+))?$/.exec(pathname)
    if (match) {
      const [, id, action] = match
      if (request.method === 'GET' && !action) {
        return id === 'ses_missing' ? json(response, 404, { name: 'NotFoundError', data: { message: 'Session not found' } }) : json(response, 200, session(id))
      }
      if (request.method === 'GET' && action === 'message') return json(response, 200, messages)
      if (action === 'fork') return json(response, 200, session('ses_fork'))
      if (action === 'abort') {
        emit({ type: 'session.error', properties: { sessionID: id, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } })
        emit({ type: 'session.idle', properties: { sessionID: id } })
        return json(response, 200, true)
      }
      if (action === 'prompt_async' || action === 'command') {
        // Le scénario voyage dans le texte du message : `fixture:{"events":[…]}`.
        const text = action === 'command' ? body.arguments : (body.parts.find((part) => part.type === 'text')?.text ?? '')
        const scenario = text.startsWith('fixture:') ? JSON.parse(text.slice(8)) : {}
        if (scenario.messages) messages = scenario.messages
        if (scenario.fail) return json(response, 400, { name: 'BadRequestError', data: { message: scenario.fail } })
        response.writeHead(204).end()
        for (const event of scenario.events ?? []) emit(event)
        return
      }
    }

    // Réponses aux permissions et aux questions, et tout le reste : accepté.
    json(response, 200, true)
  })
})

// Le port vient du runner, comme pour le vrai : `serve --port <n>`.
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
server.listen(port, '127.0.0.1', () => {
  console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`)
})
process.on('SIGTERM', () => process.exit(0))
