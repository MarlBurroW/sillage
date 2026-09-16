import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'

/** Vrais téléchargements du navigateur, uniquement dans la démo temporaire. */
export async function checkDownloads({ page, context, base, project, hero, data }) {
  assert.ok(project.workspacePath.startsWith(`${data}${sep}`))
  const folder = join(project.workspacePath, 'ui-downloads')
  await mkdir(folder)
  const binaryName = "rapport d'été (1) #+%.bin"
  const binary = Buffer.alloc(3 * 1024 * 1024 + 17, 0xa5)
  binary[0] = 0
  const fixtures = new Map([
    ['note.txt', Buffer.from('Version enregistrée sur le serveur.\n')],
    [binaryName, binary],
    ['image.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>')],
    ['document.pdf', Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')],
    ['page.html', Buffer.from('<script>window.downloadHtmlExecuted = true</script>')],
    ['vide.txt', Buffer.alloc(0)],
  ])
  for (const [name, content] of fixtures) await writeFile(join(folder, name), content)
  const endpoint = `${base}/api/projects/${project.id}/file/download`
  const downloadUrl = (path) => `${endpoint}?path=${encodeURIComponent(path)}`

  for (const [name, content] of fixtures) {
    const response = await context.request.get(downloadUrl(`ui-downloads/${name}`))
    assert.equal(response.status(), 200)
    assert.deepEqual(await response.body(), content)
    assert.equal(response.headers()['content-type'], 'application/octet-stream')
    assert.equal(response.headers()['x-content-type-options'], 'nosniff')
    assert.equal(response.headers()['cache-control'], 'no-store')
    const disposition = response.headers()['content-disposition']
    assert.ok(disposition.startsWith("attachment; filename*=UTF-8''"))
    assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]), name)
  }
  const outside = join(data, 'outside-download.txt')
  await writeFile(outside, 'Outside the workspace')
  await symlink(outside, join(folder, 'outside-link'))
  await symlink(data, join(folder, 'outside-dir'))
  await promisify(execFile)('mkfifo', [join(folder, 'pipe')])
  for (const [path, status] of [
    ['missing-file', 404], ['ui-downloads', 404], ['ui-downloads/pipe', 404],
    ['../outside-download.txt', 400], [outside, 400],
    ['ui-downloads/outside-link', 400], ['ui-downloads/outside-dir/outside-download.txt', 400],
  ]) {
    const response = await context.request.get(downloadUrl(path))
    assert.equal(response.status(), status, path)
    assert.equal(response.headers()['content-disposition'], undefined, 'An error is not a downloadable file')
  }
  const anonymous = await context.browser().newContext()
  try {
    assert.equal((await anonymous.request.get(downloadUrl('ui-downloads/note.txt'))).status(), 401)
  } finally { await anonymous.close() }

  const conversationFile = `${base}/api/conversations/${hero.id}/file`
  const worktreeResponse = await context.request.get(`${conversationFile}/download?path=src/lib/forecast.ts`)
  assert.equal(worktreeResponse.status(), 200)
  const savedWorktree = await (await context.request.get(`${conversationFile}?path=src/lib/forecast.ts`)).json()
  assert.equal((await worktreeResponse.body()).toString(), savedWorktree.content)
  const projectResponse = await context.request.get(downloadUrl('src/lib/forecast.ts'))
  assert.notDeepEqual(await projectResponse.body(), await worktreeResponse.body(), 'A conversation downloads its own worktree')
  console.log('OK : téléchargement API, gros binaire, noms Unicode, fichier vide, worktree, authentification et bornage des chemins/liens.')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/p/${project.id}/board`)
  await page.getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
  const panel = page.locator('[data-panel="workspace"]')
  await panel.getByRole('button', { name: 'Afficher l’IDE en plein écran', exact: true }).click()
  const openFile = async (path) => {
    await panel.getByRole('button', { name: 'Ouvrir un fichier', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Ouvrir un fichier', exact: true })
    await picker.getByRole('combobox').fill(path)
    await picker.getByRole('option', { name: path, exact: true }).click()
    await panel.locator('[data-editor-file]').filter({ visible: true }).waitFor()
  }
  const expectDownload = async (name, action) => {
    const pending = page.waitForEvent('download')
    await action()
    const download = await pending
    assert.equal(download.suggestedFilename(), name)
    assert.equal(await download.failure(), null)
    assert.deepEqual(await readFile(await download.path()), fixtures.get(name))
    assert.equal(page.url(), `${base}/p/${project.id}/board`, 'Downloading must keep the IDE open')
  }

  await openFile('ui-downloads/note.txt')
  const code = panel.locator('.cm-content')
  await code.fill('Brouillon local, à conserver.')
  await expectDownload('note.txt', () => panel.getByRole('button', { name: 'Télécharger la version enregistrée de ui-downloads/note.txt', exact: true }).click())
  assert.equal(await code.innerText(), 'Brouillon local, à conserver.')
  assert.equal(await panel.getByRole('button', { name: 'Enregistrer', exact: true }).isEnabled(), true)

  await panel.getByRole('button', { name: `Actions de ${binaryName}`, exact: true }).click()
  await expectDownload(binaryName, () => page.getByRole('menuitem', { name: 'Télécharger', exact: true }).click())
  await panel.getByRole('button', { name: /^page\.html(?:\s|$)/ }).click({ button: 'right' })
  await expectDownload('page.html', () => page.getByRole('menuitem', { name: 'Télécharger', exact: true }).click())
  assert.equal(await page.evaluate(() => window.downloadHtmlExecuted), undefined)

  for (const name of ['image.svg', 'document.pdf', binaryName, 'vide.txt']) {
    const path = `ui-downloads/${name}`
    await openFile(path)
    await expectDownload(name, () => panel.getByRole('button', { name: `Télécharger ${path}`, exact: true }).click())
  }
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await openFile('ui-downloads/note.txt')
    const button = panel.getByRole('button', { name: 'Télécharger la version enregistrée de ui-downloads/note.txt', exact: true })
    const bounds = await button.boundingBox()
    assert.ok(bounds.width >= 44 && bounds.height >= 44)
    await expectDownload('note.txt', () => button.click())
    assert.equal(await code.innerText(), 'Brouillon local, à conserver.')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await panel.getByRole('button', { name: 'Quitter le plein écran', exact: true }).click()
  await panel.getByRole('button', { name: 'Fermer le panneau', exact: true }).click()
  await panel.waitFor({ state: 'hidden' })
  console.log('OK : téléchargements via les deux menus et l’éditeur, images/PDF/binaire, brouillon préservé et mobile.')
}
