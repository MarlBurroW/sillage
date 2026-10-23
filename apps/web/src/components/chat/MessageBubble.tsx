import { Brain, ChevronRight, FileText, GitBranch, MessagesSquare } from 'lucide-react'
import { memo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { parseSessionMessage, type ContentBlock, type SessionMessageEnvelope } from '@sillage/protocol'
import { formatBytes } from '../../lib/attachments'
import { renderableBlocks, type MessageItem } from '../../lib/chat-fold'
import { locale, useTranslate } from '../../lib/i18n'
import { cx } from '../ui'
import { CopyButton } from './CopyButton'
import { ImageGallery } from './ImageViewer'
import { Markdown } from './Markdown'

/**
 * Message timestamp. Show time only today and full dates otherwise: time best locates today's
 * conversation, while threads resumed days later need the date.
 */
function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  const sameDay = new Date().toDateString() === date.toDateString()

  return date.toLocaleString(locale(), {
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
  })
}

/** Message action bar: timestamp then available actions. */
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
  /** Offered only for user messages, which open turns. */
  onFork?: () => void
}) {
  const t = useTranslate()
  return (
    <div
      className={cx(
        'flex items-center gap-1 px-1.5 text-[0.6875rem] text-ink-faint',
        align === 'end' && 'flex-row-reverse',
      )}
    >
      {/* Always visible unlike actions: reading markers would be useless if hover-only. */}
      <time dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString(locale())}>
        {formatTimestamp(ts)}
      </time>
      <CopyButton text={text} label={label} />
      {onFork ? (
        <button
          type="button"
          onClick={onFork}
          title={t('message.fork.title')}
          className={cx(
            'flex items-center gap-1 rounded-md px-1.5 py-1 transition-[color,opacity]',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
            'text-ink-faint hover:text-ink',
          )}
        >
          <GitBranch size={13} />
          {t('message.fork.action')}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Memoize: only the last message changes per delta batch. Otherwise 200-message threads redraw
 * entirely sixteen times per second. The fold replaces changed objects, making reference
 * comparisons exact.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  onFork,
}: {
  message: MessageItem
  /** Absent in read-only or nonforkable conversations. */
  onFork?: (message: MessageItem) => void
}) {
  const t = useTranslate()
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
  // Final text takes precedence over streaming buffers cleared on completion. Copy the same text to clipboard.
  const shown = text || liveText

  const hasAttachments = images.length > 0 || files.length > 0
  if (!shown && !thinking && !liveThinking && !hasAttachments) return null

  // Other-session messages use the CLI's user-message channel; specialized rendering prevents
  // mistaking them for typed instructions.
  const peer = message.role === 'user' && text ? parseSessionMessage(text) : null
  if (peer) {
    return (
      <PeerMessage
        envelope={peer}
        ts={message.ts}
        onFork={onFork ? () => onFork(message) : undefined}
      />
    )
  }

  if (message.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-0.5">
        <div className="sg-bubble sg-user-bubble flex min-w-0 max-w-[85%] flex-col gap-2 rounded-lg rounded-br-sm border px-3.5 py-2.5 shadow-card">
          {shown ? <Markdown text={shown} /> : null}
          <Attachments images={images} files={files} />
        </div>
        {shown ? (
          <MessageFooter
            ts={message.ts}
            text={shown}
            label={t('message.copy.user')}
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
          {/*
           * sg-bubble targets turn/search highlights. Agent replies have no bubble, so their
           * content serves as the target.
           */}
          <div className="sg-bubble min-w-0 rounded-lg">
            <Markdown text={shown} />
          </div>
          <MessageFooter ts={message.ts} text={shown} label={t('message.copy.agent')} align="start" />
        </>
      ) : null}
    </div>
  )
})

const PEER_LABELS = {
  message: 'message.peer.from',
  broadcast: 'message.peer.broadcast',
  done: 'message.peer.done',
  launch: 'message.peer.launch',
} as const

/**
 * Message from another project session. Left-aligned rather than user-right because it is not the
 * user's speech, with dashed border distinguishing agent replies. Heading links to the sender; omit
 * the model-facing note after the envelope.
 */
function PeerMessage({
  envelope,
  ts,
  onFork,
}: {
  envelope: SessionMessageEnvelope
  ts: number
  onFork?: () => void
}) {
  const t = useTranslate()
  const { projectId } = useParams()
  const sender = envelope.title || envelope.from

  return (
    <div className="group flex flex-col items-start gap-0.5">
      <div className="sg-bubble flex min-w-0 max-w-[85%] flex-col gap-2 rounded-lg rounded-bl-sm border border-dashed border-accent/50 bg-accent-wash/40 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
          <MessagesSquare size={13} className="shrink-0 text-accent" />
          <span className="shrink-0">{t(PEER_LABELS[envelope.kind])}</span>
          {projectId ? (
            <Link
              to={`/p/${projectId}/c/${envelope.from}`}
              title={t('message.peer.open')}
              className="min-w-0 truncate font-medium text-ink hover:text-accent hover:underline"
            >
              {sender}
            </Link>
          ) : (
            <span className="min-w-0 truncate font-medium text-ink">{sender}</span>
          )}
          {envelope.agent ? <span className="shrink-0 text-ink-faint">· {envelope.agent}</span> : null}
        </div>
        <Markdown text={envelope.body} />
      </div>
      <MessageFooter
        ts={ts}
        text={envelope.body}
        label={t('message.copy.peer')}
        align="start"
        onFork={onFork}
      />
    </div>
  )
}

/** Message attachments: display images and download links for others, omitting agent-facing disk paths. */
function Attachments({
  images,
  files,
}: {
  images: Extract<ContentBlock, { type: 'image' }>[]
  files: Extract<ContentBlock, { type: 'file' }>[]
}) {
  const t = useTranslate()
  if (images.length === 0 && files.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <ImageGallery maxHeight={224} images={images.map((image) => ({ src: image.url, width: image.width, height: image.height, alt: t('message.attachment.alt') }))} className="max-h-56 rounded-md border border-line object-contain" />
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
 * Collapsed reasoning content. Running state belongs to turn activity, which remains visible after
 * reasoning completes mid-turn.
 */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const t = useTranslate()

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
        <span>{t('message.thinking.label')}</span>
      </button>
      {open ? (
        <p className="border-t border-line px-2.5 py-2 text-xs whitespace-pre-wrap text-ink-soft">
          {text}
        </p>
      ) : null}
    </div>
  )
}
