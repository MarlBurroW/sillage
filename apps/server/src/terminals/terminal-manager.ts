import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from 'node-pty'
import { MAX_TERMINALS_PER_CONVERSATION, type TerminalDto } from '@sillage/protocol'
import type { Config } from '../config.js'

/**
 * Terminaux attachés aux conversations.
 *
 * Volontairement hors du journal : la sortie d'un shell n'est pas du contenu de
 * conversation, elle est massive, et la persister ferait grossir la base sans
 * qu'aucun rendu ne s'appuie dessus. Ce que le terminal garde, c'est un tampon en
 * mémoire, juste assez pour restituer l'écran quand on revient sur la vue.
 *
 * Indexés par terminal et non par conversation : on doit pouvoir laisser tourner un
 * serveur de développement dans l'un pendant qu'on lance des commandes dans l'autre.
 */

/** Tampon de restitution. Au-delà, on ne reconstitue plus un écran mais un historique. */
const REPLAY_BYTES = 128 * 1024

const DEFAULT_SHELL = '/bin/sh'
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export interface TerminalSubscriber {
  onOutput(data: string): void
  onExit(code: number): void
}

interface ManagedTerminal {
  id: string
  conversationId: string
  title: string
  pty: IPty
  cwd: string
  /** Sortie récente, pour repeindre l'écran à la reconnexion. */
  replay: string
  subscribers: Set<TerminalSubscriber>
  idleTimer: NodeJS.Timeout | null
  cols: number
  rows: number
  createdAt: number
  /** Le process s'est terminé : l'onglet reste, avec son écran final. */
  exited: boolean
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

  constructor(private readonly config: Config) {}

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
      () => this.close(terminalId),
      this.config.limits.ptyIdleTimeoutMin * 60 * 1000,
    )
    // Un terminal en veille ne doit pas maintenir le process en vie à lui seul.
    managed.idleTimer.unref()
  }

  private of(conversationId: string): ManagedTerminal[] {
    return [...this.terminals.values()]
      .filter((managed) => managed.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  list(conversationId: string): TerminalDto[] {
    return this.of(conversationId).map(toDto)
  }

  /**
   * Ouvre un terminal.
   *
   * Le répertoire de travail est celui de la conversation, worktree compris : un
   * terminal qui s'ouvrirait ailleurs que l'agent serait trompeur.
   */
  open(conversationId: string, cwd: string): TerminalDto {
    const existing = this.of(conversationId)
    if (existing.length >= MAX_TERMINALS_PER_CONVERSATION) {
      throw new TerminalError(
        'too_many_terminals',
        `Maximum ${MAX_TERMINALS_PER_CONVERSATION} terminals per conversation.`,
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
      conversationId,
      // Numéroté d'après ce qui est ouvert, pas d'un compteur : fermer le premier puis
      // en rouvrir un ne doit pas donner deux « shell 2 ».
      title: nextTitle(existing),
      pty,
      cwd,
      replay: '',
      subscribers: new Set(),
      idleTimer: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      createdAt: Date.now(),
      exited: false,
    }
    this.terminals.set(id, managed)

    pty.onData((data) => {
      managed.replay = (managed.replay + data).slice(-REPLAY_BYTES)
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

  rename(conversationId: string, terminalId: string, title: string): TerminalDto {
    const managed = this.require(conversationId, terminalId)
    managed.title = title
    return toDto(managed)
  }

  /**
   * Attache un client. Renvoie la sortie déjà produite pour qu'il repeigne son écran,
   * ainsi que la façon de se détacher.
   */
  attach(
    conversationId: string,
    terminalId: string,
    subscriber: TerminalSubscriber,
  ): { replay: string; cols: number; rows: number; exited: boolean; detach: () => void } {
    const managed = this.require(conversationId, terminalId)
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

  write(conversationId: string, terminalId: string, data: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.conversationId !== conversationId || managed.exited) return
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
  resize(conversationId: string, terminalId: string, cols: number, rows: number): void {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.conversationId !== conversationId || managed.exited) return
    if (cols < 1 || rows < 1) return
    if (managed.cols === cols && managed.rows === rows) return

    managed.cols = cols
    managed.rows = rows
    managed.pty.resize(cols, rows)
  }

  /**
   * Le terminal, s'il appartient bien à cette conversation.
   *
   * La vérification est ici et non chez l'appelant : un identifiant seul suffirait
   * sinon à lire le shell d'une conversation qu'on n'a pas le droit de voir.
   */
  private require(conversationId: string, terminalId: string): ManagedTerminal {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.conversationId !== conversationId) {
      throw new TerminalError('terminal_not_found', 'Terminal not found.')
    }
    return managed
  }

  close(terminalId: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed) return

    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    this.terminals.delete(terminalId)
    if (!managed.exited) managed.pty.kill()
  }

  closeIn(conversationId: string, terminalId: string): void {
    this.require(conversationId, terminalId)
    this.close(terminalId)
  }

  closeAll(): void {
    for (const terminalId of [...this.terminals.keys()]) this.close(terminalId)
  }

  activeCount(): number {
    return this.terminals.size
  }
}

function toDto(managed: ManagedTerminal): TerminalDto {
  return {
    id: managed.id,
    title: managed.title,
    alive: !managed.exited,
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
