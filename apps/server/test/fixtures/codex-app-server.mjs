#!/usr/bin/env node
// Deterministic protocol server without models, networking or real accounts.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

let initialized = false
let turn = null
let nextTurn = 1
const goalOf = (threadId, objective, status) =>
  ({ threadId, objective, status, tokenBudget: 50000, tokensUsed: 1200, timeUsedSeconds: 30, createdAt: 1, updatedAt: 2 })
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
      if (process.env.FIXTURE_CONFIG_ERROR) {
        send({ id, error: { code: -32600, message: process.env.FIXTURE_CONFIG_ERROR } })
        break
      }
      send({ id, result: {
        thread: { id: 'root' }, model: 'fixture', cwd: process.cwd(),
        // What 0.156.0+ restores from the thread's last turn on resume.
        ...(method === 'thread/resume' && process.env.FIXTURE_RESTORED_MODE ? { collaborationMode: {
          mode: process.env.FIXTURE_RESTORED_MODE, settings: { model: 'fixture', reasoning_effort: null, developer_instructions: '# Restored mode' },
        } } : {}),
      } })
      break
    // `FIXTURE_CLI_NETWORK` stands for `[sandbox_workspace_write] network_access` in config.toml,
    // `FIXTURE_CLI_TIER` for its `service_tier`;
    // without it the table is null, as on a fresh install (probed on codex-cli 0.172.0).
    case 'config/read': send({ id, result: { config: { sandbox_workspace_write: process.env.FIXTURE_CLI_NETWORK ? {
      writable_roots: [], network_access: process.env.FIXTURE_CLI_NETWORK === 'true', exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
    } : null, service_tier: process.env.FIXTURE_CLI_TIER ?? null }, origins: {}, layers: null } }); break
    // Quota resets: two credits, the second expiring first. Nothing here reaches a real account.
    case 'account/rateLimits/read': send({ id, result: {
      rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1796000000 }, secondary: null, credits: null, planType: 'pro' },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 2, credits: [
        { id: 'late', resetType: 'codexRateLimits', status: 'available', grantedAt: 1, expiresAt: 1797114566, title: 'Full reset', description: 'Granted later.' },
        { id: 'soon', resetType: 'codexRateLimits', status: 'available', grantedAt: 1, expiresAt: 1796164434, title: 'Full reset', description: 'Thanks for using Codex!' },
      ] },
    } }); break
    case 'account/rateLimitResetCredit/consume': send({ id, result: { outcome: process.env.FIXTURE_RESET_OUTCOME ?? 'reset' } }); break
    // Thread goal: `FIXTURE_GOAL` is the objective a resumed thread already carries.
    case 'thread/goal/get': send({ id, result: { goal: process.env.FIXTURE_GOAL ? goalOf(params.threadId, process.env.FIXTURE_GOAL, 'active') : null } }); break
    case 'thread/goal/set': send({ id, result: { goal: goalOf(params.threadId, params.objective ?? 'Ship it', params.status ?? 'active') } }); break
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
      // CLIs may complete turns BEFORE acknowledging turn/start.
      send(response)
      break
    }
    case 'turn/steer': {
      if (!turn || params.expectedTurnId !== turn.id) {
        send({ id, error: { code: -32600, message: 'expected turn mismatch' } })
        break
      }
      const text = params.input.find((input) => input.type === 'text')?.text ?? ''
      const turnId = turn.id
      // `fixture-late:` reproduces worst-case notifications read before acknowledgments,
      // as when sharing the same stdout chunk.
      if (text.startsWith('fixture-late:')) emit(JSON.parse(text.slice(13)))
      // Order observed on 0.163.0: steer acknowledgments precede interrupted deltas' end.
      send({ id, result: { turnId } })
      if (text.startsWith('fixture:')) emit(JSON.parse(text.slice(8)))
      break
    }
    case 'turn/interrupt':
      // `silent`: a wedged app-server that never answers; `ack`: answers but never closes the turn.
      if (process.env.FIXTURE_INTERRUPT === 'silent') break
      if (process.env.FIXTURE_INTERRUPT === 'ack') { send({ id, result: {} }); break }
      if (turn) notify('turn/completed', { threadId: 'root', turn: { ...turn, status: 'interrupted' } })
      send({ id, result: {} })
      break
    case 'fixture/emit': emit(params); send({ id, result: {} }); break
    case 'fixture/error': send({ id, error: { code: -32602, message: 'Invalid fixture input', data: { retry: false } } }); break
    default: send({ id, result: {} })
  }
})
