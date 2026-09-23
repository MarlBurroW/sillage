// Maquette autonome : données illustratives, aucune requête vers Sillage ou un CLI.
const icons = {
  sparkles: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/>',
  brain: '<path d="M12 5a3 3 0 0 0-5.7-1A4 4 0 0 0 3 10a4 4 0 0 0 1 7 4 4 0 0 0 8 1Zm0 0a3 3 0 0 1 5.7-1A4 4 0 0 1 21 10a4 4 0 0 1-1 7 4 4 0 0 1-8 1M7 9l-1 3m11-3 1 3M8 17l-1-2m9 2 1-2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  sliders: '<path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
  paperclip: '<path d="m9 17 8-8a3 3 0 0 0-4-4L4 14a5 5 0 0 0 7 7l9-9M7 15l7-7"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  moon: '<path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
document.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); });

// Les modèles et niveaux sont des exemples de présentation, pas un catalogue réel.
// L'intégration utilisera useAgentSettings : options et repli viennent déjà du CLI.
const effortOptions = [
  { value: 'low', label: 'Faible', hint: 'Un effort de réflexion limité.' },
  { value: 'medium', label: 'Moyen', hint: 'Un effort de réflexion intermédiaire.' },
  { value: 'high', label: 'Élevé', hint: 'Un effort de réflexion plus important.' },
  { value: 'xhigh', label: 'Très élevé', hint: 'Le niveau le plus élevé de ce modèle de démonstration.' },
];
const catalogs = {
  codex: [
    { value: 'codex', label: 'GPT-5.2 Codex', hint: 'Modèle de démonstration', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { value: 'general', label: 'GPT-5.2', hint: 'Modèle de démonstration', efforts: ['low', 'medium', 'high'] },
    { value: 'mini', label: 'Codex mini', hint: 'Modèle de démonstration', efforts: ['low', 'medium'] },
  ],
  claude: [
    { value: 'opus', label: 'Opus', hint: 'Modèle de démonstration', efforts: ['low', 'medium', 'high'] },
    { value: 'sonnet', label: 'Sonnet', hint: 'Modèle de démonstration', efforts: ['low', 'medium', 'high'] },
    { value: 'haiku', label: 'Haiku', hint: 'Exemple sans réglage de réflexion', efforts: [] },
  ],
};
const configurations = {
  codex: { model: 'codex', effort: 'high', mode: 'default', approval: 'on-request', sandbox: 'workspace-write', sillage: true, docs: false },
  claude: { model: 'opus', effort: 'high', permission: 'manual', sillage: true, docs: false },
};
const $ = (id) => document.getElementById(id);
const dialog = $('settings-dialog');
const touchLayout = matchMedia('(max-width: 600px), (pointer: coarse)');
let agent = 'codex';
let activeView = 'model';
let lastTrigger = $('model-trigger');
let selection = [0, 0];
let returnToWriting = false;
let openingWithKeyboard = false;
const state = () => configurations[agent];
const currentModel = () => catalogs[agent].find((model) => model.value === state().model);

function groups() {
  const entries = [
    { key: 'model', label: 'Modèle', options: catalogs[agent] },
    ...(currentModel().efforts.length ? [{ key: 'effort', label: 'Effort de réflexion', compact: true, options: effortOptions.filter((option) => currentModel().efforts.includes(option.value)) }] : []),
  ];
  if (agent === 'codex') entries.push(
    { key: 'mode', label: 'Mode', compact: true, options: [{ value: 'default', label: 'Standard' }, { value: 'plan', label: 'Plan' }] },
    { key: 'approval', label: 'Approbations', options: [
      { value: 'cli-default', label: 'Défaut du CLI', hint: 'Utilise la politique configurée dans Codex.' },
      { value: 'untrusted', label: 'Non fiable', hint: 'Seules les commandes sûres passent seules.' },
      { value: 'on-request', label: 'Sur demande', hint: 'Codex demande quand il le juge utile.' },
      { value: 'never', label: 'Jamais', hint: 'Aucune demande d’approbation.', caution: true },
    ] },
    { key: 'sandbox', label: 'Bac à sable', options: [
      { value: 'read-only', label: 'Lecture seule', hint: 'Aucune écriture possible.' },
      { value: 'workspace-write', label: 'Écriture workspace', hint: 'Écriture limitée au projet.' },
      { value: 'danger-full-access', label: 'Accès total', hint: 'Aucune restriction du bac à sable.', caution: true },
    ] },
  );
  else entries.push({ key: 'permission', label: 'Permissions', options: [
    { value: 'manual', label: 'Manuel', hint: 'Demander avant les opérations soumises à autorisation.' },
    { value: 'auto', label: 'Auto' },
    { value: 'acceptEdits', label: 'Accepter les modifications' },
    { value: 'plan', label: 'Plan' },
    { value: 'dontAsk', label: 'Ne pas demander' },
    { value: 'bypassPermissions', label: 'Tout autoriser', caution: true },
  ] });
  return entries;
}

function renderToolbar() {
  const model = currentModel();
  const effort = effortOptions.find((option) => option.value === state().effort);
  $('model-label').textContent = model.label;
  $('model-trigger').setAttribute('aria-label', `Modèle : ${model.label}`);
  $('model-trigger').title = `Modèle : ${model.label}`;
  $('effort-trigger').hidden = model.efforts.length === 0;
  $('effort-label').textContent = effort?.label ?? '';
  $('effort-trigger').setAttribute('aria-label', `Effort de réflexion : ${effort?.label ?? ''}`);
  const plan = state().mode === 'plan' || state().permission === 'plan';
  const warnings = [];
  if (state().approval === 'never') warnings.push('Approbations : jamais');
  if (state().sandbox === 'danger-full-access') warnings.push('Accès total');
  if (state().permission === 'bypassPermissions') warnings.push('Tout autoriser');
  const count = Number(state().sillage) + Number(state().docs);
  $('context-trigger').innerHTML = `<span>${plan ? 'Plan' : 'Standard'} · MCP ${count}</span>${warnings.map((label) => `<span class="warning">${label}</span>`).join('')}`;
  $('context-trigger').setAttribute('aria-label', `Tous les réglages, ${plan ? 'Plan' : 'Standard'}, ${count} MCP${warnings.length ? `, ${warnings.join(', ')}` : ''}`);
}

function renderGroup(group, compact = false) {
  const selected = group.options.find((option) => option.value === state()[group.key]);
  return `<section class="setting-section" data-section="${group.key}">
    ${activeView === 'all' ? `<h3 class="section-title" id="label-${group.key}">${group.label}</h3>` : ''}
    <div class="choices ${compact ? 'segments' : ''}" role="radiogroup" aria-label="${group.label}">
      ${group.options.map((option) => `<button class="choice" type="button" role="radio" aria-checked="${state()[group.key] === option.value}" tabindex="${state()[group.key] === option.value ? '0' : '-1'}" data-group="${group.key}" data-value="${option.value}" data-caution="${option.caution === true}"><span class="choice-label"><strong>${option.label}</strong>${option.hint ? `<small>${option.hint}</small>` : ''}</span><span class="check">${icon('check')}</span></button>`).join('')}
    </div>${compact && selected?.hint ? `<p class="section-hint">${selected.hint}</p>` : ''}
  </section>`;
}

function renderDialog() {
  const all = activeView === 'all';
  const entries = groups();
  const visible = all ? entries : entries.filter((group) => group.key === activeView);
  $('dialog-title').textContent = all ? 'Tous les réglages' : visible[0].label;
  $('dialog-description').textContent = all ? 'Ajuste plusieurs choix sans quitter ce panneau.' : 'Choisis une valeur pour revenir au message.';
  $('dialog-footer').hidden = !all;
  $('dialog-body').innerHTML = visible.map((group) => renderGroup(group, all && group.compact)).join('') + (all ? `<section class="setting-section"><h3 class="section-title">Outils MCP</h3>${[['sillage', 'Sillage'], ['docs', 'Documentation (exemple)']].map(([key, label]) => `<button class="mcp-toggle" role="switch" aria-checked="${state()[key]}" data-toggle="${key}"><span>${label}</span><span class="toggle" aria-hidden="true"></span></button>`).join('')}</section>` : '');
}

function positionDialog() {
  if (!dialog.open || touchLayout.matches) return;
  const anchor = lastTrigger.getBoundingClientRect();
  dialog.style.maxHeight = `${Math.max(220, anchor.top - 20)}px`;
  dialog.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - dialog.offsetWidth - 12))}px`;
  dialog.style.top = `${Math.max(12, anchor.top - dialog.offsetHeight - 8)}px`;
}

function openDialog(view, trigger, keyboard) {
  lastTrigger = trigger;
  activeView = view;
  openingWithKeyboard = keyboard;
  dialog.dataset.view = view;
  renderDialog();
  document.querySelectorAll('[data-open]').forEach((button) => button.setAttribute('aria-expanded', String(button === trigger)));
  dialog.showModal();
  if (view !== 'all') dialog.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  positionDialog();
}

function closeDialog() { dialog.close(); }
dialog.addEventListener('close', () => {
  document.querySelectorAll('[data-open]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  // Sur téléphone, rendre le focus au bouton évite de faire surgir le clavier.
  // Sur ordinateur, une saisie déjà commencée reprend à la même sélection.
  if (returnToWriting && !touchLayout.matches && !openingWithKeyboard) {
    $('message').focus({ preventScroll: true });
    $('message').setSelectionRange(...selection);
  } else lastTrigger.focus({ preventScroll: true });
});
dialog.addEventListener('click', (event) => {
  const bounds = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeDialog();
});
dialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  // Le dialog natif peut passer par la barre du navigateur à la fin du parcours.
  const stops = [...dialog.querySelectorAll('button:not([disabled])')].filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0);
  const edge = event.shiftKey ? stops[0] : stops.at(-1);
  if (document.activeElement !== edge) return;
  event.preventDefault();
  (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
});
$('close-dialog').addEventListener('click', closeDialog);
$('done').addEventListener('click', closeDialog);
document.querySelectorAll('[data-open]').forEach((button) => {
  button.addEventListener('pointerdown', () => {
    returnToWriting = document.activeElement === $('message');
    selection = [$('message').selectionStart, $('message').selectionEnd];
  });
  button.addEventListener('click', (event) => openDialog(button.dataset.open, button, event.detail === 0));
});

$('dialog-body').addEventListener('click', (event) => {
  const button = event.target.closest('[data-group], [data-toggle]');
  if (!button) return;
  if (button.dataset.toggle) {
    const key = button.dataset.toggle;
    state()[key] = !state()[key];
    button.setAttribute('aria-checked', String(state()[key]));
    renderToolbar();
    return;
  }
  const { group, value } = button.dataset;
  state()[group] = value;
  let adjusted = false;
  if (group === 'model' && !currentModel().efforts.includes(state().effort)) {
    state().effort = currentModel().efforts.includes('medium') ? 'medium' : currentModel().efforts[0] ?? '';
    adjusted = true;
  }
  renderToolbar();
  $('announcement').textContent = `${button.querySelector('strong').textContent} sélectionné.${adjusted ? ' Effort adapté au modèle.' : ''}`;
  if (activeView !== 'all') closeDialog();
  else {
    const scroll = $('dialog-body').scrollTop;
    renderDialog();
    dialog.querySelector(`[data-group="${group}"][data-value="${value}"]`)?.focus({ preventScroll: true });
    $('dialog-body').scrollTop = scroll;
    positionDialog();
  }
});

// Flèches : parcourir les choix ; Entrée/Espace : sélectionner et fermer le raccourci.
$('dialog-body').addEventListener('keydown', (event) => {
  const button = event.target.closest('[data-group]');
  if (!button || !['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const choices = [...button.parentElement.querySelectorAll('[role="radio"]')];
  const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (choices.indexOf(button) + step + choices.length) % choices.length;
  choices[index].focus();
});
$('agent').addEventListener('change', (event) => { agent = event.target.value; renderToolbar(); });

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  $('theme').setAttribute('aria-label', `Passer au thème ${theme === 'dark' ? 'clair' : 'sombre'}`);
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#14131d' : '#f6f5fb';
}
$('theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

function updateViewport() {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  if (viewport) {
    root.style.setProperty('--viewport-height', `${viewport.height}px`);
    root.style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
    root.style.setProperty('--keyboard-gap', `${Math.max(0, innerHeight - viewport.height - viewport.offsetTop)}px`);
  }
  if (touchLayout.matches) dialog.style.removeProperty('max-height');
  positionDialog();
}
window.visualViewport?.addEventListener('resize', updateViewport);
window.visualViewport?.addEventListener('scroll', updateViewport);
window.addEventListener('resize', updateViewport);
touchLayout.addEventListener('change', updateViewport);
renderToolbar();
updateViewport();
