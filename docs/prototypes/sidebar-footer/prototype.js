import { catalogs, paths } from './catalogs.js'

const state = { lang: 'fr', theme: 'dark', edition: 'server', width: 'normal', current: false, update: true }
const t = key => catalogs[state.lang][key]
const svg = body => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const icons = {
  services: svg('<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M16 6.5h2m-2 11h2"/>'),
  settings: svg('<path d="m9.5 3-.6 2.3-2 .9-2.2-.7-2.5 4.3L4 11.5v2l-1.8 1.7 2.5 4.3 2.2-.7 2 .9.6 2.3h5l.6-2.3 2-.9 2.2.7 2.5-4.3-1.8-1.7v-2l1.8-1.7-2.5-4.3-2.2.7-2-.9L14.5 3Z"/><circle cx="12" cy="12.5" r="3"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'),
  activity: svg('<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
  star: svg('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>'),
  decision: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>'),
  discussion: svg('<path d="M21 11a9 9 0 0 1-9 9 10 10 0 0 1-4-1l-5 2 2-5a9 9 0 1 1 16-5Z"/>'),
  board: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16"/>'),
  branch: svg('<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 6v12m0-3c8 0 12-2 12-8"/>'),
  check: svg('<path d="m5 12 4 4L19 6"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>'),
  archive: svg('<path d="M4 8v13h16V8M9 12h6"/><rect x="2" y="3" width="20" height="5" rx="1"/>'),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-11-3 3 3 3"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  down: svg('<path d="m8 10 4 4 4-4"/>'),
  echo: '<svg width="23" height="23" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true"><path d="M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79ZM23 79C47 79 39 21 65 21H78C54 21 62 79 36 79ZM42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z"/></svg>',
}
const agent = (claude) => `<svg class="agent" viewBox="0 0 24 24" fill="currentColor" aria-label="${claude ? 'Claude' : 'Codex'}"><path d="${paths[claude ? 'ClaudeMark' : 'OpenAiMark']}"/></svg>`
function tool(key, labeled = false) {
  const update = key === 'settings' && state.update
  return `<button class="tool ${labeled ? 'labeled' : ''}" data-action="${key}" aria-label="${t(key)}${update ? ` — ${t('update')}` : ''}"><span class="glyph">${icons[key]}${update ? '<i class="update-dot"></i>' : ''}</span>${labeled ? `<span>${t(key)}</span>` : ''}<span role="tooltip" class="tip"><strong>${t(key)}</strong>${update ? `<small>${t('update')}</small>` : ''}</span></button>`
}
function account(named = false) {
  return state.edition === 'server' ? `<button class="account ${named ? 'named' : ''}" data-action="account" aria-label="${t('account')} : marlburrow"><span class="avatar">M</span>${named ? '<span class="username">marlburrow</span>' : ''}<span role="tooltip" class="tip"><strong>marlburrow</strong><small>${t('account')}</small></span></button>` : ''
}
function footer(kind) {
  if (kind === 'b') return `${account(true)}<div class="tools">${tool('services')}${tool('settings')}</div>`
  if (kind === 'c') return `<div class="rows">${tool('services', true)}${tool('settings', true)}</div>${account(true)}`
  return `${tool('services', kind === 'old')}${tool('settings', kind === 'old')}${account()}`
}
function sidebar(kind) {
  return `<aside class="sidebar" aria-label="${t(`${kind}Title`)}">
    <div class="brand">${icons.echo}<strong>Sillage</strong><span class="push">${icons.panel}</span></div>
    <div class="search">${icons.search}<span>${t('search')}</span><small>⌘ K</small></div>
    <div class="activity">${icons.activity}<span>${t('activity')}</span><small><i></i>${t('running')}</small></div>
    <div class="global"><span>${icons.star}${t('favorites')}<small>3</small></span><span>${icons.decision}${t('decisions')}<small>1</small></span></div>
    <div class="discussions">${icons.discussion}${t('discussions')}<span class="push">${icons.plus}</span></div>
    <div class="project"><span class="project-mark">S</span><strong>Sillage</strong><span class="push">${icons.down}</span></div>
    <div class="project-nav"><div>${icons.board}${t('board')}<small>4</small></div><div>${icons.branch}${t('worktrees')}<small>3</small></div><div>${icons.calendar}${t('schedules')}<small>2</small></div></div>
    <div class="sessions-head">${t('sessions')}<span class="push">${icons.search}${icons.plus}</span></div>
    <div class="session-list">${[1,2,3,4,5,2,3,4].map((n,i) => `<div class="session ${i === 0 ? 'selected' : ''}">${agent(i % 3 === 2)}<span>${t(`session${n}`)}</span><span class="git ${i % 2 ? 'merged' : ''}" title="${i % 2 ? 'Merged' : 'Worktree'}">${i % 2 ? icons.check : icons.branch}</span></div>`).join('')}</div>
    <div class="archives">${icons.archive}${t('archives')}<small>18</small></div>
    <footer class="footer ${kind}">${footer(kind)}</footer>
  </aside>`
}
const select = (key, options) => `<label>${t(key === 'lang' ? 'language' : key)}<select data-control="${key}">${options.map(([value,label]) => `<option value="${value}" ${state[key] === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`
function render() {
  document.documentElement.dataset.theme = state.theme
  document.documentElement.lang = state.lang
  document.querySelector('#detail .close').setAttribute('aria-label', t('close'))
  document.querySelector('#app').innerHTML = `<header><div><div class="wordmark">${icons.echo}Sillage <span>${t('preview')}</span></div><h1>${t('title')}</h1><p>${t('intro')}</p></div></header>
    <div class="controls">${select('theme', [['dark',t('dark')],['light',t('light')]])}${select('edition', [['server','Server'],['desktop','Desktop']])}${select('width', [['normal',t('normal')],['narrow',t('narrow')]])}${select('lang', [['fr','Français'],['en','English']])}<label class="check"><input type="checkbox" data-control="update" ${state.update ? 'checked' : ''}>${t('updateToggle')}</label><label class="check"><input type="checkbox" data-control="current" ${state.current ? 'checked' : ''}>${t('current')}</label></div>
    <div class="comparison ${state.width}">${(state.current ? ['old','a','b','c'] : ['a','b','c']).map(kind => `<section class="variant"><div class="caption"><h2>${t(`${kind}Title`)}</h2>${kind === 'a' ? `<span class="recommended">${t('recommend')}</span>` : ''}<p>${t(`${kind}Text`)}</p></div>${sidebar(kind)}</section>`).join('')}</div>
    <div class="notes"><p>${t(state.edition === 'desktop' ? 'desktopNote' : 'serverNote')}</p><p>${t('note')}</p></div>`
}
document.addEventListener('change', event => {
  const key = event.target.dataset.control
  if (!key) return
  state[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
  render()
  document.querySelector(`[data-control="${key}"]`).focus()
})
const dialog = document.querySelector('#detail')
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-action]')
  if (!trigger) return
  const action = trigger.dataset.action
  document.querySelector('#detail-body').innerHTML = `<span class="dialog-icon">${icons[action] ?? '<span class="avatar">M</span>'}</span><h2>${action === 'account' ? 'marlburrow' : t(action)}</h2><p>${t(`${action}Text`)}</p>${action === 'settings' && state.update ? `<div class="update-message"><i></i>${t('update')}</div>` : ''}${action === 'account' ? `<button class="logout">${t('logout')}</button><p class="demo-note">${t('demoLogout')}</p>` : ''}`
  dialog.showModal()
  document.querySelector('.logout')?.addEventListener('click', () => dialog.close())
})
dialog.querySelector('.close').addEventListener('click', () => dialog.close())
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close() })
render()
