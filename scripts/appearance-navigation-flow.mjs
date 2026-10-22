import assert from 'node:assert/strict'
import { join } from 'node:path'

/** Shared with the disposable settings check so both tranches run on the same real profiles. */
export async function checkAppearance(context, origin, width, profile, shots) {
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const url = `${origin}/settings/apparence`
  const navigation = page.getByRole('navigation', { name: 'Catégories d’apparence', exact: true })
  const go = async (name) => {
    await navigation.getByRole('link', { name, exact: true }).click()
    await navigation.getByRole('link', { name, exact: true }).and(page.locator('[aria-current=page]')).waitFor()
  }
  const region = (name) => page.getByRole('region', { name, exact: true })
  const save = async (action, check) => {
    const response = page.waitForResponse((r) => r.url().endsWith('/api/me/settings') && r.request().method() === 'PATCH' && check(r.request().postDataJSON()?.appearance))
    await action()
    assert.ok((await response).ok())
  }
  assert.ok((await context.request.patch(`${origin}/api/me/settings`, { data: { appearance: { theme: 'light', syntax: 'sillage', typingIndicator: 'sillage', values: {} } } })).ok())
  await page.goto(url)
  await navigation.waitFor()
  assert.equal(await navigation.getByRole('link').count(), 4)
  assert.equal(await region('Lecture').count(), 0, 'Inactive categories are absent from the accessibility tree')
  await page.getByRole('button', { name: 'Sombre', exact: true }).click()
  await page.getByText('Réglages fins des couleurs', { exact: true }).click()
  const hue = page.getByRole('slider', { name: 'Teinte', exact: true })
  const oldHue = Number(await hue.inputValue())
  await save(async () => { await hue.focus(); await page.keyboard.press(oldHue < 360 ? 'ArrowRight' : 'ArrowLeft') }, (a) => a?.values.hue === (oldHue < 360 ? oldHue + 1 : oldHue - 1))
  const newHue = await hue.inputValue()
  await region('Interface').evaluate((el) => { el.scrollTop = el.scrollHeight })
  const oldScroll = await region('Interface').evaluate((el) => el.scrollTop)
  assert.ok((await navigation.boundingBox()).y >= 0)
  await go('Lecture')
  const size = page.getByRole('slider', { name: 'Taille du texte', exact: true })
  const oldSize = Number(await size.inputValue())
  const nextSize = oldSize < 1.25 ? oldSize + 0.0625 : oldSize - 0.0625
  await save(async () => { await size.focus(); await page.keyboard.press(oldSize < 1.25 ? 'ArrowRight' : 'ArrowLeft') }, (a) => a?.values.readingSize === nextSize)
  await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${width}-reading.png`) })
  await go('Animations')
  await save(() => page.getByRole('button', { name: 'Orbite', exact: true }).click(), (a) => a?.typingIndicator === 'orbit')
  await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${width}-animations.png`) })
  await go('Code')
  await save(() => region('Code').getByRole('button', { name: 'Océan', exact: true }).click(), (a) => a?.syntax === 'ocean')
  await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${width}-code.png`) })
  await go('Interface')
  assert.equal(await page.locator('details').getAttribute('open'), '')
  assert.equal(await hue.inputValue(), newHue)
  assert.equal(await region('Interface').evaluate((el) => el.scrollTop), oldScroll)
  await page.getByText('Réglages fins des couleurs', { exact: true }).click()
  await region('Interface').evaluate((el) => { el.scrollTop = 0 })
  await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${width}-interface.png`) })
  await page.getByRole('button', { name: 'Sombre contrasté', exact: true }).click()
  assert.equal(await page.getByRole('radio', { name: 'Neutre', exact: true }).count(), 0)
  await go('Code')
  await page.getByText(/Le thème contrasté garde sa propre palette/).waitFor()
  await go('Interface')
  await save(() => page.getByRole('button', { name: 'Clair', exact: true }).click(), (a) => a?.theme === 'light')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('navigation', { name: 'Appearance categories' }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('section'), 'interface')
  await page.getByRole('button', { name: 'Français', exact: true }).click()
  await navigation.waitFor()
  await go('Lecture')
  assert.equal(Number(await size.inputValue()), nextSize)
  await page.goBack()
  await region('Interface').waitFor()
  await page.goForward()
  await region('Lecture').waitFor()
  await page.reload()
  await size.waitFor()
  assert.equal(Number(await size.inputValue()), nextSize)
  const stored = await (await context.request.get(`${origin}/api/me/settings`)).json()
  assert.equal(stored.appearance.values.hue, Number(newHue))
  assert.equal(stored.appearance.syntax, 'ocean')
  assert.equal(stored.appearance.typingIndicator, 'orbit')
  for (const [key, label] of [['motion', 'Animations'], ['code', 'Code'], ['unknown', 'Interface']]) {
    await page.goto(`${url}?section=${key}`)
    await region(label).waitFor()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    const main = await page.locator('main').evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }))
    assert.ok(main.scroll <= main.height + 1, JSON.stringify(main))
  }
  // The settings index must remain usable on a phone, and its long menu must not move the content on desktop.
  if (width < 1024) {
    await page.locator('main').getByRole('link', { name: 'Réglages', exact: true }).click()
    const menu = page.getByRole('navigation', { name: 'Réglages', exact: true })
    await menu.getByRole('link', { name: /À propos/ }).click()
    await page.getByRole('heading', { name: 'À propos', exact: true }).waitFor()
    await page.locator('main').getByRole('link', { name: 'Réglages', exact: true }).click()
    await menu.getByRole('link', { name: /Apparence/ }).click()
    await region('Interface').waitFor()
  } else {
    const menu = page.getByRole('navigation', { name: 'Réglages', exact: true })
    const before = await navigation.boundingBox()
    await menu.evaluate((el) => { el.scrollTop = el.scrollHeight })
    assert.equal((await navigation.boundingBox()).y, before.y)
    const menuLeft = (await menu.boundingBox()).x
    await menu.getByRole('link', { name: 'À propos', exact: true }).click()
    await page.getByRole('heading', { name: 'À propos', exact: true }).waitFor()
    assert.equal((await menu.boundingBox()).x, menuLeft, 'The menu must not shift between settings categories')
  }
  await page.goto(`${origin}/settings/cli`)
  await page.getByRole('heading', { name: 'Claude Code', exact: true }).waitFor()
  const main = await page.locator('main').evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }))
  assert.ok(main.scroll <= main.height + 1)
  if (width < 768) {
    for (const extraWidth of [320, 768]) {
      await page.setViewportSize({ width: extraWidth, height: 844 })
      for (const key of ['interface', 'code']) {
        await page.goto(`${url}?section=${key}`)
        await navigation.waitFor()
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${extraWidth}px`)
      }
      assert.ok(await region('Code').locator('button > span:last-child').evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth)), 'Palette names must remain readable')
      await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${extraWidth}-code.png`) })
      await page.goto(`${origin}/settings`)
      await page.getByRole('navigation', { name: 'Réglages', exact: true }).getByRole('link', { name: /Apparence/ }).click()
      await region('Interface').waitFor()
    }
  }
  assert.deepEqual(errors, [])
  await page.close()
}
