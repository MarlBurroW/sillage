import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { agentRequests, boardLinks, cardIssues, cardNotes, conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { DEFAULT_BOARD_LINK_SETTINGS, type CardDto, type CardNoteDto } from '@sillage/protocol'
import { AttachmentStore } from '../src/attachments/store.js'
import { BoardSync, splitMarker } from '../src/board/board-sync.js'
import { BoardResponder, type MaintenanceEvent } from '../src/board/responder.js'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { githubRepoFromRemote, registerBoardLinkRoutes } from '../src/http/routes/board-link.js'
import { registerCardRoutes } from '../src/http/routes/cards.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import type { SessionManager } from '../src/sessions/session-manager.js'

interface FakeIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  state_reason: string | null
  labels: string[]
  user: string
  created: number
  updated: number
  closed: number | null
  pull?: boolean
}
interface FakeComment { id: number; issue: number; body: string; user: string; created: number; updated: number }

/** Un GitHub en mémoire : juste les routes que le board appelle, avec `since` et la pagination. */
function fakeGitHub() {
  const issues = new Map<number, FakeIssue>()
  const comments: FakeComment[] = []
  const calls: string[] = []
  let clock = Date.now()
  let nextComment = 1000
  let deny: number | null = null
  const tick = () => (clock += 1000)
  const iso = (ms: number) => new Date(ms).toISOString()
  const issueJson = (issue: FakeIssue) => ({
    number: issue.number,
    html_url: `https://github.com/acme/app/issues/${issue.number}`,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state_reason,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user },
    comments: comments.filter((comment) => comment.issue === issue.number).length,
    created_at: iso(issue.created),
    updated_at: iso(issue.updated),
    closed_at: issue.closed === null ? null : iso(issue.closed),
    ...(issue.pull ? { pull_request: {} } : {}),
  })
  const commentJson = (comment: FakeComment) => ({
    id: comment.id,
    html_url: `https://github.com/acme/app/issues/${comment.issue}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: comment.user },
    created_at: iso(comment.created),
    updated_at: iso(comment.updated),
    issue_url: `https://api.github.com/repos/acme/app/issues/${comment.issue}`,
  })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const fetcher = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}${url.search}`)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const path = url.pathname.replace('/repos/acme/app', '')
    const since = url.searchParams.get('since')
    const page = Number(url.searchParams.get('page') ?? 1)
    const paged = <T>(list: T[]) => list.slice((page - 1) * 100, page * 100)

    if (url.pathname === '/repos/acme/app' && method === 'GET') return json({ full_name: 'acme/app', has_issues: true })
    if (path === '/issues' && method === 'GET') {
      const state = url.searchParams.get('state')
      const label = url.searchParams.get('labels')
      const list = [...issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .filter((issue) => !label || issue.labels.includes(label))
        .filter((issue) => !since || issue.updated >= Date.parse(since))
        .sort((a, b) => a.updated - b.updated)
      return json(paged(list.map(issueJson)))
    }
    if (path === '/issues' && method === 'POST') {
      const number = Math.max(0, ...issues.keys()) + 1
      const issue: FakeIssue = { number, title: String(body.title), body: String(body.body ?? ''), state: 'open', state_reason: null, labels: (body.labels as string[]) ?? [], user: 'me', created: tick(), updated: clock, closed: null }
      issues.set(number, issue)
      return json(issueJson(issue), 201)
    }
    if (path === '/issues/comments' && method === 'GET') {
      return json(paged(comments.filter((comment) => !since || comment.updated >= Date.parse(since)).map(commentJson)))
    }
    const one = /^\/issues\/(\d+)(\/comments)?$/.exec(path)
    if (one) {
      const issue = issues.get(Number(one[1]))
      if (!issue) return json({ message: 'Not Found' }, 404)
      if (one[2] && method === 'GET') return json(paged(comments.filter((comment) => comment.issue === issue.number).map(commentJson)))
      if (one[2] && method === 'POST') {
        const comment = { id: nextComment++, issue: issue.number, body: String(body.body), user: 'me', created: tick(), updated: clock }
        comments.push(comment)
        issue.updated = clock
        return json(commentJson(comment), 201)
      }
      if (method === 'GET') return json(issueJson(issue))
      if (method === 'PATCH') {
        if (deny === issue.number) return json({ message: 'Forbidden' }, 403)
        if (typeof body.title === 'string') issue.title = body.title
        if (typeof body.body === 'string') issue.body = body.body
        if (Array.isArray(body.labels)) issue.labels = body.labels as string[]
        if (body.state === 'closed' && issue.state === 'open') issue.closed = clock
        if (body.state === 'open') issue.closed = null
        if (typeof body.state === 'string') {
          issue.state = body.state as 'open' | 'closed'
          issue.state_reason = body.state === 'closed' ? String(body.state_reason ?? 'completed') : null
        }
        issue.updated = tick()
        return json(issueJson(issue))
      }
    }
    return json({ message: `unhandled ${method} ${url.pathname}` }, 500)
  }

  const add = (issue: Partial<FakeIssue> & { number: number; title: string }) => {
    const at = tick()
    issues.set(issue.number, { body: '', state: 'open', state_reason: null, labels: [], user: 'stranger', created: at, updated: at, closed: null, ...issue })
  }
  const edit = (number: number, change: Partial<FakeIssue>) => {
    Object.assign(issues.get(number)!, change, { updated: tick() })
  }
  const comment = (issue: number, body: string, user = 'stranger', created?: number) => {
    comments.push({ id: nextComment++, issue, body, user, created: created ?? tick(), updated: tick() })
    issues.get(issue)!.updated = clock
  }
  return { fetcher, issues, comments, calls, add, edit, comment, denyPatch: (number: number | null) => (deny = number) }
}

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-board-github-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['owner', 'other']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Test', workspacePath: dir, ownerId: 'owner', visibility: 'shared', createdAt: 1 }).run()

  const github = fakeGitHub()
  const ctx = { db, config: {} as Config }
  const credentials = { resolve: (userId: string) => (userId === 'owner' ? { username: 'x', token: 'secret' } : undefined) }
  // Les sessions de maintenance ne partent pas ici : on relève ce qui les aurait ouvertes.
  const events: MaintenanceEvent[] = []
  const board = new BoardSync(ctx, credentials, github.fetcher, {
    respond: async (event) => {
      events.push(event)
      return 'launched'
    },
  })
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'owner'))).get()
  })
  registerErrorHandler(app)
  registerCardRoutes(app, ctx, new AttachmentStore(db, join(dir, 'attachments')), board)
  registerBoardLinkRoutes(app, ctx, board)
  t.after(() => app.close())

  const cardsOf = async () => (await app.inject('/api/projects/project/cards')).json() as CardDto[]
  const byIssue = async (number: number) => (await cardsOf()).find((card) => card.external?.number === number)
  const notesOf = async (cardId: string) => (await app.inject(`/api/cards/${cardId}/notes`)).json() as CardNoteDto[]
  const mcp = (name: string, args: object, conversation = '') => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: conversation },
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(result.status, 0, result.stderr)
    const reply = JSON.parse(result.stdout.trim().split('\n').pop()!) as { result: { content: Array<{ text: string }>; isError?: boolean } }
    return { text: reply.result.content.map((part) => part.text).join('\n'), isError: reply.result.isError === true }
  }
  return { app, db, board, github, events, cardsOf, byIssue, notesOf, mcp }
}

const LINK = { repo: 'acme/app', ...DEFAULT_BOARD_LINK_SETTINGS }

test('linked board: import, local cards, two-way columns, comments, publishing, hiding and unlinking', async (t) => {
  const { app, db, board, github, cardsOf, byIssue, notesOf, mcp } = await harness(t)
  const day = 86_400_000
  github.add({ number: 1, title: 'Crash on start', body: 'Steps to reproduce' })
  github.add({ number: 2, title: 'Dark mode', labels: ['in progress'] })
  github.add({ number: 3, title: 'Old bug', state: 'closed', state_reason: 'completed', closed: Date.now() - 40 * day })
  github.add({ number: 4, title: 'Recent wontfix', state: 'closed', state_reason: 'not_planned', closed: Date.now() - day })
  github.add({ number: 5, title: 'A pull request', pull: true })
  github.add({ number: 6, title: 'Crash in safe mode', body: 'Probably the same root cause as #1.' })
  github.comment(1, 'Same here on Linux')

  // Une carte locale avant la liaison : elle le reste.
  const local = (await app.inject({ method: 'POST', url: '/api/projects/project/cards', payload: { title: 'Internal refactor' } })).json() as CardDto
  assert.equal(local.external, null)

  // Seul le propriétaire relie ; un compte sans identifiant GitHub ne le pourrait pas.
  assert.equal((await app.inject({ method: 'PUT', url: '/api/projects/project/board-link', payload: LINK, headers: { 'x-user': 'other' } })).statusCode, 403)
  const linked = await app.inject({ method: 'PUT', url: '/api/projects/project/board-link', payload: LINK })
  assert.equal(linked.statusCode, 200, linked.body)
  await board.syncNow('project')

  const cards = await cardsOf()
  assert.deepEqual(cards.map((card) => card.external?.number ?? null).sort(), [1, 2, 4, 6, null], 'Open issues, recently closed ones, no PR, no old closed issue')
  // Dans une issue, `#1` est l'issue 1, pas la carte locale 1.
  const safeMode = cards.find((card) => card.external?.number === 6)!
  assert.deepEqual(safeMode.references.map((ref) => ref.title), ['Crash on start'])
  assert.equal((await byIssue(2))?.column, 'in_progress')
  assert.equal((await byIssue(4))?.column, 'abandoned')
  const crash = (await byIssue(1))!
  assert.equal(crash.description, 'Steps to reproduce')
  assert.equal(crash.external?.author, 'stranger')
  const imported = await notesOf(crash.id)
  assert.equal(imported.length, 1)
  assert.deepEqual(imported[0]!.author, { kind: 'github', login: 'stranger' })

  // Sillage → GitHub : colonne, titre.
  await app.inject({ method: 'PATCH', url: `/api/cards/${crash.id}`, payload: { column: 'review', title: 'Crash on start (macOS)' } })
  await board.syncNow('project')
  assert.deepEqual(github.issues.get(1)!.labels, ['review'])
  assert.equal(github.issues.get(1)!.title, 'Crash on start (macOS)')
  await app.inject({ method: 'PATCH', url: `/api/cards/${crash.id}`, payload: { column: 'done' } })
  await board.syncNow('project')
  assert.equal(github.issues.get(1)!.state, 'closed')
  assert.deepEqual(github.issues.get(1)!.labels, [], 'The review label leaves when the card is done')

  // GitHub → Sillage : réouverture, commentaire, label.
  github.edit(1, { state: 'open', state_reason: null, closed: null })
  github.comment(1, 'Still happening in 2.0')
  github.edit(2, { labels: ['review'] })
  db.update(boardLinks).set({ lastSyncedAt: 0 }).run()
  await board.syncNow('project')
  assert.equal((await byIssue(1))?.column, 'todo')
  assert.equal((await byIssue(2))?.column, 'review')
  assert.equal((await notesOf(crash.id)).length, 2)

  // Une note d'utilisateur publiée ; une note GitHub ne se supprime pas ici.
  const posted = await app.inject({ method: 'POST', url: `/api/cards/${crash.id}/notes`, payload: { body: 'Thanks, fixed in 2.1', publish: true } })
  assert.equal(posted.statusCode, 201, posted.body)
  await board.syncNow('project')
  assert.equal(github.comments.at(-1)!.body, 'Thanks, fixed in 2.1', 'A human note is posted as written')
  const thread = await notesOf(crash.id)
  assert.equal(thread.at(-1)!.publication, 'published')
  assert.equal(thread.length, 3, 'The published comment does not come back as a duplicate')
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/card-notes/${thread[0]!.id}` })).statusCode, 409)
  assert.equal((await app.inject({ method: 'POST', url: `/api/cards/${local.id}/notes`, payload: { body: 'x', publish: true } })).statusCode, 409)

  // Un agent : note locale par défaut, publiée signée sur demande ; carte locale ou issue.
  db.insert(conversations).values({ id: '11111111-2222-4333-8444-555555555555', projectId: 'project', userId: 'owner', title: 'Triage', agent: 'claude', config: '{}', status: 'running', cardId: crash.id, createdAt: 1, updatedAt: 1 }).run()
  const session = '11111111-2222-4333-8444-555555555555'
  const listing = mcp('list_cards', {})
  assert.match(listing.text, /Board relié aux issues de github\.com\/acme\/app/)
  assert.match(listing.text, /GitHub #1 de @stranger/)
  assert.match(mcp('read_card', { number: crash.number }).text, /@stranger sur GitHub/)
  assert.equal(mcp('add_card_note', { body: 'Root cause in loader.ts' }, session).isError, false)
  assert.equal(mcp('add_card_note', { body: 'Could you share your config?', github: true }, session).isError, false)
  // update_issue : la colonne change, le passage suivant ferme l'issue sur GitHub.
  assert.equal(mcp('update_issue', { state: 'closed', reason: 'not_planned' }, session).isError, false)
  assert.equal(mcp('update_issue', { state: 'closed' }).isError, true, 'A session without card cannot close anything')
  await board.syncNow('project')
  assert.equal(github.issues.get(1)!.state, 'closed')
  assert.equal(github.issues.get(1)!.state_reason, 'not_planned')
  const agentComment = github.comments.at(-1)!.body
  assert.match(agentComment, /^Could you share your config\?\n\n_Written by an AI agent\._\n<!-- sillage:session=11111111/)
  assert.equal(github.comments.filter((comment) => comment.body.includes('loader.ts')).length, 0, 'Work notes stay local')

  const requests = new AgentRequests(
    { db, config: {} as Config },
    {} as SessionManager,
    {} as AgentRegistry,
    undefined,
    undefined,
    board,
  )
  const ask = async (payload: object) => {
    const id = crypto.randomUUID()
    db.insert(agentRequests).values({ id, projectId: 'project', conversationId: session, kind: 'create_card', payload: JSON.stringify(payload), createdAt: Date.now() }).run()
    await requests.sweep()
    return db.select().from(agentRequests).where(eq(agentRequests.id, id)).get()!
  }
  assert.match((await ask({ title: 'Flaky test' })).result ?? '', /locale/)
  const published = await ask({ title: 'Document the config', description: 'Explain each key.', github: true })
  assert.equal(published.isError, false, published.result ?? '')
  const issue = [...github.issues.values()].find((entry) => entry.title === 'Document the config')!
  assert.match(issue.body ?? '', /^Explain each key\.\n\n_Written by an AI agent\._\n<!-- sillage:session=/)
  const docs = (await byIssue(issue.number))!
  assert.equal(docs.description, 'Explain each key.', 'The card shows the text without signature or marker')
  // La modifier ici garde la signature et la marque sur GitHub.
  await app.inject({ method: 'PATCH', url: `/api/cards/${docs.id}`, payload: { description: 'Explain every key.' } })
  await board.syncNow('project')
  assert.equal(splitMarker(github.issues.get(issue.number)!.body, DEFAULT_BOARD_LINK_SETTINGS.signature).body, 'Explain every key.')
  assert.match(github.issues.get(issue.number)!.body ?? '', /_Written by an AI agent\._\n<!-- sillage:session=/)

  // Réglage « tout sur GitHub » : une carte créée à la main devient une issue.
  await app.inject({ method: 'PUT', url: '/api/projects/project/board-link', payload: { ...LINK, newCards: 'github' } })
  const created = (await app.inject({ method: 'POST', url: '/api/projects/project/cards', payload: { title: 'From the board', column: 'in_progress' } })).json() as CardDto
  assert.ok(created.external)
  assert.deepEqual(github.issues.get(created.external.number)!.labels, ['in progress'])
  const forcedLocal = (await app.inject({ method: 'POST', url: '/api/projects/project/cards', payload: { title: 'Private note', github: false } })).json() as CardDto
  assert.equal(forcedLocal.external, null)

  // Publier une carte locale ; la détacher ; la supprimer la masque.
  const publish = await app.inject({ method: 'POST', url: `/api/cards/${local.id}/publish` })
  assert.equal(publish.statusCode, 200, publish.body)
  const refactor = publish.json() as CardDto
  assert.ok(refactor.external)
  const detached = (await app.inject({ method: 'POST', url: `/api/cards/${refactor.id}/unlink` })).json() as CardDto
  assert.equal(detached.external?.detached, true)
  github.edit(refactor.external.number, { title: 'Renamed on GitHub' })
  await app.inject({ method: 'DELETE', url: `/api/cards/${(await byIssue(4))!.id}` })
  github.edit(4, { title: 'Touched after hiding' })
  db.update(boardLinks).set({ lastSyncedAt: 0 }).run()
  await board.syncNow('project')
  assert.equal((await cardsOf()).find((card) => card.id === refactor.id)?.title, 'Internal refactor', 'A detached card is left alone')
  assert.equal(await byIssue(4), undefined, 'A hidden issue does not come back')

  // Un refus définitif de GitHub : la carte reprend l'état de l'issue, l'erreur s'affiche.
  github.denyPatch(2)
  const dark = (await byIssue(2))!
  await app.inject({ method: 'PATCH', url: `/api/cards/${dark.id}`, payload: { column: 'done' } })
  await board.syncNow('project')
  assert.equal((await byIssue(2))?.column, 'review')
  const state = (await app.inject('/api/projects/project/board-link')).json()
  assert.equal(state.link.lastError, 'board_github_forbidden')
  assert.equal(state.link.hiddenCount, 1)

  // Délier : les cartes GitHub sans travail local partent, celles qui en portent restent.
  const unlinked = await app.inject({ method: 'DELETE', url: '/api/projects/project/board-link' })
  assert.equal(unlinked.statusCode, 200, unlinked.body)
  const after = await cardsOf()
  assert.equal(after.find((card) => card.id === crash.id)?.external?.detached, true, 'The card with a session stays, local')
  assert.equal(after.find((card) => card.id === dark.id), undefined)
  assert.ok(after.find((card) => card.id === forcedLocal.id))
  assert.equal(db.select().from(cardNotes).where(eq(cardNotes.publication, 'pending')).all().length, 0)
})

test('maintenance triggers: new issues and comments without the Sillage marker, nothing else', async (t) => {
  const { app, board, github, events, byIssue } = await harness(t)
  github.add({ number: 1, title: 'Old bug', body: 'Before the link' })
  github.comment(1, 'Old comment')
  await app.inject({ method: 'PUT', url: '/api/projects/project/board-link', payload: { ...LINK, onIssue: true, onComment: true } })
  await board.syncNow('project')
  assert.deepEqual(events, [], 'What was there before the link is history, not news')

  const marker = '<!-- sillage:session=11111111-2222-4333-8444-555555555555 -->'
  github.add({ number: 2, title: 'From a stranger', body: 'Crash' })
  github.add({ number: 3, title: 'From an agent via gh', body: `Found while fixing #1\n\n${marker}` })
  github.add({ number: 4, title: 'From the owner on github.com', body: 'Idea', user: 'me' })
  github.comment(1, 'Still broken', 'stranger')
  github.comment(1, 'Me too, from my own account', 'me')
  github.comment(1, `Fixed in main\n${marker}`, 'me')
  // Un vieux commentaire qu'on découvre parce qu'il vient d'être modifié.
  github.comment(1, 'Edited long after', 'stranger', Date.now() - 86_400_000)
  await board.syncNow('project')

  const issues = events.filter((event) => event.kind === 'issue').map((event) => event.issue.number).sort()
  assert.deepEqual(issues, [2, 4], 'The author does not matter, only the marker does')
  const comments = events.flatMap((event) => (event.kind === 'comment' ? event.comments.map((comment) => comment.body) : []))
  assert.deepEqual(comments, ['Still broken', 'Me too, from my own account'])
  assert.equal(events.filter((event) => event.kind === 'comment').length, 1, 'One batch per issue')

  // Ce que Sillage publie lui-même ne revient pas comme nouveau.
  events.length = 0
  const old = (await byIssue(1))!
  await app.inject({ method: 'POST', url: `/api/cards/${old.id}/notes`, payload: { body: 'Thanks!', publish: true } })
  await board.syncNow('project')
  await board.syncNow('project')
  assert.deepEqual(events, [])

  // Déclencheurs coupés : plus rien.
  await app.inject({ method: 'PUT', url: '/api/projects/project/board-link', payload: LINK })
  github.comment(1, 'Anyone?', 'stranger')
  await board.syncNow('project')
  assert.deepEqual(events, [])
})

test('maintenance sessions: one per issue, comments follow it, archive restarts, hourly cap', async (t) => {
  const { app, db, board, github, byIssue } = await harness(t)
  github.add({ number: 7, title: 'Crash on start', body: 'Steps…', labels: ['bug'] })
  await app.inject({ method: 'PUT', url: '/api/projects/project/board-link', payload: { ...LINK, workspace: 'root' } })
  await board.syncNow('project')

  const sent: Array<{ to: string; text: string; steer?: boolean }> = []
  const sessions = {
    sendMessage: async (to: string, _id: string, text: string) => { sent.push({ to, text }) },
    steer: async (to: string, _id: string, text: string) => { sent.push({ to, text, steer: true }); return true },
  } as unknown as SessionManager
  const registry = { adapter: () => ({ resolveDefaults: async (config: object) => config }) } as unknown as AgentRegistry
  const responder = new BoardResponder({ db, config: {} as Config }, sessions, registry)
  const settings = {
    issueInstructions: 'Reproduce, then fix and push.',
    commentInstructions: 'Answer the question if you can.',
    replyStyle: 'English, short, friendly.',
    maxSessionsPerHour: 3,
  }
  db.update(boardLinks).set(settings).run()
  const link = () => db.select().from(boardLinks).get()!
  const issue = () => db.select().from(cardIssues).get()!
  const comment = (body: string) => ({ id: Math.floor(Math.random() * 1e9), html_url: 'https://github.com/acme/app/issues/7#c', body, user: { login: 'lena' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), issue_url: '' })

  assert.equal(await responder.respond({ kind: 'issue', link: link(), issue: issue() }), 'launched')
  const first = sent.at(-1)!
  const conversation = db.select().from(conversations).where(eq(conversations.id, first.to)).get()!
  assert.equal(conversation.cardId, (await byIssue(7))!.id)
  assert.equal(conversation.worktreeId, null)
  assert.equal(issue().responderId, conversation.id)
  for (const expected of ['nouvelle issue GitHub #7', 'Reproduce, then fix and push.', 'English, short, friendly.', '_Written by an AI agent._', `<!-- sillage:session=${conversation.id} -->`, 'labels : bug']) {
    assert.ok(first.text.includes(expected), `${expected} in the first prompt`)
  }
  assert.ok(!first.text.includes('Answer the question'), 'Comment instructions wait for a comment')

  assert.equal(await responder.respond({ kind: 'comment', link: link(), issue: issue(), comments: [comment('Any news?')] }), 'messaged')
  assert.equal(sent.at(-1)!.to, conversation.id)
  assert.ok(sent.at(-1)!.text.includes('> Any news?') && sent.at(-1)!.text.includes('Answer the question if you can.'))
  assert.equal(sent.at(-1)!.steer, undefined, 'Queued by default')

  db.update(boardLinks).set({ commentDelivery: 'steer', identity: 'developer' }).run()
  assert.equal(await responder.respond({ kind: 'comment', link: link(), issue: issue(), comments: [comment('Hello?')] }), 'messaged')
  assert.equal(sent.at(-1)!.steer, true)

  // Archivée : le commentaire suivant ouvre une session neuve, sans signature visible.
  db.update(conversations).set({ archivedAt: Date.now() }).where(eq(conversations.id, conversation.id)).run()
  assert.equal(await responder.respond({ kind: 'comment', link: link(), issue: issue(), comments: [comment('Ping')] }), 'limited', 'Three per hour at most')
  db.update(boardLinks).set({ maxSessionsPerHour: 10 }).run()
  assert.equal(await responder.respond({ kind: 'comment', link: link(), issue: issue(), comments: [comment('Ping')] }), 'launched')
  assert.notEqual(sent.at(-1)!.to, conversation.id)
  assert.ok(!sent.at(-1)!.text.includes('Written by an AI agent') && sent.at(-1)!.text.includes('aucune signature visible'))
  assert.ok(sent.at(-1)!.text.includes('Answer the question if you can.') && !sent.at(-1)!.text.includes('Reproduce, then fix'))
})

test('github remote URLs', () => {
  assert.equal(githubRepoFromRemote('git@github.com:MarlBurroW/sillage.git\n'), 'MarlBurroW/sillage')
  assert.equal(githubRepoFromRemote('https://github.com/acme/app'), 'acme/app')
  assert.equal(githubRepoFromRemote('https://x-access-token:abc@github.com/acme/app.git'), 'acme/app')
  assert.equal(githubRepoFromRemote('ssh://git@github.com/acme/app.git'), 'acme/app')
  assert.equal(githubRepoFromRemote('git@gitlab.com:acme/app.git'), null)
})
