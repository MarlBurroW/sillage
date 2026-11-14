import { icons } from './icons.js'
import { marks } from './marks.js'
import { projects, sessions, decisions, discussions, benchmarks, wallViews, settingsGroups, boardCards } from './data.js'

const app = document.getElementById('app')
const tip = document.getElementById('tip')
const phone = matchMedia('(max-width: 760px)')
const hoverless = matchMedia('(hover: none), (pointer: coarse)')

const state = {
  // Study controls, not part of the proposal.
  variant: 'after', scenario: 'busy', theme: 'dark', edition: 'server', railLabels: false, controlsOpen: !phone.matches,
  // A space is what the rail selects; the view is what the main area shows.
  space: 'project:sillage',
  view: { type: 'session', id: 's1' },
  last: {},
  columnOpen: true,
  drawerOpen: false,
  popover: null,
  filterOpen: false, filter: '', archivesOpen: false, showAll: false,
  projectQuery: '',
  pinned: new Set(projects.filter((project) => project.pinned).map((project) => project.id)),
  read: new Set(),
}

const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const icon = (name, size = 16, cls = '') => `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`
const agentIcon = (agent, size = 16) => `<svg width="${size}" height="${size}" viewBox="${marks[agent].viewBox}" fill="${marks[agent].fill}" fill-rule="evenodd" aria-hidden="true">${marks[agent].body}</svg>`
const logo = (size) => `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">${marks.logo}</svg>`
const plural = (count, one, many) => `${count} ${count > 1 ? many : one}`
const projectOf = (id) => projects.find((project) => project.id === id)
const initials = (name) => name.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase()
const avatar = (project, size = 'md') => `<span class="avatar avatar-${size}" style="--c:${project.color}" aria-hidden="true">${esc(initials(project.name))}</span>`

// The calm scenario shows the same structure with nothing live, to judge the empty states.
const calm = () => state.scenario === 'calm'
const statusOf = (session) => (calm() ? 'idle' : session.status ?? 'idle')
const isOpen = (session) => state.view.type === 'session' && state.view.id === session.id
const unreadOf = (session) => !calm() && Boolean(session.unread) && !state.read.has(session.id) && !isOpen(session)
const pendingDecisions = () => (calm() ? [] : decisions)
const spaceProject = () => (state.space.startsWith('project:') ? projectOf(state.space.slice(8)) : null)

function projectCounts(id) {
  const own = sessions.filter((session) => session.project === id)
  return {
    awaiting: own.filter((session) => statusOf(session) === 'awaiting').length + pendingDecisions().filter((decision) => decision.project === id).length,
    running: own.filter((session) => statusOf(session) === 'running').length,
    unread: own.filter(unreadOf).length,
  }
}

function countsText({ awaiting, running, unread }) {
  const parts = []
  if (awaiting) parts.push(`${awaiting} à débloquer`)
  if (running) parts.push(`${running} en cours`)
  if (unread) parts.push(plural(unread, 'non lue', 'non lues'))
  return parts.join(' · ') || 'Rien en attente'
}

function defaultView(space) {
  if (space.startsWith('project:')) {
    const id = space.slice(8)
    const first = sessions.find((session) => session.project === id)
    return first ? { type: 'session', id: first.id } : { type: 'draft', project: id }
  }
  return {
    wall: { type: 'wall', id: wallViews[0].id },
    discussions: { type: 'discussion', id: discussions[0].id },
    benchmarks: { type: 'benchmarks' },
    services: { type: 'services' },
    settings: { type: 'settings', section: 'Apparence' },
  }[space]
}

/* ---------- Rail ---------- */

function railItem({ space, glyph, label, detail = '', extra = '', short = label }) {
  const current = state.space === space
  return `<button type="button" class="rail-item" data-act="space" data-arg="${space}" ${current ? 'aria-current="page"' : ''} aria-label="${esc(detail ? `${label} : ${detail}` : label)}" data-tip="${esc(label)}|${esc(detail)}">${glyph}${extra}<span class="rail-label">${esc(short)}</span></button>`
}

function rail() {
  const awaiting = sessions.filter((session) => statusOf(session) === 'awaiting').length + pendingDecisions().length
  const running = sessions.filter((session) => statusOf(session) === 'running').length
  const unread = sessions.filter(unreadOf).length
  const badge = awaiting ? `<span class="rail-badge">${awaiting}</span>` : running ? '<span class="rail-dot is-running"></span>' : ''
  const active = spaceProject()
  // A project opened from the full list stays reachable while it is the current one.
  const shown = projects.filter((project) => state.pinned.has(project.id) || project.id === active?.id)
  const hidden = projects.length - shown.length
  const hiddenLive = projects.filter((project) => !shown.includes(project)).some((project) => { const counts = projectCounts(project.id); return counts.awaiting || counts.unread })

  return `<div class="rail" role="navigation" aria-label="Espaces">
    <span class="rail-brand" data-tip="Sillage|">${logo(22)}</span>
    <button type="button" class="rail-item" data-act="search" aria-label="Rechercher" data-tip="Rechercher|⌘ K">${icon('search', 18)}<span class="rail-label">Chercher</span></button>
    ${railItem({ space: 'activity', glyph: icon('activity', 18), label: 'Activité', detail: countsText({ awaiting, running, unread }), extra: badge })}
    ${railItem({ space: 'wall', glyph: icon('layout-grid', 18), label: 'Mur', detail: 'Plusieurs sessions côte à côte' })}
    ${railItem({ space: 'discussions', glyph: icon('message-square', 18), label: 'Discussions', detail: 'Hors projet', short: 'Discuss.' })}
    ${railItem({ space: 'benchmarks', glyph: icon('flask-conical', 18), label: 'Benchmarks', detail: benchmarks.some((entry) => entry.state === 'running') && !calm() ? '1 en cours' : '', short: 'Bench.' })}
    <span class="rail-rule"></span>
    <div class="rail-projects" data-scroll="rail">
      ${shown.map((project) => {
        const counts = projectCounts(project.id)
        const dot = counts.awaiting ? 'is-awaiting' : counts.running ? 'is-running' : counts.unread ? 'is-unread' : ''
        return railItem({ space: `project:${project.id}`, glyph: avatar(project, 'lg'), label: project.name, detail: countsText(counts), extra: dot ? `<span class="rail-dot ${dot}"></span>` : '' })
      }).join('')}
      <button type="button" class="rail-item" data-act="popover" data-arg="projects" aria-haspopup="dialog" aria-expanded="${state.popover === 'projects'}" aria-label="Tous les projets" data-tip="Tous les projets|${hidden} autres, recherche, épingles">${icon('ellipsis', 18)}${hiddenLive ? '<span class="rail-dot is-unread"></span>' : ''}<span class="rail-label">Tous</span></button>
    </div>
    <span class="rail-rule"></span>
    ${railItem({ space: 'services', glyph: icon('server', 18), label: 'Services', detail: 'Apps et serveurs lancés' })}
    ${railItem({ space: 'settings', glyph: `${icon('settings', 18)}`, label: 'Réglages', detail: 'Mise à jour disponible', extra: '<span class="rail-update"></span>' })}
    ${state.edition === 'server' ? `<button type="button" class="rail-item" data-act="popover" data-arg="account" aria-haspopup="menu" aria-expanded="${state.popover === 'account'}" aria-label="Compte" data-tip="marlburrow|Compte"><span class="account-avatar">M</span><span class="rail-label">Compte</span></button>` : ''}
  </div>`
}

/* ---------- Rows shared by every column ---------- */

const GIT = {
  merged: { glyph: 'check', label: 'Fusionné' },
  dirty: { glyph: 'pencil', label: 'Non commité' },
  unmerged: { glyph: 'git-pull-request-arrow', label: 'À fusionner' },
  leftovers: { glyph: 'file-check', label: 'Fusionné, fichiers restants' },
  missing: { glyph: 'triangle-alert', label: 'Introuvable' },
}

function signalOf(session) {
  const status = statusOf(session)
  if (status === 'awaiting') return `<span class="signal signal-awaiting" title="À débloquer">${icon('message-circle-question', 13)}</span>`
  if (status === 'running') return '<span class="signal signal-running" title="En cours"></span>'
  return ''
}

function sessionRow(session) {
  const git = session.git ? GIT[session.git] : null
  return `<li class="sidebar-session ${isOpen(session) ? 'sidebar-current' : ''} ${unreadOf(session) ? 'sidebar-unread' : ''}">
    <button type="button" class="sidebar-session-link" data-act="session" data-arg="${session.id}">
      ${agentIcon(session.agent)}
      <span class="sidebar-session-title">${esc(session.title)}</span>
      ${session.card ? `<span class="sidebar-session-card">#${session.card}</span>` : ''}
      ${session.favorite ? icon('star', 10, 'faint') : ''}
      <span class="sidebar-session-signals">${signalOf(session)}</span>
    </button>
    <span class="sidebar-session-actions"><time class="sidebar-session-age">${esc(session.age)}</time><button type="button" class="sidebar-session-menu" aria-label="Actions de la session">${icon('ellipsis', 15)}</button></span>
    <span class="git-mark git-${session.git ?? 'none'}" ${git ? `title="${git.label} · ${esc(session.branch)}"` : ''}>${git ? icon(git.glyph, 15) : ''}</span>
  </li>`
}

// Cross-project lists name the project under the title: the list no longer says where a row lives.
function wideRow({ act, arg, lead, title, project, trail = '', current = false, tone = '' }) {
  return `<li class="wide-row ${current ? 'sidebar-current' : ''} ${tone}">
    <button type="button" data-act="${act}" data-arg="${arg}">
      <span class="wide-lead">${lead}</span>
      <span class="wide-text"><span class="wide-title">${esc(title)}</span><span class="wide-meta">${project ? `${avatar(project, 'xs')}<span>${esc(project.name)}</span>` : ''}</span></span>
      ${trail}
    </button>
  </li>`
}

const crossRow = (session) => wideRow({
  act: 'session', arg: session.id, lead: agentIcon(session.agent), title: session.title, project: projectOf(session.project),
  trail: signalOf(session), current: isOpen(session), tone: unreadOf(session) ? 'sidebar-unread' : '',
})

const heading = (label, count, tone = '', actions = '') => `<div class="sidebar-sessions-heading"><span>${label}<span class="count ${tone}">${count}</span></span>${actions}</div>`
const collapseButton = () => (phone.matches
  ? `<button type="button" class="icon-btn" data-act="drawer" aria-label="Fermer la navigation">${icon('x', 18)}</button>`
  : `<button type="button" class="icon-btn" data-act="collapse" aria-label="Replier la colonne" data-tip="Replier la colonne|Le rail reste visible" data-tip-side="bottom">${icon('panel-left-close', 17)}</button>`)
const columnHead = (title, actions = '', lead = '') => `<div class="col-head">${lead}<h2>${esc(title)}</h2><span class="col-actions">${actions}${collapseButton()}</span></div>`

/* ---------- Columns ---------- */

function activityColumn() {
  const awaiting = sessions.filter((session) => statusOf(session) === 'awaiting')
  const running = sessions.filter((session) => statusOf(session) === 'running')
  const unread = sessions.filter(unreadOf)
  const favorites = sessions.filter((session) => session.favorite)
  const pending = pendingDecisions()
  const section = (label, rows, tone = '') => (rows.length ? `${heading(label, rows.length, tone)}<ul class="col-list">${rows.join('')}</ul>` : '')
  const quiet = !awaiting.length && !running.length && !unread.length && !pending.length
  return `${columnHead('Activité')}
    <div class="col-scroll" data-scroll="activity">
      ${quiet ? '<p class="col-empty">Rien ne t’attend et aucune session ne tourne.</p>' : ''}
      ${section('À débloquer', [
        ...pending.map((decision) => wideRow({ act: 'decision', arg: decision.id, lead: icon('circle-help', 16, 'caution'), title: decision.title, project: projectOf(decision.project), trail: '<span class="wide-tag caution">Décision</span>', current: state.view.type === 'decision' && state.view.id === decision.id })),
        ...awaiting.map(crossRow),
      ], 'caution')}
      ${section('En cours', running.map(crossRow))}
      ${section('Non lues', unread.map(crossRow))}
      ${section('Favoris', favorites.map(crossRow))}
    </div>`
}

function projectColumn(project) {
  const own = sessions.filter((session) => session.project === project.id)
  const viewIs = (type) => state.view.type === type && state.view.project === project.id
  const link = (type, glyph, label, counts) => `<li><button type="button" class="sidebar-project-link ${viewIs(type) ? 'sidebar-current' : ''}" data-act="view" data-arg="${type}">${icon(glyph, 14)}<span class="grow">${label}</span><span>${counts}</span></button></li>`
  const board = project.board.open ? `${plural(project.board.open, 'ouverte', 'ouvertes')}${project.board.review ? ` · <span class="caution">${project.board.review} à relire</span>` : ''}` : ''
  const trees = [project.trees.pending ? `${project.trees.pending} en attente` : '', project.trees.cleanable ? `<span class="caution">${project.trees.cleanable} à nettoyer</span>` : ''].filter(Boolean).join(' · ')
  return `${columnHead(project.name, `<button type="button" class="icon-btn" data-act="popover" data-arg="project-menu" aria-haspopup="menu" aria-expanded="${state.popover === 'project-menu'}" aria-label="Actions du projet ${esc(project.name)}">${icon('ellipsis', 16)}</button>`, `${avatar(project, 'md')}`)}
    ${state.popover === 'project-menu' ? projectMenu(project) : ''}
    <div class="sidebar-project-focused col-body"><div class="sidebar-project-content">
      <ul class="sidebar-project-links">
        ${link('board', 'square-kanban', 'Board', board)}
        ${trees ? link('worktrees', 'folder-git-2', 'Chantiers', trees) : ''}
        ${link('schedules', 'calendar-clock', 'Planifiées', project.schedules)}
      </ul>
      ${heading('Sessions', own.length, '', `
        <button type="button" class="icon-btn" data-act="filter" aria-expanded="${state.filterOpen}" aria-label="Filtrer les sessions" data-tip="Filtrer les sessions|Par titre ou par branche" data-tip-side="bottom">${icon('search', 14)}</button>
        <button type="button" class="icon-btn" data-act="draft" aria-label="Nouvelle session" data-tip="Nouvelle session|" data-tip-side="bottom">${icon('plus', 16)}</button>`)}
      ${state.filterOpen ? `<div class="sidebar-session-filter">${icon('search', 14)}<input id="session-filter" type="search" value="${esc(state.filter)}" aria-label="Filtrer les sessions" placeholder="Titre ou branche"></div>` : ''}
      <div class="sidebar-session-scroll" data-scroll="sessions"><ul data-session-list>${sessionList(own)}</ul></div>
      <div class="sidebar-archives">
        <button type="button" data-act="archives" aria-expanded="${state.archivesOpen}">${icon('archive', 14)}<span>Archivées (${project.archived})</span>${icon('chevron-right', 12, state.archivesOpen ? 'push open' : 'push')}</button>
        ${state.archivesOpen ? '<p class="col-empty">Les sessions archivées s’ouvrent ici, comme aujourd’hui.</p>' : ''}
      </div>
    </div></div>`
}

function sessionList(own) {
  const query = state.filter.trim().toLowerCase()
  const matching = own.filter((session) => !query || session.title.toLowerCase().includes(query) || (session.branch ?? '').toLowerCase().includes(query))
  if (!own.length) return '<li class="col-empty">Aucune session dans ce projet.</li>'
  if (!matching.length) return '<li class="col-empty">Aucune session ne correspond.</li>'
  return matching.map(sessionRow).join('')
}

function discussionsColumn() {
  const viewIs = (type) => state.view.type === type
  return `${columnHead('Discussions', `<button type="button" class="icon-btn" data-act="discussion-new" aria-label="Nouvelle discussion" data-tip="Nouvelle discussion|" data-tip-side="bottom">${icon('plus', 16)}</button>`)}
    <ul class="sidebar-project-links">
      <li><button type="button" class="sidebar-project-link ${viewIs('memory') ? 'sidebar-current' : ''}" data-act="page" data-arg="memory">${icon('brain', 14)}<span class="grow">Mémoire</span><span></span></button></li>
      <li><button type="button" class="sidebar-project-link ${viewIs('files') ? 'sidebar-current' : ''}" data-act="page" data-arg="files">${icon('folder-open', 14)}<span class="grow">Fichiers</span><span></span></button></li>
    </ul>
    ${heading('Discussions', discussions.length)}
    <div class="col-scroll" data-scroll="discussions"><ul class="col-list">
      ${discussions.map((entry) => `<li class="sidebar-session ${state.view.type === 'discussion' && state.view.id === entry.id ? 'sidebar-current' : ''}"><button type="button" class="sidebar-session-link" data-act="discussion" data-arg="${entry.id}">${agentIcon(entry.agent)}<span class="sidebar-session-title">${esc(entry.title)}</span></button><span class="sidebar-session-actions"><time class="sidebar-session-age">${entry.age}</time></span></li>`).join('')}
    </ul></div>
    <div class="sidebar-archives"><button type="button">${icon('archive', 14)}<span>Archivées (14)</span></button></div>`
}

function benchmarksColumn() {
  return `${columnHead('Benchmarks', `<button type="button" class="icon-btn" aria-label="Nouveau benchmark" data-tip="Nouveau benchmark|" data-tip-side="bottom">${icon('plus', 16)}</button>`)}
    ${heading('Récents', benchmarks.length)}
    <div class="col-scroll" data-scroll="benchmarks"><ul class="col-list">
      ${benchmarks.map((entry) => `<li class="wide-row ${state.view.type === 'benchmark' && state.view.id === entry.id ? 'sidebar-current' : ''}"><button type="button" data-act="benchmark" data-arg="${entry.id}"><span class="wide-lead"><span class="bench-dot bench-${calm() && entry.state === 'running' ? 'done' : entry.state}"></span></span><span class="wide-text"><span class="wide-title">${esc(entry.title)}</span><span class="wide-meta"><span>${esc(entry.detail)}</span></span></span></button></li>`).join('')}
    </ul></div>`
}

function wallColumn() {
  return `${columnHead('Mur', `<button type="button" class="icon-btn" aria-label="Nouvelle vue" data-tip="Nouvelle vue|Depuis la requête en cours" data-tip-side="bottom">${icon('plus', 16)}</button>`)}
    ${heading('Vues enregistrées', wallViews.length)}
    <div class="col-scroll" data-scroll="wall"><ul class="col-list">
      ${wallViews.map((entry) => `<li class="wide-row ${state.view.type === 'wall' && state.view.id === entry.id ? 'sidebar-current' : ''}"><button type="button" data-act="wall" data-arg="${entry.id}"><span class="wide-lead">${icon('layout-grid', 15, 'faint')}</span><span class="wide-text"><span class="wide-title">${esc(entry.name)}</span><span class="wide-meta"><code>${esc(entry.query)}</code></span></span></button></li>`).join('')}
    </ul></div>`
}

function settingsColumn() {
  return `${columnHead('Réglages')}
    <div class="col-scroll" data-scroll="settings">
      ${settingsGroups.map((group) => `<div class="settings-group">${esc(group.name)}</div><ul class="sidebar-project-links">
        ${group.items.map((item) => `<li><button type="button" class="sidebar-project-link ${state.view.type === 'settings' && state.view.section === item ? 'sidebar-current' : ''}" data-act="settings" data-arg="${esc(item)}"><span class="grow">${esc(item)}</span><span>${item === 'À propos' ? '<span class="caution">Mise à jour</span>' : ''}</span></button></li>`).join('')}
      </ul>`).join('')}
    </div>`
}

function column() {
  const project = spaceProject()
  if (project) return projectColumn(project)
  return { activity: activityColumn, wall: wallColumn, discussions: discussionsColumn, benchmarks: benchmarksColumn, settings: settingsColumn }[state.space]?.() ?? ''
}

/* ---------- Popovers ---------- */

function projectMenu(project) {
  const item = (glyph, label) => `<button type="button" role="menuitem" data-act="popover-close">${icon(glyph, 14)}${label}</button>`
  return `<div class="popover menu project-menu" role="menu" aria-label="Actions du projet ${esc(project.name)}">
    ${item('pencil', 'Renommer')}${item('sliders-horizontal', 'Réglages du projet')}${item('pin', state.pinned.has(project.id) ? 'Retirer du rail' : 'Épingler au rail')}
  </div>`
}

function projectsPanel() {
  const query = state.projectQuery.trim().toLowerCase()
  const row = (project) => {
    const counts = projectCounts(project.id)
    const dot = counts.awaiting ? 'is-awaiting' : counts.running ? 'is-running' : counts.unread ? 'is-unread' : ''
    const pinned = state.pinned.has(project.id)
    return `<li><button type="button" class="panel-project" data-act="space" data-arg="project:${project.id}">${avatar(project, 'md')}<span class="grow">${esc(project.name)}</span>${dot ? `<span class="inline-dot ${dot}"></span>` : ''}</button>
      <button type="button" class="icon-btn ${pinned ? 'is-on' : ''}" data-act="pin" data-arg="${project.id}" aria-pressed="${pinned}" aria-label="${pinned ? 'Retirer du rail' : 'Épingler au rail'} : ${esc(project.name)}">${icon('pin', 14)}</button></li>`
  }
  const match = projects.filter((project) => !query || project.name.toLowerCase().includes(query))
  const pinned = match.filter((project) => state.pinned.has(project.id))
  const others = match.filter((project) => !state.pinned.has(project.id))
  return `<div class="popover projects-panel" role="dialog" aria-label="Tous les projets">
    <div class="sidebar-session-filter">${icon('search', 14)}<input id="project-search" type="search" value="${esc(state.projectQuery)}" aria-label="Rechercher un projet" placeholder="Rechercher un projet…"></div>
    <div class="panel-scroll" data-scroll="projects" data-project-list>
      ${pinned.length ? `<div class="settings-group">Dans le rail</div><ul>${pinned.map(row).join('')}</ul>` : ''}
      ${others.length ? `<div class="settings-group">Autres projets</div><ul>${others.map(row).join('')}</ul>` : ''}
      ${match.length ? '' : '<p class="col-empty">Aucun projet trouvé</p>'}
    </div>
    <button type="button" class="panel-new" data-act="popover-close">${icon('folder-plus', 14)}Nouveau projet</button>
  </div>`
}

const accountMenu = () => `<div class="popover menu account-menu" role="menu" aria-label="Compte"><span class="menu-label">marlburrow</span><button type="button" role="menuitem" data-act="popover-close">${icon('log-out', 14)}Se déconnecter</button></div>`

/* ---------- The current sidebar, for comparison ---------- */

function currentSidebar() {
  const project = projectOf('sillage')
  const own = sessions.filter((session) => session.project === project.id)
  const shown = state.showAll ? own : own.filter((session, index) => index < 10 || isOpen(session) || session.favorite)
  const awaiting = sessions.filter((session) => statusOf(session) === 'awaiting').length
  const running = sessions.filter((session) => statusOf(session) === 'running').length
  const unread = sessions.filter(unreadOf).length
  const favorites = sessions.filter((session) => session.favorite).length
  const pending = pendingDecisions().length
  const viewIs = (type) => state.view.type === type
  return `<div class="sidebar-layout before-layout">
    <div class="sidebar-brand">${logo(21)}<span class="brand-name">Sillage</span><span class="push"><button type="button" class="icon-btn" data-act="${phone.matches ? 'drawer' : 'noop'}" aria-label="Replier">${icon(phone.matches ? 'x' : 'panel-left-close', 18)}</button></span></div>
    <button type="button" class="sidebar-search">${icon('search', 15)}<span>Rechercher</span><kbd>⌘ K</kbd></button>
    <nav class="sidebar-navigation">
      <div class="sidebar-activity">
        <button type="button" class="sidebar-activity-main">${icon('activity', 15)}<span><span class="act-heading">Activité</span><span class="act-sub">${running} en cours</span></span></button>
        <div class="sidebar-activity-counts">${awaiting ? `<button type="button" class="caution">${awaiting} à débloquer</button>` : ''}<button type="button" class="faint">${icon('inbox', 11)}${unread} non lues</button></div>
      </div>
      <div class="sidebar-global-links">
        <button type="button" class="sidebar-global-link">${icon('star', 14)}<span>Favoris</span><span>${favorites}</span></button>
        <button type="button" class="sidebar-global-link">${icon('layout-grid', 14)}<span>Mur</span></button>
        ${pending ? `<button type="button" class="sidebar-global-link">${icon('circle-help', 14)}<span>À décider</span><span class="caution">${pending}</span></button>` : ''}
      </div>
      <section class="sidebar-personal"><div class="personal-row"><button type="button" class="personal-main">${icon('message-square', 14)}<span>Discussions</span></button><span class="icon-btn">${icon('plus', 15)}</span><span class="icon-btn">${icon('ellipsis', 15)}</span></div></section>
      <section class="sidebar-personal"><div class="personal-row"><button type="button" class="personal-main">${icon('flask-conical', 14)}<span>Benchmarks</span><span class="push faint small">${benchmarks.length}</span></button><span class="icon-btn">${icon('plus', 15)}</span></div></section>
      <div class="sidebar-project-switcher"><div class="switcher"><button type="button" class="switcher-main">${avatar(project, 'md')}<span class="grow">${esc(project.name)}</span>${icon('chevron-down', 14, 'faint')}</button><span class="icon-btn">${icon('ellipsis', 16)}</span></div></div>
      <div class="sidebar-project-area"><ul class="sidebar-projects sidebar-projects-focused"><li class="sidebar-project sidebar-project-focused"><div class="sidebar-project-content">
        <ul class="sidebar-project-links">
          <li><button type="button" class="sidebar-project-link ${viewIs('board') ? 'sidebar-current' : ''}" data-act="view" data-arg="board">${icon('square-kanban', 14)}<span class="grow">Board</span><span>${project.board.open} ouvertes · <span class="caution">${project.board.review} à relire</span></span></button></li>
          <li><button type="button" class="sidebar-project-link ${viewIs('worktrees') ? 'sidebar-current' : ''}" data-act="view" data-arg="worktrees">${icon('folder-git-2', 14)}<span class="grow">Chantiers</span><span>${project.trees.pending} en attente · <span class="caution">${project.trees.cleanable} à nettoyer</span></span></button></li>
          <li><button type="button" class="sidebar-project-link ${viewIs('schedules') ? 'sidebar-current' : ''}" data-act="view" data-arg="schedules">${icon('calendar-clock', 14)}<span class="grow">Planifiées</span><span>${project.schedules}</span></button></li>
        </ul>
        ${heading('Sessions', own.length, '', `<button type="button" class="icon-btn" aria-label="Filtrer les sessions">${icon('search', 14)}</button><button type="button" class="icon-btn" aria-label="Nouvelle session">${icon('plus', 16)}</button>`)}
        <div class="sidebar-session-scroll" data-scroll="sessions"><ul>
          ${shown.map(sessionRow).join('')}
          <li><button type="button" class="more-sessions" data-act="show-all">${state.showAll ? 'Réduire la liste' : `Voir les ${own.length} sessions`}</button></li>
        </ul></div>
        <div class="sidebar-archives"><button type="button">${icon('archive', 14)}<span>Archivées (${project.archived})</span>${icon('chevron-right', 12, 'push')}</button></div>
      </div></li></ul></div>
    </nav>
    <div class="sidebar-utilities">
      <span class="sidebar-utility">${icon('server', 17)}</span><span class="sidebar-utility">${icon('settings', 17)}</span>
      ${state.edition === 'server' ? '<span class="sidebar-account"><span class="sidebar-account-avatar">M</span></span>' : ''}
    </div>
  </div>`
}

/* ---------- Main area: just enough to feel where a click lands ---------- */

function mainHead(crumb, title, extra = '') {
  const reopen = state.variant === 'after' && !state.columnOpen && state.space !== 'services' && !phone.matches
  return `<header class="main-head">
    <button type="button" class="icon-btn phone-only" data-act="drawer" aria-label="Ouvrir la navigation">${icon('menu', 18)}</button>
    ${reopen ? `<button type="button" class="icon-btn" data-act="collapse" aria-label="Afficher la colonne" data-tip="Afficher la colonne|" data-tip-side="bottom">${icon('panel-left', 17)}</button>` : ''}
    ${crumb ? `<span class="crumb">${crumb}</span><span class="faint">/</span>` : ''}
    <h1>${esc(title)}</h1>${extra}
  </header>`
}

const skeleton = (lines) => `<div class="skeleton">${Array.from({ length: lines }, (_, index) => `<span style="width:${[92, 78, 85, 60, 88, 70][index % 6]}%"></span>`).join('')}</div>`
const page = (crumb, title, body) => `${mainHead(crumb, title)}<div class="page"><div class="page-inner">${body}</div></div>`
const crumbOf = (project) => `${avatar(project, 'xs')}${esc(project.name)}`

function thread(crumb, title, agent, branch) {
  return `${mainHead(crumb, title, branch ? `<span class="branch">${icon('git-branch', 12)}${esc(branch)}</span>` : '')}
    <div class="thread"><div class="thread-inner">
      <div class="bubble">${esc(title)} : tu peux regarder ce qui cloche et me proposer quelque chose ?</div>
      <div class="assistant"><p>Je regarde d’abord l’existant avant de proposer quoi que ce soit.</p><div class="tool">${icon('search', 13)}<span>Lecture de 6 fichiers</span></div>${skeleton(4)}</div>
      <div class="bubble">Ok, vas-y.</div>
      <div class="assistant">${skeleton(3)}</div>
    </div></div>
    <div class="composer"><div class="composer-box"><span>Écrire à ${agent === 'codex' ? 'Codex' : agent === 'grok' ? 'Grok' : agent === 'opencode' ? 'opencode' : 'Claude'}…</span><span class="composer-tools">${icon('paperclip', 16)}<span class="send">${icon('arrow-up', 16)}</span></span></div></div>`
}

function main() {
  const view = state.view
  if (view.type === 'session') {
    const session = sessions.find((entry) => entry.id === view.id)
    return thread(crumbOf(projectOf(session.project)), session.title, session.agent, session.branch)
  }
  if (view.type === 'discussion') {
    const entry = discussions.find((item) => item.id === view.id)
    return thread('Discussions', entry.title, entry.agent)
  }
  if (view.type === 'draft') return `${mainHead(view.project ? crumbOf(projectOf(view.project)) : 'Discussions', view.project ? 'Nouvelle session' : 'Nouvelle discussion')}<div class="thread"><div class="thread-inner draft"><p>De quoi veux-tu parler ?</p></div></div><div class="composer"><div class="composer-box"><span>Décris ta demande…</span><span class="composer-tools">${icon('paperclip', 16)}<span class="send">${icon('arrow-up', 16)}</span></span></div></div>`
  if (view.type === 'decision') {
    const decision = decisions.find((entry) => entry.id === view.id)
    return page(crumbOf(projectOf(decision.project)), 'À décider', `<div class="card decision"><h3>${esc(decision.title)}</h3>${skeleton(2)}<div class="decision-actions"><span class="pill pill-accent">Première option</span><span class="pill">Seconde option</span><span class="pill">Ouvrir la session</span></div></div>`)
  }
  if (view.type === 'board') {
    const columns = ['À faire', 'En cours', 'À relire', 'Terminé']
    return `${mainHead(crumbOf(projectOf(view.project)), 'Board')}<div class="page"><div class="board">${columns.map((name) => `<section><h3>${name}</h3>${boardCards.filter((card) => card.column === name).map((card) => `<div class="card"><span class="faint">#${card.number}</span> ${esc(card.title)}</div>`).join('')}</section>`).join('')}</div></div>`
  }
  if (view.type === 'worktrees') {
    const rows = sessions.filter((session) => session.project === view.project && session.git)
    return page(crumbOf(projectOf(view.project)), 'Chantiers', rows.map((session) => `<div class="card line"><span class="git-mark git-${session.git}">${icon(GIT[session.git].glyph, 15)}</span><code>${esc(session.branch)}</code><span class="push faint">${GIT[session.git].label}</span></div>`).join(''))
  }
  if (view.type === 'schedules') return page(crumbOf(projectOf(view.project)), 'Planifiées', ['Veille Claude Code · tous les jours à 07:00', 'Veille Codex · tous les jours à 07:30', 'Nettoyage des worktrees fusionnés · le lundi', 'Vérifier les dépendances · le 1er du mois'].map((line) => `<div class="card line">${icon('calendar-clock', 15, 'faint')}<span>${line}</span></div>`).join(''))
  if (view.type === 'wall') {
    const entry = wallViews.find((item) => item.id === view.id)
    const tiles = sessions.filter((session) => (entry.id === 'attention' ? statusOf(session) === 'awaiting' || unreadOf(session) : entry.id === 'running' ? statusOf(session) === 'running' : entry.id === 'sillage' ? session.project === 'sillage' : true)).slice(0, 4)
    return `${mainHead('Mur', entry.name, `<code class="branch">${esc(entry.query)}</code>`)}<div class="page"><div class="wall">${tiles.map((session) => `<section class="card tile"><h3>${agentIcon(session.agent, 14)}${esc(session.title)}</h3>${skeleton(5)}</section>`).join('') || '<p class="col-empty">Aucune session ne correspond à cette vue.</p>'}</div></div>`
  }
  if (view.type === 'benchmarks' || view.type === 'benchmark') {
    const entry = benchmarks.find((item) => item.id === view.id)
    return page('Benchmarks', entry ? entry.title : 'Tous les benchmarks', (entry ? [entry] : benchmarks).map((item) => `<div class="card"><h3>${esc(item.title)}</h3><p class="faint">${esc(item.detail)}</p>${skeleton(3)}</div>`).join(''))
  }
  if (view.type === 'memory' || view.type === 'files') return page('Discussions', view.type === 'memory' ? 'Mémoire' : 'Fichiers', `<div class="card">${skeleton(6)}</div>`)
  if (view.type === 'services') return page('', 'Services', `<p class="faint">Un espace sans liste n’ouvre pas de colonne : la page prend toute la largeur.</p>${['sillage-app-sidebar-rail · :7495', 'sillage-app-mur-sessions-maquette · :7493', 'Terminal · pnpm dev (Atlas API)'].map((line) => `<div class="card line">${icon('server', 15, 'faint')}<span>${line}</span><span class="push pill">Arrêter</span></div>`).join('')}`)
  if (view.type === 'settings') return page('Réglages', view.section, `<div class="card">${skeleton(5)}</div><div class="card">${skeleton(3)}</div>`)
  return ''
}

/* ---------- Study controls ---------- */

function controls() {
  const group = (label, key, options) => `<div class="control"><span>${label}</span><div class="segmented" role="group" aria-label="${label}">${options.map(([value, text]) => `<button type="button" data-act="set" data-arg="${key}=${value}" aria-pressed="${String(state[key]) === value}">${text}</button>`).join('')}</div></div>`
  return `<aside class="controls ${state.controlsOpen ? '' : 'is-closed'}" aria-label="Réglages de la maquette">
    <button type="button" class="controls-toggle" data-act="controls" aria-expanded="${state.controlsOpen}">${icon('layers', 14)}Maquette<span class="faint" id="metric"></span></button>
    ${state.controlsOpen ? `<div class="controls-body">
      ${group('Sidebar', 'variant', [['after', 'Proposée'], ['before', 'Actuelle']])}
      ${group('Scénario', 'scenario', [['busy', 'Chargé'], ['calm', 'Calme']])}
      ${state.variant === 'after' ? group('Rail', 'railLabels', [['false', 'Icônes'], ['true', 'Avec libellés']]) : ''}
      ${group('Thème', 'theme', [['dark', 'Sombre'], ['light', 'Clair']])}
      ${group('Édition', 'edition', [['server', 'Server'], ['desktop', 'Desktop']])}
      <p class="faint">Ces réglages ne font pas partie de l’app.</p>
    </div>` : ''}
  </aside>`
}

/* ---------- Render ---------- */

function render() {
  hideTip()
  const focused = document.activeElement
  const focusKey = focused?.dataset?.act ? `[data-act="${focused.dataset.act}"]${focused.dataset.arg ? `[data-arg="${CSS.escape(focused.dataset.arg)}"]` : ''}` : focused?.id ? `#${focused.id}` : null
  const scrolls = new Map([...document.querySelectorAll('[data-scroll]')].map((node) => [node.dataset.scroll, node.scrollTop]))

  document.documentElement.dataset.theme = state.theme
  const hasColumn = state.space !== 'services'
  const after = state.variant === 'after'
  app.innerHTML = `<div class="shell" ${state.drawerOpen ? 'data-drawer' : ''} ${state.railLabels ? 'data-rail-labels' : ''}>
    <div class="scrim" data-act="drawer"></div>
    <aside class="nav ${after ? '' : 'nav-before'}" aria-label="Navigation">
      ${after ? `${rail()}${hasColumn && (state.columnOpen || phone.matches) ? `<div class="column">${column()}</div>` : ''}` : currentSidebar()}
    </aside>
    <main class="main">${main()}</main>
    ${after && state.popover === 'projects' ? projectsPanel() : ''}
    ${after && state.popover === 'account' ? accountMenu() : ''}
    ${controls()}
  </div>`

  for (const node of document.querySelectorAll('[data-scroll]')) node.scrollTop = scrolls.get(node.dataset.scroll) ?? 0
  if (focusKey) document.querySelector(focusKey)?.focus({ preventScroll: true })
  measure()
}

// The number the proposal is judged on: session rows readable without scrolling.
function measure() {
  const metric = document.getElementById('metric')
  const scroller = document.querySelector('.nav [data-scroll="sessions"]')
  if (!metric) return
  if (!scroller) { metric.textContent = ''; return }
  const box = scroller.getBoundingClientRect()
  const visible = [...scroller.querySelectorAll('.sidebar-session')].filter((row) => { const rect = row.getBoundingClientRect(); return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 }).length
  metric.textContent = `${visible} sessions visibles`
}

function open(view, { keepSpace = false } = {}) {
  state.view = view
  if (view.type === 'session') state.read.add(view.id)
  if (!keepSpace || state.space !== 'activity') state.last[state.space] = view
  state.drawerOpen = false
}

const actions = {
  space(space) {
    const same = state.space === space
    state.popover = null
    // Pressing the current space again folds its column, like an editor's activity bar.
    if (same && !phone.matches && space !== 'services') { state.columnOpen = !state.columnOpen; return }
    state.space = space
    state.columnOpen = true
    state.filter = ''
    state.filterOpen = false
    state.archivesOpen = false
    // Activity is a list to pick from: the main area keeps what was open.
    if (space !== 'activity') state.view = state.last[space] ?? defaultView(space)
    if (space === 'services') state.drawerOpen = false
  },
  session(id) { open({ type: 'session', id }, { keepSpace: true }) },
  decision(id) { open({ type: 'decision', id }, { keepSpace: true }) },
  discussion(id) { open({ type: 'discussion', id }) },
  'discussion-new'() { open({ type: 'draft' }) },
  benchmark(id) { open({ type: 'benchmark', id }) },
  wall(id) { open({ type: 'wall', id }) },
  settings(section) { open({ type: 'settings', section }) },
  page(type) { open({ type }) },
  view(type) { open({ type, project: spaceProject()?.id ?? 'sillage' }) },
  draft() { open({ type: 'draft', project: spaceProject()?.id ?? 'sillage' }) },
  collapse() { state.columnOpen = !state.columnOpen },
  drawer() { state.drawerOpen = !state.drawerOpen; state.popover = null },
  popover(name) { state.popover = state.popover === name ? null : name; state.projectQuery = '' },
  'popover-close'() { state.popover = null },
  pin(id) { if (!state.pinned.delete(id)) state.pinned.add(id) },
  filter() { state.filterOpen = !state.filterOpen; state.filter = '' },
  archives() { state.archivesOpen = !state.archivesOpen },
  'show-all'() { state.showAll = !state.showAll },
  controls() { state.controlsOpen = !state.controlsOpen },
  search() { state.popover = null },
  noop() {},
  set(pair) {
    const [key, value] = pair.split('=')
    state[key] = value === 'true' ? true : value === 'false' ? false : value
    if (key === 'variant') { state.popover = null; state.space = 'project:sillage'; if (state.view.type !== 'session') state.view = defaultView(state.space) }
  },
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]')
  if (state.popover && !event.target.closest('.popover') && target?.dataset.act !== 'popover') {
    state.popover = null
    if (!target) return render()
  }
  if (!target) return
  actions[target.dataset.act]?.(target.dataset.arg)
  render()
  if (target.dataset.act === 'filter' && state.filterOpen) document.getElementById('session-filter')?.focus()
  if (target.dataset.act === 'popover' && state.popover === 'projects') document.getElementById('project-search')?.focus()
})

// Typing must not rebuild the field being typed in: refresh the list beside it only.
document.addEventListener('input', (event) => {
  if (event.target.id === 'session-filter') {
    state.filter = event.target.value
    const list = document.querySelector('[data-session-list]')
    if (list) list.innerHTML = sessionList(sessions.filter((session) => session.project === spaceProject()?.id))
  }
  if (event.target.id === 'project-search') {
    state.projectQuery = event.target.value
    const holder = document.createElement('div')
    holder.innerHTML = projectsPanel()
    document.querySelector('[data-project-list]')?.replaceWith(holder.querySelector('[data-project-list]'))
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (state.popover) state.popover = null
  else if (state.filterOpen) { state.filterOpen = false; state.filter = '' }
  else if (state.drawerOpen) state.drawerOpen = false
  else return
  render()
})

/* ---------- Tooltips: one floating element, placed outside every scroll container ---------- */

let tipTimer = 0
function hideTip() { clearTimeout(tipTimer); tip.hidden = true }
function showTip(target) {
  const [label, detail] = target.dataset.tip.split('|')
  tip.innerHTML = `<strong>${esc(label)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}`
  tip.hidden = false
  const rect = target.getBoundingClientRect()
  const box = tip.getBoundingClientRect()
  const below = target.dataset.tipSide === 'bottom'
  const left = below ? rect.left + rect.width / 2 - box.width / 2 : rect.right + 8
  const top = below ? rect.bottom + 6 : rect.top + rect.height / 2 - box.height / 2
  tip.style.left = `${Math.max(6, Math.min(left, innerWidth - box.width - 6))}px`
  tip.style.top = `${Math.max(6, Math.min(top, innerHeight - box.height - 6))}px`
}
function armTip(event) {
  const target = event.target.closest?.('[data-tip]')
  if (!target || hoverless.matches) return
  clearTimeout(tipTimer)
  tipTimer = setTimeout(() => showTip(target), event.type === 'focusin' ? 0 : 120)
}
document.addEventListener('mouseover', armTip)
document.addEventListener('focusin', (event) => { if (event.target.matches?.(':focus-visible')) armTip(event) })
document.addEventListener('mouseout', (event) => { if (event.target.closest?.('[data-tip]')) hideTip() })
document.addEventListener('focusout', hideTip)
document.addEventListener('scroll', hideTip, true)

addEventListener('resize', measure)
phone.addEventListener('change', render)
render()
