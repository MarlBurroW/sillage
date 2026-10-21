const translations = await fetch('./translations.json').then((response) => {
  if (!response.ok) throw new Error('Translations unavailable')
  return response.json()
})
const root = document.documentElement
const app = document.querySelector('#app')
const names = ['echo', 'wave', 'orbit', 'ink', 'stars', 'breath']
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)')
const state = { choice: 'echo', theme: 'dark', language: 'fr', color: '318', speed: '1', paused: false, mode: 'think' }
const fromUrl = new URLSearchParams(location.hash.slice(1))
if (names.includes(fromUrl.get('choice'))) state.choice = fromUrl.get('choice')
if (['dark', 'light'].includes(fromUrl.get('theme'))) state.theme = fromUrl.get('theme')
if (['fr', 'en'].includes(fromUrl.get('language'))) state.language = fromUrl.get('language')

const t = (key, values = {}) => translations[state.language][key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '')
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const logoPaths = '<path d="M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79Z"/><path d="M23 79C47 79 39 21 65 21H78C54 21 62 79 36 79Z"/><path d="M42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z"/>'
const svg = (contents, viewBox = '0 0 48 48', extra = '') => '<svg viewBox="' + viewBox + '" fill="none" aria-hidden="true" ' + extra + '>' + contents + '</svg>'
const logo = svg(logoPaths, '0 0 100 100', 'class="logo"')
const icons = {
  moon: svg('<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>', '0 0 24 24'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>', '0 0 24 24'),
  pause: svg('<path d="M9 5v14M15 5v14"/>', '0 0 24 24'),
  play: svg('<path d="m8 4 12 8-12 8Z"/>', '0 0 24 24'),
  check: svg('<path d="m5 12 4 4L19 6"/>', '0 0 24 24'),
  arrow: svg('<path d="M12 5v14m-5-5 5 5 5-5"/>', '0 0 24 24'),
  plus: svg('<path d="M12 5v14M5 12h14"/>', '0 0 24 24'),
  branch: svg('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 7a8 8 0 0 1-8 8H6"/>', '0 0 24 24'),
}

function indicator(name) {
  const shapes = {
    echo: svg(logoPaths, '0 0 100 100'),
    wave: '<span></span>'.repeat(5),
    orbit: svg('<circle class="orbit-track" cx="24" cy="24" r="17"/><circle class="orbit-core" cx="24" cy="24" r="3"/><g class="orbit-points"><circle cx="24" cy="7" r="3.5"/><circle cx="24" cy="41" r="2.5"/></g>'),
    ink: svg('<path class="ink-track" d="M4 28C14 28 12 11 22 11S29 37 39 37 45 20 56 20 63 28 72 28"/><path class="ink-draw" pathLength="100" d="M4 28C14 28 12 11 22 11S29 37 39 37 45 20 56 20 63 28 72 28"/>', '0 0 76 48'),
    stars: svg('<path class="star-link" d="m9 31 10-19 19 8-10 19-9-27m9 27L9 31l29-11"/><circle cx="9" cy="31" r="3"/><circle cx="19" cy="12" r="3.5"/><circle cx="38" cy="20" r="3"/><circle cx="28" cy="39" r="2.5"/>'),
    breath: '<span class="breath-ring"></span><span class="breath-halo"></span><span class="breath-core"></span>',
  }
  return '<span class="indicator indicator-' + name + '" aria-hidden="true">' + shapes[name] + '</span>'
}

function tile(name) {
  const chosen = state.choice === name
  return '<button class="proposal' + (chosen ? ' selected' : '') + '" data-choice="' + name + '" aria-pressed="' + chosen + '" aria-label="' + escape(t(name + '.name') + ' — ' + t(name + '.short')) + '">' +
    '<span class="proposal-top">' + (name === 'echo' ? '<span class="recommend">' + escape(t('recommend')) + '</span>' : '<span></span>') + '<span class="selection-dot">' + icons.check + '</span></span>' +
    '<span class="specimen">' + indicator(name) + '</span>' +
    '<span class="proposal-name">' + escape(t(name + '.name')) + '</span><span class="proposal-caption">' + escape(t(name + '.short')) + '</span></button>'
}

function syncMotion() {
  root.dataset.paused = String(state.paused || motionPreference.matches)
  root.style.setProperty('--pace', state.speed)
  root.style.setProperty('--sg-hue', state.color)
  root.dataset.theme = state.theme
}

function saveSelection() {
  const values = new URLSearchParams({ choice: state.choice, theme: state.theme, language: state.language })
  history.replaceState(null, '', '#' + values)
}

function previewMotion() {
  return indicator(state.choice) + '<span>' + escape(t(state.mode === 'think' ? 'thinking' : 'writing')) + '</span>'
}

function render() {
  root.lang = state.language
  document.title = t('title')
  syncMotion()
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#" aria-label="Sillage">${logo}<span>Sillage</span></a>
      <span class="breadcrumb">${escape(t('workshop'))}</span>
      <div class="header-controls">
        <button class="theme-button" id="theme" aria-label="${escape(t('theme'))}">${icons[state.theme === 'dark' ? 'moon' : 'sun']}<span>${escape(t(state.theme))}</span></button>
        <select id="language" aria-label="${escape(t('language'))}"><option value="fr" ${state.language === 'fr' ? 'selected' : ''}>FR</option><option value="en" ${state.language === 'en' ? 'selected' : ''}>EN</option></select>
      </div>
    </header>
    <main>
      <div class="introduction">
        <div class="intro-copy"><p class="intro-label">${escape(t('prototype'))}</p><h1>${escape(t('heading'))}</h1><p class="intro-text">${escape(t('intro'))}</p></div>
        <div class="hero-mark" aria-hidden="true">${indicator(state.choice)}</div>
      </div>
      <div class="workspace">
        <section class="collection" aria-labelledby="gallery-title">
          <div class="section-heading"><h2 id="gallery-title">${escape(t('gallery'))}</h2><span>6</span></div>
          <div class="gallery" id="gallery">${names.map(tile).join('')}</div>
          <div class="playback">
            <div class="pace-control"><label for="speed">${escape(t('speed'))}</label><select id="speed">
              <option value="1.6" ${state.speed === '1.6' ? 'selected' : ''}>${escape(t('slow'))}</option>
              <option value="1" ${state.speed === '1' ? 'selected' : ''}>${escape(t('normal'))}</option>
              <option value="0.65" ${state.speed === '0.65' ? 'selected' : ''}>${escape(t('fast'))}</option>
            </select></div>
            <div class="colors" role="group" aria-label="${escape(t('color'))}">
              ${[['318', 'lilac'], ['250', 'blue'], ['165', 'green']].map(([hue, name]) => '<button class="swatch" style="--swatch: oklch(0.7 0.14 ' + hue + ')" data-color="' + hue + '" aria-label="' + escape(t(name)) + '" aria-pressed="' + (state.color === hue) + '">' + icons.check + '</button>').join('')}
            </div>
            <button class="pause-button" id="pause" aria-pressed="${state.paused}" ${motionPreference.matches ? 'disabled' : ''}>${icons[state.paused ? 'play' : 'pause']}<span>${escape(t(state.paused ? 'play' : 'pause'))}</span></button>
          </div>
          <p class="gallery-hint">${escape(t(motionPreference.matches ? 'reduced' : 'galleryHint'))}</p>
        </section>
        <section class="context" id="context" aria-labelledby="preview-title">
          <div class="section-heading"><h2 id="preview-title">${escape(t('preview'))}</h2><span class="scale-label">${escape(t('scale'))}</span></div>
          <div class="conversation">
            <div class="conversation-header"><span class="project-mark">${logo}</span><span>${escape(t('project'))}</span><span class="branch">${icons.branch}main</span></div>
            <div class="messages">
              <div class="user-heading">${escape(t('you'))}</div>
              <p class="user-message">${escape(t('question'))}</p>
              <div class="agent-heading">${logo}<strong>Sillage</strong><span>Claude</span></div>
              <p class="agent-message${state.mode === 'write' ? ' writing-text' : ''}">${escape(t('answer'))}</p>
              <div class="live-indicator" role="status">${previewMotion()}</div>
            </div>
            <div class="composer-preview" aria-hidden="true"><span>${escape(t('composer'))}</span><div><span class="composer-plus">${icons.plus}</span><span>Claude Sonnet</span><span class="stop-square"></span></div></div>
          </div>
          <div class="preview-controls" role="group" aria-label="${escape(t('preview'))}">
            <button data-mode="think" aria-pressed="${state.mode === 'think'}">${escape(t('thinkTab'))}</button>
            <button data-mode="write" aria-pressed="${state.mode === 'write'}">${escape(t('writeTab'))}</button>
          </div>
          <div class="choice-note" aria-live="polite"><span class="note-label">${escape(t('choice'))}</span><h3>${escape(t(state.choice + '.name'))}</h3><p>${escape(t(state.choice + '.detail'))}</p></div>
          <p class="context-note">${escape(t('note'))}</p>
          <a class="back-link" href="#gallery">${escape(t('back'))}</a>
        </section>
      </div>
      <footer><span>${escape(t('footer'))}</span><span>${escape(t('editions'))}</span></footer>
    </main>
    <a class="mobile-preview-link" href="#context"><span>${escape(t('mobilePreview', { name: t(state.choice + '.name') }))}</span>${icons.arrow}</a>
  `
}

function choose(name) {
  state.choice = name
  app.querySelectorAll('[data-choice]').forEach((button) => {
    const selected = button.dataset.choice === name
    button.classList.toggle('selected', selected)
    button.setAttribute('aria-pressed', String(selected))
  })
  app.querySelector('.hero-mark').innerHTML = indicator(name)
  app.querySelector('.live-indicator').innerHTML = previewMotion()
  app.querySelector('.choice-note h3').textContent = t(name + '.name')
  app.querySelector('.choice-note p').textContent = t(name + '.detail')
  app.querySelector('.mobile-preview-link span').textContent = t('mobilePreview', { name: t(name + '.name') })
  saveSelection()
}

app.addEventListener('click', (event) => {
  const anchor = event.target.closest('a')
  if (anchor) {
    event.preventDefault()
    const destination = anchor.getAttribute('href')
    if (destination === '#') window.scrollTo({ top: 0 })
    else document.querySelector(destination).scrollIntoView()
    return
  }
  const target = event.target.closest('button')
  if (!target) return
  if (target.dataset.choice) choose(target.dataset.choice)
  if (target.dataset.color) {
    state.color = target.dataset.color
    syncMotion()
    app.querySelectorAll('[data-color]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.color === state.color)))
  }
  if (target.dataset.mode) {
    state.mode = target.dataset.mode
    app.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)))
    app.querySelector('.live-indicator').innerHTML = previewMotion()
    app.querySelector('.agent-message').classList.toggle('writing-text', state.mode === 'write')
  }
  if (target.id === 'pause') {
    state.paused = !state.paused
    syncMotion()
    target.setAttribute('aria-pressed', String(state.paused))
    target.innerHTML = icons[state.paused ? 'play' : 'pause'] + '<span>' + escape(t(state.paused ? 'play' : 'pause')) + '</span>'
  }
  if (target.id === 'theme') {
    state.theme = state.theme === 'dark' ? 'light' : 'dark'
    syncMotion()
    target.innerHTML = icons[state.theme === 'dark' ? 'moon' : 'sun'] + '<span>' + escape(t(state.theme)) + '</span>'
    saveSelection()
  }
})
app.addEventListener('change', (event) => {
  if (event.target.id === 'speed') { state.speed = event.target.value; syncMotion() }
  if (event.target.id === 'language') {
    state.language = event.target.value
    render()
    document.querySelector('#language').focus()
    saveSelection()
  }
})
motionPreference.addEventListener('change', render)
render()

