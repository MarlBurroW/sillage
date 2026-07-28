import type { ChatItem, MessageItem } from './chat-fold'

/** Un tour de conversation, tel que la réglette de repères le représente. */
export interface TurnMarker {
  /** Identifiant du message utilisateur : sert aussi d'ancre dans le fil. */
  id: string
  user: string
  assistant: string
}

/** Assez pour reconnaître un tour au survol, sans transformer l'infobulle en pavé. */
const EXCERPT_LENGTH = 140

function excerpt(message: MessageItem): string {
  const text = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    // Le tampon de streaming complète le texte tant que le message n'est pas fini,
    // sinon le tour en cours apparaîtrait vide dans la réglette.
    .concat(message.streamingText)
    .replace(/\s+/g, ' ')
    .trim()

  return text.length <= EXCERPT_LENGTH ? text : `${text.slice(0, EXCERPT_LENGTH).trimEnd()}...`
}

/**
 * Découpe le fil en tours : chaque message utilisateur en ouvre un, et la première
 * réponse de l'assistant qui suit lui est rattachée.
 *
 * Les appels d'outils et les demandes de permission sont ignorés : la réglette sert
 * à retrouver un échange, pas à détailler ce qui s'est passé dedans.
 */
export function buildTurns(items: ChatItem[]): TurnMarker[] {
  const turns: TurnMarker[] = []

  for (const item of items) {
    if (item.kind !== 'message') continue
    // Le rapport d'un sous-agent vit dans la carte de son appel, pas dans le fil :
    // le citer comme réponse du tour renverrait vers un texte absent à l'ancre.
    if (item.parentToolCallId) continue

    if (item.role === 'user') {
      turns.push({ id: item.id, user: excerpt(item), assistant: '' })
      continue
    }

    const current = turns[turns.length - 1]
    if (current && !current.assistant) current.assistant = excerpt(item)
  }

  return turns
}
