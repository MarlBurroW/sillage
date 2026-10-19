import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Paths } from '../config.js'

/**
 * Déclaration du helper de credentials auprès de git.
 *
 * Deux moments s'en servent, avec le même helper. Le clone, où le dépôt n'existe pas
 * encore, le reçoit par l'environnement. Le dépôt cloné le garde dans son
 * `.git/config`, ce qui le rend valable pour tout ce qui viendra ensuite : le `push`
 * d'un agent, un `git fetch` tapé dans un terminal, et les worktrees, qui partagent la
 * configuration locale du dépôt principal.
 */

/**
 * Le fichier du helper, selon qu'on tourne sur les sources ou sur le bundle.
 *
 * En développement ce module est `src/git-credential/helper.ts` et le `.mjs` son
 * voisin ; en production tsup a fondu ce module dans `dist/main.js` et le `.mjs` est
 * copié dans `dist/git-credential/`.
 */
function resolveEntry(): string {
  const candidates = [
    join(import.meta.dirname, 'sillage-git-credential.mjs'),
    join(import.meta.dirname, 'git-credential/sillage-git-credential.mjs'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    throw new Error(
      `Helper de credentials git introuvable (cherché : ${candidates.join(', ')})`,
    )
  }
  return found
}

/** Git exécute un helper préfixé de `!` via un shell, donc tout argument doit être cité. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Le lanceur stable du helper, dans le répertoire de données.
 *
 * Le `.git/config` d'un dépôt cloné survit à tout : aux mises à jour, qui ne gardent que
 * trois releases, et aux changements de Node (un `nvm uninstall`). Il n'y écrit donc
 * plus que ce chemin, qui ne bouge pas ; c'est le lanceur, réécrit à chaque démarrage,
 * qui porte le Node et le `.mjs` du serveur du moment.
 */
export function credentialLauncherPath(paths: Pick<Paths, 'data'>): string {
  return join(paths.data, 'bin', 'sillage-git-credential')
}

/**
 * Le contenu du lanceur : du sh POSIX, que lisent aussi bien le dash de Debian, le bash
 * 3.2 de macOS que celui du conteneur.
 *
 * Le Node et le `.mjs` sont ceux du serveur qui l'écrit, et pas `app/current/…` ni le
 * `node` du PATH : better-sqlite3 est compilé pour un Node précis, et seul le couple du
 * serveur en marche est sûr de s'accorder. Si l'un des deux a disparu (Node désinstallé
 * sans redémarrer Sillage), une ligne claire vaut mieux qu'une trace de Node.
 *
 * La base et la clé sont ici plutôt que dans le `.git/config` : elles suivent le
 * répertoire de données, comme le lanceur lui-même.
 */
export function credentialLauncherScript(paths: Pick<Paths, 'data' | 'database'>, node: string, entry: string): string {
  return [
    '#!/bin/sh',
    '# Lanceur du helper de credentials git de Sillage.',
    '# Réécrit à chaque démarrage du serveur : ne pas modifier à la main.',
    `node=${shellQuote(gitPath(node))}`,
    `entry=${shellQuote(gitPath(entry))}`,
    'if [ ! -x "$node" ] || [ ! -f "$entry" ]; then',
    '  echo "sillage: helper de credentials introuvable ($node, $entry) ; redémarrez Sillage pour le réinstaller." >&2',
    '  exit 1',
    'fi',
    `exec "$node" "$entry" --db ${shellQuote(gitPath(paths.database))} --key ${shellQuote(gitPath(join(paths.data, 'secret.key')))} "$@"`,
    '',
  ].join('\n')
}

/**
 * Écrit le lanceur s'il manque ou ne décrit pas ce serveur.
 *
 * Relu à chaque appel plutôt que retenu en mémoire : quelques centaines d'octets, lus au
 * clone ou au push, et un lanceur abîmé ou écrit par un autre process se répare seul.
 *
 * Par renommage d'un fichier temporaire : un git qui l'exécute pendant le démarrage voit
 * l'ancien ou le nouveau, jamais un fichier à moitié écrit.
 */
export function installCredentialLauncher(paths: Pick<Paths, 'data' | 'database'>): string {
  const target = credentialLauncherPath(paths)
  const script = credentialLauncherScript(paths, process.execPath, resolveEntry())
  let current: string | null = null
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    // Absent : premier démarrage de cette version, ou dossier nettoyé.
  }
  if (current !== script) {
    mkdirSync(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, script, { mode: 0o755 })
    renameSync(temp, target)
  }
  return target
}

/**
 * La valeur à écrire dans `credential.helper`.
 *
 * Elle ne nomme que le lanceur et le propriétaire, rien qui dépende de la version
 * installée (voir `credentialLauncherPath`).
 *
 * Les arguments ne portent jamais le jeton : c'est le helper qui va le chercher dans la
 * base au moment où git le réclame. Une ligne de commande est lisible dans `ps` par
 * quiconque a un shell sur la machine.
 */
export function credentialHelperCommand(paths: Pick<Paths, 'data' | 'database'>, ownerId: string): string {
  const launcher = installCredentialLauncher(paths)
  return `!${[gitPath(launcher), '--owner', ownerId].map(shellQuote).join(' ')}`
}

/**
 * Un chemin tel que le lit le sh qui exécute le helper. Sous Windows, c'est celui de Git
 * for Windows : il comprend `C:/…` comme le Node qu'il lance, alors que les barres
 * obliques inverses d'un chemin Windows se lisent mal entre les mains d'un shell.
 */
function gitPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/**
 * Environnement d'un git lancé par Sillage sur un dépôt qui n'a pas encore sa
 * configuration, c'est-à-dire au clone.
 *
 * `GIT_CONFIG_COUNT` plutôt que des `-c` en ligne de commande : même raison que
 * ci-dessus, et ça vaut aussi pour les process que git lance lui-même.
 *
 * `GIT_TERMINAL_PROMPT=0` est indispensable et pas un détail : sans terminal, un git qui
 * décide de demander un mot de passe reste bloqué jusqu'au timeout au lieu d'échouer.
 *
 * La valeur vide en tête vide la liste des helpers : git interroge sinon d'abord ceux des
 * configurations système et globale. Sur macOS, celle de git pose `osxkeychain` : le
 * trousseau répondrait avant Sillage, et garderait le jeton de Sillage après chaque succès.
 */
export function credentialEnv(paths: Pick<Paths, 'data' | 'database'>, ownerId: string): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: credentialHelperCommand(paths, ownerId),
  }
}
