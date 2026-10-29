import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { conversations, conversationShares, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { agentKindSchema, exportOptionsSchema, sillageEventSchema, type ExportDraftDto, type ExportField, type ExportOptions } from '@sillage/protocol'
import { EventLog } from '../src/events/event-log.js'
import { ConversationExports } from '../src/exports/service.js'
import { scanFields, maskFields } from '../src/exports/redaction.js'
import { registerExportRoutes } from '../src/http/routes/exports.js'
import { registerErrorHandler } from '../src/http/errors.js'
import type { Config } from '../src/config.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-export-test-'))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  for (const id of ['owner', 'other']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'p', name: 'Private project name', workspacePath: workspace, ownerId: 'owner', visibility: 'shared', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'c', projectId: 'p', userId: 'owner', title: 'A shared investigation', agent: 'codex', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  const ctx = { db, config: {
    server: { publicUrl: 'https://sillage.example' }, paths: { data: dir }, retention: { autoArchiveDays: 14, autoArchiveSchedule: '45 4 * * *' },
    limits: { maxConcurrentSessions: 10 },
  } as Config }
  const log = new EventLog(db)
  log.thread.stop()
  const app = Fastify()
  app.addHook('preHandler', async request => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? ''))).get()
  })
  registerErrorHandler(app)
  const service = registerExportRoutes(app, ctx, log)
  t.after(async () => { await app.close(); sqlite.close(); await rm(dir, { recursive: true, force: true }) })
  const add = (event: unknown) => log.append('c', sillageEventSchema.parse(event))
  const message = (id: string, role: 'user' | 'assistant', text: string) => add({ type: 'message.completed', messageId: id, role, blocks: [{ type: 'text', text }], parentToolCallId: null })
  async function wait(id: string, status: ExportDraftDto['status']) {
    for (let i = 0; i < 1000; i++) {
      const draft = service.get(id, 'owner', true)
      assert.notEqual(draft.status, 'failed', draft.error ?? 'failed')
      if (draft.status === status) return draft
      await delay(10)
    }
    throw Error('Export did not reach ' + status)
  }
  const ready = async () => wait(service.create('c', 'owner', 'en').id, 'ready')
  const analyze = async (draft: ExportDraftDto, options: Partial<ExportOptions> = {}) => {
    service.analyze(draft.id, 'owner', exportOptionsSchema.parse({ ...draft.options, ...options }))
    return wait(draft.id, 'review')
  }
  const render = async (draft: ExportDraftDto, overrides: Record<string, unknown> = {}) => {
    service.render(draft.id, 'owner', { revision: draft.revision, kept: [], manual: [], reviewedImages: [], ...overrides })
    const result = await wait(draft.id, 'complete')
    return { draft: result, html: await readFile(service.artifact(result.id, 'owner', result.revision).file, 'utf8') }
  }
  return { app, service, db, dir, workspace, ctx, log, add, message, ready, analyze, render, wait }
}

test('selection counts include off-page entries, range limits, hidden tools and individual overrides', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 85; i++) f.message('m' + i, 'user', 'Message ' + i)
  f.add({ type: 'tool.started', toolCallId: 'tool', name: 'Bash', input: { command: 'PRIVATE_BODY' }, parentToolCallId: null })
  const draft = await f.ready()
  const lastPage = f.service.items(draft.id, 'owner', 80, '')
  const tool = lastPage.items.at(-1)!
  const from = lastPage.items[0]!, to = lastPage.items.at(-2)!
  const options = { ...draft.options, tools: { mode: 'hidden' as const, input: false, output: false } }
  assert.equal(f.service.selection(draft.id, 'owner', options).included, 85)
  assert.equal(f.service.selection(draft.id, 'owner', { ...options, toolOverrides: { [tool.id]: { ...options.tools, mode: 'summary' } } }).included, 86)
  const selected = { ...options, from: from.id, to: to.id, excluded: [lastPage.items[1]!.id] }
  const summary = f.service.selection(draft.id, 'owner', selected)
  assert.equal(summary.included, 4)
  assert.equal(summary.messages, 4)
  assert.equal(summary.tools, 0)
  assert.equal(summary.from?.text, 'Message 80')
  const report = await f.analyze(draft, selected)
  assert.equal(report.fields!.filter(field => field.kind === 'message').length, summary.messages)
  assert.equal(f.service.selection(draft.id, 'owner', { ...options, from: tool.id }).included, 0)
  assert.throws(() => f.service.selection(draft.id, 'owner', { ...options, from: 'unknown' }), /Invalid/)
  const denied = await f.app.inject({ method: 'POST', url: '/api/exports/' + draft.id + '/selection', headers: { 'x-user': 'other' }, payload: selected })
  assert.equal(denied.statusCode, 404)
})

test('local scanning covers credentials, all personal identifiers, suppression comments and manual overlap', async () => {
  const key = 'ghp_' + 'A'.repeat(36)
  const fields: ExportField[] = [
    { id: 'first', entryId: null, kind: 'message', text: '// secretlint-disable\n' + key + '\npassword="private-value-713"\nmail@example.com 192.168.12.8 2001:db8::42 /Users/Alice/private/file.txt C:\\Users\\Bob\\private.txt' },
    { id: 'second', entryId: null, kind: 'output', text: 'Again private-value-713 and ' + key },
  ]
  const found = await scanFields(fields, new AbortController().signal, () => {})
  for (const kind of ['secret', 'email', 'ip', 'path']) assert.ok(found.some(f => f.kind === kind), kind)
  assert.ok(found.some(f => f.fieldId === 'first' && fields[0]!.text.slice(f.start, f.end) === key))
  assert.equal(new Set(found.filter(f => fields.find(field => field.id === f.fieldId)!.text.slice(f.start, f.end) === key).map(f => f.group)).size, 1)
  const clean = maskFields(fields, found, { revision: 1, kept: [], manual: [{ fieldId: 'second', start: 0, end: 10 }], reviewedImages: [] }, () => '[masked]')
  for (const value of clean.values()) for (const privateText of [key, 'private-value-713', 'mail@example.com', '192.168.12.8', '2001:db8::42', '/Users/Alice', 'C:\\Users\\Bob']) {
    assert.ok(!value.includes(privateText), privateText)
  }
  assert.throws(() => maskFields(fields, found, { revision: 1, kept: ['unrecognized'], manual: [], reviewedImages: [] }, () => ''), /Invalid/)
})

test('snapshot selection is immutable, excludes tools and thinking, and retains questions and plans for every CLI', async t => {
  const f = await fixture(t)
  f.message('u1', 'user', 'Investigate the issue.')
  f.add({ type: 'message.completed', role: 'assistant', messageId: 'a1', blocks: [{ type: 'thinking', text: 'PRIVATE_REASONING' }, { type: 'text', text: 'Let us check.' }] })
  f.add({ type: 'tool.started', parentToolCallId: null, toolCallId: 't', name: 'Bash', input: { command: 'PRIVATE_COMMAND', description: 'PRIVATE_TITLE' }, title: 'PRIVATE_TITLE' })
  f.add({ type: 'tool.completed', toolCallId: 't', output: 'PRIVATE_OUTPUT', isError: false, durationMs: 10 })
  f.add({ type: 'question.requested', requestId: 'q', questions: [{ id: 'q1', header: 'Approach', question: 'Which approach?', options: [{ label: 'Carefully', description: 'Check first' }] }] })
  f.add({ type: 'question.resolved', requestId: 'q', status: 'answered', decidedBy: 'owner', answers: { q1: ['Carefully'] } })
  f.add({ type: 'plan.review_requested', requestId: 'plan', plan: 'A careful plan.' })
  f.message('a2', 'assistant', 'The issue is fixed.')
  for (const agent of agentKindSchema.options) {
    f.db.update(conversations).set({ agent }).where(eq(conversations.id, 'c')).run()
    const draft = await f.ready()
    if (agent === 'claude') f.message('late', 'assistant', 'AFTER_CAPTURE')
    const report = await f.analyze(draft)
    const { html } = await f.render(report)
    for (const value of ['PRIVATE_REASONING', 'PRIVATE_COMMAND', 'PRIVATE_OUTPUT', 'PRIVATE_TITLE', 'Private project name']) assert.ok(!html.includes(value), value)
    if (agent === 'claude') assert.ok(!html.includes('AFTER_CAPTURE'))
    for (const value of ['Which approach?', 'Carefully', 'A careful plan.', 'The issue is fixed.']) assert.ok(html.includes(value), value)
    await f.service.cancel(draft.id, 'owner')
  }
})

test('full selected tool bodies are checked beyond replay previews, with independent input/output and exclusions', async t => {
  const f = await fixture(t)
  f.message('u', 'user', 'First question')
  f.add({ type: 'tool.started', parentToolCallId: null, toolCallId: 'tool', name: 'Bash', input: { command: 'INPUT_PRIVATE_SENTINEL' } })
  const secret = 'very-private-long-token-7251'
  f.add({ type: 'tool.completed', toolCallId: 'tool', output: 'a'.repeat(150_000) + '\npassword="' + secret + '"\nOUTPUT_END', isError: false, durationMs: 1 })
  f.message('a', 'assistant', 'REMOVE_THIS_MESSAGE')
  f.message('u2', 'user', 'Second question')
  const draft = await f.ready()
  const items = f.service.items(draft.id, 'owner', 0, '').items
  const tool = items.find(item => item.kind === 'tool')!
  const excluded = items.find(item => item.text.includes('REMOVE_THIS_MESSAGE'))!
  const report = await f.analyze(draft, {
    excluded: [excluded.id], tools: { mode: 'hidden', input: false, output: false },
    toolOverrides: { [tool.id]: { mode: 'details', input: false, output: true } },
  })
  assert.ok(report.fields!.some(field => field.text.includes('OUTPUT_END')))
  assert.ok(report.findings!.some(finding => report.fields!.find(field => field.id === finding.fieldId)!.text.slice(finding.start, finding.end) === secret))
  const { html } = await f.render(report)
  assert.ok(html.includes('OUTPUT_END'))
  assert.ok(html.includes('Passage not shared'))
  for (const text of [secret, 'REMOVE_THIS_MESSAGE', 'INPUT_PRIVATE_SENTINEL']) assert.ok(!html.includes(text))
  const range = await f.analyze(draft, { from: items.at(-1)!.id, to: items.at(-1)!.id })
  const last = await f.render(range)
  assert.ok(last.html.includes('Second question'))
  assert.ok(!last.html.includes('First question'))
})

test('HTML routes serve the exact artifact anonymously; ownership, stale approvals, expiry and cascades are enforced', async t => {
  const f = await fixture(t)
  f.message('u', 'user', '<script>window.EXFILTRATE=1</script> ![external](https://attacker.example/image.png)\n[internal](/api/conversations/c/events)')
  f.message('a', 'assistant', 'A safe answer with password="secret-99881".')
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/conversations/c/exports', headers: { 'x-user': 'other' }, payload: { locale: 'en' } })).statusCode, 403)
  assert.equal((await f.app.inject('/api/exports/missing')).statusCode, 401)
  const report = await f.analyze(await f.ready())
  const { draft, html } = await f.render(report)
  assert.ok(!html.includes('<script>window.EXFILTRATE'))
  assert.ok(!html.includes('src="https://attacker'))
  assert.ok(!html.includes('href="/api/'))
  assert.ok(!html.includes('secret-99881'))
  assert.throws(() => f.service.artifact(draft.id, 'owner', report.revision), /Preview/)
  const share = await f.service.publish(draft.id, 'owner', draft.revision, Date.now() + 30 * 86400_000)
  const publicPage = await f.app.inject('/s/' + share.id)
  const download = await f.app.inject({ url: '/api/exports/' + draft.id + '/html?revision=' + draft.revision + '&download=1', headers: { 'x-user': 'owner' } })
  assert.equal(publicPage.statusCode, 200)
  assert.equal(publicPage.body, html)
  assert.equal(download.body, html)
  assert.match(String(download.headers['content-disposition']), /^attachment;/)
  assert.match(String(publicPage.headers['content-security-policy']), /sandbox/)
  assert.match(String(publicPage.headers['cache-control']), /no-store/)
  assert.equal((await f.app.inject({ url: '/api/exports/' + draft.id + '/review', headers: { 'x-user': 'other' } })).statusCode, 404)
  assert.equal((await f.app.inject({ method: 'DELETE', url: '/api/conversation-shares/' + share.id, headers: { 'x-user': 'other' } })).statusCode, 404)
  await f.service.revoke(share.id, 'owner')
  assert.equal((await f.app.inject('/s/' + share.id)).statusCode, 404)
  const expired = await f.service.publish(draft.id, 'owner', draft.revision, Date.now() + 10_000)
  f.db.update(conversationShares).set({ expiresAt: 1 }).where(eq(conversationShares.id, expired.id)).run()
  assert.equal((await f.app.inject('/s/' + expired.id)).statusCode, 404)
  const deleted = await f.service.publish(draft.id, 'owner', draft.revision, null)
  await f.service.cancel(draft.id, 'owner')
  f.message('later', 'assistant', 'LATER_PRIVATE_UPDATE')
  assert.equal((await f.app.inject('/s/' + deleted.id)).body, html)
  f.db.update(conversations).set({ archivedAt: Date.now() }).where(eq(conversations.id, 'c')).run()
  assert.equal((await f.app.inject('/s/' + deleted.id)).statusCode, 200)
  f.db.delete(conversations).where(eq(conversations.id, 'c')).run()
  assert.equal((await f.app.inject('/s/' + deleted.id)).statusCode, 404)
  await f.service.cleanup()
  assert.ok(!(await readdir(join(f.dir, 'conversation-exports'))).some(file => file.startsWith('share-')))
})

test('selected images are frozen, require review, and cannot escape the workspace or fetch remote URLs', async t => {
  const f = await fixture(t)
  await writeFile(join(f.workspace, 'preview.png'), Buffer.from(png, 'base64'))
  await writeFile(join(f.dir, 'outside.png'), Buffer.from(png, 'base64'))
  await symlink(join(f.dir, 'outside.png'), join(f.workspace, 'escape.png'))
  f.message('u', 'user', '![The result](preview.png)\n![Outside](escape.png)\n![Remote](https://attacker.example/private.png)')
  const draft = await f.ready()
  const imageChoices = f.service.items(draft.id, 'owner', 0, '').items[0]!.images
  assert.equal(imageChoices[2]!.available, false)
  await assert.rejects(f.service.image(draft.id, 'owner', imageChoices[1]!.id), /Image/)
  const imageId = imageChoices[0]!.id
  const report = await f.analyze(draft, { images: [imageId] })
  await writeFile(join(f.workspace, 'preview.png'), 'Changed after review')
  assert.throws(() => f.service.render(draft.id, 'owner', { revision: report.revision, kept: [], manual: [], reviewedImages: [] }), /Review/)
  const { html } = await f.render(report, { reviewedImages: [imageId] })
  assert.ok(html.includes('data:image/png;base64,' + png))
  assert.ok(!html.includes('Changed after review'))
  assert.ok(!html.includes('escape.png'))
  assert.ok(!html.includes('attacker.example'))
})

test('Desktop and Server without a public URL retain HTML export without publishing', async t => {
  const f = await fixture(t)
  const desktop = new ConversationExports(f.ctx, f.log, false)
  t.after(() => desktop.stop())
  f.message('u', 'user', 'Export from Desktop')
  const draft = desktop.create('c', 'owner', 'fr')
  assert.equal(draft.canPublish, false)
  await assert.rejects(desktop.publish(draft.id, 'owner', 1, null), /unavailable/)
  f.ctx.config.server.publicUrl = ''
  assert.equal((await f.ready()).canPublish, false)
})

test('paged snapshots keep the opening cutoff while a streamed answer finishes later', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 300; i++) f.message('message-' + i, i % 2 ? 'assistant' : 'user', 'Exchange ' + i)
  f.add({ type: 'message.delta', messageId: 'streaming', text: 'Captured partial reply', parentToolCallId: null })
  const created = f.service.create('c', 'owner', 'en')
  f.add({ type: 'message.completed', messageId: 'streaming', role: 'assistant', blocks: [{ type: 'text', text: 'LATER_REPLACEMENT' }], parentToolCallId: null })
  const draft = await f.wait(created.id, 'ready')
  assert.equal(draft.total, 301)
  assert.equal(f.service.items(draft.id, 'owner', 0, '').next, 80)
  const last = f.service.items(draft.id, 'owner', 240, '').items.at(-1)!
  const { html } = await f.render(await f.analyze(draft, { from: last.id }))
  assert.ok(html.includes('Captured partial reply'))
  assert.ok(html.includes('Incomplete at the time of export'))
  assert.ok(!html.includes('LATER_REPLACEMENT'))
  assert.ok(!html.includes('Exchange 0'))
})

test('selecting tool text never includes binary media or inline data URLs', async t => {
  const f = await fixture(t)
  f.message('u', 'user', 'Read an image')
  f.add({ type: 'tool.started', toolCallId: 'image-tool', name: 'Read', parentToolCallId: null, input: {} })
  f.add({ type: 'tool.completed', toolCallId: 'image-tool', output: {
    content: [{ type: 'image', data: 'BINARY_PRIVATE_SENTINEL', mimeType: 'image/png' }, { type: 'text', text: 'Useful textual result' }],
    blob: 'ANOTHER_BINARY_SENTINEL', embedded: 'data:image/png;base64,' + png,
  }, isError: false, durationMs: 1 })
  const { html } = await f.render(await f.analyze(await f.ready(), { tools: { mode: 'details', input: true, output: true } }))
  assert.ok(html.includes('Useful textual result'))
  for (const value of ['BINARY_PRIVATE_SENTINEL', 'ANOTHER_BINARY_SENTINEL', png]) assert.ok(!html.includes(value))
})

test('redaction handles UTF-16 selections, overlapping findings and explicit false positives', () => {
  const field: ExportField = { id: 'text', kind: 'message', entryId: '1', text: '🪁 Project ORION mail@example.com' }
  const email = field.text.indexOf('mail@')
  const findings = [{ id: 'email', fieldId: field.id, start: email, end: field.text.length, kind: 'email' as const, group: 'g1' }]
  const clean = maskFields([field], findings, { revision: 1, kept: ['email'], reviewedImages: [],
    manual: [{ fieldId: 'text', start: 3, end: 11 }, { fieldId: 'text', start: 10, end: email - 1 }] }, () => '[masked]')
  assert.equal(clean.get('text'), '🪁 [masked] mail@example.com')
})

test('editing invalidates review artifacts, failed analysis blocks sharing, and cancellation frees drafts', async t => {
  const f = await fixture(t)
  f.message('u', 'user', 'A message')
  const { draft } = await f.render(await f.analyze(await f.ready()))
  const oldFile = f.service.artifact(draft.id, 'owner', draft.revision).file
  f.service.analyze(draft.id, 'owner', exportOptionsSchema.parse({ ...draft.options, excluded: ['unknown-entry'] }))
  for (let i = 0; i < 100 && f.service.get(draft.id, 'owner').status !== 'failed'; i++) await delay(10)
  assert.equal(f.service.get(draft.id, 'owner').status, 'failed')
  assert.throws(() => f.service.artifact(draft.id, 'owner', draft.revision), /Preview/)
  await assert.rejects(f.service.publish(draft.id, 'owner', draft.revision, null), /Preview/)
  await assert.rejects(readFile(oldFile))
  await f.service.cancel(draft.id, 'owner')
  assert.throws(() => f.service.get(draft.id, 'owner'), /expired/)
  const next = f.service.create('c', 'owner', 'en')
  await f.service.cancel(next.id, 'owner')
  assert.throws(() => f.service.get(next.id, 'owner'), /expired/)
})

test('a scanner can be cancelled without retaining a worker or an incomplete report', async () => {
  const controller = new AbortController()
  const pending = scanFields([{ id: 'large', kind: 'output', entryId: '1', text: 'safe '.repeat(100_000) }], controller.signal, () => {})
  controller.abort()
  await assert.rejects(pending, /could not be checked/)
})

test('bounded replay refuses an oversized projected row before reading its contents', async t => {
  const f = await fixture(t)
  f.message('large', 'assistant', 'x'.repeat(2048))
  assert.throws(() => f.log.readForReplay('c', 0, { rows: 10, bytes: 100, bodies: true, maxEventBytes: 1024 }), RangeError)
})

test('child events retain their provenance when native IDs are reused or later parent fields are absent', async t => {
  const f = await fixture(t)
  f.message('u', 'user', 'Only share the main conversation')
  f.add({ type: 'tool.started', toolCallId: 'reused', name: 'Read', input: {}, parentToolCallId: null })
  f.add({ type: 'tool.completed', toolCallId: 'reused', output: 'PUBLIC_PARENT_RESULT', isError: false, durationMs: 1 })
  f.add({ type: 'tool.started', toolCallId: 'reused', name: 'Read', input: {}, parentToolCallId: 'child-task' })
  f.add({ type: 'tool.completed', toolCallId: 'reused', output: 'PRIVATE_CHILD_RESULT', isError: false, durationMs: 1 })
  f.add({ type: 'message.delta', messageId: 'child-message', text: 'PRIVATE_CHILD_DELTA', parentToolCallId: 'child-task' })
  f.message('child-message', 'assistant', 'PRIVATE_CHILD_COMPLETION')
  const { html } = await f.render(await f.analyze(await f.ready(), { tools: { mode: 'details', input: true, output: true } }))
  assert.ok(html.includes('PUBLIC_PARENT_RESULT'))
  for (const value of ['PRIVATE_CHILD_RESULT', 'PRIVATE_CHILD_DELTA', 'PRIVATE_CHILD_COMPLETION']) assert.ok(!html.includes(value))
})
