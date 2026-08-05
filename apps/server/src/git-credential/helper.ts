import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * La valeur à écrire dans `credential.helper`.
 *
 * `process.execPath` et non « node » : sous systemd le PATH est minimal, et rien ne
 * garantit que celui d'un agent mène au même runtime que celui du serveur.
 *
 * Les arguments ne portent que des chemins et un identifiant de propriétaire, jamais le
 * jeton : c'est le helper qui va le chercher dans la base au moment où git le réclame.
 * Une ligne de commande est lisible dans `ps` par quiconque a un shell sur la machine.
 */
export function credentialHelperCommand(paths: Paths, ownerId: string): string {
  const args = [
    process.execPath,
    resolveEntry(),
    '--db',
    paths.database,
    '--key',
    join(paths.data, 'secret.key'),
    '--owner',
    ownerId,
  ]
  return `!${args.map(shellQuote).join(' ')}`
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
 */
export function credentialEnv(paths: Paths, ownerId: string): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: credentialHelperCommand(paths, ownerId),
  }
}
