import { TooltipButton } from '../ui/Tooltip'
import { ArrowUp, FastForward, Loader2, Mic, Paperclip, Square } from 'lucide-react'
import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  DEFAULT_COMPOSER_LAYOUT,
  sessionMentionAt,
  sessionReference,
  sessionReferenceRanges,
  type ConversationDto,
  MAX_ATTACHMENTS_PER_MESSAGE,
  NATIVE_SLASH_COMMANDS,
  parseSlashCommand,
  type AgentConfig,
  type AttachmentDto,
  type AgentSkillDto,
  type CardLinkDto,
  type ConversationStatus,
  type McpServerStatus,
  type SlashCommandDto,
} from '@sillage/protocol'
import { useNavigate } from 'react-router-dom'
import type { ContextState } from '../../lib/chat-fold'
import { readDraft, saveDraft } from '../../lib/composer-drafts'
import { useComposerDrops, useComposerPrefill, useComposerReferences } from '../../lib/composer-ref'
import { ContextMeter } from './ContextMeter'
import { ComposerInsert, type ComposerPrefix } from './ComposerInsert'
import { discardAttachment, uploadAttachment } from '../../lib/attachments'
import { useCardSuggestions } from '../../lib/cards'
import { useFileSuggestions, type FileMatchDto } from '../../lib/files'
import { useDictation, useSttEnabled } from '../../lib/stt'
import { useTranslate } from '../../lib/i18n'
import { useUpdateComposerLayout, useUserSettings } from '../../lib/user-settings'
import { matchCommands, matchSkills, type PickerEntry } from '../../lib/composer-tokens'
import { ConfirmDialog, cx } from '../ui'
import { AttachmentTray } from './AttachmentTray'
import { DictationStrip } from './DictationStrip'
import { useAgentSettings } from './agent-settings'
import { TokenPicker } from './TokenPicker'
import { ComposerQuickSettings, ComposerSettingsButton } from './ComposerSettings'
import { toolButtonClass } from './composer-buttons'
import { SkillsControl } from './SkillsControl'
import { CardPicker } from './CardPicker'
import { MentionPicker } from './MentionPicker'
import { SessionPicker } from './SessionPicker'
import { SessionReference } from './SessionReference'
import { matchSessions, useSessionReferences } from '../../lib/session-references'

/** The `@...` mention around the cursor. */
/** Below this toolbar width, use the phone composer layout. */
const NARROW_BAR_PX = 480
/** Toolbar gap-1 spacing used to measure pinned settings. */
const BAR_GAP_PX = 4

interface MentionToken {
  query: string
  /** Position of the @ itself for replacing the whole token on selection. */
  start: number
  end: number
}

/**
 * Mention containing the cursor, or null. Require @ at a word start or email addresses and pasted
 * identifiers would open file suggestions mid-word.
 */
function mentionAt(value: string, caret: number): MentionToken | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret))
  if (!match) return null
  const query = match[1] ?? ''
  return { query, start: caret - query.length - 1, end: caret }
}

/**
 * Card # mention being typed, or null. Same word-start rule as @ so hex colors and pasted URL
 * fragments do not open cards mid-word. Accept nonnumeric queries too because the server searches
 * titles.
 */
function cardAt(value: string, caret: number): MentionToken | null {
  const match = /(?:^|\s)#([^\s#]*)$/.exec(value.slice(0, caret))
  if (!match) return null
  const query = match[1] ?? ''
  return { query, start: caret - query.length - 1, end: caret }
}

/** Slash command or dollar skill currently surrounding the cursor. */
interface SigilToken {
  sigil: '/' | '$'
  query: string
  /** Prefix position for replacing the whole token on selection. */
  start: number
  end: number
}

/**
 * Token containing the cursor, or null. Prefixes have different scopes: commands occupy the whole
 * message and match only at the field start so path slashes do not open suggestions. Skills occur
 * within sentences like mentions and match any word start.
 */
function sigilAt(value: string, caret: number): SigilToken | null {
  const before = value.slice(0, caret)

  const command = /^\/([a-zA-Z0-9_:-]*)$/.exec(before)
  if (command) return { sigil: '/', query: command[1] ?? '', start: 0, end: caret }

  const skill = /(?:^|\s)\$([a-zA-Z0-9_:-]*)$/.exec(before)
  if (skill) {
    const query = skill[1] ?? ''
    return { sigil: '$', query, start: caret - query.length - 1, end: caret }
  }
  return null
}

/** Fallback filename for nameless pasted files. */
function defaultPastedName(mimeType: string): string {
  const extension = mimeType.split('/')[1]?.split('+')[0] ?? 'bin'
  return `collage.${extension}`
}

/** Beyond this height scroll the field instead of consuming the conversation. */
const MAX_TEXTAREA_PX = 200

interface ComposerProps {
  config: AgentConfig
  status: ConversationStatus
  disabled: boolean
  /** Session MCP inventory identifying what is actually loaded. */
  mcpInventory: McpServerStatus[]
  /**
   * Running CLI configuration, null before startup. Differences from config are selected settings
   * awaiting restart.
   */
  appliedConfig?: AgentConfig | null
  /**
   * Slash commands recognized by the session CLI, empty until published. Keep suggestions closed
   * then rather than announcing an empty list.
   */
  commands: SlashCommandDto[]
  /**
   * Dollar skills published by the CLI, empty when unsupported. Only Codex publishes these; Claude
   * includes skills among commands.
   */
  skills: AgentSkillDto[]
  onSend(
    text: string,
    attachmentIds: string[],
    mentions: string[],
    skills: string[],
  ): Promise<void>
  /**
   * Execute commands handled by Sillage rather than sending text to the CLI
   * (`NATIVE_SLASH_COMMANDS`). Absent without that plumbing, such as before thread creation, where
   * commands become normal CLI messages.
   */
  onCommand?(name: string): Promise<void>
  onInterrupt(): void
  onConfigChange(config: AgentConfig): void
  configError?: string
  onConfigRetry?: () => void
  /** Context window usage, absent before any turn. */
  context?: ContextState | null
  /**
   * Steer the running turn where supported. Otherwise absent: omit the button instead of offering
   * then rejecting it.
   */
  onSteer?(
    text: string,
    attachmentIds: string[],
    mentions: string[],
    skills: string[],
  ): Promise<void>
  /**
   * Initial field content after forks: open with the cut message ready to rephrase. Read once
   * because conversation changes remount the keyed component.
   */
  initialText?: string
  /** Taller input integrated into the start screen. */
  variant?: 'thread' | 'draft'
  /**
   * Draft identity retained across mounts: conversation ID, or project ID before thread creation.
   * Restore text exactly where it was left, not elsewhere.
   */
  draftKey: string
  /** Project and worktree used for @ completion. */
  projectId?: string
  worktreeId?: string | null
  /**
   * Status strip immediately below the field. Render here rather than beside it in callers so one
   * component owns consistent bottom spacing instead of leaving text against the edge.
   */
  footer?: ReactNode
}

export function Composer({
  config,
  status,
  disabled,
  mcpInventory,
  appliedConfig = null,
  commands,
  skills,
  onSend,
  onCommand,
  onInterrupt,
  onConfigChange,
  configError,
  onConfigRetry,
  context,
  onSteer,
  initialText = '',
  variant = 'thread',
  draftKey,
  projectId,
  worktreeId = null,
  footer,
}: ComposerProps) {
  const t = useTranslate()
  // Follow language to recalculate memoized translated options. Read initial draft once at mount;
  // afterward local state is authoritative and updates the retained draft.
  const [restored] = useState(() => readDraft(draftKey))
  const [text, setText] = useState(restored.text || initialText)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<AttachmentDto[]>(restored.attachments)
  const [uploading, setUploading] = useState(0)
  const [token, setToken] = useState<MentionToken | null>(null)
  const [sessionToken, setSessionToken] = useState<MentionToken | null>(null)
  const { sessions: referenceSessions, loading: searchingSessions } = useSessionReferences(projectId)
  const sessionSuggestions = useMemo(() => matchSessions(referenceSessions, sessionToken?.query ?? '', draftKey), [referenceSessions, sessionToken, draftKey])
  const referencedIds = useMemo(() => [...new Set(sessionReferenceRanges(text, window.location.origin).filter(ref => !ref.projectId || ref.projectId === projectId).filter(ref => ref.explicit || referenceSessions.has(ref.id)).map(ref => ref.id))], [text, referenceSessions, projectId])
  const [cardToken, setCardToken] = useState<MentionToken | null>(null)
  const [sigil, setSigil] = useState<SigilToken | null>(null)
  // Shared by suggestion lists: tokens are mutually exclusive, since no cursor position opens @, /,
  // and $ simultaneously.
  const [active, setActive] = useState(0)
  /**
   * Paths actually selected from suggestions. Manually typed mentions are excluded: existence is
   * unproven and Codex rejects nonexistent targets. Claude expands text @ references itself anyway.
   */
  const [mentioned, setMentioned] = useState<Set<string>>(() => new Set(restored.mentions))
  /**
   * Skills actually selected from suggestions by name. As with mentions, typed dollar text is
   * excluded because it may not identify a published skill. The runner also rejects unknown names.
   */
  const [invoked, setInvoked] = useState<Set<string>>(() => new Set(restored.skills))
  const textarea = useRef<HTMLTextAreaElement>(null)
  const dismissedSessionToken = useRef<{ value: string; caret: number } | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)

  const running = status === 'running' || status === 'awaiting_input'
  const { groups, summary, mcp, mcpPanel, catalogError } = useAgentSettings({
    config,
    onConfigChange,
    appliedConfig,
    mcpInventory,
    disabled,
  })

  // Settings pinned beneath text for this conversation's CLI. Until account loading completes, use
  // protocol defaults rather than an empty toolbar during the round trip.
  const { data: userSettings } = useUserSettings()
  const layout = userSettings?.composerLayout ?? DEFAULT_COMPOSER_LAYOUT
  const updateLayout = useUpdateComposerLayout()
  const pinned = layout[config.agent]
  const setPinned = (next: string[]) => updateLayout.mutate({ ...layout, [config.agent]: next })

  // Measure toolbar width rather than window width, which ignores sidebar and panel: below this
  // breakpoint use a single-line phone bar without pins.
  const bar = useRef<HTMLDivElement>(null)
  const prefs = useRef<HTMLDivElement>(null)
  const lead = useRef<HTMLDivElement>(null)
  const trail = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [split, setSplit] = useState(false)
  const measureBar = useCallback(() => {
    const node = bar.current
    if (!node || !prefs.current || !lead.current || !trail.current) return
    const width = node.clientWidth
    setNarrow(width < NARROW_BAR_PX)
    // Chip natural widths do not change with collapse because they do not shrink, preventing
    // oscillation when compared with available space.
    const chips = [...prefs.current.children] as HTMLElement[]
    const natural = chips.reduce((sum, chip) => sum + chip.offsetWidth, 0) + BAR_GAP_PX * Math.max(0, chips.length - 1)
    const free = width - lead.current.offsetWidth - trail.current.offsetWidth - BAR_GAP_PX * 2
    setSplit(width >= NARROW_BAR_PX && natural > free)
  }, [])
  useLayoutEffect(() => {
    const node = bar.current
    if (!node) return
    const observer = new ResizeObserver(measureBar)
    observer.observe(node)
    return () => observer.disconnect()
  }, [measureBar])
  // Pins, longer values, and MCP counts change occupied space.
  useLayoutEffect(measureBar)

  // Grow with content up to a cap: mobile fields pushing conversations offscreen make input unusable.
  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

  // Persist drafts during editing rather than unmounting: a component removed by routing can no
  // longer read its state while disappearing.
  useEffect(() => {
    saveDraft(draftKey, {
      text,
      attachments,
      mentions: [...mentioned],
      skills: [...invoked],
    })
  }, [draftKey, text, attachments, mentioned, invoked])

  const { data: files, isFetching: searching } = useFileSuggestions(
    projectId,
    worktreeId,
    token?.query ?? null,
  )
  const suggestions = token ? (files ?? []) : []

  const { data: cardMatches, isFetching: searchingCards } = useCardSuggestions(
    projectId,
    cardToken?.query ?? null,
  )
  const cardSuggestions = cardToken ? (cardMatches ?? []) : []

  /** Replace the current token with the selected path and return focus to the field. */
  const pickMention = (file: FileMatchDto) => {
    const node = textarea.current
    if (!token || !node) return

    const next = `${text.slice(0, token.start)}@${file.path} ${text.slice(token.end)}`
    const caret = token.start + file.path.length + 2

    setText(next)
    setMentioned((current) => new Set(current).add(file.path))
    setToken(null)
    // After rendering: restoring the cursor before React writes the value would jump it to the end.
    requestAnimationFrame(() => {
      node.focus()
      node.setSelectionRange(caret, caret)
    })
  }

  /**
   * Replace the current token with the selected card. Write only its number, which the server can
   * resolve; inserting titles would freeze text that may later change.
   */
  const pickCard = (card: CardLinkDto) => {
    const node = textarea.current
    if (!cardToken || !node) return

    const reference = `#${card.number}`
    const next = `${text.slice(0, cardToken.start)}${reference} ${text.slice(cardToken.end)}`
    const caret = cardToken.start + reference.length + 1

    setText(next)
    setCardToken(null)
    requestAnimationFrame(() => {
      node.focus()
      node.setSelectionRange(caret, caret)
    })
  }

  const pickSession = (session: ConversationDto) => {
    const node = textarea.current
    if (!sessionToken || !node) return
    const reference = sessionReference(session.id)
    const next = `${text.slice(0, sessionToken.start)}${reference} ${text.slice(sessionToken.end)}`
    const caret = sessionToken.start + reference.length + 1
    setText(next)
    setSessionToken(null)
    requestAnimationFrame(() => { node.focus(); node.setSelectionRange(caret, caret) })
  }

  /**
   * File referenced from the explorer. Append rather than insert at the cursor: focus is in another
   * column and the old insertion point is meaningless. Also retain it as a selected mention because
   * it is a real workspace file and Codex rejects nonexistent targets.
   */
  const referenceFile = useCallback((path: string) => {
    setMentioned((current) => new Set(current).add(path))
    setText((current) => {
      const separator = current.length === 0 || current.endsWith(' ') || current.endsWith('\n')
      return `${current}${separator ? '' : ' '}@${path} `
    })
    requestAnimationFrame(() => {
      const node = textarea.current
      if (!node) return
      node.focus()
      node.setSelectionRange(node.value.length, node.value.length)
    })
  }, [])

  useComposerReferences(referenceFile)

  /**
   * Next-message suggestion accepted beneath the thread. Replace empty input or append to existing
   * text: a tap must never erase writing, and the suggestion is a whole message rather than a
   * cursor fragment.
   */
  useComposerPrefill((suggested) => {
    setText((current) =>
      current.trim().length === 0 ? suggested : `${current.replace(/\s+$/, '')}\n\n${suggested}`,
    )
    requestAnimationFrame(() => {
      const node = textarea.current
      if (!node) return
      node.focus()
      node.setSelectionRange(node.value.length, node.value.length)
    })
  })

  /**
   * Insert dictated text at the cursor with typing-style spacing. The field may have changed while
   * dictating, so current state is authoritative.
   */
  const insertDictation = useCallback((spoken: string) => {
    const node = textarea.current
    setText((current) => {
      const caret = node && document.activeElement === node ? node.selectionStart : current.length
      const before = current.slice(0, caret)
      const after = current.slice(caret)
      const lead = before.length === 0 || /\s$/.test(before) ? '' : ' '
      const trail = after.length === 0 || /^\s/.test(after) ? '' : ' '
      const position = caret + lead.length + spoken.length + trail.length
      requestAnimationFrame(() => {
        node?.focus()
        node?.setSelectionRange(position, position)
      })
      return `${before}${lead}${spoken}${trail}${after}`
    })
  }, [])

  const sttEnabled = useSttEnabled()
  const dictation = useDictation({
    projectId,
    onText: insertDictation,
    onError: setError,
  })
  // Keep the microphone visible when unconfigured: absence hides the feature; a dialog explains and
  // links to settings.
  const [sttNotice, setSttNotice] = useState(false)
  const navigate = useNavigate()

  // Drops target the thread rather than the field: files land here with the same limits and errors
  // as paste or file selection.
  useComposerDrops((files) => {
    if (disabled) return
    void addFiles(files)
    textarea.current?.focus()
  })

  // Without onCommand native commands would reach the CLI as text, so omit them. Centralize this
  // rule here rather than requiring every future composer caller to copy it.
  const offered = useMemo(
    () => (onCommand ? commands : commands.filter((c) => !NATIVE_SLASH_COMMANDS.has(c.name))),
    [commands, onCommand],
  )

  const syncToken = (value: string, caret: number | null) => {
    const position = caret ?? value.length
    const dismissed = dismissedSessionToken.current
    if (dismissed?.value !== value || dismissed.caret !== position) {
      dismissedSessionToken.current = null
      setSessionToken(sessionMentionAt(value, position))
    }
    setToken(mentionAt(value, position))
    setCardToken(cardAt(value, position))
    // Prefixes without published CLI entries open no list: better offer nothing than announce
    // emptiness for every dollar sign in a cited shell command.
    const found = sigilAt(value, position)
    const available = found?.sigil === '/' ? offered.length > 0 : skills.length > 0
    setSigil(found && available ? found : null)
    setActive(0)
  }

  const insertPrefix = (prefix: ComposerPrefix) => {
    const node = textarea.current
    if (!node || disabled) return
    // Commands start the message; preserve the draft as arguments. Other references replace only
    // the selection and retain the caret captured by the textarea while the help panel was open.
    const start = prefix === '/' ? 0 : node.selectionStart
    const end = prefix === '/' ? 0 : node.selectionEnd
    const before = text.slice(0, start)
    const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${prefix}`
    const next = before + inserted + text.slice(end)
    const caret = start + inserted.length
    setText(next)
    dismissedSessionToken.current = null
    requestAnimationFrame(() => {
      node.focus({ preventScroll: true })
      node.setSelectionRange(caret, caret)
      syncToken(next, caret)
    })
  }

  const entries = !sigil
    ? []
    : sigil.sigil === '/'
      ? matchCommands(offered, sigil.query)
      : matchSkills(skills, sigil.query)

  /** Replace the current token with the selected entry, ready for further input. */
  const pickEntry = ({ name }: PickerEntry) => {
    const node = textarea.current
    if (!sigil || !node) return

    const next = `${text.slice(0, sigil.start)}${sigil.sigil}${name} ${text.slice(sigil.end)}`
    const caret = sigil.start + name.length + 2

    setText(next)
    if (sigil.sigil === '$') setInvoked((current) => new Set(current).add(name))
    setSigil(null)
    // After rendering: restoring the cursor before React writes the value would jump it to the end.
    requestAnimationFrame(() => {
      node.focus()
      node.setSelectionRange(caret, caret)
    })
  }

  // Sending remains possible during turns: the server queues messages beneath activity instead of
  // rejecting input.
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !sending && !disabled

  /**
   * Send field contents through the supplied action. Clear first for every gesture: messages
   * reappear through the log, the thread's sole display source. On failure restore text,
   * attachments, and mentions unchanged and display the cause.
   */
  const submit = async (
    action: (
      text: string,
      attachmentIds: string[],
      mentions: string[],
      skills: string[],
    ) => Promise<void>,
  ) => {
    if (!canSend) return

    let value = text.trim()
    const sent = attachments
    // Mentions or skills deleted from text after selection must not be sent: current text is
    // authoritative, not previous clicks.
    const urls = sessionReferenceRanges(value, window.location.origin).filter(ref => ref.projectId === projectId)
    for (const ref of urls.reverse()) value = `${value.slice(0, ref.start)}${sessionReference(ref.id)}${value.slice(ref.end)}`
    const paths = [...mentioned].filter((path) => value.includes(`@${path}`))
    const invocations = [...invoked].filter((name) => value.includes(`$${name}`))

    setSending(true)
    setError(null)
    setText('')
    setAttachments([])
    setMentioned(new Set())
    setInvoked(new Set())
    setToken(null)
    setSigil(null)
    setCardToken(null)
    setSessionToken(null)
    try {
      await action(
        value,
        sent.map((attachment) => attachment.id),
        paths,
        invocations,
      )
    } catch (err) {
      // Silent send failures look like dead buttons: restore contents and display every failure cause.
      setText(value)
      setAttachments(sent)
      setMentioned(new Set(paths))
      setInvoked(new Set(invocations))
      setError(err instanceof Error ? err.message : t('composer.send.failed'))
    } finally {
      setSending(false)
    }
  }

  /**
   * Normal send or Sillage execution when the message is exactly a supported native command. Return
   * control to the CLI for arguments, which local routes cannot preserve (such as compact summary
   * instructions), or attachments, which otherwise have nowhere to go. Passing the full line is
   * preferable to silently dropping data.
   */
  const send = () => {
    const parsed = parseSlashCommand(text)
    const native =
      parsed &&
      parsed.args.length === 0 &&
      attachments.length === 0 &&
      NATIVE_SLASH_COMMANDS.has(parsed.name)
    if (native && onCommand) return submit(() => onCommand(parsed.name))
    return submit(onSend)
  }

  const addFiles = async (chosen: File[]) => {
    if (chosen.length === 0) return
    setError(null)

    const room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length
    if (room <= 0) {
      setError(t('composer.attachments.max', { max: MAX_ATTACHMENTS_PER_MESSAGE }))
      return
    }

    const selected = chosen.slice(0, room)
    if (selected.length < chosen.length) {
      setError(t('composer.attachments.limited', { count: room }))
    }

    setUploading((count) => count + selected.length)
    for (const file of selected) {
      try {
        const uploaded = await uploadAttachment(file)
        setAttachments((current) => [...current, uploaded])
      } catch (err) {
        setError(err instanceof Error ? err.message : t('composer.attachments.uploadFailed', { name: file.name }))
      } finally {
        setUploading((count) => count - 1)
      }
    }
  }

  const removeAttachment = (id: string) => {
    // Remove onscreen first: leftover server uploads are collected as orphans anyway.
    setAttachments((current) => current.filter((entry) => entry.id !== id))
    void discardAttachment(id).catch(() => {})
  }

  /**
   * Paste files, typically screenshots. Clipboards can contain both text and files: intercept only
   * when files actually exist or ordinary text pasting would break.
   */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return

    event.preventDefault()
    void addFiles(
      files.map((file) =>
        // Some browsers paste nameless files: the fallback prevents unlabeled attachments in both UI and agent input.
        file.name ? file : new File([file], defaultPastedName(file.type), { type: file.type }),
      ),
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Open lists capture navigation and confirmation first or Enter would send instead of insert.
    // Mutually exclusive tokens allow only one list at a time.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && (sessionToken || token || cardToken || sigil)) {
      event.preventDefault()
      dismissedSessionToken.current = { value: text, caret: event.currentTarget.selectionStart }
      setToken(null); setCardToken(null); setSessionToken(null); setSigil(null)
      return
    }
    const listed = sessionToken ? sessionSuggestions.length : sigil
      ? entries.length
      : cardToken
        ? cardSuggestions.length
        : suggestions.length
    if (listed > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((index) => (index + 1) % listed)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index - 1 + listed) % listed)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const session = sessionToken ? sessionSuggestions[active] : undefined
        if (session) { event.preventDefault(); pickSession(session); return }
        const entry = sigil ? entries[active] : undefined
        if (entry) {
          event.preventDefault()
          pickEntry(entry)
          return
        }
        const card = sigil ? undefined : cardSuggestions[active]
        if (cardToken && card) {
          event.preventDefault()
          pickCard(card)
          return
        }
        const file = sigil || cardToken ? undefined : suggestions[active]
        if (file) {
          event.preventDefault()
          pickMention(file)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setToken(null)
        setCardToken(null)
        setSigil(null)
        return
      }
    }

    // Enter sends; Shift+Enter inserts a newline. Mobile keyboards send ordinary newlines,
    // preserving multiline editing.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  const configFeedback = configError ? (
    <div role="alert" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-critical">
      <span>{t('composer.settings.saveError')} {configError}</span>
      <button type="button" onClick={onConfigRetry} className="min-h-11 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent">{t('composer.settings.retry')}</button>
    </div>
  ) : null

  const settingsProps = {
    groups,
    summary,
    pinned,
    onPinnedChange: setPinned,
    narrow,
    mcp: mcpPanel,
    feedback: configFeedback,
    disabled,
    inputRef: textarea,
  }

  const dictate = (
    <TooltipButton
      type="button"
      aria-label={dictation.state === 'recording' ? t('composer.dictate.stop') : t('composer.dictate.start')}
      title={dictation.state === 'recording' ? t('composer.dictate.stop') : t('composer.dictate.start')}
      disabled={disabled || dictation.state === 'transcribing'}
      onClick={() => {
        if (sttEnabled) void dictation.toggle()
        else setSttNotice(true)
      }}
      className={cx(
        toolButtonClass(narrow),
        dictation.state === 'recording' &&
          'animate-pulse bg-critical/12 text-critical hover:bg-critical/20 hover:text-critical',
      )}
    >
      {dictation.state === 'transcribing' ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
    </TooltipButton>
  )

  return (
    // The page owns the safe-area inset (pb-safe): adding another here would reserve it twice.
    <div className={cx('shrink-0', variant === 'thread' && 'px-3 pt-1 pb-6')}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
        // Container queries collapse settings according to composer width rather than window width,
        // which ignores the sidebar.
        className="@container mx-auto sg-conversation-width"
      >
        {error ? (
          <p role="alert" className="mb-1.5 px-1 text-xs text-critical">
            {error}
          </p>
        ) : null}

        {catalogError ? (
          <p className="mb-1.5 px-1 text-xs text-caution">{t('composer.catalog.unavailable')}</p>
        ) : null}

        {configFeedback}

        {/* One frame surrounds field and toolbar as a single object illuminated by input focus. */}
        <div className="surface flex flex-col gap-1 rounded-xl border border-line p-1.5 shadow-float">
          <AttachmentTray
            attachments={attachments}
            uploading={uploading}
            onRemove={removeAttachment}
          />

          {sessionToken && <SessionPicker sessions={sessionSuggestions} active={active} loading={searchingSessions} onPick={pickSession} onHover={setActive} />}

          {referencedIds.length > 0 && <div className="flex flex-wrap gap-1 px-2 py-1" aria-label={t('sessionRef.attached')}>
            {referencedIds.map(id => <SessionReference key={id} id={id} conversation={referenceSessions.get(id)} loading={searchingSessions} />)}
          </div>}

          {sigil ? (
            <TokenPicker
              sigil={sigil.sigil}
              entries={entries}
              active={active}
              label={sigil.sigil === '/' ? t('command.picker.aria') : t('skill.picker.aria')}
              emptyLabel={
                sigil.sigil === '/' ? t('command.picker.empty') : t('skill.picker.empty')
              }
              onPick={pickEntry}
              onHover={setActive}
            />
          ) : null}

          {cardToken ? (
            <CardPicker
              cards={cardSuggestions}
              active={active}
              loading={searchingCards}
              onPick={pickCard}
              onHover={setActive}
            />
          ) : null}

          {token ? (
            <MentionPicker
              files={suggestions}
              active={active}
              loading={searching}
              onPick={pickMention}
              onHover={setActive}
            />
          ) : null}

          {dictation.state === 'recording' && dictation.analyser ? (
            <DictationStrip analyser={dictation.analyser} onStop={() => void dictation.toggle()} />
          ) : null}

          {/* Hide rather than unmount during dictation to preserve cursor insertion position. */}
          <textarea
            ref={textarea}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              syncToken(event.target.value, event.target.selectionStart)
            }}
            // The cursor can enter or leave existing @ mentions without text changes: suggestions
            // follow cursor movement too.
            onSelect={(event) =>
              syncToken(event.currentTarget.value, event.currentTarget.selectionStart)
            }
            onBlur={() => {
              setToken(null)
              setCardToken(null)
              setSessionToken(null)
              setSigil(null)
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-controls={sessionToken ? 'session-suggestions' : undefined}
            aria-activedescendant={sessionToken && sessionSuggestions[active] ? `session-option-${active}` : undefined}
            rows={1}
            disabled={disabled}
            placeholder={disabled ? t('composer.placeholder.readonly') : t('composer.placeholder.write')}
            className={cx(
              'max-h-[200px] w-full resize-none bg-transparent px-2 py-2',
              'text-[0.9375rem] leading-relaxed text-ink outline-none',
              'placeholder:text-ink-faint disabled:opacity-60',
              variant === 'draft' && 'min-h-28',
              dictation.state === 'recording' && 'hidden',
            )}
          />

          <div ref={bar} className={cx('flex items-center gap-1', split && 'flex-wrap')}>
                        {/* Omit capture so iOS offers camera, library, and files instead of restricting selection. */}
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void addFiles(Array.from(event.target.files ?? []))
                // Reset so selecting the same file twice triggers a second change event.
                event.target.value = ''
              }}
            />
            {/* Pinned settings that no longer fit beside tools get a separate line above rather than squeezing values. */}
            <div ref={prefs}
              className={cx('flex min-w-0 items-center gap-1', split ? 'order-first basis-full flex-wrap border-b border-line pb-1' : 'order-2')}>
              <ComposerQuickSettings {...settingsProps} />
            </div>
            <div ref={lead} className="order-1 flex shrink-0 items-center gap-1">
              <TooltipButton type="button" aria-label={t('composer.attach.label')} title={t('composer.attach.label')}
                className={toolButtonClass(narrow)}
                disabled={disabled || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                onClick={() => filePicker.current?.click()}
              >
                <Paperclip size={16} />
              </TooltipButton>
              {narrow ? null : dictate}
              {narrow || split ? null : <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />}
            </div>
            <div ref={trail} className="order-3 ml-auto flex shrink-0 items-center gap-1">
              {mcp ? cloneElement(mcp, { narrow }) : null}
              <SkillsControl projectId={projectId} config={config} skills={skills} commands={commands} inputRef={textarea} narrow={narrow} />
              {context ? <span className="flex items-center px-1"><ContextMeter context={context} compact={narrow} /></span> : null}
              {narrow ? null : <ComposerSettingsButton {...settingsProps} />}
              {/* Both buttons coexist during turns: stop agents without losing typed messages, or send without stopping. */}
              {/*
               * Offer steering only during turns and for supporting CLIs: handle immediately rather
               * than queue until completion.
               */}
              {running && onSteer && canSend ? (
                <TooltipButton
                  type="button"
                  onClick={() => void submit(onSteer)}
                  aria-label={t('composer.steer.aria')}
                  title={t('composer.steer.hint')}
                  className={cx(
                    'flex shrink-0 items-center justify-center rounded-full',
                  narrow ? 'relative size-9 before:absolute before:-inset-1 before:content-[""]' : 'size-11 md:size-9 pointer-coarse:size-11',
                    'border border-accent text-accent transition-colors hover:bg-accent-wash',
                  )}
                >
                  <FastForward size={16} />
                </TooltipButton>
              ) : null}

              {running ? (
                <TooltipButton
                  type="button"
                  onClick={onInterrupt}
                  aria-label={t('composer.interrupt')}
                  title={t('composer.interrupt')}
                  className={cx(
                    'flex shrink-0 items-center justify-center rounded-full',
                  narrow ? 'relative size-9 before:absolute before:-inset-1 before:content-[""]' : 'size-11 md:size-9 pointer-coarse:size-11',
                    'border border-line bg-surface-high text-ink transition-colors hover:border-line-strong',
                  )}
                >
                  <Square size={13} fill="currentColor" />
                </TooltipButton>
              ) : null}

              {/* Phone microphone and send share space: dictate empty fields, send filled ones. */}
              {narrow && !canSend ? dictate : null}
              <TooltipButton
                type="submit"
                disabled={!canSend}
                aria-label={running ? t('composer.send.queue') : t('composer.send.aria')}
                title={running ? t('composer.send.queue.hint') : t('composer.send.aria')}
                className={cx(
                  'flex shrink-0 items-center justify-center rounded-full',
                  narrow ? 'relative size-9 before:absolute before:-inset-1 before:content-[""]' : 'size-11 md:size-9 pointer-coarse:size-11',
                  'gradient-accent text-accent-ink transition-[filter,opacity] hover:brightness-110',
                  'disabled:pointer-events-none disabled:opacity-35',
                  // During turns Stop stays primary: show queueing only when there is content to
                  // queue. On phones leave room for the microphone while input is empty.
                  (running || narrow) && !canSend && 'hidden',
                )}
              >
                <ArrowUp size={17} strokeWidth={2.5} />
              </TooltipButton>
            </div>
            <ConfirmDialog
              open={sttNotice}
              onOpenChange={setSttNotice}
              title={t('composer.dictate.unconfigured.title')}
              confirmLabel={t('composer.dictate.unconfigured.action')}
              onConfirm={() => navigate('/settings/dictee')}
            >
              <p>{t('composer.dictate.unconfigured.body')}</p>
            </ConfirmDialog>

          </div>
        </div>
      </form>

      <div className="mx-auto flex sg-conversation-width items-start gap-2">
        <ComposerInsert inputRef={textarea} disabled={disabled} project={Boolean(projectId)}
          commands={offered.length > 0} skills={skills.length > 0}
          combinedCommands={config.agent === 'claude' || config.agent === 'grok'} onInsert={insertPrefix} />
        {footer ? <div className="min-w-0 flex-1">{footer}</div> : null}
      </div>
    </div>
  )
}
