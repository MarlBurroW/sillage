import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import { MAX_TERMINALS_PER_PROJECT, type TerminalDto } from '@sillage/protocol'
import type { Config } from '../config.js'

/**
 * Terminaux attachés aux projets.
 *
 * Un pty est un process qui vit dans un répertoire : rien ne le rattache à une
 * conversation, et l'y indexer rendait introuvable un serveur lancé dans le shell
 * d'une session archivée. La session ne fait que fournir un répertoire par défaut
 * (son worktree) au moment de l'ouverture.
 *
 * Volontairement hors du journal : la sortie d'un shell n'est pas du contenu de
 * conversation, elle est massive, et la persister en base ferait grossir celle-ci
 * sans qu'aucun rendu ne s'appuie dessus. Ce que le terminal garde, c'est un tampon,
 * juste assez pour restituer l'écran quand on revient sur la vue.
 *
 * Les process ne survivent pas au redémarrage du daemon, et c'est assumé : les faire
 * survivre demanderait un porteur externe (la pente tmux). En revanche les
 * métadonnées et le dernier écran sont écrits sur disque : au redémarrage, l'entrée
 * réapparaît marquée « interrompue », écran lisible, prête à être relancée.
 */

/** Tampon de restitution. Au-delà, on ne reconstitue plus un écran mais un historique. */
const REPLAY_BYTES = 128 * 1024

/** L'écran se réécrit sur disque à ce pas, tant qu'il a changé depuis la dernière fois. */
const FLUSH_INTERVAL_MS = 30 * 1000

const DEFAULT_SHELL = '/bin/sh'
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export interface TerminalSubscriber {
  onOutput(data: string): void
  onExit(code: number): void
}

interface ManagedTerminal {
  id: string
  projectId: string
  title: string
  /** Null pour une entrée restaurée après un redémarrage : le process est perdu. */
  pty: IPty | null
  cwd: string
  /** Sortie récente, pour repeindre l'écran à la reconnexion. */
  replay: string
  /** L'écran sur disque est en retard sur celui en mémoire. */
  replayDirty: boolean
  subscribers: Set<TerminalSubscriber>
  idleTimer: NodeJS.Timeout | null
  cols: number
  rows: number
  createdAt: number
  /** Le process s'est terminé : l'onglet reste, avec son écran final. */
  exited: boolean
  /** Le process a été emporté par un redémarrage du daemon, pas par un `exit`. */
  interrupted: boolean
}

interface PersistedTerminal {
  id: string
  projectId: string
  title: string
  cwd: string
  createdAt: number
}

/** Le shell s'est terminé, ou n'a jamais démarré : deux refus distincts à afficher. */
export class TerminalError extends Error {
  constructor(
    readonly code: 'too_many_terminals' | 'terminal_not_found',
    message: string,
  ) {
    super(message)
    this.name = 'TerminalError'
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>()
  private readonly storeDir: string
  private readonly flushTimer: NodeJS.Timeout

  constructor(private readonly config: Config) {
    this.storeDir = join(config.paths.data, 'terminals')
    mkdirSync(this.storeDir, { recursive: true })
    this.restore()

    this.flushTimer = setInterval(() => this.flushDirty(), FLUSH_INTERVAL_MS)
    this.flushTimer.unref()
  }

  /**
   * Le shell de l'utilisateur, ou un repli POSIX.
   *
   * Sous systemd, `SHELL` peut manquer : sans repli, le terminal ne démarrerait tout
   * simplement pas, et l'erreur n'apparaîtrait qu'à l'ouverture de la vue.
   */
  private shell(): string {
    const fromEnv = process.env.SHELL
    return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_SHELL
  }

  private touch(terminalId: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed) return

    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    managed.idleTimer = setTimeout(
      () => this.reapIfIdle(terminalId),
      this.config.limits.ptyIdleTimeoutMin * 60 * 1000,
    )
    // Un terminal en veille ne doit pas maintenir le process en vie à lui seul.
    managed.idleTimer.unref()
  }

  /**
   * L'échéance d'inactivité ne fauche que les shells au prompt.
   *
   * Un shell qui fait tourner quelque chose (un serveur de dev, un build long) n'est
   * pas inactif : personne ne lui parle, mais son travail est la raison pour laquelle
   * on l'a ouvert. Tant qu'il a un process enfant, on remet l'échéance.
   */
  private reapIfIdle(terminalId: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.exited || !managed.pty) return

    if (hasChildProcess(managed.pty.pid)) {
      this.touch(terminalId)
      return
    }
    this.close(terminalId)
  }

  private of(projectId: string): ManagedTerminal[] {
    return [...this.terminals.values()]
      .filter((managed) => managed.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  list(projectId: string): TerminalDto[] {
    return this.of(projectId).map(toDto)
  }

  /** Shells vivants du projet, pour l'indicateur d'activité de la liste de projets. */
  aliveCount(projectId: string): number {
    return [...this.terminals.values()].filter(
      (managed) => managed.projectId === projectId && !managed.exited,
    ).length
  }

  open(projectId: string, cwd: string): TerminalDto {
    const existing = this.of(projectId)
    if (existing.length >= MAX_TERMINALS_PER_PROJECT) {
      throw new TerminalError(
        'too_many_terminals',
        `Maximum ${MAX_TERMINALS_PER_PROJECT} terminals per project.`,
      )
    }

    const id = randomUUID()
    const pty = spawn(this.shell(), [], {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    })

    const managed: ManagedTerminal = {
      id,
      projectId,
      // Numéroté d'après ce qui est ouvert, pas d'un compteur : fermer le premier puis
      // en rouvrir un ne doit pas donner deux « shell 2 ».
      title: nextTitle(existing),
      pty,
      cwd,
      replay: '',
      replayDirty: false,
      subscribers: new Set(),
      idleTimer: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      createdAt: Date.now(),
      exited: false,
      interrupted: false,
    }
    this.terminals.set(id, managed)
    this.persistMeta(managed)

    pty.onData((data) => {
      managed.replay = (managed.replay + data).slice(-REPLAY_BYTES)
      managed.replayDirty = true
      for (const subscriber of managed.subscribers) subscriber.onOutput(data)
    })

    pty.onExit(({ exitCode }) => {
      // L'entrée survit à son process, avec son dernier écran : un `exit` accidentel ou
      // une commande qui plante ne doivent pas faire disparaître ce qu'on voulait lire.
      managed.exited = true
      if (managed.idleTimer) clearTimeout(managed.idleTimer)
      managed.idleTimer = null
      for (const subscriber of managed.subscribers) subscriber.onExit(exitCode)
    })

    this.touch(id)
    return toDto(managed)
  }

  rename(projectId: string, terminalId: string, title: string): TerminalDto {
    const managed = this.require(projectId, terminalId)
    managed.title = title
    this.persistMeta(managed)
    return toDto(managed)
  }

  /**
   * Attache un client. Renvoie la sortie déjà produite pour qu'il repeigne son écran,
   * ainsi que la façon de se détacher.
   */
  attach(
    projectId: string,
    terminalId: string,
    subscriber: TerminalSubscriber,
  ): { replay: string; cols: number; rows: number; exited: boolean; detach: () => void } {
    const managed = this.require(projectId, terminalId)
    managed.subscribers.add(subscriber)
    if (!managed.exited) this.touch(terminalId)

    return {
      replay: managed.replay,
      cols: managed.cols,
      rows: managed.rows,
      exited: managed.exited,
      // Le terminal survit au départ de son dernier client : fermer un onglet ne doit
      // pas tuer une commande en cours. C'est l'inactivité qui finit par le libérer.
      detach: () => managed.subscribers.delete(subscriber),
    }
  }

  write(projectId: string, terminalId: string, data: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.projectId !== projectId || managed.exited || !managed.pty) return
    managed.pty.write(data)
    this.touch(terminalId)
  }

  /**
   * Redimensionne le pty.
   *
   * Plusieurs clients peuvent regarder le même terminal avec des tailles différentes ;
   * le pty n'en a qu'une. Le dernier qui parle l'emporte, comme le ferait un
   * multiplexeur sans mode « taille minimale ».
   */
  resize(projectId: string, terminalId: string, cols: number, rows: number): void {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.projectId !== projectId || managed.exited || !managed.pty) return
    if (cols < 1 || rows < 1) return
    if (managed.cols === cols && managed.rows === rows) return

    managed.cols = cols
    managed.rows = rows
    managed.pty.resize(cols, rows)
  }

  /**
   * Le terminal, s'il appartient bien à ce projet.
   *
   * La vérification est ici et non chez l'appelant : un identifiant seul suffirait
   * sinon à lire le shell d'un projet qu'on n'a pas le droit de voir.
   */
  private require(projectId: string, terminalId: string): ManagedTerminal {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.projectId !== projectId) {
      throw new TerminalError('terminal_not_found', 'Terminal not found.')
    }
    return managed
  }

  close(terminalId: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed) return

    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    this.terminals.delete(terminalId)
    this.forget(terminalId)
    if (!managed.exited) managed.pty?.kill()
  }

  closeIn(projectId: string, terminalId: string): void {
    this.require(projectId, terminalId)
    this.close(terminalId)
  }

  /** À la suppression du projet : rien ne doit continuer à tourner en son nom. */
  closeForProject(projectId: string): void {
    for (const managed of this.of(projectId)) this.close(managed.id)
  }

  /** À la suppression d'un worktree : un shell dans un dossier disparu n'a plus d'objet. */
  closeForCwd(cwd: string): void {
    for (const managed of [...this.terminals.values()]) {
      if (managed.cwd === cwd) this.close(managed.id)
    }
  }

  /**
   * Arrêt du daemon : on écrit les écrans puis on tue les process, mais on garde les
   * fichiers. C'est eux qui feront réapparaître les entrées, marquées interrompues.
   */
  shutdown(): void {
    clearInterval(this.flushTimer)
    for (const managed of this.terminals.values()) {
      if (managed.idleTimer) clearTimeout(managed.idleTimer)
      this.persistMeta(managed)
      this.flushReplay(managed)
      if (!managed.exited) managed.pty?.kill()
    }
    this.terminals.clear()
  }

  private restore(): void {
    for (const entry of readdirSync(this.storeDir)) {
      if (!entry.endsWith('.json')) continue
      let meta: PersistedTerminal
      try {
        meta = JSON.parse(readFileSync(join(this.storeDir, entry), 'utf8')) as PersistedTerminal
      } catch {
        // Un fichier tronqué par un arrêt brutal ne doit pas empêcher le démarrage,
        // ni rester là à échouer à chaque redémarrage.
        rmSync(join(this.storeDir, entry), { force: true })
        continue
      }

      let replay = ''
      try {
        replay = readFileSync(join(this.storeDir, `${meta.id}.replay`), 'utf8')
      } catch {
        // Pas d'écran sauvé : l'entrée réapparaît quand même, vide.
      }

      this.terminals.set(meta.id, {
        id: meta.id,
        projectId: meta.projectId,
        title: meta.title,
        pty: null,
        cwd: meta.cwd,
        replay,
        replayDirty: false,
        subscribers: new Set(),
        idleTimer: null,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        createdAt: meta.createdAt,
        exited: true,
        interrupted: true,
      })
    }
  }

  private persistMeta(managed: ManagedTerminal): void {
    const meta: PersistedTerminal = {
      id: managed.id,
      projectId: managed.projectId,
      title: managed.title,
      cwd: managed.cwd,
      createdAt: managed.createdAt,
    }
    try {
      writeFileSync(join(this.storeDir, `${managed.id}.json`), JSON.stringify(meta))
    } catch {
      // Disque plein ou dossier retiré : le terminal fonctionne, seule la
      // restitution après redémarrage est perdue.
    }
  }

  private flushReplay(managed: ManagedTerminal): void {
    if (!managed.replayDirty) return
    try {
      writeFileSync(join(this.storeDir, `${managed.id}.replay`), managed.replay)
      managed.replayDirty = false
    } catch {
      // Même contrat que persistMeta : on réessaiera au prochain passage.
    }
  }

  private flushDirty(): void {
    for (const managed of this.terminals.values()) this.flushReplay(managed)
  }

  private forget(terminalId: string): void {
    rmSync(join(this.storeDir, `${terminalId}.json`), { force: true })
    rmSync(join(this.storeDir, `${terminalId}.replay`), { force: true })
  }
}

/**
 * Le shell a-t-il un process enfant en cours ?
 *
 * Lecture de `/proc`, donc Linux seulement : ailleurs, la question répond non et
 * l'échéance d'inactivité retrouve son comportement d'origine.
 */
function hasChildProcess(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().length > 0
  } catch {
    return false
  }
}

function toDto(managed: ManagedTerminal): TerminalDto {
  return {
    id: managed.id,
    title: managed.title,
    alive: !managed.exited,
    interrupted: managed.interrupted,
    cwd: managed.cwd,
    createdAt: managed.createdAt,
  }
}

/** Premier numéro libre, pour que les intitulés restent lisibles après des fermetures. */
function nextTitle(existing: ManagedTerminal[]): string {
  const taken = new Set(existing.map((managed) => managed.title))
  for (let index = 1; ; index += 1) {
    const candidate = `shell ${index}`
    if (!taken.has(candidate)) return candidate
  }
}
