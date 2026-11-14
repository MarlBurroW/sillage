import assert from 'node:assert/strict'

/** Regression: opening conversation also loads instruction-files object. */
export async function checkFavorites({ page, context, base, project, hero }) {
  await page.setViewportSize({ width: 1440, height: 900 })
  const url = `${base}/p/${project.id}/c/${hero.id}`
  const endpoint = `${base}/api/conversations/${hero.id}/favorite`
  const saved = async () => (await (await context.request.get(`${base}/api/conversations/${hero.id}`)).json()).favorite
  const instructions = page.waitForResponse(response => response.url().endsWith(`/api/conversations/${hero.id}/files/exist`))
  await page.goto(url)
  assert.ok((await instructions).ok())
  assert.equal(await saved(), false)

  const sidebar = page.locator('.sidebar-layout')
  const projectColumn = sidebar.locator(`[data-nav-column="project:${project.id}"]`)
  const row = projectColumn.locator(`[data-sidebar-session="${hero.id}"]`)
  const activity = sidebar.locator('[data-nav-column="activity"]')
  const favorites = activity.getByRole('region', { name: 'Favoris', exact: true })
  const favorite = favorites.locator(`[data-sidebar-session="${hero.id}"]`)
  const error = sidebar.getByRole('alert').filter({ hasText: 'La modification des favoris n’a pas été enregistrée.' })
  const show = async (space, column) => {
    if (!await column.isVisible()) await sidebar.locator(`[data-nav-space="${space}"]`).click()
    await column.waitFor()
  }
  const showActivity = () => show('activity', activity)
  const showProject = () => show(`project:${project.id}`, projectColumn)
  const openMenu = async (target) => {
    await target.getByRole('button', { name: 'Actions de la conversation', exact: true }).click()
  }
  const menuAction = async (label, target = row) => {
    await openMenu(target)
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  const write = async (method, action) => {
    const response = page.waitForResponse(response => response.url() === endpoint && response.request().method() === method)
    await action()
    assert.ok((await response).ok())
  }

  let release
  const gate = new Promise(resolve => { release = resolve })
  const pending = page.waitForRequest(request => request.url() === endpoint && request.method() === 'PUT')
  const route = async route => {
    if (route.request().method() === 'PUT') await gate
    await route.continue()
  }
  await page.route(endpoint, route)
  await menuAction('Mettre en favori')
  await pending
  await showActivity()
  await favorite.waitFor()
  await openMenu(favorite)
  assert.equal(await page.getByRole('menuitem', { name: 'Retirer des favoris', exact: true }).getAttribute('aria-disabled'), 'true', 'The newly mounted favorite shares the pending mutation')
  await page.keyboard.press('Escape')
  await showProject()
  await openMenu(row)
  assert.equal(await page.getByRole('menuitem', { name: 'Retirer des favoris', exact: true }).getAttribute('aria-disabled'), 'true')
  await page.keyboard.press('Escape')
  assert.equal(await saved(), false, 'The pending state is optimistic')
  await write('PUT', async () => release())
  await page.unroute(endpoint, route)
  assert.equal(await saved(), true, 'The request must actually reach the server after the instructions have loaded')
  await page.reload()
  await showActivity()
  await favorite.waitFor()
  assert.equal(await favorite.count(), 1)

  // Removing from favorites hides row before response: sidebar must retain error
  // and allow retry.
  const failure = route => route.fulfill({ status: 503, json: { error: { code: 'ui_favorite_failure', message: 'Simulated favorite failure' } } })
  await page.route(endpoint, failure)
  await menuAction('Retirer des favoris', favorite)
  await error.waitFor()
  await favorite.waitFor()
  assert.equal(await saved(), true)
  await page.unroute(endpoint, failure)
  await write('DELETE', () => error.getByRole('button', { name: 'Réessayer', exact: true }).click())
  await favorite.waitFor({ state: 'hidden' })
  await error.waitFor({ state: 'hidden' })
  assert.equal(await saved(), false)

  await showProject()
  await page.route(endpoint, failure)
  await menuAction('Mettre en favori')
  await error.waitFor()
  await favorite.waitFor({ state: 'hidden' })
  assert.equal(await row.locator('svg[aria-label="Favoris"]').count(), 0)
  await page.unroute(endpoint, failure)
  await write('PUT', () => error.getByRole('button', { name: 'Réessayer', exact: true }).click())
  await showActivity()
  await favorite.waitFor()
  await write('DELETE', () => menuAction('Retirer des favoris', favorite))
  await favorite.waitFor({ state: 'hidden' })
  assert.equal(await saved(), false)
  console.log('OK : favoris après chargement des consignes, ajout réel et persistant, doublon désactivé, échecs ajout/retrait visibles et réessayables.')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-navigation-trigger]').click()
  await showProject()
  await write('PUT', () => menuAction('Mettre en favori'))
  await showActivity()
  await favorite.waitFor()
  assert.equal(await sidebar.locator('..').getAttribute('aria-hidden'), 'false', 'Favoriting keeps mobile navigation open')
  await write('DELETE', () => menuAction('Retirer des favoris', favorite))
  await favorite.waitFor({ state: 'hidden' })
  assert.equal(await saved(), false)
  await page.reload()
  await page.locator('[data-navigation-trigger]').click()
  await showActivity()
  await favorite.waitFor({ state: 'hidden' })
  assert.equal(await favorite.count(), 0, 'Removal survives reloading')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/p/${project.id}/board`)
  console.log('OK : ajout/retrait sur mobile sans quitter la navigation, retrait conservé après rechargement.')
}
