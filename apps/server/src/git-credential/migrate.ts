import { readLocalCredentialHelpers, writeLocalCredentialHelpers } from '../git.js'
import type { Paths } from '../config.js'
import { credentialHelperCommand, credentialLauncherPath } from './helper.js'

/**
 * Remise à niveau du helper de credentials des dépôts déjà clonés.
 *
 * Avant le lanceur stable, le clone écrivait dans le `.git/config` le Node et le `.mjs`
 * de la release du moment. Ces chemins disparaissent avec la release (on n'en garde que
 * trois) ou avec le Node, et `git push` finit alors sur une trace de Node. Au
 * démarrage, on réécrit ces entrées vers le lanceur, en place.
 */

/**
 * Découpe une commande dans la forme qu'écrit `shellQuote` : des mots entre apostrophes,
 * l'apostrophe elle-même écrite `'\''`. Ce n'est pas un analyseur de shell complet, et
 * il n'a pas à l'être : il ne sert qu'à reconnaître ce que Sillage a lui-même écrit. Une
 * forme qu'il ne comprend pas rend null, et l'entrée reste intacte.
 */
export function splitQuotedWords(command: string): string[] | null {
  const words: string[] = []
  let index = 0
  while (index < command.length) {
    if (command[index] === ' ') {
      index++
      continue
    }
    let word = ''
    while (index < command.length && command[index] !== ' ') {
      if (command[index] === "'") {
        const close = command.indexOf("'", index + 1)
        if (close === -1) return null
        word += command.slice(index + 1, close)
        index = close + 1
      } else if (command[index] === '\\' && index + 1 < command.length) {
        word += command[index + 1]
        index += 2
      } else {
        word += command[index]
        index++
      }
    }
    words.push(word)
  }
  return words
}

function argAfter(words: string[], name: string): string | undefined {
  const index = words.indexOf(name)
  return index === -1 ? undefined : words[index + 1]
}

type Entry = { kind: 'current' } | { kind: 'legacy'; ownerId: string } | { kind: 'other' }

/**
 * Ce qu'est une entrée pour cette instance.
 *
 * Une ancienne entrée n'est reprise que si elle vise la base de cette instance : un
 * serveur de test, avec son propre répertoire de données, peut enregistrer le même dépôt
 * que le daemon, et ne doit pas lui détourner son helper.
 */
function classify(value: string, paths: Pick<Paths, 'data' | 'database'>): Entry {
  if (!value.startsWith('!')) return { kind: 'other' }
  const words = splitQuotedWords(value.slice(1))
  if (!words || words.length < 2) return { kind: 'other' }
  if (words[0] === credentialLauncherPath(paths)) return { kind: 'current' }

  const ownerId = argAfter(words, '--owner')
  if (words[1]?.endsWith('/sillage-git-credential.mjs') && argAfter(words, '--db') === paths.database && ownerId) {
    return { kind: 'legacy', ownerId }
  }
  return { kind: 'other' }
}

/**
 * La liste remise à niveau, ou null si elle n'a pas à changer.
 *
 * Les helpers de l'utilisateur restent où ils sont ; seules les anciennes entrées de
 * Sillage sont remplacées, chacune à sa place. Une valeur vide est ajoutée devant la
 * première entrée Sillage si rien ne la précède encore, comme le fait le clone depuis
 * 0fd5b4e : sans elle, le trousseau de macOS répond avant Sillage. Deux entrées devenues
 * identiques n'en font plus qu'une.
 */
export function upgradeHelperList(values: string[], paths: Pick<Paths, 'data' | 'database'>): string[] | null {
  const entries = values.map((value) => classify(value, paths))
  if (!entries.some((entry) => entry.kind === 'legacy')) return null

  const result: string[] = []
  let sawEmpty = false
  for (const [index, value] of values.entries()) {
    const entry = entries[index]!
    if (entry.kind === 'other') {
      if (value === '') sawEmpty = true
      result.push(value)
      continue
    }
    const next = entry.kind === 'legacy' ? credentialHelperCommand(paths, entry.ownerId) : value
    if (result.includes(next)) continue
    if (!sawEmpty) {
      result.push('')
      sawEmpty = true
    }
    result.push(next)
  }
  return result
}

/**
 * Passe sur les dépôts des projets. Un dossier qui n'est plus un dépôt, ou qui a
 * disparu, est ignoré : ce ménage ne doit jamais empêcher le serveur de démarrer.
 *
 * Idempotent : un dépôt déjà à jour n'est pas réécrit.
 */
export async function upgradeCredentialHelpers(
  workspaces: Iterable<string>,
  paths: Pick<Paths, 'data' | 'database'>,
): Promise<string[]> {
  const upgraded: string[] = []
  for (const cwd of new Set(workspaces)) {
    const values = await readLocalCredentialHelpers(cwd)
    if (!values) continue
    const next = upgradeHelperList(values, paths)
    if (!next) continue
    try {
      await writeLocalCredentialHelpers(cwd, next)
      upgraded.push(cwd)
    } catch {
      // Configuration en lecture seule ou verrouillée : on retentera au prochain démarrage.
    }
  }
  return upgraded
}
