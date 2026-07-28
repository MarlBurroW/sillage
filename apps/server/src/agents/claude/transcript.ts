import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ContentBlock, SillageEvent } from '@sillage/protocol'
import { toWorkspacePath } from '../paths.js'
import { editedPath } from './file-edits.js'

/**
 * Lecture et traduction d'un transcript de session Claude Code.
 *
 * Le CLI persiste chaque session en JSONL sous
 * `$CLAUDE_CONFIG_DIR/projects/<slug-du-cwd>/<sessionId>.jsonl`. Importer une session
 * commencée hors de Sillage demande de reconstruire le journal depuis ce fichier
 * (invariant I2 : le journal est la seule source d'affichage), avec la même
 * traduction que le flux vivant de `ClaudeRunner.translate`.
 *
 * Ce n'est pas une copie : le CLI relit toujours le fichier complet à la reprise,
 * Sillage n'en tire que son affichage. Les `raw` conservent l'entrée de transcript,
 * dont l'`uuid` sert de point de coupe à un fork ultérieur (invariant I3).
 */

/**
 * Provenance des `raw` issus d'un transcript relu sur disque, par opposition au flux
 * vivant du SDK : mêmes formes aujourd'hui, mais deux sources qui peuvent diverger.
 */
export const TRANSCRIPT_RAW_FORMAT = 'claude-transcript@1'

/** Ce que le journal reçoit pour une entrée traduite. */
export interface TranslatedEvent {
  ts: number
  event: SillageEvent
  raw?: unknown
}

interface TranscriptEntry {
  type?: unknown
  subtype?: unknown
  uuid?: unknown
  timestamp?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  isCompactSummary?: unknown
  message?: { id?: unknown; model?: unknown; content?: unknown }
  toolUseResult?: { type?: unknown }
  compactMetadata?: { trigger?: unknown; preTokens?: unknown; postTokens?: unknown }
}

/**
 * Emplacement du fichier de session, tel que le CLI l'écrit : chaque caractère
 * non alphanumérique du cwd devient un tiret. Le SDK ne fournit pas de lecture du
 * transcript (seulement `listSessions`/`getSessionInfo`), d'où cette résolution.
 */
export function transcriptPath(cwd: string, sessionId: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return join(configDir, 'projects', slug, `${sessionId}.jsonl`)
}

/** Les entrées du transcript, ou une liste vide si le fichier n'existe pas. */
export async function readTranscript(cwd: string, sessionId: string): Promise<TranscriptEntry[]> {
  let content: string
  try {
    content = await readFile(transcriptPath(cwd, sessionId), 'utf8')
  } catch {
    return []
  }

  const entries: TranscriptEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) entries.push(parsed as TranscriptEntry)
    } catch {
      // Une ligne tronquée (écriture en cours au moment de la lecture) n'invalide pas
      // le reste du fichier.
    }
  }
  return entries
}

function entryTs(entry: TranscriptEntry): number {
  const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/**
 * Les commandes locales (`/compact`, `/model`...) sont enregistrées comme des messages
 * utilisateur balisés : ce sont des ordres au CLI, pas des choses dites à l'agent.
 */
function isLocalCommand(text: string): boolean {
  return text.startsWith('<command-') || text.startsWith('<local-command-')
}

/**
 * Marqueur écrit par le CLI quand un tour est coupé, sous les formes
 * `[Request interrupted by user]` et `[Request interrupted by user for tool use]`.
 *
 * Le transcript l'enregistre comme un message utilisateur, mais personne ne l'a écrit :
 * c'est la trace de l'interruption. Repris tel quel, il apparaissait dans le fil comme
 * une chose que l'utilisateur aurait dite, une fois de plus à chaque interruption.
 *
 * Ancré aux deux bouts : un message qui cite le marqueur pour en parler, lui, est bien
 * un message.
 */
const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]]*\]$/

interface ToolUse {
  name: string
  input: unknown
  startedAt: number
}

/**
 * Traduit les entrées d'un transcript en événements de journal.
 *
 * Miroir de `ClaudeRunner.translate`, aux différences près du format persisté : les
 * frontières de tour viennent de `system/turn_duration` (le message `result` du flux
 * n'est pas écrit dans le fichier), et les compteurs de tokens ne sont pas repris,
 * le transcript ne portant pas les totaux par tour.
 *
 * Les entrées `isSidechain` (sous-agents) sont écartées : le fil vivant ne les montre
 * que rattachées à leur appel parent, un lien que le transcript n'exprime pas.
 */
export function translateTranscript(
  entries: TranscriptEntry[],
  cwd: string,
): { events: TranslatedEvent[]; model: string | null } {
  const events: TranslatedEvent[] = []
  const pendingTools = new Map<string, ToolUse>()
  let model: string | null = null
  let inTurn = false

  for (const entry of entries) {
    if (entry.isSidechain === true) continue
    const ts = entryTs(entry)

    if (entry.type === 'assistant') {
      const message = entry.message
      if (!message || !Array.isArray(message.content)) continue
      if (typeof message.model === 'string' && message.model !== '<synthetic>') {
        model = message.model
      }

      const blocks: ContentBlock[] = []
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          blocks.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          blocks.push({ type: 'thinking', text: block.thinking })
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = typeof block.name === 'string' ? block.name : ''
          pendingTools.set(block.id, { name, input: block.input, startedAt: ts })
          blocks.push({ type: 'tool_use', toolCallId: block.id, name, input: block.input })
          events.push({
            ts,
            event: {
              type: 'tool.started',
              toolCallId: block.id,
              name,
              input: block.input,
              parentToolCallId: null,
            },
            raw: block,
          })
        }
      }

      if (blocks.length > 0 && typeof message.id === 'string') {
        events.push({
          ts,
          event: {
            type: 'message.completed',
            messageId: message.id,
            role: 'assistant',
            blocks,
            // Comme les appels d'outils ci-dessus : le transcript range les tours de
            // sous-agent dans un fichier annexe, que cet import ne relit pas.
            parentToolCallId: null,
          },
          raw: entry,
        })
      }
      continue
    }

    if (entry.type === 'user') {
      if (entry.isMeta === true || entry.isCompactSummary === true) continue
      const content = entry.message?.content

      if (Array.isArray(content)) {
        let handled = false
        for (const block of content as Record<string, unknown>[]) {
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
          handled = true
          const started = pendingTools.get(block.tool_use_id)
          pendingTools.delete(block.tool_use_id)

          const isError = block.is_error === true
          events.push({
            ts,
            event: {
              type: 'tool.completed',
              toolCallId: block.tool_use_id,
              output: block.content ?? null,
              isError,
              durationMs: started ? Math.max(ts - started.startedAt, 0) : 0,
            },
            raw: block,
          })

          const path = started && !isError ? editedPath(started.name, started.input) : null
          if (path !== null) {
            events.push({
              ts,
              event: {
                type: 'file.edited',
                toolCallId: block.tool_use_id,
                path: toWorkspacePath(cwd, path),
                // L'existence antérieure du fichier n'est plus observable après coup :
                // c'est le résultat conservé par le CLI qui dit si c'était une création.
                action: entry.toolUseResult?.type === 'create' ? 'created' : 'modified',
              },
            })
          }
        }
        if (handled) continue
      }

      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as Record<string, unknown>[])
                .filter((block) => block.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text as string)
                .join('\n')
            : ''
      if (!text.trim() || isLocalCommand(text) || INTERRUPT_MARKER.test(text.trim())) continue

      if (!inTurn) {
        events.push({ ts, event: { type: 'turn.started' } })
        inTurn = true
      }
      events.push({
        ts,
        event: {
          type: 'message.completed',
          messageId: typeof entry.uuid === 'string' ? entry.uuid : `import-${events.length}`,
          role: 'user',
          blocks: [{ type: 'text', text }],
          parentToolCallId: null,
        },
        raw: entry,
      })
      continue
    }

    if (entry.type === 'system') {
      // Sans condition sur `inTurn` : une resynchronisation peut reprendre au milieu
      // d'un tour dont l'ouverture est déjà au journal, et sa clôture doit passer.
      if (entry.subtype === 'turn_duration') {
        // Le transcript ne porte ni coût ni totaux de tokens par tour : les compteurs
        // repartent de zéro pour la partie importée, plutôt que d'inventer des chiffres.
        events.push({
          ts,
          event: {
            type: 'turn.completed',
            stopReason: 'imported',
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        })
        inTurn = false
      } else if (entry.subtype === 'compact_boundary') {
        const meta = entry.compactMetadata
        events.push({
          ts,
          event: {
            type: 'context.compacted',
            trigger: meta?.trigger === 'manual' || meta?.trigger === 'auto' ? meta.trigger : 'unknown',
            preTokens: typeof meta?.preTokens === 'number' ? meta.preTokens : null,
            postTokens: typeof meta?.postTokens === 'number' ? meta.postTokens : null,
          },
          raw: entry,
        })
      }
    }
    // Tout le reste (mode, last-prompt, file-history-*, attachment...) est un état
    // interne du CLI sans traduction dans le fil.
  }

  // Un transcript qui s'arrête en plein tour vient d'une session interrompue : sans
  // clôture, le fil rejoué garderait l'indicateur d'activité allumé.
  if (inTurn) {
    const last = events.at(-1)
    events.push({ ts: last?.ts ?? Date.now(), event: { type: 'session.ended', reason: 'interrupted' } })
  }

  return { events, model }
}
