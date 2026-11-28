// The page's language picks the words this script writes; the pages themselves are translated at build time.
const STRINGS = {
  en: {
    light: 'Switch to the light theme',
    dark: 'Switch to the dark theme',
    openMenu: 'Open navigation',
    closeMenu: 'Close navigation',
    anchor: 'Link to this section: ',
    fit: 'Fit to screen',
    zoom: 'Zoom in',
    copied: 'Copied',
    selectToCopy: 'Select to copy',
    copyDone: 'Command copied to clipboard.',
    copyFailed: 'Could not copy automatically. Select the command and copy it manually.',
    megabytes: 'MB',
  },
  fr: {
    light: 'Passer au thème clair',
    dark: 'Passer au thème sombre',
    openMenu: 'Ouvrir la navigation',
    closeMenu: 'Fermer la navigation',
    anchor: 'Lien vers cette section\u00a0: ',
    fit: 'Ajuster à l’écran',
    zoom: 'Agrandir',
    copied: 'Copié',
    selectToCopy: 'Sélectionne pour copier',
    copyDone: 'Commande copiée dans le presse-papiers.',
    copyFailed: 'Copie automatique impossible. Sélectionne la commande et copie-la à la main.',
    megabytes: 'Mo',
  },
}
const t = STRINGS[document.documentElement.lang] || STRINGS.en

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
    const label = dark ? t.light : t.dark
    themeToggle.setAttribute('aria-label', label)
    themeToggle.title = label
  }
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

/**
 * The new theme spreads from the toggle as a circle, like a ring on water. Browsers without view
 * transitions, and readers who ask for less motion, get the switch at once.
 */
function switchTheme(next, origin) {
  if (!document.startViewTransition || reducedMotion.matches) {
    applyTheme(next)
    return
  }
  // Set before the old state is captured: the whole page, top bar included, is one picture.
  root.setAttribute('data-theme-switching', '')
  const transition = document.startViewTransition(() => applyTheme(next))
  transition.ready.then(() => {
    const radius = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y))
    root.animate(
      { clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
      { duration: 560, easing: 'cubic-bezier(0.25, 0.7, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
    )
  }).catch(() => { /* Skipped transitions still applied the theme. */ })
  transition.finished.finally(() => root.removeAttribute('data-theme-switching'))
}

applyTheme(storedTheme() || (systemDark.matches ? 'dark' : 'light'))
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    const bounds = themeToggle.getBoundingClientRect()
    switchTheme(next, { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
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
    menuToggle.setAttribute('aria-label', open ? t.closeMenu : t.openMenu)
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

  // A panel the reader chose comes in with a short motion; the one shown at load is simply there.
  const select = (tab, focus = false, chosen = false) => {
    tabs.forEach((other, index) => {
      const selected = other === tab
      other.setAttribute('aria-selected', String(selected))
      other.tabIndex = selected ? 0 : -1
      panels[index].hidden = !selected
      panels[index].toggleAttribute('data-chosen', selected && chosen)
    })
    if (focus) tab.focus({ preventScroll: true })
  }

  tabs.forEach((tab, index) => {
    tab.disabled = false
    tab.addEventListener('click', () => select(tab, false, true))
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
      select(target, true, true)
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

// Long pages: each section heading links to itself, so a reader can share where they are.
if (!document.querySelector('.hero')) {
  document.querySelectorAll('main section[id]:not(.release-month):not(.feature-category)').forEach((section) => {
    const heading = section.querySelector('h2')
    if (!heading || heading.closest('section[id]') !== section || heading.querySelector('.anchor')) return
    const link = document.createElement('a')
    link.className = 'anchor'
    link.href = `#${section.id}`
    link.textContent = '#'
    link.setAttribute('aria-label', `${t.anchor}${heading.textContent.trim()}`)
    heading.append(link)
  })
}

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
    zoomSize.textContent = actualSize ? t.fit : t.zoom
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
    // The still is fetched when the film opens, not on every visit to the page.
    if (!film.poster && film.dataset.poster) film.poster = film.dataset.poster
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

// The home page's drawings wait off screen, and each starts its story once it is well in view.
// The stylesheet holds them only while this script runs, so without it they simply play.
const drawings = document.querySelectorAll('.tile-art, .currents')
if (drawings.length) {
  if ('IntersectionObserver' in window) {
    const watcher = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.intersectionRatio >= 0.4) entry.target.setAttribute('data-running', '')
        else if (!entry.isIntersecting) entry.target.removeAttribute('data-running')
      }
    }, { threshold: [0, 0.4] })
    drawings.forEach((drawing) => watcher.observe(drawing))
  } else {
    drawings.forEach((drawing) => drawing.setAttribute('data-running', ''))
  }
}

// The catalog's count runs up the first time it comes into view. A reader who arrives with it
// already on screen, or who asked for less motion, simply reads the number.
const featureCount = document.querySelector('.tile-figure span')
if (featureCount && 'IntersectionObserver' in window && !reducedMotion.matches) {
  const total = Number(featureCount.textContent)
  let first = true
  const counter = new IntersectionObserver(([entry]) => {
    if (first) {
      first = false
      if (entry.isIntersecting) return counter.disconnect()
      featureCount.textContent = '0'
      return
    }
    if (entry.intersectionRatio < 0.5) return
    counter.disconnect()
    const start = performance.now()
    const step = (now) => {
      const progress = Math.min((now - start) / 1400, 1)
      featureCount.textContent = String(Math.round(total * (1 - (1 - progress) ** 3)))
      if (progress < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, { threshold: [0, 0.5] })
  counter.observe(featureCount)
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
    button.removeAttribute('data-copied')
    if (copyStatus) copyStatus.textContent = ''
    try {
      await copyText(source.textContent.trim())
      if (label) label.textContent = t.copied
      button.setAttribute('data-copied', '')
      if (copyStatus) copyStatus.textContent = t.copyDone
    } catch {
      if (label) label.textContent = t.selectToCopy
      if (copyStatus) copyStatus.textContent = t.copyFailed
    }
    reset = setTimeout(() => {
      if (label) label.textContent = originalLabel
      button.removeAttribute('data-copied')
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
    const assets = Array.isArray(release.assets) ? release.assets : []
    const find = (suffix) => assets.find((candidate) => typeof candidate?.name === 'string' && candidate.name.endsWith(suffix))
    document.querySelectorAll('[data-asset]').forEach((link) => {
      const asset = link.dataset.asset && find(link.dataset.asset)
      const href = asset && githubUrl(asset.browser_download_url)
      if (href) link.href = href
    })
    // Sizes as GitHub lists them, in MiB written MB, like the page's own fallback.
    document.querySelectorAll('[data-asset-size]').forEach((label) => {
      const asset = find(label.dataset.assetSize)
      if (Number.isFinite(asset?.size) && asset.size > 0) label.textContent = `${Math.round(asset.size / 1048576)}\u00a0${t.megabytes}`
    })
  } catch { /* Release information is optional; the page already has working links. */ }
  finally {
    clearTimeout(timeout)
  }
}

updateReleaseLinks()
