import { ArrowUp, FastForward, Paperclip, Square } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AgentConfig,
  type AttachmentDto,
  type ConversationStatus,
  type McpServerStatus,
} from '@sillage/protocol'
import type { ContextState } from '../../lib/chat-fold'
import { readDraft, saveDraft } from '../../lib/composer-drafts'
import { useComposerDrops, useComposerReferences } from '../../lib/composer-ref'
import { ContextMeter } from './ContextMeter'
import { discardAttachment, uploadAttachment } from '../../lib/attachments'
import { useFileSuggestions, type FileMatchDto } from '../../lib/files'
import { useTranslate } from '../../lib/i18n'
import { IconButton, cx } from '../ui'
import { AttachmentTray } from './AttachmentTray'
import { useAgentSettings } from './agent-settings'
import { ComposerSettings } from './ComposerSettings'
import { MentionPicker } from './MentionPicker'

/** Le `@...` en cours de saisie, repéré autour du curseur. */
interface MentionToken {
  query: string
  /** Position du `@` lui-même, pour remplacer le jeton entier à la sélection. */
  start: number
  end: number
}

/**
 * Mention dans laquelle se trouve le curseur, ou null.
 *
 * Le `@` doit ouvrir un mot : sans cette contrainte, une adresse de courriel ou un
 * identifiant collé déclencherait la liste des fichiers en plein milieu d'un mot.
 */
function mentionAt(value: string, caret: number): MentionToken | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret))
  if (!match) return null
  const query = match[1] ?? ''
  return { query, start: caret - query.length - 1, end: caret }
}

/** Nom de repli pour un fichier collé qui n'en porte pas. */
function defaultPastedName(mimeType: string): string {
  const extension = mimeType.split('/')[1]?.split('+')[0] ?? 'bin'
  return `collage.${extension}`
}

/** Au-delà, le champ défile au lieu de manger la conversation. */
const MAX_TEXTAREA_PX = 200

interface ComposerProps {
  config: AgentConfig
  status: ConversationStatus
  disabled: boolean
  /** Inventaire MCP de la session, pour dire ce qui est réellement chargé. */
  mcpInventory: McpServerStatus[]
  /**
   * Configuration sous laquelle le CLI tourne, `null` à froid. Ce qui y diffère de
   * `config` est un réglage choisi qui attend le redémarrage de la session.
   */
  appliedConfig?: AgentConfig | null
  onSend(text: string, attachmentIds: string[], mentions: string[]): Promise<void>
  onInterrupt(): void
  onConfigChange(config: AgentConfig): void
  /** Occupation de la fenêtre de contexte, absente tant qu'aucun tour n'a eu lieu. */
  context?: ContextState | null
  /**
   * Infléchit le tour en cours, là où le CLI le permet.
   *
   * Absent sinon : le bouton ne s'affiche pas plutôt que d'être proposé puis refusé.
   */
  onSteer?(text: string, attachmentIds: string[], mentions: string[]): Promise<void>
  /**
   * Contenu de départ du champ.
   *
   * Utilisé après un fork : la branche s'ouvre avec le message qu'on vient de couper,
   * prêt à être reformulé. Lu une seule fois, le composant étant remonté par sa clé
   * quand la conversation change.
   */
  initialText?: string
  /**
   * Identité du brouillon conservé entre deux montages.
   *
   * L'identifiant de la conversation, ou celui du projet pour un fil pas encore créé :
   * ce qui est en train d'être écrit doit revenir à l'endroit où on l'a laissé, et pas
   * ailleurs.
   */
  draftKey: string
  /** Projet et worktree consultés pour compléter les mentions `@`. */
  projectId?: string
  worktreeId?: string | null
  /**
   * Bande d'état affichée juste sous le champ.
   *
   * Rendue ici plutôt qu'à côté par l'appelant : la marge basse est la même quel que
   * soit ce qui suit, et la répartir entre deux composants revenait à ce que personne
   * ne la possède, avec le texte collé au bord pour résultat.
   */
  footer?: ReactNode
}

export function Composer({
  config,
  status,
  disabled,
  mcpInventory,
  appliedConfig = null,
  onSend,
  onInterrupt,
  onConfigChange,
  context,
  onSteer,
  initialText = '',
  draftKey,
  projectId,
  worktreeId = null,
  footer,
}: ComposerProps) {
  const t = useTranslate()
  // `t` lui-même ne change jamais de référence : c'est la langue qu'il faut suivre
  // pour recalculer les options mémoïsées qui l'appellent.
  // Lu une seule fois au montage : à partir de là c'est l'état local qui fait foi, et
  // c'est lui qui réalimente le brouillon.
  const [restored] = useState(() => readDraft(draftKey))
  const [text, setText] = useState(restored.text || initialText)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<AttachmentDto[]>(restored.attachments)
  const [uploading, setUploading] = useState(0)
  const [token, setToken] = useState<MentionToken | null>(null)
  const [active, setActive] = useState(0)
  /**
   * Chemins réellement choisis dans la liste. Un `@quelquechose` tapé à la main n'en
   * fait pas partie : rien ne garantit qu'il désigne un fichier, et Codex refuse une
   * mention qui ne pointe nulle part. Claude, lui, développe de toute façon les `@`
   * du texte tout seul.
   */
  const [mentioned, setMentioned] = useState<Set<string>>(() => new Set(restored.mentions))
  const textarea = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)

  const running = status === 'running' || status === 'awaiting_input'
  const { groups, summary, mcp, catalogError } = useAgentSettings({
    config,
    onConfigChange,
    appliedConfig,
    mcpInventory,
    disabled,
  })

  // Hauteur suivant le contenu, plafonnée : sur mobile, un champ qui pousse la
  // conversation hors de l'écran rend la saisie inutilisable.
  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

  // Le brouillon suit la saisie plutôt que le démontage : un composant démonté par un
  // changement de route ne peut plus lire son état au moment où il disparaît.
  useEffect(() => {
    saveDraft(draftKey, { text, attachments, mentions: [...mentioned] })
  }, [draftKey, text, attachments, mentioned])

  const { data: files, isFetching: searching } = useFileSuggestions(
    projectId,
    worktreeId,
    token?.query ?? null,
  )
  const suggestions = token ? (files ?? []) : []

  /** Remplace le jeton en cours par le chemin choisi, puis rend la main au champ. */
  const pickMention = (file: FileMatchDto) => {
    const node = textarea.current
    if (!token || !node) return

    const next = `${text.slice(0, token.start)}@${file.path} ${text.slice(token.end)}`
    const caret = token.start + file.path.length + 2

    setText(next)
    setMentioned((current) => new Set(current).add(file.path))
    setToken(null)
    // Après le rendu : replacer le curseur avant que React ait réécrit la valeur le
    // ferait sauter en fin de champ.
    requestAnimationFrame(() => {
      node.focus()
      node.setSelectionRange(caret, caret)
    })
  }

  /**
   * Fichier référencé depuis l'explorateur.
   *
   * Ajouté en fin de texte et non au curseur : le geste part de l'autre colonne de la
   * page, où le champ n'a pas le focus et où sa position d'insertion n'a plus de sens.
   * Le chemin rejoint aussi les mentions retenues, comme s'il avait été choisi dans la
   * liste : c'est bien un fichier du répertoire de travail, et Codex refuse une mention
   * qui ne pointe nulle part.
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

  // Le dépôt vise le fil, pas le champ : c'est ici que les fichiers atterrissent, avec
  // les mêmes bornes et les mêmes erreurs qu'un collage ou qu'un choix au sélecteur.
  useComposerDrops((files) => {
    if (disabled) return
    void addFiles(files)
    textarea.current?.focus()
  })

  const syncToken = (value: string, caret: number | null) => {
    setToken(mentionAt(value, caret ?? value.length))
    setActive(0)
  }

  // Envoyer reste possible pendant un tour : le serveur met alors le message en file
  // et l'affiche sous l'indicateur d'activité, plutôt que de refuser la saisie.
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !sending && !disabled

  /**
   * Envoie le contenu du champ par l'action donnée.
   *
   * Le champ est vidé d'abord, quel que soit le geste : le message réapparaîtra par le
   * journal, seule source d'affichage du fil. En cas d'échec il est rendu tel quel,
   * pièces jointes et mentions comprises, avec la cause affichée.
   */
  const submit = async (
    action: (text: string, attachmentIds: string[], mentions: string[]) => Promise<void>,
  ) => {
    if (!canSend) return

    const value = text.trim()
    const sent = attachments
    // Une mention effacée du texte depuis sa sélection ne doit plus partir.
    const paths = [...mentioned].filter((path) => value.includes(`@${path}`))

    setSending(true)
    setError(null)
    setText('')
    setAttachments([])
    setMentioned(new Set())
    setToken(null)
    try {
      await action(
        value,
        sent.map((attachment) => attachment.id),
        paths,
      )
    } catch (err) {
      // Un envoi qui échoue en silence donne un bouton mort : le contenu est rendu et
      // la cause affichée, quelle qu'elle soit.
      setText(value)
      setAttachments(sent)
      setMentioned(new Set(paths))
      setError(err instanceof Error ? err.message : t('composer.send.failed'))
    } finally {
      setSending(false)
    }
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
    // Retiré de l'écran d'abord : le fichier téléversé qui subsisterait côté serveur
    // est de toute façon ramassé comme orphelin.
    setAttachments((current) => current.filter((entry) => entry.id !== id))
    void discardAttachment(id).catch(() => {})
  }

  /**
   * Collage d'un fichier, typiquement une capture d'écran.
   *
   * Le presse-papiers peut porter du texte et des fichiers en même temps : on ne
   * détourne le collage que s'il contient réellement des fichiers, sinon coller du
   * texte cesserait de fonctionner.
   */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return

    event.preventDefault()
    void addFiles(
      files.map((file) =>
        // Certains navigateurs collent un fichier sans nom : sans ce repli, la
        // pièce jointe s'afficherait et partirait à l'agent sans intitulé.
        file.name ? file : new File([file], defaultPastedName(file.type), { type: file.type }),
      ),
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // La liste des mentions capte d'abord les touches de navigation et de validation :
    // sinon Entrée enverrait le message au lieu d'insérer le fichier sélectionné.
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((index) => (index + 1) % suggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const file = suggestions[active]
        if (file) {
          event.preventDefault()
          pickMention(file)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setToken(null)
        return
      }
    }

    // Entrée envoie, Maj+Entrée passe à la ligne. Sur mobile le clavier virtuel
    // envoie un retour à la ligne classique, donc la saisie multiligne reste possible.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit(onSend)
    }
  }

  return (
    // L'encoche est portée par la page (`pb-safe`), pas ici : deux `env()` empilés
    // creuseraient un vide de deux encoches.
    <div className="shrink-0 px-3 pt-1 pb-6">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit(onSend)
        }}
        // `@container` : les réglages se replient selon la largeur du composer, pas
        // celle de la fenêtre, qui ignore la sidebar.
        className="@container mx-auto max-w-3xl"
      >
        {error ? (
          <p role="alert" className="mb-1.5 px-1 text-xs text-critical">
            {error}
          </p>
        ) : null}

        {catalogError ? (
          <p className="mb-1.5 px-1 text-xs text-caution">{t('composer.catalog.unavailable')}</p>
        ) : null}

        {/* Un seul bloc porte le cadre : le champ et sa barre d'outils forment un
            objet unique, qui s'illumine quand la saisie a le focus. */}
        <div className="surface flex flex-col gap-1 rounded-xl border border-line p-1.5 shadow-float">
          <AttachmentTray
            attachments={attachments}
            uploading={uploading}
            onRemove={removeAttachment}
          />

          {token ? (
            <MentionPicker
              files={suggestions}
              active={active}
              loading={searching}
              onPick={pickMention}
              onHover={setActive}
            />
          ) : null}

          <textarea
            ref={textarea}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              syncToken(event.target.value, event.target.selectionStart)
            }}
            // Le curseur peut entrer dans un `@` déjà écrit, ou en sortir, sans que le
            // texte change : la liste doit suivre le curseur, pas seulement la frappe.
            onSelect={(event) =>
              syncToken(event.currentTarget.value, event.currentTarget.selectionStart)
            }
            onBlur={() => setToken(null)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            disabled={disabled}
            placeholder={disabled ? t('composer.placeholder.readonly') : t('composer.placeholder.write')}
            className={cx(
              'max-h-[200px] w-full resize-none bg-transparent px-2 py-2',
              'text-[0.9375rem] leading-relaxed text-ink outline-none',
              'placeholder:text-ink-faint disabled:opacity-60',
            )}
          />

          <div className="flex items-center gap-1.5">
            {/* Pas de `capture` : iOS propose alors lui-même l'appareil photo, la
                photothèque et les fichiers, ce qu'un `capture` forcé interdirait. */}
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void addFiles(Array.from(event.target.files ?? []))
                // Réinitialisé pour que rejoindre deux fois le même fichier
                // déclenche bien un second `change`.
                event.target.value = ''
              }}
            />
            <IconButton
              label={t('composer.attach.label')}
              size="sm"
              disabled={disabled || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              onClick={() => filePicker.current?.click()}
            >
              <Paperclip size={16} />
            </IconButton>

            <ComposerSettings
              groups={groups}
              summary={summary}
              aside={mcp}
              disabled={disabled}
              onDone={() => textarea.current?.focus()}
            />

            {context ? <ContextMeter context={context} /> : null}

            {/* Les deux boutons coexistent pendant un tour : on doit pouvoir arrêter
                l'agent sans perdre le message qu'on vient de taper, et l'envoyer sans
                avoir à l'arrêter. */}
            {/* Infléchir n'est proposé que pendant un tour, et seulement là où le CLI
                sait le faire : le message est pris en compte immédiatement, au lieu
                d'attendre la fin comme le fait la file. */}
            {running && onSteer && canSend ? (
              <button
                type="button"
                onClick={() => void submit(onSteer)}
                aria-label={t('composer.steer.aria')}
                title={t('composer.steer.hint')}
                className={cx(
                  'flex size-9 shrink-0 items-center justify-center rounded-full',
                  'border border-accent text-accent transition-colors hover:bg-accent-wash',
                )}
              >
                <FastForward size={16} />
              </button>
            ) : null}

            {running ? (
              <button
                type="button"
                onClick={onInterrupt}
                aria-label={t('composer.interrupt')}
                title={t('composer.interrupt')}
                className={cx(
                  'flex size-9 shrink-0 items-center justify-center rounded-full',
                  'border border-line bg-surface-high text-ink transition-colors hover:border-line-strong',
                )}
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : null}

            <button
              type="submit"
              disabled={!canSend}
              aria-label={running ? t('composer.send.queue') : t('composer.send.aria')}
              title={running ? t('composer.send.queue.hint') : t('composer.send.aria')}
              className={cx(
                'flex size-9 shrink-0 items-center justify-center rounded-full',
                'gradient-accent text-accent-ink transition-[filter,opacity] hover:brightness-110',
                'disabled:pointer-events-none disabled:opacity-35',
                // Pendant un tour, le bouton d'arrêt reste l'action principale : celui-ci
                // ne s'affiche que s'il y a réellement quelque chose à mettre en file.
                running && !canSend && 'hidden',
              )}
            >
              <ArrowUp size={17} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </form>

      {footer}
    </div>
  )
}
