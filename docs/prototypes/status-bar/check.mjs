// Screenshots of the mockup at desktop and phone sizes, failing on console errors.
// Usage: node check.mjs [base-url] [output-directory]
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:7502/'
const out = process.argv[3] ?? '/var/tmp/sillage-status-bar-check'
await mkdir(out, { recursive: true })

const browser = await chromium.launch()
const errors = []
const watch = (page) => {
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(String(error)))
}
const seed = (state) => Object.entries(state).map(([key, value]) => `localStorage.setItem(${JSON.stringify(`status-bar.${key}`)}, ${JSON.stringify(JSON.stringify(value))});`).join('')

async function shot(name, { width, height, state = {}, touch = false, act }) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 2 })
  await context.addInitScript(`localStorage.clear();${seed(state)}`)
  const page = await context.newPage()
  watch(page)
  await page.goto(base)
  await page.waitForSelector('[data-status-bar]')
  await page.waitForTimeout(300)
  if (act) await act(page)
  await page.screenshot({ path: `${out}/${name}.png` })
  const bar = await page.$eval('[data-status-bar]', (node) => node.innerText.replace(/\s+/g, ' ').trim()).catch(() => '')
  console.log(`${name}: ${bar}`)
  await context.close()
}

await shot('desktop-default', { width: 1440, height: 900 })
await shot('desktop-running', { width: 1440, height: 900, state: { scenario: 'running' } })
await shot('desktop-limit-rich', { width: 1440, height: 900, state: { scenario: 'limit' }, act: (page) => page.getByRole('button', { name: 'Chargée', exact: true }).click().then(() => page.waitForTimeout(300)) })
await shot('narrow-rich', { width: 1000, height: 800, state: { scenario: 'running' }, act: (page) => page.getByRole('button', { name: 'Chargée', exact: true }).click().then(() => page.waitForTimeout(300)) })
await shot('desktop-config', { width: 1440, height: 900, act: (page) => page.getByRole('button', { name: 'Personnaliser…' }).click().then(() => page.waitForTimeout(300)) })
await shot('phone-default', { width: 390, height: 844, touch: true, state: { scenario: 'running' } })
await shot('phone-sheet', { width: 390, height: 844, touch: true, state: { scenario: 'running' }, act: (page) => page.getByRole('button', { name: 'Infos de la session' }).click().then(() => page.waitForTimeout(300)) })
await shot('phone-config', { width: 390, height: 844, touch: true, act: async (page) => {
  await page.getByRole('button', { name: 'Infos de la session' }).click()
  await page.getByRole('button', { name: 'Personnaliser la barre' }).click()
  await page.waitForTimeout(300)
} })

await browser.close()
if (errors.length) {
  console.error(`Console errors:\n${[...new Set(errors)].join('\n')}`)
  process.exit(1)
}
