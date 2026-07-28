import type { Catalog } from './catalog-en'

/** Catalogue français. Typé d'après l'anglais : une clé oubliée casse le build. */
export const fr: Catalog = {
  'draft.title': 'Nouvelle conversation',
  'draft.subtitle':
    "Elle sera créée à l'envoi du premier message, et prendra le titre que le CLI lui donne.",
  'draft.cli.legend': 'CLI',

  'agent.unavailable.disabled': 'Désactivé dans la configuration du serveur.',
  'agent.unavailable.notExecutable': 'Trouvé à {binary}, mais pas exécutable.',
  'agent.unavailable.notOnPath': 'Introuvable sur le PATH du serveur ({binary}).',
  'agent.version.mismatch':
    'Version {installed} installée, Sillage vise {preferred} : des différences de comportement sont possibles.',
  'agent.install.missing': "{label} n'est pas installé sur le serveur.",
  'agent.install.running': 'Installation de {label} {version}…',
  'agent.install.action': 'Installer {version}',
  'agent.install.retry': 'Réessayer',
}
