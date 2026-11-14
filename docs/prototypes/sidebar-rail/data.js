// Fictional data for the rail study. Shapes follow what the real sidebar already reads
// (projects with board counts, sessions with status, unread and worktree state).

export const projects = [
  { id: 'sillage', name: 'Sillage', color: '#8f9bff', pinned: true, board: { open: 6, review: 2 }, trees: { pending: 3, cleanable: 2 }, schedules: 4, archived: 212 },
  { id: 'power', name: 'Power Rush', color: '#f59e6b', pinned: true, board: { open: 3, review: 0 }, trees: { pending: 1, cleanable: 0 }, schedules: 1, archived: 48 },
  { id: 'chaos', name: 'Chaosfolk', color: '#6fd3a8', pinned: true, board: { open: 9, review: 1 }, trees: { pending: 2, cleanable: 1 }, schedules: 0, archived: 31 },
  { id: 'atlas', name: 'Atlas API', color: '#6bb8f5', pinned: true, shared: true, board: { open: 2, review: 0 }, trees: { pending: 1, cleanable: 0 }, schedules: 2, archived: 17 },
  { id: 'photos', name: 'Photos', color: '#e58fd0', pinned: true, board: { open: 0, review: 0 }, trees: { pending: 0, cleanable: 0 }, schedules: 0, archived: 9 },
  { id: 'infra', name: 'Infra marldev', color: '#d9c36a', pinned: true, board: { open: 1, review: 0 }, trees: { pending: 0, cleanable: 0 }, schedules: 3, archived: 22 },
  ...[
    'Blog', 'Bot Discord', 'Budget', 'Dotfiles', 'Domotique', 'Jeu de cartes', 'Kata Rust', 'Notes',
    'Portfolio', 'Sandbox', 'Scraper', 'Site vitrine', 'Thème Neovim', 'Veille techno',
  ].map((name, index) => ({
    id: `other-${index}`, name, color: ['#9aa3b5', '#b59a9a', '#9ab5a4', '#b5ae9a'][index % 4], pinned: false,
    board: { open: 0, review: 0 }, trees: { pending: 0, cleanable: 0 }, schedules: 0, archived: 3 + index,
  })),
]

// status: running | awaiting | idle. git: merged | dirty | unmerged | leftovers | missing (absent: no worktree).
export const sessions = [
  { id: 's1', project: 'sillage', agent: 'claude', title: 'Repenser la sidebar', status: 'running', git: 'dirty', branch: 'design/sidebar-rail', age: '1 min' },
  { id: 's2', project: 'sillage', agent: 'codex', title: 'Redémarrer Sillage Server sur macOS', status: 'awaiting', age: '12 min' },
  { id: 's3', project: 'sillage', agent: 'claude', title: 'Accès distant Tailscale pour Desktop', unread: true, git: 'unmerged', branch: 'feat/desktop-remote-access', card: 77, age: '1 h' },
  { id: 's4', project: 'sillage', agent: 'codex', title: 'Transférer une session entre projets', git: 'merged', branch: 'feat/session-project-transfer', card: 81, age: '2 j' },
  { id: 's5', project: 'sillage', agent: 'claude', title: 'Reprise après limite d’usage', git: 'merged', branch: 'feat/usage-limit-resume', card: 78, age: '2 j' },
  { id: 's6', project: 'sillage', agent: 'claude', title: 'Écran multi-session', favorite: true, git: 'merged', branch: 'feat/session-wall', age: '4 j' },
  { id: 's7', project: 'sillage', agent: 'claude', title: 'Liste des modèles Claude périmée', git: 'merged', branch: 'fix/claude-model-list-fallback', age: '2 j' },
  { id: 's8', project: 'sillage', agent: 'codex', title: 'Démarrage et mises à jour Windows', git: 'merged', branch: 'merge/windows-desktop-experience', age: '2 j' },
  { id: 's9', project: 'sillage', agent: 'claude', title: 'Services actuellement', git: 'leftovers', branch: 'feat/services-apps', age: '3 j' },
  { id: 's10', project: 'sillage', agent: 'codex', title: 'Export et partage de sessions', git: 'merged', branch: 'feat/session-sharing', age: '5 j' },
  { id: 's11', project: 'sillage', agent: 'claude', title: 'Mise à jour bloquée sur Mac', git: 'merged', branch: 'fix/macos-update-restart', age: '5 j' },
  { id: 's12', project: 'sillage', agent: 'grok', title: 'Liens file:// non rendus', git: 'merged', branch: 'fix/file-url-links', age: '6 j' },
  { id: 's13', project: 'sillage', agent: 'claude', title: 'Sélecteur de projets réutilisable', git: 'merged', branch: 'feat/project-selector', age: '7 j' },
  { id: 's14', project: 'sillage', agent: 'claude', title: 'Installation de MCP par l’agent', git: 'merged', branch: 'feat/agent-mcp-install', card: 72, age: '7 j' },
  { id: 's15', project: 'sillage', agent: 'codex', title: 'Bruit technique des conversations Codex', git: 'merged', branch: 'fix/compact-agent-notices', age: '7 j' },
  { id: 's16', project: 'sillage', agent: 'claude', title: 'Plantages mémoire à l’ouverture', git: 'dirty', branch: 'fix/transcript-memory-crash', age: '7 j' },
  { id: 's17', project: 'sillage', agent: 'claude', title: 'Benchmark de sessions comparées', favorite: true, git: 'merged', branch: 'feat/benchmarks', card: 69, age: '14 j' },
  { id: 's18', project: 'sillage', agent: 'opencode', title: 'Ordre des boutons de navigation', git: 'merged', branch: 'fix/navbar-drawer-order', age: '14 j' },
  { id: 's19', project: 'sillage', agent: 'claude', title: 'Visibilité des workflows Claude', git: 'merged', branch: 'feat/workflow-progress', age: '14 j' },
  { id: 's20', project: 'sillage', agent: 'codex', title: 'Audit éditeur et explorateur de fichiers', git: 'merged', branch: 'audit/file-explorer', age: '14 j' },
  { id: 's21', project: 'sillage', agent: 'grok', title: 'Diagnostic d’une session bloquée', age: '14 j' },
  { id: 's22', project: 'sillage', agent: 'claude', title: 'Crash des panneaux latéraux', git: 'missing', branch: 'deploy/sidebar-crash', age: '21 j' },
  { id: 's23', project: 'sillage', agent: 'claude', title: 'MCP indisponible au démarrage', git: 'merged', branch: 'fix/mcp-reconnect', age: '14 j' },

  { id: 'p1', project: 'power', agent: 'claude', title: 'Équilibrage des vagues d’ennemis', status: 'awaiting', git: 'dirty', branch: 'feat/wave-balance', age: '5 min' },
  { id: 'p2', project: 'power', agent: 'codex', title: 'Écran de fin de partie', git: 'unmerged', branch: 'feat/game-over', age: '1 j' },
  { id: 'p3', project: 'power', agent: 'claude', title: 'Musique adaptative par couches', favorite: true, git: 'merged', branch: 'feat/adaptive-music', age: '4 j' },
  { id: 'p4', project: 'power', agent: 'claude', title: 'Secousse d’écran sur les impacts', git: 'merged', branch: 'feat/screen-shake', age: '7 j' },

  { id: 'c1', project: 'chaos', agent: 'claude', title: 'Carte procédurale par graines', status: 'running', git: 'dirty', branch: 'feat/seeded-map', age: '1 min' },
  { id: 'c2', project: 'chaos', agent: 'codex', title: 'Tables de butin pondérées', git: 'unmerged', branch: 'feat/loot-tables', age: '3 h' },
  { id: 'c3', project: 'chaos', agent: 'claude', title: 'Caméra à zone morte', git: 'merged', branch: 'feat/deadzone-camera', age: '2 j' },

  { id: 'a1', project: 'atlas', agent: 'codex', title: 'Valider les requêtes entrantes', status: 'running', git: 'dirty', branch: 'feat/request-validation', age: '1 min' },
  { id: 'a2', project: 'atlas', agent: 'claude', title: 'Pagination par curseur', git: 'merged', branch: 'feat/cursor-pagination', age: '6 j' },

  { id: 'ph1', project: 'photos', agent: 'claude', title: 'Grille adaptée au téléphone', unread: true, git: 'unmerged', branch: 'feat/photo-grid', age: '40 min' },
  { id: 'ph2', project: 'photos', agent: 'claude', title: 'Import par glisser-déposer', age: '7 j' },

  { id: 'i1', project: 'infra', agent: 'codex', title: 'Sauvegarde horaire et espace disque', unread: true, age: '2 h' },
  { id: 'i2', project: 'infra', agent: 'claude', title: 'Profil AppArmor de Chromium', age: '21 j' },
]

export const decisions = [
  { id: 'd1', project: 'sillage', session: 's9', title: 'Garder les fichiers restants de feat/services-apps ?' },
  { id: 'd2', project: 'chaos', session: 'c2', title: 'Choisir le format des tables de butin' },
]

export const discussions = [
  { id: 'x1', agent: 'claude', title: 'Comparer deux offres d’hébergement', age: '3 h' },
  { id: 'x2', agent: 'codex', title: 'Idées de noms pour le jeu de cartes', age: '1 j' },
  { id: 'x3', agent: 'claude', title: 'Relire ma lettre au syndic', age: '2 j' },
  { id: 'x4', agent: 'claude', title: 'Plan d’entraînement vélo', age: '5 j' },
  { id: 'x5', agent: 'grok', title: 'Comprendre les fuseaux horaires en SQL', age: '7 j' },
]

export const benchmarks = [
  { id: 'b1', title: 'Refactor du parseur de requêtes', state: 'running', detail: '3 modèles · 2 sur 3 terminés' },
  { id: 'b2', title: 'Corriger un test instable', state: 'done', detail: '4 modèles · noté' },
  { id: 'b3', title: 'Écrire une migration réversible', state: 'done', detail: '2 modèles · à noter' },
  { id: 'b4', title: 'Résumer un journal de 5 000 lignes', state: 'failed', detail: '3 modèles · 1 échec' },
]

export const wallViews = [
  { id: 'attention', name: 'À traiter', query: 'is:attention' },
  { id: 'running', name: 'En cours', query: 'is:running' },
  { id: 'sillage', name: 'Sillage, dernière heure', query: 'project:sillage active:1h' },
  { id: 'recent', name: 'Tout récent', query: 'sort:recent limit:8' },
]

export const settingsGroups = [
  { name: 'Personnel', items: ['Compte', 'Apparence', 'Notifications', 'Dictée', 'Veille'] },
  { name: 'Agents', items: ['Réglages des CLI', 'Versions des CLI', 'Limites d’usage', 'Comptes Claude', 'Comptes Codex', 'Comptes Grok'] },
  { name: 'Projets et outils', items: ['Serveurs MCP', 'Consignes', 'Skills', 'Jetons d’API', 'Git', 'Secrets', 'Archivage', 'Sessions'] },
  { name: 'Administration', items: ['Comptes', 'Accès distant', 'À propos'] },
]

export const boardCards = [
  { number: 82, title: 'Rail de navigation et colonne par espace', column: 'En cours' },
  { number: 77, title: 'Accès distant pour l’app de bureau', column: 'À relire' },
  { number: 75, title: 'Réparer les vérifications palette et activité', column: 'À relire' },
  { number: 83, title: 'Sortie Bash en direct pour Codex', column: 'À faire' },
  { number: 84, title: 'Épingler un message dans une session', column: 'À faire' },
  { number: 85, title: 'Raccourcis clavier configurables', column: 'À faire' },
  { number: 81, title: 'Transférer une session entre projets', column: 'Terminé' },
  { number: 78, title: 'Reprise après limite d’usage', column: 'Terminé' },
]
