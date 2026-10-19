import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linksTo, linkTo } from '../platform/links.js'

/**
 * Le `CODEX_HOME` d'un compte supplémentaire.
 *
 * Un dossier par compte, où seul `auth.json` est réel : chaque autre entrée du home de
 * l'utilisateur y est liée par un lien symbolique. Codex y lit donc la même
 * configuration, les mêmes skills, les mêmes mémoires, et surtout les mêmes threads,
 * ce qui permet de reprendre ou de brancher une conversation quel que soit le compte
 * qui l'a ouverte (sondé sur 0.162.1). Les bases SQLite suivent aussi : SQLite résout
 * le lien avant de poser ses fichiers de journal à côté de la vraie base.
 *
 * Les liens sont repris à chaque lancement et non posés une fois : Codex crée de
 * nouvelles entrées au fil des versions (`memories/`, `goals_1.sqlite`…), et une
 * entrée apparue dans le home de l'utilisateur après la création du compte doit être
 * vue par le compte aussi. Une entrée que Codex crée lui-même dans le home du compte
 * (journal, `history.jsonl`) y reste : elle n'est pas un lien, et on n'y touche pas.
 */

/** `$CODEX_HOME` du serveur, à défaut `~/.codex` : là où vit la connexion du CLI. */
export function userCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

const PRIVATE = new Set(['auth.json'])

export class CodexAccountHomes {
  constructor(private readonly root: string) {}

  path(accountId: string): string {
    return join(this.root, accountId)
  }

  /** Crée le home s'il manque, puis reprend les liens. Rend son chemin. */
  ensure(accountId: string): string {
    const home = this.path(accountId)
    mkdirSync(home, { recursive: true })
    const source = userCodexHome()
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
        // Un lien juste : rien à faire. Un lien vers ailleurs (home de l'utilisateur
        // déplacé) : repris. Un vrai fichier ou dossier : propre au compte, laissé.
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
