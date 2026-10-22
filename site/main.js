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

// Decoration stays static without JavaScript; offscreen animation rests.
const backgroundObserver = new IntersectionObserver((entries) => {
  entries.forEach(({ target, isIntersecting }) => target.toggleAttribute('data-visible', isIntersecting))
})
document.querySelectorAll('.site-background, .section-background').forEach((background) => {
  backgroundObserver.observe(background)
})

// Sillage Desktop: the package for the visitor's system, as a direct download.
const DESKTOP_PACKAGES = {
  windows: { asset: 'win-x64.exe', label: 'Download for Windows' },
  mac: { asset: 'mac-arm64.dmg', label: 'Download for macOS' },
  linux: { asset: 'linux-amd64.deb', label: 'Download for Linux (.deb)' },
}

function desktopSystem() {
  if (/android|iphone|ipad|ipod/i.test(navigator.userAgent)) return null
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()
  // iPadOS asks for the desktop site as a Mac, but no Mac has a touch screen.
  if (platform.includes('mac')) return navigator.maxTouchPoints > 1 ? null : 'mac'
  if (platform.includes('win')) return 'windows'
  if (platform.includes('linux')) return 'linux'
  return null
}

const desktopPackage = DESKTOP_PACKAGES[desktopSystem()]

// Offered only once the release is known to carry this system's package: a direct link
// to a file the release lacks would end on a GitHub error page.
function offerDownload(href, version) {
  document.querySelectorAll('[data-desktop-download]').forEach((button) => {
    const detail = button.hasAttribute('data-detailed') ? ` · v${version}` : ''
    button.href = href
    button.firstChild.textContent = `${desktopPackage.label}${detail} `
    button.hidden = false
  })
}

// Latest release from GitHub: the version badge, and the direct downloads. The package
// links already point at `releases/latest/download/` and stable asset names; the answer
// adds the version and covers older releases, whose asset names carried it. The page
// stays complete without it: the unauthenticated API is capped at 60 requests per hour
// and per IP.
fetch('https://api.github.com/repos/MarlBurroW/sillage/releases/latest')
  .then((res) => (res.ok ? res.json() : null))
  .then((release) => {
    if (!release?.tag_name) return
    const version = release.tag_name.replace(/^v/, '')
    const badge = document.getElementById('version-badge')
    badge.textContent = `v${version} available`
    badge.href = release.html_url
    badge.hidden = false

    const assets = release.assets ?? []
    const find = (suffix) => assets.find((asset) => asset.name.endsWith(suffix))
    document.querySelectorAll('[data-asset]').forEach((link) => {
      const asset = find(link.dataset.asset)
      if (asset) link.href = asset.browser_download_url
    })
    const own = desktopPackage && find(desktopPackage.asset)
    if (own) offerDownload(own.browser_download_url, version)
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
    if (focus) {
      tab.focus()
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
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

// Opening film: poster/button remain until click, then video plays in place with
// controls. At end, button returns for replay. #film link (from README) leads here;
// playback waits for click because browsers reject autoplay with sound.
const hero = document.querySelector('.hero-film')
const film = hero.querySelector('[data-film]')
const filmPlay = hero.querySelector('[data-film-play]')
// Without JavaScript, native controls suffice; with it, large button replaces them.
film.controls = false
filmPlay.hidden = false
filmPlay.addEventListener('click', () => {
  hero.toggleAttribute('data-playing', true)
  film.controls = true
  film.play().catch(() => {})
})
film.addEventListener('ended', () => {
  hero.toggleAttribute('data-playing', false)
  film.controls = false
  film.load() // return to poster
})

// The header only grows a rule once it sits over content.
const topbar = document.querySelector('.topbar')
const onScroll = () => topbar.toggleAttribute('data-stuck', window.scrollY > 8)
addEventListener('scroll', onScroll, { passive: true })
onScroll()
