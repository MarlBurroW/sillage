const THEME_KEY = 'sillage-site-theme'
const root = document.documentElement
const systemDark = matchMedia('(prefers-color-scheme: dark)')
const themeToggle = document.querySelector('[data-theme-toggle]')
const darkSources = [...document.querySelectorAll('picture source[media*="dark"]')].map((source) => ({
  source,
  media: source.media.replace(/(?: and )?\(prefers-color-scheme: dark\)/, '') || 'all',
}))
const darkMeta = document.querySelector('meta[name="theme-color"][media*="dark"]')
const lightMeta = document.querySelector('meta[name="theme-color"][media*="light"]')

function storedTheme() {
  try {
    const theme = localStorage.getItem(THEME_KEY)
    return theme === 'dark' || theme === 'light' ? theme : null
  } catch {
    return null
  }
}

function applyTheme(theme) {
  const dark = theme === 'dark'
  root.dataset.theme = theme
  // Picture and browser chrome otherwise follow the OS, ignoring our switch.
  darkSources.forEach(({ source, media }) => { source.media = dark ? media : 'not all' })
  if (darkMeta) darkMeta.media = dark ? 'all' : 'not all'
  if (lightMeta) lightMeta.media = dark ? 'not all' : 'all'
  if (themeToggle) {
    themeToggle.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme')
  }
}

applyTheme(storedTheme() || (systemDark.matches ? 'dark' : 'light'))
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch { /* The choice still works for this visit. */ }
  })
  themeToggle.hidden = false
}
systemDark.addEventListener('change', (event) => {
  if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light')
})

const topbar = document.querySelector('.topbar')
const menuToggle = document.querySelector('[data-menu-toggle]')
const navigation = document.getElementById('site-nav')

if (topbar) {
  const onScroll = () => topbar.toggleAttribute('data-stuck', window.scrollY > 8)
  addEventListener('scroll', onScroll, { passive: true })
  onScroll()
}

if (topbar && menuToggle && navigation) {
  const setMenuOpen = (open) => {
    topbar.toggleAttribute('data-open', open)
    menuToggle.setAttribute('aria-expanded', String(open))
    menuToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation')
  }
  menuToggle.addEventListener('click', () => {
    setMenuOpen(menuToggle.getAttribute('aria-expanded') !== 'true')
  })
  navigation.addEventListener('click', (event) => {
    if (event.target.closest('a')) setMenuOpen(false)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || menuToggle.getAttribute('aria-expanded') !== 'true') return
    setMenuOpen(false)
    menuToggle.focus({ preventScroll: true })
  })
  matchMedia('(max-width: 850px)').addEventListener('change', (event) => {
    if (!event.matches) setMenuOpen(false)
  })
  setMenuOpen(false)
  topbar.setAttribute('data-enhanced', '')
  menuToggle.hidden = false
}

// Panels remain readable without JavaScript. Only complete tab groups are enhanced.
const tabGroups = []
document.querySelectorAll('[data-tabs]').forEach((group) => {
  const tabs = [...group.querySelectorAll('[role="tab"]')]
    .filter((tab) => tab.closest('[data-tabs]') === group)
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')))
  if (!tabs.length || panels.some((panel) => !panel)) return

  if (group.matches('.gallery')) {
    const tablist = group.querySelector('[role="tablist"]')
    const desktop = matchMedia('(min-width: 851px)')
    const orient = () => tablist.setAttribute('aria-orientation', desktop.matches ? 'vertical' : 'horizontal')
    orient()
    desktop.addEventListener('change', orient)
  }

  const select = (tab, focus = false) => {
    tabs.forEach((other, index) => {
      const selected = other === tab
      other.setAttribute('aria-selected', String(selected))
      other.tabIndex = selected ? 0 : -1
      panels[index].hidden = !selected
    })
    if (focus) tab.focus({ preventScroll: true })
  }

  tabs.forEach((tab, index) => {
    tab.disabled = false
    tab.addEventListener('click', () => select(tab))
    tab.addEventListener('keydown', (event) => {
      const vertical = tab.closest('[role="tablist"]')?.getAttribute('aria-orientation') === 'vertical'
      const previous = vertical ? 'ArrowUp' : 'ArrowLeft'
      const next = vertical ? 'ArrowDown' : 'ArrowRight'
      let target
      if (event.key === previous) target = tabs[(index - 1 + tabs.length) % tabs.length]
      if (event.key === next) target = tabs[(index + 1) % tabs.length]
      if (event.key === 'Home') target = tabs[0]
      if (event.key === 'End') target = tabs[tabs.length - 1]
      if (!target) return
      event.preventDefault()
      select(target, true)
    })
  })
  select(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0])
  group.setAttribute('data-enhanced', '')
  tabGroups.push({ tabs, panels, select })
})

function revealHash(hash) {
  if (!hash || hash === '#') return
  let target
  try {
    target = document.getElementById(decodeURIComponent(hash.slice(1)))
  } catch {
    return
  }
  if (!target) return
  tabGroups.forEach(({ tabs, panels, select }) => {
    const index = panels.findIndex((panel) => panel === target || panel.contains(target))
    if (index !== -1) select(tabs[index])
  })
}

revealHash(location.hash)
addEventListener('hashchange', () => revealHash(location.hash))
// Reveal before the browser follows an anchor, including repeated same-hash clicks.
document.addEventListener('click', (event) => {
  const anchor = event.target.closest('a[href^="#"]')
  if (anchor) revealHash(anchor.getAttribute('href'))
})

function enhanceDialog(dialog, onClose) {
  if (!dialog || typeof dialog.showModal !== 'function') return false
  dialog.querySelectorAll('[data-dialog-close], [data-dialog-close-link]').forEach((control) => {
    control.addEventListener('click', () => dialog.close())
  })
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return
    const bounds = dialog.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close()
  })
  if (onClose) dialog.addEventListener('close', onClose)
  return true
}

function isPlainClick(event) {
  return !event.defaultPrevented && event.button === 0 &&
    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

const zoomDialog = document.querySelector('[data-zoom-dialog]')
const zoomImage = zoomDialog?.querySelector('[data-zoom-image]')
const zoomTitle = zoomDialog?.querySelector('[data-zoom-title]')
const zoomSize = zoomDialog?.querySelector('[data-zoom-size]')
const zoomViewport = zoomDialog?.querySelector('.zoom-viewport')
function setZoomSize(actualSize) {
  zoomDialog.toggleAttribute('data-actual-size', actualSize)
  if (zoomSize) {
    zoomSize.setAttribute('aria-pressed', String(actualSize))
    zoomSize.textContent = actualSize ? 'Fit to screen' : 'Zoom in'
  }
  if (zoomViewport) zoomViewport.scrollTo(0, 0)
}
if (zoomImage && enhanceDialog(zoomDialog, () => {
  setZoomSize(false)
  zoomImage.removeAttribute('src')
  zoomImage.alt = ''
  if (zoomTitle) zoomTitle.textContent = ''
})) {
  document.querySelectorAll('[data-zoom]').forEach((trigger) => {
    const image = trigger.querySelector('img')
    if (!image) return
    trigger.addEventListener('click', (event) => {
      if (!isPlainClick(event)) return
      event.preventDefault()
      zoomImage.src = image.currentSrc || image.src
      zoomImage.alt = image.alt
      if (zoomTitle) {
        zoomTitle.textContent = trigger.closest('figure')?.querySelector('figcaption')?.textContent.trim() || image.alt
      }
      setZoomSize(false)
      zoomDialog.showModal()
    })
    trigger.disabled = false
  })
  zoomSize?.addEventListener('click', () => {
    setZoomSize(!zoomDialog.hasAttribute('data-actual-size'))
  })
}

const filmSection = document.getElementById('film')
const film = filmSection?.querySelector('video[data-film]')
const filmDialog = document.querySelector('[data-film-dialog]')
const filmContent = filmDialog?.querySelector('.film-modal-content')
if (film && filmContent && enhanceDialog(filmDialog, () => film.pause())) {
  filmContent.append(film)
  filmSection.setAttribute('data-film-enhanced', '')
  const openFilm = (autoplay = false) => {
    if (!filmDialog.open) filmDialog.showModal()
    if (autoplay) film.play().catch(() => { /* Native controls remain available if playback is blocked. */ })
  }
  document.querySelectorAll('a[data-film-open]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      if (!isPlainClick(event)) return
      event.preventDefault()
      openFilm(true)
    })
  })
  const revealFilmHash = () => {
    if (location.hash === '#film') openFilm()
  }
  addEventListener('hashchange', revealFilmHash)
  revealFilmHash()
}

// The fallback also supports a private HTTP preview, where Clipboard is unavailable.
async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch { /* A denied Clipboard permission may still allow a user-initiated copy. */ }
  }
  const focused = document.activeElement
  const field = document.createElement('textarea')
  field.value = value
  field.setAttribute('readonly', '')
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.append(field)
  field.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Copy unavailable')
  } finally {
    field.remove()
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
  }
}

const copyStatus = document.getElementById('copy-status')
document.querySelectorAll('[data-copy]').forEach((button) => {
  const selector = button.dataset.copy || ''
  const source = document.getElementById(selector.replace(/^#/, ''))
  if (!source) return
  const label = button.querySelector('[data-copy-label]')
  const originalLabel = label?.textContent
  let reset
  button.addEventListener('click', async () => {
    clearTimeout(reset)
    if (copyStatus) copyStatus.textContent = ''
    try {
      await copyText(source.textContent.trim())
      if (label) label.textContent = 'Copied'
      if (copyStatus) copyStatus.textContent = 'Command copied to clipboard.'
    } catch {
      if (label) label.textContent = 'Select to copy'
      if (copyStatus) copyStatus.textContent = 'Could not copy automatically. Select the command and copy it manually.'
    }
    reset = setTimeout(() => {
      if (label) label.textContent = originalLabel
    }, 2500)
  })
  button.disabled = false
  button.hidden = false
})

function githubUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      !url.username && !url.password && !url.port &&
      url.pathname.startsWith('/MarlBurroW/sillage/releases/') ? url.href : null
  } catch {
    return null
  }
}

// Stable links remain usable if GitHub's public API is unavailable or rate-limited.
async function updateReleaseLinks() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch('https://api.github.com/repos/MarlBurroW/sillage/releases/latest', {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return
    const release = await response.json()
    if (typeof release?.tag_name !== 'string') return
    const releaseUrl = githubUrl(release.html_url)
    const badge = document.getElementById('version-badge')
    if (badge && releaseUrl) {
      badge.textContent = `${release.tag_name} available`
      badge.href = releaseUrl
      badge.hidden = false
    }
    const assets = Array.isArray(release.assets) ? release.assets : []
    document.querySelectorAll('[data-asset]').forEach((link) => {
      const suffix = link.dataset.asset
      if (!suffix) return
      const asset = assets.find((candidate) => typeof candidate?.name === 'string' && candidate.name.endsWith(suffix))
      const href = asset && githubUrl(asset.browser_download_url)
      if (href) link.href = href
    })
  } catch { /* Release information is optional; the page already has working links. */ }
  finally {
    clearTimeout(timeout)
  }
}

updateReleaseLinks()
