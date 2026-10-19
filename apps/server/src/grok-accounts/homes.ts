import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linksTo, linkTo } from '../platform/links.js'

/**
 * Le `GROK_HOME` d'un compte supplémentaire, sur le modèle de `CodexAccountHomes`.
 *
 * Un dossier par compte, où seul ce qui tient au compte est réel : chaque autre entrée
 * du home de l'utilisateur y est liée par un lien symbolique. Grok y lit donc la même
 * configuration, les mêmes skills, la même mémoire, et surtout les mêmes sessions
 * (`sessions/`), ce qui permet de reprendre une conversation quel que soit le compte qui
 * l'a ouverte. Les liens sont repris à chaque lancement : une entrée apparue dans le home
 * de l'utilisateur après la création du compte doit être vue par le compte aussi. Une
 * entrée que Grok crée lui-même dans le home du compte (journaux) y reste.
 */

/** `$GROK_HOME` du serveur, à défaut `~/.grok` : là où vit la connexion du CLI. */
export function userGrokHome(): string {
  return process.env.GROK_HOME || join(homedir(), '.grok')
}

/**
 * Ce qui reste propre au compte : la connexion, et les caches que Grok remplit d'après
 * elle (catalogue de modèles, réglages distants), qui changent d'un abonnement à l'autre.
 */
const PRIVATE = new Set(['auth.json', 'models_cache.json', 'settings_cache.json'])

export class GrokAccountHomes {
  constructor(private readonly root: string) {}

  path(accountId: string): string {
    return join(this.root, accountId)
  }

  /** Crée le home s'il manque, puis reprend les liens. Rend son chemin. */
  ensure(accountId: string): string {
    const home = this.path(accountId)
    mkdirSync(home, { recursive: true })
    const source = userGrokHome()
    if (!existsSync(source)) return home

    for (const name of readdirSync(source)) {
      if (PRIVATE.has(name)) continue
      const target = join(source, name)
      const link = join(home, name)
      let current: ReturnType<typeof lstatSync> | null = null
      try {
        current = lstatSync(link)
      } catch {
        current = null
      }
      if (current) {
        // Un lien juste : rien à faire. Un lien vers ailleurs : repris. Un vrai fichier
        // ou dossier : propre au compte, laissé.
        if (!current.isSymbolicLink()) continue
        if (linksTo(link, target)) continue
        unlinkSync(link)
      }
      linkTo(target, link)
    }
    return home
  }

  /** Vrai quand le home porte une connexion, c'est-à-dire un `auth.json`. */
  connected(accountId: string): boolean {
    return existsSync(join(this.path(accountId), 'auth.json'))
  }
}
