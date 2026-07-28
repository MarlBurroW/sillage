/**
 * Vocabulaire canonique des noms d'outils portés par `tool.started.name`.
 *
 * Ce contrat n'était écrit nulle part : il ne vivait que dans un commentaire du
 * registre de vues du frontend, et un auteur d'adaptateur devait le deviner en
 * lisant l'adaptateur Codex. Le voici, normatif.
 *
 * Un adaptateur DOIT publier ses appels d'outils sous ces noms quand l'action
 * correspond : Codex publie ses exécutions de commande sous `Bash` et ses
 * changements de fichiers sous `Edit`. Un outil MCP passe tel quel sous la forme
 * `serveur/outil`, et un outil vraiment natif sans équivalent garde son nom : le
 * frontend le rend alors par sa vue générique, sans casser.
 *
 * La détection des modifications de fichiers ne passe jamais par ces noms :
 * l'événement `file.edited` existe précisément pour ça.
 */
export const CANONICAL_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  /** `Task` et `Agent` désignent le même outil de sous-agent selon la version du CLI. */
  'Task',
  'Agent',
  'ExitPlanMode',
] as const

export type CanonicalToolName = (typeof CANONICAL_TOOLS)[number]
