// Theme switch. The button stays hidden until this runs: without JavaScript the
// page still follows the system preference, and a dead control would be worse
// than none. The head applies the stored choice earlier, to avoid a flash.
const THEME_KEY = 'sillage-site-theme'
const root = document.documentElement
const systemDark = matchMedia('(prefers-color-scheme: dark)')
const themeToggle = document.querySelector('[data-theme-toggle]')
// A <picture> resolves its variant against the system preference alone, so the
// switch has to move the media conditions out of the way itself. Same for the
// colour the mobile browser paints its chrome with.
const darkSources = [...document.querySelectorAll('picture source')]
const darkMeta = document.querySelector('meta[name="theme-color"][media*="dark"]')
const lightMeta = document.querySelector('meta[name="theme-color"][media*="light"]')

const storedTheme = () => {
  try {
    return localStorage.getItem(THEME_KEY)
  } catch {
    return null
  }
}

function applyTheme(theme) {
  const dark = theme === 'dark'
  root.dataset.theme = theme
  darkSources.forEach((source) => { source.media = dark ? 'all' : 'not all' })
  darkMeta.media = dark ? 'all' : 'not all'
  lightMeta.media = dark ? 'not all' : 'all'
  themeToggle.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme')
}

applyTheme(root.dataset.theme || (systemDark.matches ? 'dark' : 'light'))
themeToggle.hidden = false

themeToggle.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch { /* the choice just does not survive the tab */ }
})

// Someone who never touched the switch keeps following their system.
systemDark.addEventListener('change', (event) => {
  if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light')
})

// Latest release from GitHub. The page stays complete without it: the
// unauthenticated API is capped at 60 requests per hour and per IP.
fetch('https://api.github.com/repos/MarlBurroW/sillage/releases/latest')
  .then((res) => (res.ok ? res.json() : null))
  .then((release) => {
    if (!release?.tag_name) return
    const badge = document.getElementById('version-badge')
    badge.textContent = `v${release.tag_name.replace(/^v/, '')} available`
    badge.href = release.html_url
    badge.hidden = false
  })
  .catch(() => {})

/** Wires an ARIA tablist: click, arrow keys, Home and End. */
function tablist(tabs, show) {
  const select = (tab, focus) => {
    tabs.forEach((other) => {
      other.setAttribute('aria-selected', String(other === tab))
      other.tabIndex = other === tab ? 0 : -1
    })
    show(tabs.indexOf(tab))
    if (focus) tab.focus()
  }
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => select(tab, false))
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
      const target = step
        ? tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]
        : { Home: tabs[0], End: tabs[tabs.length - 1] }[event.key]
      if (!target) return
      event.preventDefault()
      select(target, true)
    })
  })
  return (index) => select(tabs[(index + tabs.length) % tabs.length], false)
}

// Screenshot tour.
const shotTabs = [...document.querySelectorAll('.shots-nav [role="tab"]')]
const shotPanels = [...document.querySelectorAll('.shots-panels [role="tabpanel"]')]
let currentShot = 0

const goToShot = tablist(shotTabs, (index) => {
  currentShot = index
  shotPanels.forEach((panel, i) => { panel.hidden = i !== index })
})

document.querySelector('[data-shot-prev]').addEventListener('click', () => goToShot(currentShot - 1))
document.querySelector('[data-shot-next]').addEventListener('click', () => goToShot(currentShot + 1))

// Installation methods.
const installTabs = [...document.querySelectorAll('.tabs [role="tab"]')]
const installPanels = [...document.querySelectorAll('.tab-panel')]
tablist(installTabs, (index) => {
  installPanels.forEach((panel, i) => { panel.hidden = i !== index })
})

// Screenshots are dense; let people open one at its full size.
const dialog = document.querySelector('[data-zoom-dialog]')
const dialogImage = dialog.querySelector('[data-zoom-image]')

document.querySelectorAll('[data-zoom]').forEach((trigger) => {
  trigger.addEventListener('click', () => {
    const image = trigger.querySelector('img')
    dialogImage.src = image.currentSrc || image.src
    dialogImage.alt = image.alt
    dialog.showModal()
  })
})
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close()
})

// The header only grows a rule once it sits over content.
const topbar = document.querySelector('.topbar')
const onScroll = () => topbar.toggleAttribute('data-stuck', window.scrollY > 8)
addEventListener('scroll', onScroll, { passive: true })
onScroll()
