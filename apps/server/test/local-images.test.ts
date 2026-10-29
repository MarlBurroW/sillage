import assert from 'node:assert/strict'
import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { conversationPaths, worktrees } from '@sillage/db'
import { localImages } from './fixtures/local-images.js'

test('conversation images resolve linked worktrees without changing cwd or granting other file access', async (t) => {
  const h = await localImages()
  t.after(h.close)
  const raw = (path: string, base = '/api/conversations/session') => h.app.inject({ url: `${base}/file/raw?path=${encodeURIComponent(path)}` })
  const exists = (paths: string[]) => h.app.inject({ method: 'POST', url: '/api/conversations/session/files/exist', payload: { paths } })
  const relative = '.preview/image.png'
  const absolute = join(h.linked, relative)
  assert.deepEqual((await exists([relative, absolute, join(h.other, relative), '/var/tmp/private.png'])).json().files, [relative, absolute])
  for (const path of [relative, absolute]) {
    const response = await raw(path)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.rawPayload, h.png)
  }
  assert.equal((await raw(relative, '/api/projects/project')).statusCode, 404)
  assert.equal((await raw(join(h.other, relative))).statusCode, 404)
  assert.equal((await raw('../other/' + relative)).statusCode, 404)
  await symlink(join(h.other, relative), join(h.linked, 'escape.png'))
  assert.equal((await raw('escape.png')).statusCode, 404)
  assert.deepEqual((await exists(['escape.png'])).json().files, [])
  assert.equal((await h.app.inject({ url: `/api/conversations/session/file/raw?path=${encodeURIComponent(absolute)}`, headers: { 'x-test-user': 'stranger' } })).statusCode, 401)
  // Two linked trees must not silently pick different screenshots with the same name.
  h.db.insert(conversationPaths).values({ conversationId: 'session', path: h.other, lastTs: 2 }).run()
  assert.equal((await raw(relative)).statusCode, 404)
  assert.equal((await raw(absolute)).statusCode, 200)
  await writeFile(join(h.root, relative), h.png)
  assert.equal((await raw(relative)).statusCode, 200)
  h.db.update(worktrees).set({ removedAt: 3 }).where(eq(worktrees.id, 'linked')).run()
  assert.equal((await raw(absolute)).statusCode, 404)
})
