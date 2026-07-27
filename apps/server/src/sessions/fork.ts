import { forkSession } from '@anthropic-ai/claude-agent-sdk'
import type { AgentKind } from '@sillage/protocol'
import type { ThreadForkResponse } from '@sillage/protocol/codex/v2'
import { CodexAppServerClient } from '../agents/codex/app-server-client.js'

/**
 * Fork d'une session d'agent.
 *
 * Les deux CLI savent brancher une conversation, mais pas de la même façon, et c'est
 * cette divergence qui impose la couche ci-dessous plutôt qu'un appel direct :
 *
 *   Claude Code : `forkSession(id, { upToMessageId })`, coupe à un message.
 *   Codex       : `thread/fork` puis `thread/rollback { numTurns }` sur la branche.
 *
 * Codex ne sait pas couper à un message, seulement retirer des tours entiers depuis la
 * fin. La granularité commune est donc **le tour**, ce qui tombe bien : c'est déjà le
 * découpage que la réglette de navigation utilise.
 *
 * Aucun runner n'est requis : le fork travaille sur ce que le CLI a persisté, donc il
 * fonctionne sur une conversation dont la session est arrêtée depuis longtemps.
 */

const CLIENT_INFO = { name: 'sillage', title: 'Sillage', version: '0.1.0' } as const

export interface ForkTarget {
  agent: AgentKind
  /** Identifiant natif de la session à brancher. */
  agentSessionId: string
  /**
   * Exécutable du CLI, tel que la configuration le déclare. Jamais réécrit en dur :
   * sous systemd le PATH est minimal, et un CLI installé dans ~/.local/bin ne serait
   * pas trouvé.
   */
  binary: string
  cwd: string
  /**
   * Point de coupe côté Claude : l'`uuid` d'une entrée du fichier de transcript.
   *
   * Ce n'est pas un identifiant d'API. Seules les entrées `user`, `attachment` et
   * `assistant` en portent un ; viser un message `result`, qui n'existe pas dans le
   * transcript, fait échouer le fork avec « Message <uuid> not found in session ».
   */
  claudeUpToMessageId: string | null
  /** Point de coupe côté Codex : nombre de tours à retirer depuis la fin de la branche. */
  codexTurnsToDrop: number
}

export class ForkError extends Error {}

/** Identifiant natif de la nouvelle session, prête à être reprise. */
export async function forkAgentSession(target: ForkTarget): Promise<string> {
  return target.agent === 'claude' ? forkClaude(target) : forkCodex(target)
}

async function forkClaude(target: ForkTarget): Promise<string> {
  if (!target.claudeUpToMessageId) {
    throw new ForkError(
      "Aucun message de l'agent avant ce point : il n'y a rien à reprendre dans la branche.",
    )
  }

  try {
    const forked = await forkSession(target.agentSessionId, {
      dir: target.cwd,
      upToMessageId: target.claudeUpToMessageId,
    })
    return forked.sessionId
  } catch (err) {
    throw new ForkError(
      `Claude Code n'a pas pu forker la session : ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function forkCodex(target: ForkTarget): Promise<string> {
  const client = new CodexAppServerClient({
    binary: target.binary,
    cwd: target.cwd,
    onNotification: () => {},
    onServerRequest: () =>
      Promise.reject(new Error('Aucune requête serveur attendue pendant un fork.')),
  })

  try {
    await client.initialize(CLIENT_INFO)

    const forked = await client.call<ThreadForkResponse, 'thread/fork'>('thread/fork', {
      threadId: target.agentSessionId,
    })
    const branchId = forked.thread.id

    // Le fork copie tout le fil : c'est le rollback qui le ramène au point de coupe.
    // Il ne revient pas sur les fichiers déjà écrits sur le disque, seulement sur la
    // conversation, et cette limite est dite à l'utilisateur plutôt que devinée.
    if (target.codexTurnsToDrop > 0) {
      await client.call('thread/rollback', {
        threadId: branchId,
        numTurns: target.codexTurnsToDrop,
      })
    }

    return branchId
  } catch (err) {
    throw new ForkError(
      `Codex n'a pas pu forker le fil : ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    client.close()
  }
}
