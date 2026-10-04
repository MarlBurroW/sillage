import type { SillageEvent } from '@sillage/protocol'

/**
 * Ce que la suite d'un journal rend caduc à la relecture.
 *
 * Une conversation longue se relit surtout en octets que le fold écrase aussitôt. Sur la
 * plus lourde en base, 73 des 102 Mo d'une relecture complète :
 *
 *   - 47 Mo de `tool.output_delta`, la sortie d'un outil au fil de l'eau. Le fold cesse de
 *     l'écouter dès que l'appel est rendu, et `tool.completed` porte la sortie définitive ;
 *   - 26 Mo de `diff.updated`, le patch cumulé du tour, renvoyé en entier à chaque
 *     modification de fichier alors que la carte n'affiche que le dernier.
 *
 * Écarter ce qui suit laisse le fold à l'identique, ce qu'a montré le rejeu des cinq
 * conversations les plus lourdes de la base et ce que vérifie `replay.test.ts` :
 *
 *   - un `tool.output_delta` qu'un `tool.completed` du même appel suit. La position compte,
 *     pas seulement l'identifiant : un appel encore en cours garde sa sortie, même si un
 *     appel de même identifiant s'est terminé plus tôt ;
 *   - un `diff.updated` qui n'est ni le premier ni le dernier de son tour. Le premier pose
 *     la carte à sa place dans le fil, le dernier lui donne son contenu final. Un client
 *     qui reprend en cours de tour a déjà la carte, reçue en direct ou par une relecture
 *     qui garde toujours le premier : le dernier lui suffit ;
 *   - une liste que le fold remplace en bloc (`commands.updated`, `skills.updated`,
 *     `mcp.updated`) quand une plus récente la suit.
 *
 * Chaque événement écarté a donc un successeur gardé, que la relecture livre plus loin.
 * Rien n'est effacé du journal, et le direct n'y passe pas : c'est la relecture qui trie.
 */

/** Listes que le fold remplace en bloc : seule la dernière compte. */
const REPLACED = new Set<string>(['commands.updated', 'skills.updated', 'mcp.updated'])

/** Événements après lesquels le fold ouvre une nouvelle carte de diff (`diffId`). */
const DIFF_BOUNDARIES = new Set<string>(['turn.started', 'turn.completed'])

/** Les seuls types qui renseignent l'index : le reste du journal n'y change rien. */
export const INDEXED_TYPES: SillageEvent['type'][] = [
  'tool.completed',
  'diff.updated',
  'turn.started',
  'turn.completed',
  'commands.updated',
  'skills.updated',
  'mcp.updated',
]

/**
 * Une ligne du journal, réduite à ce que la décision demande. `toolCallId` n'est lu que
 * sur les appels d'outils (`tool.completed` à l'indexation, `tool.output_delta` à la
 * relecture) et vaut `null` ailleurs.
 */
export interface JournalRow {
  seq: number
  type: string
  toolCallId: string | null
}

export interface SupersessionIndex {
  /** Dernier `seq` couvert. Au-delà, la suite est inconnue et tout est gardé. */
  seq: number
  /** Frontières de tour vues, qui numérotent les tours de diff. */
  turns: number
  /** Dernier `tool.completed` de chaque appel. */
  completed: Map<string, number>
  /** Tour de chaque `diff.updated`. */
  diffTurn: Map<number, number>
  /** Premier et dernier `diff.updated` de chaque tour. */
  turnDiffs: Map<number, { first: number; last: number }>
  /** Dernier `seq` de chaque liste remplacée en bloc. */
  latest: Map<string, number>
}

export function emptySupersessionIndex(): SupersessionIndex {
  return {
    seq: 0,
    turns: 0,
    completed: new Map(),
    diffTurn: new Map(),
    turnDiffs: new Map(),
    latest: new Map(),
  }
}

/**
 * Avance l'index jusqu'à `throughSeq`, avec les lignes des types indexés comprises entre
 * `index.seq` (exclu) et `throughSeq`, dans l'ordre du journal. Une ligne déjà vue
 * compterait une seconde fois sa frontière de tour, et décalerait tous les tours de diff
 * qui suivent.
 *
 * Incrémental : un journal ne fait que s'allonger, donc ce qui est indexé ne change plus.
 */
export function advanceIndex(index: SupersessionIndex, rows: JournalRow[], throughSeq: number): void {
  for (const row of rows) {
    if (row.type === 'tool.completed') {
      if (row.toolCallId !== null) index.completed.set(row.toolCallId, row.seq)
    } else if (DIFF_BOUNDARIES.has(row.type)) {
      index.turns += 1
    } else if (row.type === 'diff.updated') {
      index.diffTurn.set(row.seq, index.turns)
      const bounds = index.turnDiffs.get(index.turns)
      if (bounds) bounds.last = row.seq
      else index.turnDiffs.set(index.turns, { first: row.seq, last: row.seq })
    } else if (REPLACED.has(row.type)) {
      index.latest.set(row.type, row.seq)
    }
  }
  index.seq = Math.max(index.seq, throughSeq)
}

/** Vrai si un événement ultérieur rend la ligne inutile au fold. */
export function isSuperseded(index: SupersessionIndex, row: JournalRow): boolean {
  if (row.seq > index.seq) return false

  if (row.type === 'tool.output_delta') {
    const completedAt = row.toolCallId === null ? undefined : index.completed.get(row.toolCallId)
    return completedAt !== undefined && completedAt > row.seq
  }

  if (row.type === 'diff.updated') {
    const turn = index.diffTurn.get(row.seq)
    const bounds = turn === undefined ? undefined : index.turnDiffs.get(turn)
    return bounds !== undefined && row.seq !== bounds.first && row.seq !== bounds.last
  }

  const latest = index.latest.get(row.type)
  return latest !== undefined && latest > row.seq
}
