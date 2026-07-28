/**
 * Catalogue anglais, source de vérité.
 *
 * L'anglais est la langue de repli : une clé absente ailleurs retombe ici, donc ce
 * fichier doit rester complet. C'est aussi lui qui définit l'ensemble des clés, les
 * autres catalogues étant typés d'après lui : ajouter une clé sans la traduire casse
 * le build plutôt que d'afficher un identifiant à l'utilisateur.
 *
 * Convention de nommage : `domaine.sujet`, en minuscules, points comme séparateurs. Le
 * domaine désigne une zone fonctionnelle et non un composant — renommer un fichier ne
 * doit pas faire bouger des clés. Les clés sont plates : une hiérarchie d'objets se lit
 * mal en diff et complique la vérification de complétude.
 *
 * Les paramètres s'écrivent `{nom}` et sont substitués par `t()`.
 */
export const en = {
  // Nouvelle conversation
  'draft.title': 'New conversation',
  'draft.subtitle':
    'It will be created when you send the first message, and will take the title the CLI gives it.',
  'draft.cli.legend': 'CLI',

  // Disponibilité des CLI agents
  'agent.unavailable.disabled': 'Disabled in the server configuration.',
  'agent.unavailable.notExecutable': 'Found at {binary}, but not executable.',
  'agent.unavailable.notOnPath': "Not on the server's PATH ({binary}).",
  'agent.version.mismatch':
    'Version {installed} installed, Sillage targets {preferred}: behaviour may differ.',
  'agent.install.missing': '{label} is not installed on the server.',
  'agent.install.running': 'Installing {label} {version}…',
  'agent.install.action': 'Install {version}',
  'agent.install.retry': 'Retry',
} as const

/**
 * Toutes les clés doivent exister dans chaque catalogue. `Record` et non `Partial` :
 * une traduction oubliée doit être une erreur de compilation, pas une surprise à
 * l'écran.
 */
export type MessageKey = keyof typeof en
export type Catalog = Record<MessageKey, string>
