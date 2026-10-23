import assert from 'node:assert/strict'

/** Exercise actual routes, placement and search against the disposable large-journal fixture. */
export async function checkThreadHistory(page, base, id, other) {
  const route = `/p/audit/c/${id}`
  const oldRows = page.locator('.sg-conversation-width [data-seq]')
  const initial = await oldRows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-seq')))
  const earlier = page.getByRole('button', { name: 'Load earlier activity', exact: true })
  let requested = false
  const watch = (request) => { if (request.url().includes(`/conversations/${id}/thread?before=`)) requested = true }
  page.on('request', watch)
  for (let n = 0; n < 4 && !requested; n++) {
    await earlier.click()
    await page.waitForTimeout(200)
  }
  assert.ok(requested, 'History button must fetch an older page')
  await page.waitForFunction((known) => [...document.querySelectorAll('.sg-conversation-width [data-seq]')].some((node) => !known.includes(node.getAttribute('data-seq'))), initial)
  const target = await oldRows.evaluateAll((nodes, known) => nodes.map((node) => node.getAttribute('data-seq')).find((seq) => !known.includes(seq)), initial)
  page.off('request', watch)

  // Start from a fresh JS context: cached history cannot accidentally satisfy the deep link.
  await page.goto(`${base}${route}?seq=${target}`)
  await page.locator('.sg-conversation-width.opacity-100').waitFor({ timeout: 60000 })
  const anchor = page.locator(`[data-seq="${target}"]`).first()
  await anchor.waitFor()
  assert.ok((await anchor.boundingBox()).y < 250, 'An old search anchor must be positioned near the top')

  // Reading positions intentionally live only in the current tab; use router navigation here.
  const navigate = async (href) => {
    await page.evaluate((href) => document.querySelector(`a[href="${href}"]`).click(), href)
    await page.waitForURL(base + href)
  }
  await navigate(route)
  await anchor.scrollIntoViewIfNeeded()
  await page.evaluate(() => document.querySelector('.sg-conversation-width').parentElement.scrollBy({ top: 20 }))
  await page.waitForTimeout(400)
  await navigate(`/p/audit/c/${other}`)
  await page.locator('.sg-conversation-width.opacity-100').waitFor()
  await navigate(route)
  await page.locator('.sg-conversation-width.opacity-100').waitFor({ timeout: 60000 })
  const restored = page.locator(`[data-seq="${target}"]`).first()
  await restored.waitFor()
  assert.ok((await restored.boundingBox()).y < 400, 'Reading position must survive paged reopening')

  await page.keyboard.press('Control+f')
  await page.getByPlaceholder('Search in the conversation...').fill('SILLAGE_ABSENT_SEARCH_MARKER_20261023')
  await page.getByText('Loading history…', { exact: true }).first().waitFor({ state: 'hidden', timeout: 120000 })
  await page.getByText('No results', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Load earlier activity', exact: true }).count(), 0, 'Search must cover the complete thread')
  await page.keyboard.press('Escape')
  console.log(JSON.stringify({ historyUi: 'passed', viewport: page.viewportSize(), olderPages: true, deepLink: true, readingPosition: true, completeSearch: true }))
}
