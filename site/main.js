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
