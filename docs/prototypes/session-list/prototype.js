import { catalogs, openAiPath, claudePath } from './catalogs.js'

const fullStudy = document.body.dataset.study === 'sidebar'
const variants = ['quiet', 'timeline', 'workspace']
const gitPresentations = ['subline', 'badge', 'symbol']
const state = { locale: 'fr', short: true, theme: 'dark', width: 320, view: 'quiet', selected: 'progress', query: '', gitPresentation: 'symbol' }
const expanded = new Set(['workspace-tools', 'workspace-main'])
const sessions = [
  { id: 'desktop', original: 'Bardak me dit que la mise à jour de sa version desktop de Sillage plante au démarrage.', branch: 'fix/desktop-heap-limit', git: 'merged', status: 'running', date: 'today', age: ['minutes', 2], workspace: 'desktop' },
  { id: 'mergeReady', original: 'La correction du panneau est commitée. Il reste à la fusionner dans la branche principale.', branch: 'fix/panel-navigation', git: 'unmerged', status: 'idle', date: 'today', age: ['minutes', 8] },
  { id: 'translate', original: 'J’aimerais que tu passes la codebase en français, mais il faut d’abord regarder les conventions.', branch: 'docs/english-codebase', git: 'merged', status: 'idle', date: 'today', age: ['minutes', 18] },
  { id: 'history', original: 'Tu peux remove tous les Co-authored Claude de l’historique Sillage ?', branch: 'docs/readme-refresh', git: 'merged', status: 'idle', date: 'today', age: ['hours', 1] },
  { id: 'progress', original: 'J’ai envie de faire un système de progression de task. L’idée serait de voir où en est chaque demande.', branch: null, git: null, status: 'waiting', date: 'today', age: ['hours', 2], workspace: 'main' },
  { id: 'tools', original: 'J’aimerais bien changer les affichages de tool dans le fil de conversation.', branch: 'design/tool-displays', git: 'uncommitted', status: 'waiting', date: 'today', age: ['hours', 3], workspace: 'tools' },
  { id: 'missingTree', original: 'Le dossier de ce worktree a été déplacé. Retrouvons-le avant de poursuivre.', branch: 'fix/desktop-paths', git: 'missing', status: 'idle', date: 'today', age: ['hours', 4] },
  { id: 'unknownTree', original: 'La lecture de l’état Git est indisponible pour le moment. Il faudra la relancer.', branch: 'feat/cli-review', git: 'unknown', status: 'idle', date: 'today', age: ['hours', 5] },
  { id: 'permissions', original: 'Un pote m’a dit qu’il a configuré le défaut Claude Code en tout autoriser, mais il reçoit encore des demandes.', branch: 'fix/claude-bypass-permissions', git: 'merged', status: 'idle', date: 'yesterday', age: ['days', 1] },
  { id: 'rss', original: 'Je viens de supprimer une session Sillage sans faire exprès, est-ce qu’on peut la retrouver ?', branch: 'feat/rss-watch', git: 'merged', status: 'idle', date: 'yesterday', age: ['days', 1] },
  { id: 'typing', original: 'J’aimerais bien que tu me fasses des propositions de typing indicators.', branch: 'design/typing-indicators', git: 'merged', status: 'idle', date: 'yesterday', age: ['days', 1] },
  { id: 'activityList', original: 'Dans Activity (modal), j’aimerais plutôt que ce soit une liste triée par projet.', branch: 'feat/activity-project-list', git: 'merged', status: 'idle', date: 'week', age: ['days', 2] },
  { id: 'conversationWidth', original: 'Un pote dit que la taille (width du contenu) est trop petite. On peut la régler ?', branch: 'feat/conversation-width', git: 'merged', status: 'idle', date: 'week', age: ['days', 2] },
  { id: 'desktopFollowup', original: 'Tu peux vérifier que le correctif mémoire permet bien le démarrage sur Windows ?', branch: 'fix/desktop-heap-limit', git: 'merged', status: 'idle', date: 'week', age: ['days', 3], workspace: 'desktop' },
  { id: 'toolsFollowup', original: 'Comparons une ligne compacte et une version avec le résultat de l’outil déplié.', branch: 'design/tool-displays', git: 'uncommitted', status: 'idle', date: 'week', age: ['days', 3], workspace: 'tools' },
]

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), catalogs[state.locale][key] ?? catalogs.en[key] ?? key)
const title = session => state.short ? t(session.id) : session.original
const age = session => t(session.age[0], { n: session.age[1] })
const svg = (content, extra = '') => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${content}</svg>`
const icons = {
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  branch: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 8-12 3-12 10"/>'),
  chevron: svg('<path d="m9 5 7 7-7 7"/>'),
  board: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16"/>'),
  chat: svg('<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-5 3V6a2 2 0 0 1 2-2Z"/>'),
  close: svg('<path d="m6 6 12 12M6 18 18 6"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>'),
  merged: svg('<path d="m5 12 4 4L19 6"/>'),
  uncommitted: svg('<path d="m15 4 5 5M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6Z"/>'),
  unmerged: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m1-6h7a4 4 0 0 0 4-4V3m-3 3 3-3 3 3"/>'),
  missing: svg('<path d="m12 3 10 18H2L12 3Z M12 9v5m0 3v.01"/>'),
  unknown: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3v.01"/>'),
  agent: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="${openAiPath}"/></svg>`,
  echo: '<svg viewBox="0 0 100 100" width="25" height="25" fill="currentColor" aria-hidden="true"><path d="M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79ZM23 79C47 79 39 21 65 21H78C54 21 62 79 36 79ZM42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z"/></svg>',
}

const agentName = session => session.agent === 'claude' ? 'Claude Code' : 'Codex'
const agentIcon = session => session.agent === 'claude' ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="#D97757" aria-hidden="true"><path d="${claudePath}"/></svg>` : icons.agent

function statusMark(session) {
  return `<span class="state-mark ${session.status}" aria-label="${t(session.status)}">${{ running: '◉', waiting: '?', idle: '' }[session.status]}</span>`
}

function gitMarker(session, presentation) {
  if (!session.branch || !session.git) return ''
  return `<span class="worktree-marker git-${session.git} git-${presentation}" role="note" aria-label="${escape(t('worktreeStateLabel', { state: t(session.git) }))}">${icons[session.git]}${presentation === 'symbol' ? '' : `<span>${t(session.git)}</span>`}</span>`
}

function row(session, kind, presentation = state.gitPresentation) {
  const original = kind === 'original'
  const symbol = !original && presentation === 'symbol'
  const selected = state.selected === session.id && (!fullStudy || state.screen === 'session')
  const detailsLabel = symbol && session.git ? t('showWorktreeDetails', { title: t(session.id), state: t(session.git) }) : t('showDetails', { title: t(session.id) })
  return `<li class="session-entry ${symbol ? 'symbol-entry' : ''}"><button class="session-row ${selected ? 'selected' : ''} ${original ? 'legacy' : ''}" data-session="${session.id}" data-kind="${kind}-${presentation}" aria-pressed="${selected}">
    <span class="agent-mark" role="img" aria-label="${agentName(session)}">${agentIcon(session)}</span>
    <span class="row-copy"><span class="row-title">${escape(original ? session.original : title(session))}</span>${!original && presentation === 'subline' ? gitMarker(session, presentation) : ''}${kind === 'timeline' ? `<span class="excerpt">${escape(t(`${session.id}Excerpt`))}</span>` : ''}</span>
    ${!original && presentation === 'badge' ? gitMarker(session, presentation) : ''}
    ${original ? statusMark(session) : `${kind === 'quiet' && (symbol || session.status !== 'idle') ? statusMark(session) : ''}<span class="age">${age(session)}</span>`}
    ${original && session.branch ? `<span class="legacy-branch"><i class="git-square ${session.git}"></i><span>${escape(session.branch)}</span><span>· ${t(session.git)}</span></span>` : ''}
  </button><button class="details-trigger ${symbol && session.git ? 'worktree-trigger' : ''}" data-details="${session.id}" aria-label="${escape(detailsLabel)}" aria-haspopup="dialog" aria-expanded="false" aria-controls="session-preview">${symbol && session.git ? gitMarker(session, 'symbol') : icons.info}</button></li>`
}

function group(key, label, data, kind, branch = '') {
  const open = expanded.has(key) || Boolean(state.query)
  return `<details class="session-group" data-group="${key}" ${open ? 'open' : ''}><summary><span class="chevron">${icons.chevron}</span><span class="group-copy"><span>${escape(label)}</span>${branch ? `<code>${escape(branch)}</code>` : ''}</span><span class="group-count">${data.length}</span></summary><ul>${data.map(session => row(session, kind)).join('')}</ul></details>`
}

function list(kind, presentation) {
  const query = state.query.toLocaleLowerCase(state.locale)
  const data = sessions.filter(session => `${title(session)} ${session.original} ${session.branch ?? ''}`.toLocaleLowerCase(state.locale).includes(query))
  if (!data.length) return `<div class="empty">${icons.search}<p>${t('noResults')}</p></div>`
  if (kind === 'quiet' || kind === 'original') return `<ul>${data.map(session => row(session, kind, presentation)).join('')}</ul>`
  if (kind === 'timeline') return ['today', 'yesterday', 'week'].map(date => {
    const items = data.filter(session => session.date === date)
    return items.length ? `<section class="date-section"><h3>${t(date)}</h3><ul>${items.map(session => row(session, kind)).join('')}</ul></section>` : ''
  }).join('')
  const active = data.filter(session => session.git && session.git !== 'merged')
  const main = data.filter(session => !session.branch)
  const merged = data.filter(session => session.git === 'merged')
  const branches = [...new Set(merged.map(session => session.branch))]
  return `${active.length || main.length ? `<h3 class="list-label">${t('activeWorktrees')}</h3>` : ''}
    ${[...new Set(active.map(session => session.branch))].map(branch => {
      const items = active.filter(session => session.branch === branch)
      const key = items[0].workspace || items[0].id
      return group(`workspace-${key}`, t(key === 'tools' ? 'toolsWorkspace' : key), items, kind, branch)
    }).join('')}
    ${main.length ? group('workspace-main', t('mainTree'), main, kind) : ''}
    ${merged.length ? `<details class="merged-section" data-group="workspace-merged" ${expanded.has('workspace-merged') || state.query ? 'open' : ''}><summary><span class="chevron">${icons.chevron}</span><span>${t('mergedWorktrees')}</span><span class="group-count">${branches.length}</span></summary>${branches.map(branch => {
      const items = merged.filter(session => session.branch === branch)
      const key = items[0].workspace || items[0].id
      return group(`workspace-${key}`, t(key === 'desktop' ? 'desktopWorkspace' : key), items, kind, branch)
    }).join('')}</details>` : ''}`
}

function previewContent(session, pinned) {
  return `<div class="preview-cli">${agentIcon(session)}<span>${agentName(session)}</span><span class="preview-project">${escape(session.projectName || 'Sillage')}</span>${pinned ? `<button class="preview-close" data-close-preview aria-label="${t('close')}">${icons.close}</button>` : ''}</div><h3 id="preview-title">${escape(t(session.id))}</h3><p class="preview-excerpt">${escape(t(`${session.id}Excerpt`))}</p><dl class="preview-metadata"><div><dt>${t('activity')}</dt><dd class="${session.status}">${statusMark(session)}${t(session.status)}</dd></div><div><dt>${t('lastActivity')}</dt><dd>${age(session)}</dd></div></dl><div class="preview-worktree"><span>${t('worktreeState')}</span>${session.git ? `<div class="preview-git-state">${gitMarker(session, 'detail')}<p class="git-explanation">${t(`${session.git}Meaning`)}</p></div>` : ''}<div class="preview-branch">${icons.branch}<code>${escape(session.branch || t('noBranch'))}</code></div></div><div class="preview-request"><span>${t('prompt')}</span><p>${escape(session.original)}</p></div>`
}

function sidebar(kind, presentation = state.gitPresentation) {
  return `<div class="sidebar ${kind} worktree-${presentation}"><div class="project-head"><span class="project-avatar">S</span><strong>Sillage</strong><span class="project-chevron">⌄</span></div><div class="project-nav"><span>${icons.board}${t('board')}</span><span>${icons.branch}${t('worktrees')}</span></div><div class="sessions-head"><span>${t('sessions')}<span class="total">${sessions.length}</span></span><button class="add-session" data-new aria-label="${t('newSession')}" title="${t('newSession')}">${icons.plus}</button></div><div class="session-scroll" data-scroll="${kind}-${presentation}">${list(kind, presentation)}</div></div>`
}

function gitDescription(presentation) {
  return `<div class="description"><div class="proposal-name"><h2>${t(`git${presentation}Name`)}</h2>${presentation === 'symbol' ? `<span class="recommendation">${t('chosen')}</span>` : ''}</div><p>${t(`git${presentation}Desc`)}</p><p class="tradeoff">${t(`git${presentation}Trade`)}</p></div>`
}

function gitControls() {
  return `<section class="git-controls" aria-label="${t('worktreeState')}"><div class="git-controls-head"><span>${icons.branch}${t('worktreeState')}</span><div class="git-choices" role="group" aria-label="${t('worktreeState')}">${gitPresentations.map(presentation => `<button data-git="${presentation}" aria-pressed="${state.view !== 'gitcompare' && state.gitPresentation === presentation}">${t(`git${presentation}Name`)}</button>`).join('')}<button data-view="gitcompare" aria-pressed="${state.view === 'gitcompare'}">${t('compareMarkers')}</button></div></div><p>${t('gitControlHint')}</p><div class="git-legend">${['uncommitted', 'unmerged', 'merged', 'missing', 'unknown'].map(git => gitMarker({branch:true, git}, 'legend')).join('')}</div></section>`
}

function description(kind) {
  return `<div class="description"><div class="proposal-name"><h2>${t(`${kind}Name`)}</h2>${kind === 'quiet' ? `<span class="recommendation">${t('recommended')}</span>` : ''}</div><p>${t(`${kind}Desc`)}</p><p class="tradeoff">${t(`${kind}Trade`)}</p></div>`
}

function conversation() {
  const session = sessions.find(item => item.id === state.selected)
  return `<section class="conversation"><div class="conversation-head">${icons.chat}<span>${escape(t(session.id))}</span><span class="conversation-kind">Codex</span></div><div class="conversation-content"><div class="conversation-note">${t('demoNotice')}</div><p class="user-message">${escape(session.original)}</p><div class="assistant-label">${icons.agent}<strong>Codex</strong><span>${t(session.status)}</span></div><p>${escape(t(`${session.id}Excerpt`))}</p><div class="context-detail"><span>${t('branch')}</span><code>${escape(session.branch || t('noBranch'))}</code>${session.git ? `<span>${t('git')}</span><strong>${t(session.git)}</strong>` : ''}</div></div><div class="composer"><span>${t('composer')}</span><div><span>Codex</span><span>${t('composerNote')}</span></div></div></section>`
}

function paintContent() {
  closePreview()
  const content = document.querySelector('#content')
  const scrolls = new Map([...content.querySelectorAll('[data-scroll]')].map(el => [el.dataset.scroll, el.scrollTop]))
  const focused = document.activeElement
  const focusKey = focused?.dataset.session ? `[data-session="${focused.dataset.session}"][data-kind="${focused.dataset.kind}"]` : null
  document.querySelector('#git-controls').innerHTML = gitControls()
  content.className = ['compare', 'gitcompare'].includes(state.view) ? 'gallery' : 'in-context'
  content.innerHTML = state.view === 'gitcompare' ? gitPresentations.map(presentation => `<article class="proposal">${gitDescription(presentation)}<button class="context-button" data-git="${presentation}">${t('context')}<span aria-hidden="true">↗</span></button><div class="preview-wrap">${sidebar('quiet', presentation)}</div></article>`).join('') : state.view === 'compare' ? variants.map(kind => `<article class="proposal">${description(kind)}<button class="context-button" data-view="${kind}">${t('context')}<span aria-hidden="true">↗</span></button><div class="preview-wrap">${sidebar(kind)}</div></article>`).join('') : `${description(state.view)}<div class="app-preview">${sidebar(state.view)}${conversation()}</div>`
  for (const el of content.querySelectorAll('[data-scroll]')) el.scrollTop = scrolls.get(el.dataset.scroll) || 0
  restoringFocus = true
  if (focusKey) content.querySelector(focusKey)?.focus({ preventScroll: true })
  restoringFocus = false
  content.querySelectorAll('details[data-group]').forEach(detail => detail.addEventListener('toggle', () => {
    if (state.query) return
    if (detail.open) expanded.add(detail.dataset.group)
    else expanded.delete(detail.dataset.group)
  }))
  document.querySelectorAll('button[data-view]').forEach(button => button.setAttribute('aria-pressed', button.dataset.view === state.view))
}

// This standalone study mirrors the app tooltip's 400 ms delay and uses a body-level
// overlay so scrolling sidebars never clip the preview. A pinned view supports touch.
const preview = document.querySelector('#session-preview')
let anchor = null
let previewPinned = false
let openingTimer
let closingTimer
let restoringFocus = false

function closePreview(restoreFocus = false) {
  clearTimeout(openingTimer)
  clearTimeout(closingTimer)
  const previousAnchor = anchor
  const wasPinned = previewPinned
  anchor?.removeAttribute('aria-describedby')
  if (previewPinned) anchor?.setAttribute('aria-expanded', 'false')
  anchor = null
  previewPinned = false
  preview.hidden = true
  if (restoreFocus && wasPinned && previousAnchor?.isConnected) {
    restoringFocus = true
    previousAnchor.focus({ preventScroll: true })
    restoringFocus = false
  }
}

function positionPreview() {
  if (!anchor?.isConnected || preview.hidden) return
  const rect = anchor.getBoundingClientRect()
  const width = preview.offsetWidth
  const height = preview.offsetHeight
  const narrow = window.innerWidth <= 720
  const preferredLeft = rect.right + 12
  const left = narrow ? (innerWidth - width) / 2 : preferredLeft + width <= innerWidth - 12 ? preferredLeft : rect.left - width - 12
  const top = narrow && previewPinned ? innerHeight - height - 12 : rect.top - 12
  preview.style.left = `${Math.max(12, Math.min(left, innerWidth - width - 12))}px`
  preview.style.top = `${Math.max(12, Math.min(top, innerHeight - height - 12))}px`
}

function showPreview(nextAnchor, pinned = false) {
  if (!nextAnchor.isConnected || (previewPinned && !pinned)) return
  closePreview()
  anchor = nextAnchor
  previewPinned = pinned
  const session = sessions.find(item => item.id === (anchor.dataset.details || anchor.dataset.session))
  preview.innerHTML = previewContent(session, pinned)
  preview.setAttribute('role', pinned ? 'dialog' : 'tooltip')
  preview.toggleAttribute('data-pinned', pinned)
  if (pinned) {
    preview.setAttribute('aria-labelledby', 'preview-title')
    anchor.setAttribute('aria-expanded', 'true')
  } else {
    preview.removeAttribute('aria-labelledby')
    anchor.setAttribute('aria-describedby', 'session-preview')
  }
  preview.hidden = false
  positionPreview()
  if (pinned) preview.querySelector('[data-close-preview]').focus({ preventScroll: true })
}

function schedulePreview(nextAnchor, delay = 400) {
  if (previewPinned) return
  clearTimeout(openingTimer)
  clearTimeout(closingTimer)
  if (anchor === nextAnchor && !preview.hidden) return
  // Moving to another row should not temporarily show details for the previous one.
  closePreview()
  openingTimer = setTimeout(() => showPreview(nextAnchor), delay)
}

function scheduleClose() {
  clearTimeout(openingTimer)
  if (!previewPinned) closingTimer = setTimeout(() => closePreview(), 180)
}

document.addEventListener('pointerover', event => {
  if (event.pointerType !== 'mouse' || !matchMedia('(hover: hover) and (pointer: fine)').matches) return
  if (preview.contains(event.target)) { clearTimeout(closingTimer); return }
  const entry = event.target.closest('.session-entry')
  if (entry && !entry.contains(event.relatedTarget)) schedulePreview(entry.querySelector('.session-row'))
})
document.addEventListener('pointerout', event => {
  if (event.pointerType !== 'mouse') return
  if (preview.contains(event.target)) {
    if (!preview.contains(event.relatedTarget) && !anchor?.closest('.session-entry').contains(event.relatedTarget)) scheduleClose()
    return
  }
  const entry = event.target.closest('.session-entry')
  if (entry && !entry.contains(event.relatedTarget) && !preview.contains(event.relatedTarget)) scheduleClose()
})
document.addEventListener('focusin', event => {
  if (restoringFocus || preview.contains(event.target)) return
  if (previewPinned && event.target !== anchor) closePreview()
  if (event.target.matches('.session-row:focus-visible, .details-trigger:focus-visible') && matchMedia('(hover: hover) and (pointer: fine)').matches) schedulePreview(event.target, 0)
  else if (!previewPinned) closePreview()
})
document.addEventListener('focusout', event => {
  if (event.target === anchor && !preview.contains(event.relatedTarget)) scheduleClose()
})
document.addEventListener('pointerdown', event => {
  if (!preview.contains(event.target) && !anchor?.closest('.session-entry').contains(event.target)) closePreview()
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !preview.hidden) { event.preventDefault(); closePreview(true) }
})
document.addEventListener('scroll', event => {
  if (preview.hidden || preview.contains(event.target)) return
  // Opening the explicit popup can finish a browser focus scroll on the next frame.
  // Keep that popup attached; only transient hover previews disappear on scroll.
  if (previewPinned) positionPreview()
  else closePreview()
}, true)
window.addEventListener('resize', () => closePreview())

function render() {
  document.documentElement.lang = state.locale
  document.documentElement.dataset.theme = state.theme
  document.documentElement.style.setProperty('--sidebar-size', `${state.width}px`)
  document.title = t('pageTitle')
  document.querySelector('#app').innerHTML = `<header class="page-head"><div class="brand">${icons.echo}<strong>Sillage</strong><span>/</span><span>${t('atelier')}</span><a class="full-study-link" href="sidebar.html">${t('fullTitle')} ↗</a></div><div class="intro"><h1>${t('title')}</h1><p>${t('intro')}</p><small>${t('fixture')}</small></div></header>
    <main><section class="controls" aria-label="${t('atelier')}"><div class="control-main"><div class="title-switch" role="group" aria-label="${t('titleLabel')}"><button data-title="short" aria-pressed="${state.short}">${t('short')}</button><button data-title="original" aria-pressed="${!state.short}">${t('original')}</button></div><label class="width-control">${t('width')}<input type="range" id="width" min="264" max="440" step="8" value="${state.width}"><output for="width">${state.width} px</output></label><label class="select-control"><span>${t('theme')}</span><select id="theme"><option value="dark" ${state.theme === 'dark' ? 'selected' : ''}>${t('dark')}</option><option value="light" ${state.theme === 'light' ? 'selected' : ''}>${t('light')}</option></select></label><label class="select-control"><span>${t('language')}</span><select id="language"><option value="fr" ${state.locale === 'fr' ? 'selected' : ''}>Français</option><option value="en" ${state.locale === 'en' ? 'selected' : ''}>English</option></select></label></div><p class="title-hint">${t('titleHint')}</p></section>
    <div class="view-bar"><nav aria-label="${t('atelier')}"><button data-view="compare">${t('compare')}</button>${variants.map(kind => `<button data-view="${kind}">${t(`${kind}Name`)}</button>`).join('')}<button data-view="original">${t('current')}</button></nav><label class="search-box">${icons.search}<input id="search" type="search" placeholder="${t('search')}" aria-label="${t('search')}" value="${escape(state.query)}"></label></div><div id="git-controls"></div><div id="content"></div><footer><span>${t('footer')}</span><span>${t('sample', { count: sessions.length })}</span></footer></main>`
  paintContent()
}

document.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  if (button.dataset.details) {
    if (previewPinned && anchor === button) closePreview(true)
    else showPreview(button, true)
    return
  }
  if (button.hasAttribute('data-close-preview')) { closePreview(true); return }
  if (fullStudy) return
  if (button.dataset.git) {
    state.gitPresentation = button.dataset.git
    state.view = 'quiet'
    paintContent()
    document.querySelector(`#git-controls [data-git="${state.gitPresentation}"]`).focus({ preventScroll: true })
    return
  }
  if (button.dataset.view) {
    const fromGitControls = Boolean(button.closest('#git-controls'))
    state.view = button.dataset.view
    paintContent()
    if (fromGitControls) document.querySelector('#git-controls [data-view="gitcompare"]').focus({ preventScroll: true })
  }
  if (button.dataset.title) {
    state.short = button.dataset.title === 'short'
    document.querySelectorAll('[data-title]').forEach(el => el.setAttribute('aria-pressed', (el.dataset.title === 'short') === state.short))
    paintContent()
  }
  if (button.dataset.session) { state.selected = button.dataset.session; paintContent() }
  if (button.hasAttribute('data-new')) {
    const notice = document.querySelector('#notice')
    notice.querySelector('p').textContent = t('demoOnly')
    notice.querySelector('button').textContent = t('close')
    notice.showModal()
  }
})
document.addEventListener('input', event => {
  if (fullStudy) return
  if (event.target.id === 'search') { state.query = event.target.value; paintContent() }
  if (event.target.id === 'width') {
    closePreview()
    state.width = Number(event.target.value)
    document.documentElement.style.setProperty('--sidebar-size', `${state.width}px`)
    document.querySelector('output').textContent = `${state.width} px`
  }
})
document.addEventListener('change', event => {
  if (fullStudy) return
  if (event.target.id === 'theme') { state.theme = event.target.value; document.documentElement.dataset.theme = state.theme }
  if (event.target.id === 'language') { state.locale = event.target.value; render(); document.querySelector('#language').focus() }
})
if (fullStudy) {
  const { mountFullSidebar } = await import('./full-sidebar.js')
  mountFullSidebar({ state, sessions, t, escape, icons, svg, row, gitMarker, agentName, agentIcon, closePreview })
} else render()
