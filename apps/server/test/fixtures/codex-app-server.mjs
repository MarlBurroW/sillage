#!/usr/bin/env node
// Serveur de protocole déterministe : aucun modèle, réseau ou accès au vrai compte.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

let initialized = false
let turn = null
let nextTurn = 1
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => {
  if (method === 'turn/completed' && params.threadId === 'root') turn = null
  send({ method, params })
}
const emit = (scenario) => {
  for (const entry of scenario.notifications ?? []) notify(entry.method, entry.params)
  for (const entry of scenario.requests ?? []) send(entry)
  for (const line of scenario.lines ?? []) process.stdout.write(`${line}\n`)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync('rpc.jsonl', `${line}\n`)
  const { method, id, params } = message
  if (!method) return
  if (method === 'initialize') {
    send({ id, result: { userAgent: 'fixture' } })
    return
  }
  if (method === 'initialized') { initialized = true; return }
  if (!initialized) { send({ id, error: { code: -32002, message: 'Not initialized' } }); return }
  switch (method) {
    case 'thread/start':
    case 'thread/resume':
      send({ id, result: { thread: { id: 'root' }, model: 'fixture', cwd: process.cwd() } })
      break
    case 'skills/list': send({ id, result: { data: [] } }); break
    case 'mcpServerStatus/list': send({ id, result: { data: [], nextCursor: null } }); break
    case 'turn/start': {
      const text = params.input.find((input) => input.type === 'text')?.text ?? ''
      const scenario = text.startsWith('fixture:') ? JSON.parse(text.slice(8)) : {}
      if (!turn) {
        turn = { id: `turn-${nextTurn++}`, status: 'inProgress', items: [], error: null }
        if (!scenario.silentStart) notify('turn/started', { threadId: 'root', turn })
      }
      const response = { id, result: { turn } }
      emit(scenario)
      // Le CLI peut clore le tour AVANT d'accuser réception de turn/start.
      send(response)
      break
    }
    case 'turn/interrupt':
      if (turn) notify('turn/completed', { threadId: 'root', turn: { ...turn, status: 'interrupted' } })
      send({ id, result: {} })
      break
    case 'fixture/emit': emit(params); send({ id, result: {} }); break
    case 'fixture/error': send({ id, error: { code: -32602, message: 'Invalid fixture input', data: { retry: false } } }); break
    default: send({ id, result: {} })
  }
})
