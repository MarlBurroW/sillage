import assert from 'node:assert/strict'

/** Régression : une conversation ouverte charge aussi l'objet des fichiers de consignes. */
export async function checkFavorites({ page, context, base, project, hero }) {
  await page.setViewportSize({ width: 1440, height: 900 })
  const url = `${base}/p/${project.id}/c/${hero.id}`
  const endpoint = `${base}/api/conversations/${hero.id}/favorite`
  const saved = async () => (await (await context.request.get(`${base}/api/conversations/${hero.id}`)).json()).favorite
  const instructions = page.waitForResponse(response => response.url().endsWith(`/api/conversations/${hero.id}/files/exist`))
  await page.goto(url)
  assert.ok((await instructions).ok())
  assert.equal(await saved(), false)

  const sidebar = page.locator('aside')
  const projectGroup = sidebar.locator(`a[title="${project.name}"]`).locator('xpath=../..')
  const row = projectGroup.locator(`a[href="/p/${project.id}/c/${hero.id}"]`).locator('..')
  const heading = sidebar.getByRole('button', { name: /^Favoris\s+1$/ })
  const favorites = heading.locator('..')
  const error = sidebar.getByRole('alert').filter({ hasText: 'La modification des favoris n’a pas été enregistrée.' })
  const menuAction = async (label) => {
    await row.getByRole('button', { name: 'Actions de la conversation', exact: true }).click()
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
  await heading.waitFor()
  const favoriteStar = favorites.getByRole('button', { name: 'Retirer des favoris', exact: true })
  assert.equal(await favoriteStar.isDisabled(), true, 'The newly mounted favorite shares the pending mutation')
  assert.equal(await row.getByRole('button', { name: 'Retirer des favoris', exact: true }).isDisabled(), true)
  assert.equal(await saved(), false, 'The pending state is optimistic')
  await write('PUT', async () => release())
  await page.unroute(endpoint, route)
  assert.equal(await saved(), true, 'The request must actually reach the server after the instructions have loaded')
  await page.reload()
  await heading.waitFor()
  assert.equal(await favorites.locator(`a[href="/p/${project.id}/c/${hero.id}"]`).count(), 1)

  // Retirer depuis les favoris fait disparaître la ligne avant la réponse :
  // l'erreur doit rester portée par la sidebar et permettre de réessayer.
  const failure = route => route.fulfill({ status: 503, json: { error: { code: 'ui_favorite_failure', message: 'Simulated favorite failure' } } })
  await page.route(endpoint, failure)
  await favoriteStar.click()
  await error.waitFor()
  await favoriteStar.waitFor()
  assert.equal(await saved(), true)
  await page.unroute(endpoint, failure)
  await write('DELETE', () => error.getByRole('button', { name: 'Réessayer', exact: true }).click())
  await heading.waitFor({ state: 'hidden' })
  await error.waitFor({ state: 'hidden' })
  assert.equal(await saved(), false)

  await page.route(endpoint, failure)
  await menuAction('Mettre en favori')
  await error.waitFor()
  await heading.waitFor({ state: 'hidden' })
  assert.equal(await row.getByRole('button', { name: 'Retirer des favoris', exact: true }).count(), 0)
  await page.unroute(endpoint, failure)
  await write('PUT', () => error.getByRole('button', { name: 'Réessayer', exact: true }).click())
  await heading.waitFor()
  await write('DELETE', () => menuAction('Retirer des favoris'))
  await heading.waitFor({ state: 'hidden' })
  assert.equal(await saved(), false)
  console.log('OK : favoris après chargement des consignes, ajout réel et persistant, doublon désactivé, échecs ajout/retrait visibles et réessayables.')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-navigation-trigger]').click()
  await write('PUT', () => menuAction('Mettre en favori'))
  await heading.waitFor()
  assert.equal(await sidebar.getAttribute('aria-hidden'), 'false', 'Favoriting keeps mobile navigation open')
  await write('DELETE', () => row.getByRole('button', { name: 'Retirer des favoris', exact: true }).click())
  await heading.waitFor({ state: 'hidden' })
  assert.equal(await saved(), false)
  await page.reload()
  await page.locator('[data-navigation-trigger]').click()
  await row.waitFor()
  assert.equal(await heading.count(), 0, 'Removal survives reloading')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/p/${project.id}/board`)
  console.log('OK : ajout/retrait sur mobile sans quitter la navigation, retrait conservé après rechargement.')
}
