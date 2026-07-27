import { Brain, ChevronRight, FileText, GitBranch } from 'lucide-react'
import { memo, useState } from 'react'
import type { ContentBlock } from '@sillage/protocol'
import { formatBytes } from '../../lib/attachments'
import { renderableBlocks, type MessageItem } from '../../lib/chat-fold'
import { cx } from '../ui'
import { CopyButton } from './CopyButton'
import { Markdown } from './Markdown'

/**
 * Horodatage d'un message.
 *
 * Heure seule dans la journée, date complète au-delà : dans une conversation ouverte
 * ce matin, « 14:32 » situe mieux qu'une date répétée à chaque ligne, alors qu'un fil
 * repris trois jours plus tard a besoin du jour.
 */
function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  const sameDay = new Date().toDateString() === date.toDateString()

  return date.toLocaleString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
  })
}

/** Barre d'actions sous un message : date, puis ce qu'on peut en faire. */
function MessageFooter({
  ts,
  text,
  label,
  align,
  onFork,
}: {
  ts: number
  text: string
  label: string
  align: 'start' | 'end'
  /** Proposé sur les seuls messages utilisateur : ce sont eux qui ouvrent un tour. */
  onFork?: () => void
}) {
  return (
    <div
      className={cx(
        'flex items-center gap-1 px-1.5 text-[0.6875rem] text-ink-faint',
        align === 'end' && 'flex-row-reverse',
      )}
    >
      {/* Toujours visible, contrairement aux actions : c'est un repère de lecture, pas
          une commande, et le faire apparaître au survol le rendrait inutile. */}
      <time dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString('fr-FR')}>
        {formatTimestamp(ts)}
      </time>
      <CopyButton text={text} label={label} />
      {onFork ? (
        <button
          type="button"
          onClick={onFork}
          title="Créer une conversation qui reprend l'historique jusqu'ici, sans ce message"
          className={cx(
            'flex items-center gap-1 rounded-md px-1.5 py-1 transition-[color,opacity]',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
            'text-ink-faint hover:text-ink',
          )}
        >
          <GitBranch size={13} />
          Forker
        </button>
      ) : null}
    </div>
  )
}

/**
 * Mémoïsé : pendant un tour, seul le dernier message change à chaque lot de deltas.
 * Sans ça, un fil de 200 messages est redessiné entièrement seize fois par seconde.
 * Le fold produit désormais un nouvel objet par élément modifié, ce qui rend la
 * comparaison par référence exacte.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  onFork,
}: {
  message: MessageItem
  /** Absent en lecture seule, ou quand la conversation ne peut pas être branchée. */
  onFork?: (message: MessageItem) => void
}) {
  const blocks = renderableBlocks(message.blocks)
  const thinking = blocks
    .filter((block) => block.type === 'thinking')
    .map((block) => block.text)
    .join('\n\n')
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
  const images = blocks.filter((block) => block.type === 'image')
  const files = blocks.filter((block) => block.type === 'file')

  const liveThinking = message.streamingThinking
  const liveText = message.streamingText
  // Le texte définitif prime sur le tampon de streaming, vidé dès que le message
  // complet arrive. C'est aussi ce qui part dans le presse-papiers.
  const shown = text || liveText

  const hasAttachments = images.length > 0 || files.length > 0
  if (!shown && !thinking && !liveThinking && !hasAttachments) return null

  if (message.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-0.5">
        <div className="surface flex min-w-0 max-w-[85%] flex-col gap-2 rounded-lg rounded-br-sm border border-line px-3.5 py-2.5 shadow-card">
          {shown ? <Markdown text={shown} /> : null}
          <Attachments images={images} files={files} />
        </div>
        {shown ? (
          <MessageFooter
            ts={message.ts}
            text={shown}
            label="Copier ce message"
            align="end"
            onFork={onFork ? () => onFork(message) : undefined}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className="group flex flex-col gap-2">
      {thinking || liveThinking ? <ThinkingBlock text={thinking || liveThinking} /> : null}
      <Attachments images={images} files={files} />
      {shown ? (
        <>
          <div className="min-w-0">
            <Markdown text={shown} />
          </div>
          <MessageFooter ts={message.ts} text={shown} label="Copier la réponse" align="start" />
        </>
      ) : null}
    </div>
  )
})

/**
 * Pièces jointes d'un message. Les images sont montrées, le reste devient un lien de
 * téléchargement : le chemin transmis à l'agent n'a pas à apparaître dans le fil.
 */
function Attachments({
  images,
  files,
}: {
  images: Extract<ContentBlock, { type: 'image' }>[]
  files: Extract<ContentBlock, { type: 'file' }>[]
}) {
  if (images.length === 0 && files.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {images.map((image) => (
            <a key={image.url} href={image.url} target="_blank" rel="noopener noreferrer">
              <img
                src={image.url}
                alt="Pièce jointe"
                loading="lazy"
                className="max-h-56 rounded-md border border-line object-contain"
              />
            </a>
          ))}
        </div>
      ) : null}

      {files.map((file) => (
        <a
          key={file.url}
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cx(
            'flex items-center gap-2 rounded-md border border-line bg-surface-high',
            'px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:text-ink',
          )}
        >
          <FileText size={14} className="shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0 text-ink-faint">{formatBytes(file.sizeBytes)}</span>
        </a>
      ))}
    </div>
  )
}

/**
 * Contenu de la réflexion, replié. L'état « en cours » n'est plus porté ici : il
 * appartient à l'indicateur de tour, qui reste affiché même quand ce bloc s'est déjà
 * terminé au milieu d'un tour.
 */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-md border border-line bg-surface/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-ink-faint"
      >
        <ChevronRight
          size={13}
          className={cx('shrink-0 transition-transform', open && 'rotate-90')}
        />
        <Brain size={13} className="shrink-0" />
        <span>Réflexion</span>
      </button>
      {open ? (
        <p className="border-t border-line px-2.5 py-2 text-xs whitespace-pre-wrap text-ink-soft">
          {text}
        </p>
      ) : null}
    </div>
  )
}
