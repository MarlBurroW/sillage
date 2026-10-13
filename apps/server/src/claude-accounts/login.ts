import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import { claudeSecretKind, type ClaudeLoginStatusDto } from '@sillage/protocol'
import { agentProcessEnv } from '../agents/process-env.js'
import type { ClaudeAccountStore } from './store.js'

/**
 * Connexion guidée d'un abonnement Claude, par `claude setup-token` piloté dans un
 * pseudo-terminal.
 *
 * Le CLI n'offre pas de flux sans terminal pour un abonnement : `setup-token` ouvre
 * un navigateur, ou imprime l'URL d'autorisation, puis attend que l'on colle le code
 * que la page affiche, et imprime enfin le jeton. Sondé sur 2.1.296 sous `script` :
 * l'URL arrive en lien OSC 8, l'invite « Paste code here if prompted » suit, un code
 * faux donne « OAuth error: Invalid code … Press Enter to retry », et le dossier de
 * configuration n'est pas touché. Sillage rejoue donc ce dialogue : il montre l'URL,
 * reçoit le code, l'écrit au CLI et lit le jeton dans sa sortie.
 *
 * Le CLI tourne dans un dossier de configuration jetable : il ne doit ni lire la
 * connexion du poste ni y écrire quoi que ce soit. Le jeton n'existe qu'en mémoire le
 * temps d'être chiffré dans le compte, qui n'est créé qu'à ce moment.
 */

/** Au-delà, le CLI en attente est fermé : personne n'a collé le code. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
/** Le temps que le CLI vérifie un code auprès d'Anthropic et imprime le jeton. */
const CODE_TIMEOUT_MS = 3 * 60 * 1000
/** Ce qu'on garde de la sortie du CLI pour expliquer un échec, jeton masqué. */
const DIAGNOSTIC_TAIL = 400
const URL_PATTERN = /https:\/\/[a-z.]*claude\.com\/[^\s\x07\x1b"']*oauth\/authorize\?[^\s\x07\x1b"']+/g
const TOKEN_PREFIX = 'sk-ant-oat01-'
const TOKEN_CHARS = /[A-Za-z0-9_-]/
/** Un jeton de setup-token fait une centaine de caractères : moins, c'est une coupure. */
const TOKEN_MIN_LENGTH = 60
/** Le motif s'arrête où le CLI reprend la main : « Press Enter to retry », « Retrying… ». */
const ERROR_PATTERN = /OAuth\s*error:\s*(.*?)(?=[\s\x00]*(?:Press\s*Enter|Retrying|$))/i

interface Login {
  ownerId: string
  label: string
  pty: IPty
  configDir: string
  /** Sortie cumulée, débarrassée des séquences de terminal, pour y lire invite et jeton. */
  output: string
  /** La même, brute : c'est là que vit l'URL entière, dans la cible de son lien. */
  raw: string
  status: ClaudeLoginStatusDto
  timer: NodeJS.Timeout
  /** Délai de la vérification du code en cours, s'il y en a une. */
  checking: { since: number; timer: NodeJS.Timeout } | null
}

/**
 * L'URL d'autorisation, lue dans la sortie brute et non dans sa version nettoyée.
 *
 * Le CLI l'écrit en lien OSC 8 : la cible du lien porte l'URL entière, le texte
 * visible n'en montre qu'une ligne, coupée à la largeur du terminal. Nettoyer d'abord
 * retirait la cible et ne laissait que le texte, et l'URL tronquée finissait sur un
 * `%3` incomplet que le navigateur réencodait en `%253` : « Requête OAuth non valide »
 * (vu le 13 octobre 2026). On garde donc la plus longue occurrence, et seulement si
 * elle va jusqu'au `state`, dernier paramètre.
 */
export function authUrlFrom(raw: string): string | null {
  const complete = [...raw.matchAll(URL_PATTERN)].map((match) => match[0]).filter((url) => /[?&]state=[A-Za-z0-9_-]+$/.test(url))
  return complete.sort((a, b) => b.length - a.length)[0] ?? null
}

/**
 * Remplace ce qu'un terminal interprète (couleurs, curseur, liens OSC 8) par une
 * marque, et retire le retour chariot. Une marque et non rien : le jeton est imprimé
 * en couleur, et c'est la remise à zéro de la couleur qui le sépare du texte qui suit.
 */
const MARK = '\x00'
export function plain(chunk: string): string {
  return chunk
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, MARK)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, MARK)
    .replace(/\x1b[()][A-Za-z0-9]/g, MARK)
    .replace(/[\x0e\x0f\x07\r]/g, '')
}

/**
 * Le jeton imprimé par le CLI, reconstitué par-dessus les sauts de ligne.
 *
 * Ink coupe le texte à la largeur de sa boîte, et un jeton d'une centaine de
 * caractères peut donc arriver sur deux lignes. On suit le jeton depuis son préfixe,
 * en enjambant espaces et sauts de ligne, et on s'arrête à tout autre caractère, dont
 * la marque laissée par la remise à zéro de la couleur. Le plus long l'emporte : un
 * cadre Ink redessiné répète le jeton, parfois coupé.
 */
export function tokenFrom(output: string): string | null {
  let best: string | null = null
  for (let at = output.indexOf(TOKEN_PREFIX); at !== -1; at = output.indexOf(TOKEN_PREFIX, at + 1)) {
    let token = TOKEN_PREFIX
    for (let i = at + TOKEN_PREFIX.length; i < output.length; i += 1) {
      const char = output[i]!
      if (TOKEN_CHARS.test(char)) token += char
      else if (char === ' ' || char === '\n' || char === '\t') continue
      else break
    }
    if (token.length >= TOKEN_MIN_LENGTH && (best === null || token.length > best.length)) best = token
  }
  return best
}

/** La fin de la sortie du CLI, lisible et sans jeton : ce qu'on montre quand il n'a pas conclu. */
function diagnostic(output: string): string {
  return output
    .replace(/sk-ant-oat01-[A-Za-z0-9_-]*/g, 'sk-ant-oat01-…')
    .replace(new RegExp(MARK, 'g'), '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(-DIAGNOSTIC_TAIL)
}

export class ClaudeLoginService {
  private readonly logins = new Map<string, Login>()

  constructor(
    private readonly store: ClaudeAccountStore,
    private readonly binary: () => Promise<string>,
  ) {}

  status(ownerId: string, loginId: string): ClaudeLoginStatusDto | undefined {
    const login = this.logins.get(loginId)
    return login && login.ownerId === ownerId ? login.status : undefined
  }

  /** Lance le CLI et attend qu'il imprime l'URL, ou qu'il échoue avant. */
  async start(ownerId: string, label: string): Promise<ClaudeLoginStatusDto> {
    const loginId = randomUUID()
    const configDir = await mkdtemp(join(tmpdir(), 'sillage-claude-login-'))
    const pty = spawn(await this.binary(), ['setup-token'], {
      name: 'xterm-256color',
      cols: 200,
      rows: 40,
      cwd: configDir,
      env: agentProcessEnv({ CLAUDE_CONFIG_DIR: configDir, TERM: 'xterm-256color' }) as Record<string, string>,
    })
    const login: Login = {
      ownerId,
      label,
      pty,
      configDir,
      output: '',
      raw: '',
      status: { loginId, state: 'starting', authUrl: null, error: null, account: null },
      timer: setTimeout(() => this.finish(loginId, 'Personne n’a collé le code à temps : connexion abandonnée.'), LOGIN_TIMEOUT_MS),
      checking: null,
    }
    this.logins.set(loginId, login)

    pty.onData((data) => this.consume(loginId, data))
    pty.onExit(({ exitCode }) => {
      const current = this.logins.get(loginId)
      if (!current || current.status.state === 'done') return
      this.finish(
        loginId,
        current.status.error ??
          `claude setup-token s'est arrêté (code ${exitCode}) sans donner de jeton. Sa sortie : ${diagnostic(current.output)}`,
      )
    })

    // L'URL vient en une seconde ; au-delà, c'est que le CLI n'a pas démarré ou
    // qu'il raconte autre chose, et la sortie est le seul indice.
    await this.until(loginId, (current) => current.status.state !== 'starting', 20_000).catch(() => {
      this.finish(loginId, `Le CLI n'a pas imprimé d'URL d'autorisation : ${login.output.trim().slice(-300) || 'aucune sortie'}`)
    })
    return login.status
  }

  /**
   * Écrit le code au CLI. La suite se lit par `status` : le jeton arrive en quelques
   * secondes, mais l'échange peut traîner, et une requête HTTP qui attend trois minutes
   * serait coupée avant. Un échec garde la fin de la sortie du CLI : c'est le seul
   * indice de ce qu'il attendait.
   */
  submitCode(ownerId: string, loginId: string, code: string): ClaudeLoginStatusDto | undefined {
    const login = this.logins.get(loginId)
    if (!login || login.ownerId !== ownerId) return undefined
    if (login.status.state === 'done' || login.status.state === 'checking') return login.status

    // Après un refus, le CLI attend Entrée pour rouvrir l'invite (sondé) : on la lui
    // donne, puis le code. Un code collé avec ses espaces ou sauts de ligne est nettoyé,
    // le CLI le refuserait tel quel.
    if (login.status.state === 'failed') login.pty.write('\r')
    login.status = { ...login.status, state: 'checking', error: null }
    const since = login.output.length
    login.pty.write(`${code.replace(/\s+/g, '')}\r`)

    const timer = setTimeout(() => {
      if (!login.checking) return
      login.checking = null
      login.status = {
        ...login.status,
        state: 'failed',
        error: `Le CLI n'a pas donné de jeton en trois minutes. Sa sortie : ${diagnostic(login.output.slice(since))}`,
      }
    }, CODE_TIMEOUT_MS)
    login.checking = { since, timer }
    // Le flux a peut-être déjà tout dit entre l'écriture et l'attente.
    this.settle(loginId)
    return login.status
  }

  async cancel(ownerId: string, loginId: string): Promise<boolean> {
    const login = this.logins.get(loginId)
    if (!login || login.ownerId !== ownerId) return false
    await this.finish(loginId, 'Connexion annulée.')
    this.logins.delete(loginId)
    return true
  }

  /** Ferme ce qui attend encore, à l'arrêt : rien n'y survit. */
  async closeAll(): Promise<void> {
    for (const loginId of [...this.logins.keys()]) await this.finish(loginId, 'Serveur arrêté.')
  }

  private consume(loginId: string, data: string): void {
    const login = this.logins.get(loginId)
    if (!login) return
    // Nettoyé sur le cumul et non par morceau : une séquence coupée entre deux
    // morceaux laisserait ses débris dans ce qu'on lit.
    login.raw += data
    login.output = plain(login.raw)
    if (login.status.state === 'starting') {
      const url = authUrlFrom(login.raw)
      if (url) login.status = { ...login.status, state: 'waiting_code', authUrl: url }
    }
    if (login.checking) this.settle(loginId)
  }

  /**
   * Pendant la vérification d'un code : un jeton imprimé fait le compte, un refus
   * remet en attente. Lu depuis l'envoi du code, pour ne pas reprendre un refus
   * précédent.
   */
  private settle(loginId: string): void {
    const login = this.logins.get(loginId)
    if (!login?.checking) return
    const since = login.output.slice(login.checking.since)
    const token = tokenFrom(since)
    const refused = ERROR_PATTERN.exec(since)?.[1]?.replace(new RegExp(MARK, 'g'), '')
    if (!token && !refused) return

    clearTimeout(login.checking.timer)
    login.checking = null
    if (token && claudeSecretKind(token) === 'oauth') {
      // Le libellé a pu être pris entre-temps : un suffixe vaut mieux qu'un jeton perdu.
      const label = this.store.labelFree(login.ownerId, login.label) ? login.label : `${login.label} ${new Date().toLocaleDateString('fr-FR')}`
      const account = this.store.create(login.ownerId, label, token)
      login.status = { ...login.status, state: 'done', error: null, account }
      void this.finish(loginId, null)
    } else {
      login.status = { ...login.status, state: 'failed', error: (refused ?? '').trim() || 'Code refusé.' }
    }
  }

  private async finish(loginId: string, error: string | null): Promise<void> {
    const login = this.logins.get(loginId)
    if (!login) return
    clearTimeout(login.timer)
    if (login.checking) {
      clearTimeout(login.checking.timer)
      login.checking = null
    }
    if (error !== null && login.status.state !== 'done') {
      login.status = { ...login.status, state: 'failed', error }
    }
    // Le dossier ne s'efface qu'une fois le CLI parti : il y écrit encore en mourant,
    // et un dossier supprimé sous lui renaissait à moitié.
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      login.pty.onExit(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    try {
      login.pty.kill()
    } catch {
      // Déjà mort : c'est ce qu'on voulait.
    }
    await exited
    await rm(login.configDir, { recursive: true, force: true })
    // L'état reste lisible le temps que l'écran le relise, puis s'oublie.
    setTimeout(() => this.logins.delete(loginId), 5 * 60 * 1000).unref()
  }

  private until(loginId: string, done: (login: Login) => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        const login = this.logins.get(loginId)
        if (!login) return reject(new Error('Connexion disparue.'))
        if (done(login)) return resolve()
        if (Date.now() - started > timeoutMs) return reject(new Error('Délai dépassé.'))
        setTimeout(tick, 100)
      }
      tick()
    })
  }
}
