import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import { existsSync } from 'node:fs'
import { claudeSecretKind, type ClaudeLoginPurpose, type ClaudeLoginStatusDto } from '@sillage/protocol'
import { agentProcessEnv } from '../agents/process-env.js'
import type { ClaudeAccountGauges } from './gauges.js'
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
 *
 * Le même dialogue sert à la jauge d'un compte existant, par `claude auth login` :
 * même URL, même invite (sondé sur 2.1.296), mais la portée comprend `user:profile` et
 * le CLI écrit sa connexion dans le dossier au lieu d'imprimer un jeton. La fin se lit
 * donc à l'apparition de `.credentials.json`, et le dossier jetable est repris par
 * `ClaudeAccountGauges.adopt` avant d'être effacé.
 */

/** Au-delà, le CLI en attente est fermé : personne n'a collé le code. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
/** Le temps que le CLI vérifie un code auprès d'Anthropic et imprime le jeton. */
const CODE_TIMEOUT_MS = 3 * 60 * 1000
/** Entre le code et l'Entrée qui le valide, pour que le CLI ne les lise pas d'un bloc. */
const ENTER_DELAY_MS = 300
/** Ce qu'on garde de la sortie du CLI pour expliquer un échec, jeton masqué. */
const DIAGNOSTIC_TAIL = 400
const URL_PATTERN = /https:\/\/[a-z.]*claude\.com\/[^\s\x07\x1b"']*oauth\/authorize\?[^\s\x07\x1b"']+/g
const TOKEN_PREFIX = 'sk-ant-oat01-'
const TOKEN_CHARS = /[A-Za-z0-9_-]/
/** Un jeton de setup-token fait une centaine de caractères : moins, c'est une coupure. */
const TOKEN_MIN_LENGTH = 60
/** Le motif s'arrête où le CLI reprend la main : « Press Enter to retry », « Retrying… ». */
const ERROR_PATTERN = /OAuth\s*error:\s*(.*?)(?=[\s\x00]*(?:Press\s*Enter|Retrying|$))/i
/** Ce qu'`auth login` dit d'un code refusé, juste avant de quitter (sondé sur 2.1.296). */
const LOGIN_FAILED_PATTERN = /Login\s*failed:\s*([^\n\x00]*)/i
/** Les relances d'`auth login` après un code refusé, avant d'abandonner. */
const MAX_RELAUNCHES = 5

interface Login {
  ownerId: string
  purpose: ClaudeLoginPurpose
  /** Le libellé du compte à créer (`token`), ou le compte qui reçoit sa jauge (`gauge`). */
  label: string
  accountId: string | null
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
  /** Ce qui relance le CLI : les arguments, et combien de fois il l'a été. */
  args: string[]
  relaunches: number
  /** Posé par `finish` : un CLI qui meurt ensuite ne doit plus être relancé. */
  closing: boolean
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
  // La dernière : le CLI rouvre un flux, avec une nouvelle URL, quand un code ne
  // correspond pas à celui en cours, et c'est elle qu'il faut alors montrer.
  return complete[complete.length - 1] ?? null
}

/** Le `state` d'une URL d'autorisation : ce qui distingue un flux d'un autre. */
function stateOf(url: string | null): string | null {
  return url ? (/[?&]state=([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null) : null
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
    // Les marques, et ce qui reste de contrôle : un message d'erreur se lit et se sérialise.
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
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
    private readonly gauges: ClaudeAccountGauges | null = null,
  ) {}

  /** Connexion qui donne sa jauge à un compte existant, par `claude auth login`. */
  startGauge(ownerId: string, accountId: string, label: string): Promise<ClaudeLoginStatusDto> {
    return this.launch(ownerId, 'gauge', label, accountId)
  }

  status(ownerId: string, loginId: string): ClaudeLoginStatusDto | undefined {
    const login = this.logins.get(loginId)
    return login && login.ownerId === ownerId ? login.status : undefined
  }

  /** Lance le CLI et attend qu'il imprime l'URL, ou qu'il échoue avant. */
  start(ownerId: string, label: string): Promise<ClaudeLoginStatusDto> {
    return this.launch(ownerId, 'token', label, null)
  }

  private async launch(
    ownerId: string,
    purpose: ClaudeLoginPurpose,
    label: string,
    accountId: string | null,
  ): Promise<ClaudeLoginStatusDto> {
    const loginId = randomUUID()
    const args = purpose === 'token' ? ['setup-token'] : ['auth', 'login', '--claudeai']
    const { pty, configDir } = await this.spawnCli(args)
    const login: Login = {
      ownerId,
      purpose,
      label,
      accountId,
      pty,
      configDir,
      output: '',
      raw: '',
      status: { loginId, purpose, state: 'starting', authUrl: null, error: null, account: null },
      timer: setTimeout(() => this.finish(loginId, 'Personne n’a collé le code à temps : connexion abandonnée.'), LOGIN_TIMEOUT_MS),
      checking: null,
      args,
      relaunches: 0,
      closing: false,
    }
    this.logins.set(loginId, login)
    this.attach(loginId, pty)

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
    if (login.status.state === 'done' || login.status.state === 'checking' || login.status.state === 'starting') {
      return login.status
    }

    // Après un refus, le CLI attend Entrée pour rouvrir l'invite (sondé) : on la lui
    // donne, puis le code. Un code collé avec ses espaces ou sauts de ligne est nettoyé,
    // le CLI le refuserait tel quel.
    if (login.status.state === 'failed' && login.purpose === 'token') login.pty.write('\r')
    login.status = { ...login.status, state: 'checking', error: null }
    const since = login.output.length
    // Le code et l'Entrée en deux écritures, espacées : arrivés d'un bloc, le CLI tient
    // un code long pour un collage et l'Entrée qui le suit en fait partie, rien n'est
    // validé et l'écran reste muet (sondé sur 2.1.296 : 91 caractères + Entrée en une
    // écriture, aucune réaction ; en deux, le code part). Un code court passait, d'où
    // des essais à code faux qui marchaient.
    login.pty.write(code.replace(/\s+/g, ''))
    setTimeout(() => {
      if (login.checking) login.pty.write('\r')
    }, ENTER_DELAY_MS)

    const timer = setTimeout(() => {
      if (!login.checking) return
      login.checking = null
      login.status = {
        ...login.status,
        state: 'failed',
        error: `Le CLI n'a pas conclu en trois minutes. Sa sortie : ${diagnostic(login.output.slice(since))}`,
      }
    }, CODE_TIMEOUT_MS)
    login.checking = { since, timer }
    // Le flux a peut-être déjà tout dit entre l'écriture et l'attente.
    this.settle(loginId)
    // `auth login` peut écrire sa connexion sans rien imprimer de plus : on regarde le
    // dossier à intervalle, tant que la vérification dure.
    if (login.purpose === 'gauge') {
      const watch = setInterval(() => {
        if (!login.checking) return clearInterval(watch)
        this.settle(loginId)
      }, 1000)
    }
    return login.status
  }

  /** Un CLI neuf, dans son propre dossier jetable. */
  private async spawnCli(args: string[]): Promise<{ pty: IPty; configDir: string }> {
    const configDir = await mkdtemp(join(tmpdir(), 'sillage-claude-login-'))
    const pty = spawn(await this.binary(), args, {
      name: 'xterm-256color',
      // Large : l'URL d'`auth login` est imprimée en texte et non en lien, et la plus
      // longue des deux, avec ses sept portées, ne doit pas dépendre de la largeur.
      cols: 400,
      rows: 40,
      cwd: configDir,
      env: agentProcessEnv({ CLAUDE_CONFIG_DIR: configDir, TERM: 'xterm-256color' }) as Record<string, string>,
    })
    return { pty, configDir }
  }

  /** Branche la sortie et la fin d'un CLI ; celles d'un CLI déjà remplacé sont ignorées. */
  private attach(loginId: string, pty: IPty): void {
    pty.onData((data) => {
      if (this.logins.get(loginId)?.pty === pty) this.consume(loginId, data)
    })
    pty.onExit(({ exitCode }) => {
      const current = this.logins.get(loginId)
      if (!current || current.pty !== pty || current.closing || current.status.state === 'done') return
      void this.exited(loginId, exitCode)
    })
  }

  /**
   * Le CLI a quitté sans conclure. `setup-token` attend un nouveau code après un refus,
   * `auth login` quitte (« Login failed: … », sondé sur 2.1.296) : pour garder le même
   * geste, on en relance un, sous la même connexion, et l'écran montre le nouveau lien.
   */
  private async exited(loginId: string, exitCode: number): Promise<void> {
    const login = this.logins.get(loginId)
    if (!login) return
    // `auth login` réussi quitte aussi, une fois sa connexion écrite : c'est un succès,
    // à reprendre avant que quoi que ce soit n'efface le dossier.
    if (login.purpose === 'gauge' && existsSync(join(login.configDir, '.credentials.json'))) {
      if (!login.checking) login.checking = { since: login.output.length, timer: setTimeout(() => undefined, 0) }
      this.adoptGauge(loginId, 0)
      return
    }
    const refused = LOGIN_FAILED_PATTERN.exec(login.output)?.[1]?.trim()
    if (login.purpose === 'gauge' && refused && login.relaunches < MAX_RELAUNCHES) {
      if (login.checking) {
        clearTimeout(login.checking.timer)
        login.checking = null
      }
      const previous = login.configDir
      const { pty, configDir } = await this.spawnCli(login.args)
      login.relaunches += 1
      login.pty = pty
      login.configDir = configDir
      login.raw = ''
      login.output = ''
      login.status = {
        ...login.status,
        state: 'starting',
        error: `Code refusé (${refused}). Une nouvelle page d'autorisation est prête : rouvre le lien ci-dessus et colle son code.`,
      }
      this.attach(loginId, pty)
      await rm(previous, { recursive: true, force: true })
      return
    }
    void this.finish(
      loginId,
      login.status.error ??
        (refused
          ? `Code refusé : ${refused}.`
          : `claude ${login.args.join(' ')} s'est arrêté (code ${exitCode}) sans conclure. Sa sortie : ${diagnostic(login.output)}`),
    )
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
    const url = authUrlFrom(login.raw)
    if (login.status.state === 'starting' && url) {
      // Après une relance, l'écran reste sur l'échec, motif et nouveau lien compris :
      // c'est l'envoi du prochain code qui l'efface.
      login.status = { ...login.status, state: login.status.error ? 'failed' : 'waiting_code', authUrl: url }
    }
    if (login.checking) this.settle(loginId)
    // Hors vérification aussi : un flux rouvert change l'URL, et l'écran doit la suivre.
    if (url && url !== login.status.authUrl) login.status = { ...login.status, authUrl: url }
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
    // `auth login` ne montre rien de ce qu'il obtient : sa connexion se lit dans le dossier.
    if (login.purpose === 'gauge' && existsSync(join(login.configDir, '.credentials.json'))) {
      this.adoptGauge(loginId)
      return
    }
    const token = login.purpose === 'token' ? tokenFrom(since) : null
    const refused = ERROR_PATTERN.exec(since)?.[1]?.replace(new RegExp(MARK, 'g'), '')
    // Un code d'une autre page : le CLI ne dit rien et rouvre un flux, avec une nouvelle
    // URL (vu le 13 octobre 2026, un code collé depuis une tentative précédente). On le
    // dit, et l'URL affichée devient la nouvelle : il suffit de la rouvrir.
    const reopened = authUrlFrom(login.raw)
    const restarted = reopened !== null && stateOf(reopened) !== stateOf(login.status.authUrl)
    if (!token && !refused && !restarted) return

    clearTimeout(login.checking.timer)
    login.checking = null
    if (token && claudeSecretKind(token) === 'oauth') {
      // Le libellé a pu être pris entre-temps : un suffixe vaut mieux qu'un jeton perdu.
      const label = this.store.labelFree(login.ownerId, login.label) ? login.label : `${login.label} ${new Date().toLocaleDateString('fr-FR')}`
      const account = this.store.create(login.ownerId, label, token)
      login.status = { ...login.status, state: 'done', error: null, account }
      void this.finish(loginId, null)
    } else if (restarted && !refused) {
      login.status = {
        ...login.status,
        state: 'failed',
        authUrl: reopened,
        error:
          "Ce code vient d'une autre page d'autorisation : le CLI en a ouvert une nouvelle. Rouvre le lien ci-dessus et colle le code qu'il affiche.",
      }
    } else {
      login.status = { ...login.status, state: 'failed', error: (refused ?? '').trim() || 'Code refusé.' }
    }
  }

  /**
   * Reprend la connexion de jauge. Le CLI écrit `.credentials.json` puis complète
   * `.claude.json` (le compte, son courriel) : on laisse passer un instant pour que le
   * second soit là, la jauge sait de toute façon vivre sans courriel.
   */
  private adoptGauge(loginId: string, delayMs = 1500): void {
    const login = this.logins.get(loginId)
    if (!login?.checking || !login.accountId || !this.gauges) return
    clearTimeout(login.checking.timer)
    login.checking = null
    // Plus rien ne doit conclure à sa place : ni la fin du CLI, ni un délai.
    login.closing = true
    const accountId = login.accountId
    setTimeout(() => {
      try {
        this.gauges!.adopt(accountId, login.configDir)
        login.status = { ...login.status, state: 'done', error: null, account: this.store.find(login.ownerId, accountId) ?? null }
      } catch (err) {
        login.status = { ...login.status, state: 'failed', error: err instanceof Error ? err.message : String(err) }
      }
      void this.finish(loginId, null)
    }, delayMs)
  }

  private async finish(loginId: string, error: string | null): Promise<void> {
    const login = this.logins.get(loginId)
    if (!login) return
    login.closing = true
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
