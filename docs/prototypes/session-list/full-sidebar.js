export function mountFullSidebar({ state, sessions, t, escape, icons, svg, row, gitMarker, agentName, agentIcon, closePreview }) {
  const ui = { project: 'sillage', screen: 'session', navOpen: true, filterOpen: false, filter: '', edition: 'server', calm: false, dialog: '', dialogQuery: '' }
  const visits = new Map([['sillage', state.selected]])
  const projects = [
    { id: 'sillage', name: 'Sillage', letter: 'S' },
    { id: 'atlas', name: 'Atlas API', letter: 'A' },
    { id: 'photos', name: 'Photos', letter: 'P' },
    { id: 'sandbox', name: 'Sandbox', letter: 'S' },
  ]
  sessions.forEach(session => { session.project = 'sillage'; session.projectName = 'Sillage' })
  sessions.push(
    { id: 'fullApiTitle', project: 'atlas', projectName: 'Atlas API', agent: 'claude', original: 'Vérifier la validation des requêtes avant de fusionner la nouvelle API.', branch: 'feat/request-validation', git: 'unmerged', status: 'idle', age: ['hours', 1] },
    { id: 'fullPhotoTitle', project: 'photos', projectName: 'Photos', agent: 'claude', original: 'Adapter la grille des photos aux écrans de téléphone.', branch: 'feat/photo-grid', git: 'merged', status: 'idle', age: ['days', 1] },
    { id: 'fullArchivedTitle', project: 'sillage', projectName: 'Sillage', original: 'Conserver la première étude de la navigation pour référence.', branch: null, git: null, status: 'idle', age: ['days', 3], archived: true },
    { id: 'fullArchivedSetup', project: 'atlas', projectName: 'Atlas API', agent: 'claude', original: 'Préparer les dépendances et lancer les premiers tests du projet.', branch: null, git: null, status: 'idle', age: ['days', 3], archived: true },
  )
  const statuses = new Map(sessions.map(session => [session.id, session.status]))
  const favorites = new Set(['progress', 'fullApiTitle'])
  const unread = new Set(['tools', 'mergeReady', 'fullApiTitle'])
  const extra = {
    star: svg('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>'),
    activity: svg('<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
    calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m3 0h2"/>'),
    archive: svg('<path d="M4 8v13h16V8M9 12h6"/><rect x="2" y="3" width="20" height="5" rx="1"/>'),
    settings: svg('<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--sg-surface)"/><circle cx="16" cy="17" r="3" fill="var(--sg-surface)"/>'),
    server: svg('<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M16 6.5h2m-2 11h2"/>'),
    panel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m5-11-3 3 3 3"/>'),
    more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    folder: svg('<path d="M3 7V4h7l3 3h8v14H3V7Z"/>'),
    switch: svg('<path d="m8 8 4-4 4 4m-8 8 4 4 4-4"/>'),
  }
  const dialog = document.querySelector('#study-dialog')
  const isPhone = () => matchMedia('(max-width: 720px)').matches
  const project = () => projects.find(p => p.id === ui.project)
  const current = () => sessions.find(s => s.id === state.selected)
  const scopeSessions = () => sessions.filter(s => ui.project === 'all' || s.project === ui.project)
  const activeSessions = () => scopeSessions().filter(s => !s.archived)
  const selectedTitle = () => current() ? t(current().id) : t('newSession')
  const iconButton = (action, icon, label) => `<button class="full-icon" data-action="${action}" aria-label="${escape(t(label))}" title="${escape(t(label))}">${icon}</button>`
  const avatar = p => `<span class="full-avatar" data-project-color="${p.id}">${p.letter}</span>`
  const navLine = (screen, icon, label, summary = '') => `<button class="full-nav-line ${ui.screen === screen ? 'current' : ''}" data-screen="${screen}" ${ui.screen === screen ? 'aria-current="page"' : ''}>${icon}<span>${t(label)}</span><small>${summary}</small></button>`
  const match = (s, query) => `${t(s.id)} ${s.original} ${s.branch || ''} ${s.projectName}`.toLocaleLowerCase(state.locale).includes(query.toLocaleLowerCase(state.locale))

  function sessionList() {
    const visible = activeSessions().filter(s => match(s, ui.filter))
    if (!visible.length) return `<div class="full-empty"><p>${t(ui.filter ? 'noResults' : 'fullEmptyProject')}</p>${ui.filter ? '' : `<button class="full-text-action" data-screen="new">${icons.plus}${t('newSession')}</button>`}</div>`
    if (ui.project === 'all') return projects.map(p => {
      const group = visible.filter(s => s.project === p.id)
      return group.length ? `<section class="full-project-group"><button data-project="${p.id}" class="full-group-title">${avatar(p)}${p.name}<small>${group.length}</small></button><ul>${group.map(s => row(s, 'quiet', 'symbol')).join('')}</ul></section>` : ''
    }).join('')
    return `<ul>${visible.map(s => row(s, 'quiet', 'symbol')).join('')}</ul>`
  }

  function sidebar() {
    const running = sessions.filter(s => s.status === 'running').length
    const waiting = sessions.filter(s => s.status === 'waiting').length
    const trees = [...new Map(activeSessions().filter(s => s.branch).map(s => [s.branch, s])).values()]
    const merged = trees.filter(s => s.git === 'merged').length
    const pending = trees.length - merged
    const archived = scopeSessions().filter(s => s.archived).length
    return `<aside class="full-sidebar quiet worktree-symbol" aria-label="${t('fullNav')}" ${!ui.navOpen ? 'inert aria-hidden="true"' : ''} ${isPhone() && ui.navOpen ? `role="dialog" aria-modal="true"` : ''}>
      <div class="full-brand">${icons.echo}<strong>Sillage</strong><span>${ui.edition === 'desktop' ? 'Desktop' : 'Server'}</span>${iconButton('collapse', isPhone() ? icons.close : extra.panel, 'fullCollapse')}</div>
      <button class="full-search" data-action="search">${icons.search}<span>${t('fullSearch')}</span><kbd>${navigator.userAgent.includes('Mac') ? '⌘ K' : 'Ctrl K'}</kbd></button>
      <div class="full-sidebar-body">
        <div class="full-sidebar-context">
          <section class="full-global" aria-label="${t('fullAllProjects')}">
            <button class="full-activity" data-action="activity">${extra.activity}<span><strong>${t('activity')}</strong><small>${ui.calm ? t('fullCalm') : `${t('fullRunning', { n: running })} · ${t('fullUnread', { n: unread.size })}`}</small></span>${waiting ? `<span class="full-waiting">${t('fullAwaiting', { n: waiting })}</span>` : icons.chevron}</button>
            <div class="full-global-links"><button data-action="favorites">${extra.star}<span>${t('fullFavorites')}</span><small>${favorites.size}</small></button>${!ui.calm ? `<button data-action="decisions">${icons.unknown}<span>${t('fullDecisions')}</span><small>1</small></button>` : ''}</div>
          </section>
          <div class="full-project-choice"><button data-action="projects" aria-haspopup="dialog">${project() ? avatar(project()) : extra.folder}<span>${project()?.name || t('fullAllProjects')}</span>${extra.switch}</button>${iconButton('projectMenu', extra.more, 'fullProjectOptions')}</div>
          ${ui.project !== 'all' ? `<nav class="full-project-nav" aria-label="${escape(project().name)}">
            ${navLine('board', icons.board, 'board', ui.project === 'sillage' ? `${t('fullOpenCards', { n: 4 })} · <em>${t('fullReviewCards', { n: 1 })}</em>` : '')}
            ${navLine('worktrees', icons.branch, 'worktrees', trees.length ? `${t('fullPending', { n: pending })} · ${t('fullMerged', { n: merged })}` : '0')}
            ${navLine('schedules', extra.calendar, 'schedules', t('fullTasks', { n: ui.project === 'sillage' ? 2 : 0 }))}
          </nav>` : ''}
          <div class="full-sessions-head"><span>${t('sessions')}<small>${activeSessions().length}</small></span>${iconButton('filter', icons.search, 'fullFilter')}${iconButton('new', icons.plus, 'newSession')}</div>
          <div class="full-filter" ${!ui.filterOpen ? 'hidden' : ''}>${icons.search}<input id="session-filter" type="search" placeholder="${t('search')}" aria-label="${t('search')}" value="${escape(ui.filter)}">${iconButton('clearFilter', icons.close, 'clear')}</div>
        </div>
        <div class="session-scroll" data-scroll="full-sessions">${sessionList()}</div>
      </div>
      <div class="full-sidebar-bottom"><button class="full-archives" data-action="archives">${extra.archive}<span>${t('fullArchives')}</span><small>${archived}</small></button><nav class="full-utilities" aria-label="${t('fullSettings')}"><button data-screen="services">${extra.server}<span>${t('fullServices')}</span></button><button data-screen="settings">${extra.settings}<span>${t('fullSettings')}</span></button>${ui.edition === 'server' ? `<button class="full-account" data-action="account" aria-label="${t('fullAccount')}" title="${t('fullAccount')}">M</button>` : ''}</nav></div>
    </aside>`
  }

  function detailRows(items) {
    return items.length ? items.map(s => `<button class="full-result" data-go-session="${s.id}"><span class="agent-mark" role="img" aria-label="${agentName(s)}">${agentIcon(s)}</span><span><strong>${t(s.id)}</strong><small>${s.projectName}${s.branch ? ` · ${escape(s.branch)}` : ''}</small></span>${s.git ? gitMarker(s, 'legend') : `<small>${t(s.status)}</small>`}</button>`).join('') : `<p class="full-empty">${t('noResults')}</p>`
  }

  function screenBody() {
    if (ui.screen === 'session' && current()) {
      const s = current()
      return `<div class="full-conversation"><div class="full-conversation-meta">${agentIcon(s)}<span>${agentName(s)}</span>${s.branch ? `<code>${escape(s.branch)}</code>` : `<span>${t('noBranch')}</span>`}</div><p class="user-message">${escape(s.original)}</p><div class="assistant-label">${agentIcon(s)}<strong>${agentName(s)}</strong><span>${t(s.status)}</span></div><p>${t(`${s.id}Excerpt`)}</p>${s.git ? `<div class="full-inline-git">${gitMarker(s, 'detail')}<p>${t(`${s.git}Meaning`)}</p></div>` : ''}<div class="full-conversation-spacer"></div><div class="composer"><span>${t('composer')}</span><div><span>${agentName(s)}</span><span>${t('composerNote')}</span></div></div></div>`
    }
    if (ui.screen === 'new') return `<div class="full-destination"><h2>${t('newSession')}</h2><p>${t('fullChooseCli')}</p><div class="full-cli-choices">${['codex', 'claude'].map(agent => `<button data-cli="${agent}" aria-pressed="${(ui.draftAgent || 'codex') === agent}">${agentIcon({ agent })}${agentName({ agent })}</button>`).join('')}</div><div class="composer"><span>${t('composer')}</span><div><span>${agentName({ agent: ui.draftAgent })}</span></div></div><small>${t('fullDraftHint')}</small></div>`
    if (ui.screen === 'worktrees') {
      const trees = [...new Map(activeSessions().filter(s => s.branch).map(s => [s.branch, s])).values()]
      return `<div class="full-destination"><h2>${t('worktrees')}</h2>${trees.length ? detailRows(trees) : `<p>${t('fullNoWorktrees')}</p>`}</div>`
    }
    if (ui.screen === 'board') return `<div class="full-destination"><h2>${t('board')}</h2><p>${t('fullBoardHint')}</p><div class="full-board">${['fullTodo', 'fullInProgress', 'fullReview'].map((key, index) => `<section><h3>${t(key)}</h3>${ui.project === 'sillage' ? `<button data-go-session="${['progress','tools','mergeReady'][index]}">${t(['progress','tools','mergeReady'][index])}</button>${index === 0 ? `<button data-go-session="unknownTree">${t('unknownTree')}</button>` : ''}` : ''}</section>`).join('')}</div></div>`
    if (ui.screen === 'schedules') return `<div class="full-destination"><h2>${t('schedules')}</h2><p>${t('fullScheduleHint')}</p>${ui.project === 'sillage' ? ['fullScheduleClaude', 'fullScheduleCodex'].map(key => `<details class="full-schedule"><summary>${extra.calendar}<strong>${t(key)}</strong><span>${t('fullMorning')}</span>${icons.chevron}</summary><p>${t('fullRun')} · 22/10 · 07:00</p><small>${t('fullPrototypeNote')}</small></details>`).join('') : `<p>${t('fullNoTasks')}</p>`}</div>`
    if (ui.screen === 'services') return `<div class="full-destination"><h2>${t('fullServices')}</h2><p>${t('fullServicesHint')}</p><div class="full-service">${extra.server}<strong>${t('fullServiceName')}</strong><span>${t('fullServiceState')}</span></div></div>`
    if (ui.screen === 'settings' || ui.screen === 'projectSettings') return `<div class="full-destination"><h2>${t(ui.screen === 'settings' ? 'fullSettings' : 'fullProjectSettings')}</h2><p>${t(ui.screen === 'settings' ? 'fullSettingsHint' : 'fullProjectHint')}</p><div class="full-settings-list">${(ui.screen === 'settings' ? ['fullAppearance','fullAccount'] : ['fullInstructions','fullActions']).map(key => `<button data-action="${key === 'fullAppearance' ? 'options' : 'information'}">${t(key)}${icons.chevron}</button>`).join('')}</div></div>`
    return `<div class="full-empty"><p>${t('fullEmptyProject')}</p><button class="full-text-action" data-screen="new">${icons.plus}${t('newSession')}</button></div>`
  }

  const screenTitle = () => ui.screen === 'session' ? selectedTitle() : t(({ new: 'newSession', board: 'board', worktrees: 'worktrees', schedules: 'schedules', services: 'fullServices', settings: 'fullSettings', projectSettings: 'fullProjectSettings' })[ui.screen])
  function render(focus) {
    state.screen = ui.screen
    closePreview()
    const listScroll = document.querySelector('[data-scroll="full-sessions"]')?.scrollTop || 0
    const bodyScroll = document.querySelector('.full-sidebar-body')?.scrollTop || 0
    document.documentElement.lang = state.locale
    document.documentElement.dataset.theme = state.theme
    document.documentElement.style.setProperty('--sidebar-size', `${state.width}px`)
    document.title = `${t('fullTitle')} · Sillage`
    document.querySelector('#app').innerHTML = `<header class="full-study-bar"><div><strong>${t('fullTitle')}</strong><span>${t('fullStudy')}</span></div><a href="index.html">${t('fullBack')}</a><button data-action="options">${extra.settings}<span>${t('fullOptions')}</span></button></header><div class="full-shell ${ui.navOpen ? 'nav-open' : 'nav-closed'}">${sidebar()}<main class="full-main" ${isPhone() && ui.navOpen ? 'inert aria-hidden="true"' : ''}><header class="full-content-head">${iconButton('openNav', extra.panel, 'fullOpen')}<div><small>${['services','settings'].includes(ui.screen) ? 'Sillage' : current()?.projectName && ui.screen === 'session' ? current().projectName : project()?.name || t('fullAllProjects')}</small><strong>${escape(screenTitle())}</strong></div><span>${ui.edition === 'server' ? 'Server' : 'Desktop'}</span></header><div class="full-content-scroll">${screenBody()}</div></main></div><div class="full-toast" role="status" hidden></div>`
    document.querySelector('[data-scroll="full-sessions"]').scrollTop = listScroll
    document.querySelector('.full-sidebar-body').scrollTop = bodyScroll
    if (focus) document.querySelector(focus)?.focus({ preventScroll: true })
  }

  function results() {
    const q = ui.dialogQuery
    if (ui.dialog === 'projects') {
      const matches = projects.filter(p => p.name.toLocaleLowerCase(state.locale).includes(q.toLocaleLowerCase(state.locale)))
      return `${!q ? `<button class="full-project-result" data-project="all">${extra.folder}<span>${t('fullAllProjects')}</span>${ui.project === 'all' ? icons.merged : ''}</button>` : ''}${matches.map(p => `<button class="full-project-result" data-project="${p.id}">${avatar(p)}<span>${p.name}</span>${ui.project === p.id ? icons.merged : ''}</button>`).join('')}${!matches.length ? `<p class="full-empty">${t('noResults')}</p>` : ''}`
    }
    if (ui.dialog === 'search') return detailRows(sessions.filter(s => match(s, q)))
    if (ui.dialog === 'favorites') return detailRows(sessions.filter(s => favorites.has(s.id)))
    if (ui.dialog === 'archives') {
      const archived = scopeSessions().filter(s => s.archived)
      return archived.length ? detailRows(archived) : `<p class="full-empty">${t('fullNoArchives')}</p>`
    }
    if (ui.dialog === 'activity') {
      const items = sessions.filter(s => s.status !== 'idle' || (!ui.calm && unread.has(s.id)))
      return `${!ui.calm ? `<div class="full-activity-totals"><span>${t('fullRunning', { n: 1 })}</span><span>${t('fullAwaiting', { n: 2 })}</span><span>${t('fullUnread', { n: unread.size })}</span></div>` : ''}${projects.map(p => {
        const list = items.filter(s => s.project === p.id).sort((a,b) => (a.status === 'waiting' ? 0 : 1) - (b.status === 'waiting' ? 0 : 1))
        return list.length ? `<h3 class="full-dialog-subtitle">${p.name}</h3>${list.map(s => `<button class="full-result" data-go-session="${s.id}"><span class="agent-mark" role="img" aria-label="${agentName(s)}">${agentIcon(s)}</span><span><strong>${t(s.id)}</strong><small>${s.projectName}</small></span><small class="${s.status}">${t(s.status)}${unread.has(s.id) ? ` · ${t('fullUnread', { n: 1 })}` : ''}</small></button>`).join('')}` : ''
      }).join('')}${!items.length ? `<p class="full-empty">${t('fullCalm')}</p>` : ''}`
    }
    return ''
  }

  function openDialog(kind) {
    closePreview()
    ui.dialog = kind
    ui.dialogQuery = ''
    const titleKey = { projects:'fullSwitch', search:'fullSearch', activity:'fullGlobal', favorites:'fullFavorites', archives:'fullArchives', decisions:'fullDecisions', options:'fullOptions', account:'fullAccount', projectMenu:'fullProjectOptions', information:'atelier', newProject:'fullNewProject' }[kind]
    let body = ''
    if (['projects','search','activity','favorites','archives'].includes(kind)) body = `${['activity','favorites'].includes(kind) ? `<p class="full-dialog-hint">${t('fullGlobalScope')}</p>` : ''}${['projects','search'].includes(kind) ? `<label class="full-dialog-search">${icons.search}<input id="dialog-search" type="search" placeholder="${t(kind === 'projects' ? 'fullProjectSearch' : 'fullSearchHint')}" aria-label="${t(kind === 'projects' ? 'fullProjectSearch' : 'fullSearchHint')}"></label>` : ''}<div id="dialog-results">${results()}</div>${kind === 'projects' ? `<button class="full-text-action" data-action="newProject">${icons.plus}${t('fullNewProject')}</button>` : ''}`
    if (kind === 'projectMenu') body = `<div class="full-menu">${project() ? `${navLine('projectSettings',extra.settings,'fullProjectSettings')}${navLine('board',icons.board,'board')}${navLine('schedules',extra.calendar,'schedules')}` : ''}<button data-action="refresh">${t('fullRefresh')}</button><button data-action="newProject">${t('fullNewProject')}</button></div>`
    if (kind === 'account') body = `<p class="full-dialog-hint">${t('fullProfile')}</p><p>Marlburrow</p><div class="full-menu">${navLine('settings',extra.settings,'fullSettings')}<button data-action="logout">${t('fullLogout')}</button></div>`
    if (kind === 'decisions') body = ui.calm ? `<p>${t('fullNoDecisions')}</p>` : `<p class="full-dialog-hint">Sillage · ${t('fullScheduleClaude')}</p><h3>${t('fullDecisionTitle')}</h3><p>${t('fullDecisionDetail')}</p><button class="full-text-action" data-action="decisionDetail">${t('fullReviewDecision')}${icons.chevron}</button>`
    if (kind === 'information') body = `<p>${t('fullPrototypeNote')}</p>`
    if (kind === 'newProject') body = `<label class="full-option">${t('fullProjectNewName')}<input placeholder="${t('fullProjectNewName')}" aria-label="${t('fullProjectNewName')}"></label><p class="full-dialog-hint">${t('fullPrototypeNote')}</p>`
    if (kind === 'options') body = `<div class="full-options"><label class="full-option">${t('theme')}<select data-option="theme"><option value="dark" ${state.theme === 'dark' ? 'selected' : ''}>${t('dark')}</option><option value="light" ${state.theme === 'light' ? 'selected' : ''}>${t('light')}</option></select></label><label class="full-option">${t('language')}<select data-option="locale"><option value="fr" ${state.locale === 'fr' ? 'selected' : ''}>Français</option><option value="en" ${state.locale === 'en' ? 'selected' : ''}>English</option></select></label><label class="full-option">${t('fullEdition')}<select data-option="edition"><option value="server" ${ui.edition === 'server' ? 'selected' : ''}>Server</option><option value="desktop" ${ui.edition === 'desktop' ? 'selected' : ''}>Desktop</option></select></label><label class="full-option">${t('fullScenario')}<select data-option="calm"><option value="busy" ${!ui.calm ? 'selected' : ''}>${t('fullBusyScenario')}</option><option value="calm" ${ui.calm ? 'selected' : ''}>${t('fullCalmScenario')}</option></select></label><label class="full-option">${t('width')}<input type="range" min="264" max="440" step="8" value="${state.width}" data-option="width"><output>${state.width} px</output></label></div>`
    dialog.innerHTML = `<div class="full-dialog-head"><h2 id="dialog-title">${t(titleKey)}</h2><button class="full-icon" data-close-dialog aria-label="${t('close')}">${icons.close}</button></div><div class="full-dialog-body">${body}</div>`
    if (!dialog.open) dialog.showModal()
    dialog.querySelector('#dialog-search')?.focus()
  }

  function navigate(screen) {
    dialog.close()
    ui.screen = screen
    if (isPhone()) ui.navOpen = false
    render(isPhone() ? '[data-action="openNav"]' : undefined)
  }
  function selectSession(id) {
    const s = sessions.find(item => item.id === id)
    if (!s) return
    state.selected = id
    visits.set(s.project, id)
    if (ui.project !== 'all') ui.project = s.project
    navigate('session')
  }
  let toastTimer
  function toast(key) {
    const element = document.querySelector('.full-toast')
    element.textContent = t(key)
    element.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { element.hidden = true }, 3500)
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('button')
    if (!button || button.dataset.details || button.hasAttribute('data-close-preview')) return
    if (button.hasAttribute('data-close-dialog')) { dialog.close(); return }
    if (button.dataset.session || button.dataset.goSession) { selectSession(button.dataset.session || button.dataset.goSession); return }
    if (button.dataset.screen) { navigate(button.dataset.screen); return }
    if (button.dataset.project) {
      const id = button.dataset.project
      ui.project = id
      ui.filter = ''
      ui.filterOpen = false
      const next = visits.get(id) || sessions.find(s => s.project === id && !s.archived)?.id
      if (next) state.selected = next
      navigate(next || id === 'all' ? 'session' : 'new')
      return
    }
    if (button.dataset.cli) { ui.draftAgent = button.dataset.cli; render(`[data-cli="${ui.draftAgent}"]`); return }
    const action = button.dataset.action
    if (['projects','search','activity','favorites','archives','decisions','options','account','projectMenu','information','newProject'].includes(action)) { openDialog(action); return }
    if (action === 'new') { navigate('new'); return }
    if (action === 'collapse' || action === 'openNav') { ui.navOpen = action === 'openNav'; render(ui.navOpen ? '[data-action="collapse"]' : '[data-action="openNav"]'); return }
    if (action === 'filter') { ui.filterOpen = !ui.filterOpen; if (!ui.filterOpen) ui.filter = ''; render(ui.filterOpen ? '#session-filter' : '[data-action="filter"]'); return }
    if (action === 'clearFilter') { ui.filter = ''; document.querySelector('#session-filter').value = ''; document.querySelector('[data-scroll="full-sessions"]').innerHTML = sessionList(); document.querySelector('#session-filter').focus(); return }
    if (action === 'refresh') { dialog.close(); toast('fullRefreshed') }
    if (action === 'logout') { dialog.close(); toast('fullDisconnected') }
    if (action === 'decisionDetail') { dialog.querySelector('.full-dialog-body').innerHTML = `<p>${t('fullDecisionDemo')}</p>` }
  })
  document.addEventListener('input', event => {
    if (event.target.id === 'session-filter') { closePreview(); ui.filter = event.target.value; document.querySelector('[data-scroll="full-sessions"]').innerHTML = sessionList() }
    if (event.target.id === 'dialog-search') { ui.dialogQuery = event.target.value; document.querySelector('#dialog-results').innerHTML = results() }
    if (event.target.dataset.option === 'width') { state.width = Number(event.target.value); document.documentElement.style.setProperty('--sidebar-size', `${state.width}px`); dialog.querySelector('output').textContent = `${state.width} px` }
  })
  document.addEventListener('change', event => {
    const key = event.target.dataset.option
    if (!key) return
    if (key === 'theme' || key === 'locale') state[key] = event.target.value
    if (key === 'edition') ui.edition = event.target.value
    if (key === 'calm') { ui.calm = event.target.value === 'calm'; sessions.forEach(s => { s.status = ui.calm ? 'idle' : statuses.get(s.id) }) }
    render()
    if (key === 'locale') { openDialog('options'); dialog.querySelector('[data-option="locale"]').focus() }
  })
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close() } })
  dialog.addEventListener('close', () => {
    if (!document.activeElement || document.activeElement === document.body) document.querySelector(`[data-action="${ui.dialog}"]`)?.focus({ preventScroll: true })
  })
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openDialog('search'); return }
    if (event.defaultPrevented || !document.querySelector('#session-preview').hidden) return
    if (dialog.open) {
      if (event.target.id === 'dialog-search' && ['ArrowDown','Enter'].includes(event.key)) {
        const first = dialog.querySelector('#dialog-results button')
        if (first) { event.preventDefault(); if (event.key === 'Enter') first.click(); else first.focus() }
      }
      return
    }
    if (isPhone() && ui.navOpen) {
      if (event.key === 'Escape') { event.preventDefault(); ui.navOpen = false; render('[data-action="openNav"]') }
      if (event.key === 'Tab') {
        const controls = [...document.querySelector('.full-sidebar').querySelectorAll('button, input')].filter(el => el.getClientRects().length && !el.closest('[hidden]'))
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
  })
  matchMedia('(max-width: 720px)').addEventListener('change', () => { ui.navOpen = true; render() })
  render()
}
