import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const base = process.env.TYPING_PROPOSALS_URL ?? 'http://marldev.tail710c78.ts.net:7476'
const output = process.env.TYPING_PROPOSALS_OUTPUT ?? '/var/tmp/sillage-typing-ui'
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base)
  await page.getByRole('heading', { name: 'Une idée prend forme.' }).waitFor()
  assert.equal(await page.locator('[data-choice]').count(), 6)
  await page.waitForTimeout(600)
  await page.screenshot({ path: output + '/desktop-dark.png', fullPage: true })
  for (const name of ['echo', 'wave', 'orbit', 'ink', 'stars', 'breath']) {
    await page.locator('[data-choice="' + name + '"]').click()
    assert.equal(await page.locator('[data-choice="' + name + '"]').getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('.live-indicator .indicator-' + name).count(), 1)
    assert.ok(page.url().includes('choice=' + name))
  }
  await page.locator('[data-choice="echo"]').click()
  await page.locator('#speed').selectOption('1.6')
  assert.equal(await page.locator('.live-indicator path').first().evaluate((el) => getComputedStyle(el).animationDuration), '3.84s')
  await page.locator('#pause').click()
  await page.locator('.live-indicator path').first().evaluate(async (el) => { await el.getAnimations()[0].ready })
  const pausedTime = await page.locator('.live-indicator path').first().evaluate((el) => el.getAnimations()[0].currentTime)
  await page.waitForTimeout(160)
  const laterTime = await page.locator('.live-indicator path').first().evaluate((el) => el.getAnimations()[0].currentTime)
  assert.equal(pausedTime, laterTime)
  await page.locator('#pause').click()
  await page.locator('#speed').selectOption('1')
  await page.locator('[data-mode="write"]').click()
  await page.getByRole('status').filter({ hasText: 'Rédaction en cours…' }).waitFor()
  await page.locator('[data-mode="think"]').click()
  await page.locator('[data-color="250"]').click()
  assert.equal(await page.locator('html').evaluate((el) => el.style.getPropertyValue('--sg-hue')), '250')
  await page.locator('[data-color="318"]').click()
  await page.locator('#theme').click()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
  await page.screenshot({ path: output + '/desktop-light.png', fullPage: true })
  await page.locator('#language').selectOption('en')
  await page.getByRole('heading', { name: 'An idea takes shape.' }).waitFor()
  await page.reload()
  await page.getByRole('heading', { name: 'An idea takes shape.' }).waitFor()
  await page.locator('#language').selectOption('fr')
  await page.locator('#theme').click()
  // Same static files serve both editions, without sign-in or API.
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow at ' + width)
    await page.screenshot({ path: output + '/viewport-' + width + '.png', fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-choice="ink"]').click()
  await page.locator('.mobile-preview-link').click()
  assert.ok(page.url().includes('choice=ink'))
  await page.waitForTimeout(350)
  assert.ok(await page.locator('#context').evaluate((el) => el.getBoundingClientRect().top < 100))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByText('Les animations sont réduites selon les réglages de ton appareil.').waitFor()
  assert.equal(await page.locator('#pause').isDisabled(), true)
  assert.equal(await page.locator('.ink-draw').first().evaluate((el) => getComputedStyle(el).animationName), 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.locator('[data-choice="breath"]').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('[data-choice="breath"]').getAttribute('aria-pressed'), 'true')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, proposals: 6, widths: [1440, 768, 390, 320], themes: ['dark', 'light'], languages: ['fr', 'en'], controls: ['selection', 'pace', 'pause', 'accent', 'mode', 'keyboard', 'reduced-motion'], screenshots: output }))
} finally {
  await browser.close()
}

