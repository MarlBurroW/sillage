import { ArrowUp, Brain, Compass, Paperclip, ShieldCheck, Square, Waypoints } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  CLI_DEFAULT,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentDto,
  DEFAULT_CLAUDE_CONFIG,
  type AgentConfig,
  type ClaudeConfig,
  type CodexApprovalName,
  type CodexConfig,
  type CodexMode,
  type ConversationStatus,
} from '@sillage/protocol'
import { codexEffortsFor, effortLevelsFor, useClaudeModels, useCodexModels } from '../../lib/agents'
import type { ContextState } from '../../lib/chat-fold'
import { useComposerReferences } from '../../lib/composer-ref'
import { ContextMeter } from './ContextMeter'
import { discardAttachment, uploadAttachment } from '../../lib/attachments'
import { useFileSuggestions, type FileMatchDto } from '../../lib/files'
import { IconButton, Select, cx, type SelectOption, type SelectTone } from '../ui'
import { AttachmentTray } from './AttachmentTray'
import { ComposerSettings, type ComposerControl } from './ComposerSettings'
import { MentionPicker } from './MentionPicker'

const EFFORT_LABELS: Record<ClaudeConfig['effort'], string> = {
  low: 'Faible',
  medium: 'Moyen',
  high: 'Élevé',
  xhigh: 'Très élevé',
  max: 'Maximal',
}

const PERMISSION_OPTIONS: SelectOption<ClaudeConfig['permissionMode']>[] = [
  { value: 'manual', label: 'Demander', hint: 'Chaque outil est soumis à ton accord' },
  { value: 'auto', label: 'Automatique', hint: 'Claude décide, demande en cas de doute' },
  { value: 'acceptEdits', label: 'Éditions acceptées', hint: 'Les écritures passent sans demande' },
  { value: 'plan', label: 'Plan', hint: 'Analyse seule, aucune modification' },
  { value: 'dontAsk', label: 'Ne pas demander', hint: 'Aucune demande, les refus sont muets' },
  {
    value: 'bypassPermissions',
    label: 'Tout autoriser',
    hint: 'Aucun garde-fou, à réserver aux dossiers sans risque',
  },
]

/**
 * Valeur d'affichage de la sentinelle `CLI_DEFAULT` dans le sélecteur d'approbation.
 * Laisser Codex appliquer sa propre politique est un état réel du protocole
 * (`approvalPolicy: null`), pas un trou : il mérite d'être nommé et sélectionnable.
 */
const CLI_DEFAULT_CHOICE = 'cli-default'

type ApprovalChoice = CodexApprovalName | typeof CLI_DEFAULT_CHOICE | 'granular'

/**
 * Vocabulaire natif de Codex, volontairement non aligné sur celui de Claude : les
 * deux CLI n'ont pas les mêmes concepts, et inventer une abstraction commune
 * mentirait sur ce qui se passe réellement.
 */
const CODEX_APPROVAL_OPTIONS: SelectOption<ApprovalChoice>[] = [
  {
    value: CLI_DEFAULT_CHOICE,
    label: 'Défaut du CLI',
    hint: 'La politique configurée dans Codex s\'applique',
  },
  { value: 'untrusted', label: 'Non fiable', hint: 'Seules les commandes sûres passent seules' },
  { value: 'on-request', label: 'Sur demande', hint: 'Codex demande quand il le juge utile' },
  { value: 'on-failure', label: 'Sur échec', hint: 'Déprécié par le CLI, conservé par le protocole' },
  { value: 'never', label: 'Jamais', hint: 'Aucune demande, les échecs remontent au modèle' },
]

const CODEX_SANDBOX_OPTIONS: SelectOption<CodexConfig['sandbox']>[] = [
  { value: 'read-only', label: 'Lecture seule', hint: 'Aucune écriture possible' },
  { value: 'workspace-write', label: 'Écriture workspace', hint: 'Écriture limitée au projet' },
  {
    value: 'danger-full-access',
    label: 'Accès total',
    hint: 'Aucun garde-fou, à réserver aux dossiers sans risque',
  },
]

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
  onSend,
  onInterrupt,
  onConfigChange,
  context,
  onSteer,
  initialText = '',
  projectId,
  worktreeId = null,
  footer,
}: ComposerProps) {
  const [text, setText] = useState(initialText)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<AttachmentDto[]>([])
  const [uploading, setUploading] = useState(0)
  const [token, setToken] = useState<MentionToken | null>(null)
  const [active, setActive] = useState(0)
  /**
   * Chemins réellement choisis dans la liste. Un `@quelquechose` tapé à la main n'en
   * fait pas partie : rien ne garantit qu'il désigne un fichier, et Codex refuse une
   * mention qui ne pointe nulle part. Claude, lui, développe de toute façon les `@`
   * du texte tout seul.
   */
  const [mentioned, setMentioned] = useState<Set<string>>(() => new Set())
  const textarea = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const { data: catalog, error: catalogError } = useClaudeModels()
  const { data: codexCatalog } = useCodexModels()

  const running = status === 'running' || status === 'awaiting_input'

  // Copies constantes de la configuration : TypeScript ne conserve pas l'affinement
  // d'un paramètre à l'intérieur des fonctions de rendu construites plus bas.
  const claude = config.agent === 'claude' ? config : null
  const codex = config.agent === 'codex' ? config : null

  const modelOptions = useMemo((): SelectOption<string>[] => {
    const known = (catalog?.models ?? []).map((model) => ({
      value: model.value,
      label: model.displayName,
      // `resolvedModel` donne la version réelle derrière un alias : sans elle,
      // « Opus » ne dit pas quelle génération va effectivement répondre.
      hint: model.resolvedModel
        ? `${model.description} · ${model.resolvedModel}`
        : model.description,
    }))

    // Le modèle enregistré doit rester sélectionnable même si le catalogue n'a pas pu
    // être lu, sinon le select s'affiche vide et efface le réglage de la conversation.
    if (config.agent === 'claude' && !known.some((option) => option.value === config.model)) {
      known.unshift({ value: config.model, label: config.model, hint: 'Réglage enregistré' })
    }
    return known
  }, [catalog, config])

  const effortOptions = useMemo((): SelectOption<ClaudeConfig['effort']>[] => {
    if (config.agent !== 'claude') return []
    return effortLevelsFor(catalog?.models, config.model).map((level) => ({
      value: level,
      label: EFFORT_LABELS[level],
      icon: <Brain size={13} />,
    }))
  }, [catalog, config])

  const codexModelOptions = useMemo((): SelectOption<string>[] => {
    const known = (codexCatalog?.models ?? []).map((model) => ({
      value: model.model,
      label: model.displayName,
      hint: model.isDefault ? `${model.description} · par défaut` : model.description,
    }))
    if (config.agent === 'codex' && !known.some((o) => o.value === config.model)) {
      known.unshift({ value: config.model, label: config.model, hint: 'Réglage enregistré' })
    }
    return known
  }, [codexCatalog, config])

  /**
   * Modes de collaboration annoncés par Codex. Le mode décide des outils accessibles
   * au modèle : en mode Plan, il peut poser des questions à choix, ce que le routeur
   * du CLI refuse autrement. La liste vient du CLI, donc elle disparaît si la version
   * installée ne la connaît pas.
   */
  const codexModeOptions = useMemo((): SelectOption<CodexMode>[] => {
    return (codexCatalog?.modes ?? []).map((entry) => ({
      value: entry.mode,
      label: entry.label,
      icon: <Compass size={13} />,
    }))
  }, [codexCatalog])

  const codexEffortOptions = useMemo((): SelectOption<string>[] => {
    if (config.agent !== 'codex') return []
    return codexEffortsFor(codexCatalog?.models, config.model).map((effort) => ({
      value: effort.value,
      label: effort.value,
      hint: effort.description,
      icon: <Brain size={13} />,
    }))
  }, [codexCatalog, config])

  // L'approbation peut être un objet granulaire, que Sillage n'édite pas : il est
  // alors affiché comme une option non modifiable plutôt que comme un select vide.
  const approval = config.agent === 'codex' ? config.askForApproval : CLI_DEFAULT
  const granular = typeof approval !== 'string'

  // Radix refuse une option de valeur vide : la sentinelle « le CLI décide » a donc
  // besoin d'une valeur d'affichage propre, traduite dans les deux sens ci-dessous.
  const approvalValue: ApprovalChoice = granular
    ? 'granular'
    : approval === CLI_DEFAULT
      ? CLI_DEFAULT_CHOICE
      : approval

  const approvalOptions: SelectOption<ApprovalChoice>[] = granular
    ? [
        { value: 'granular', label: 'Granulaire', hint: 'Défini hors de Sillage', disabled: true },
        ...CODEX_APPROVAL_OPTIONS,
      ]
    : CODEX_APPROVAL_OPTIONS

  /** Un effort inconnu du nouveau modèle ferait échouer le tour. */
  const clampCodexEffort = (model: string): string => {
    if (config.agent !== 'codex') return ''
    const levels = codexEffortsFor(codexCatalog?.models, model)
    if (levels.some((l) => l.value === config.reasoningEffort)) return config.reasoningEffort
    return codexCatalog?.models.find((m) => m.model === model)?.defaultReasoningEffort ?? ''
  }

  /**
   * Chaque modèle expose ses propres niveaux. Garder l'effort courant quand le nouveau
   * modèle ne le connaît pas ferait échouer son lancement côté CLI.
   */
  const clampEffort = (model: string): ClaudeConfig['effort'] => {
    const levels = effortLevelsFor(catalog?.models, model)
    if (config.agent !== 'claude' || levels.length === 0) return DEFAULT_CLAUDE_CONFIG.effort
    if (levels.includes(config.effort)) return config.effort
    return levels.includes('medium') ? 'medium' : (levels[0] ?? DEFAULT_CLAUDE_CONFIG.effort)
  }

  // Hauteur suivant le contenu, plafonnée : sur mobile, un champ qui pousse la
  // conversation hors de l'écran rend la saisie inutilisable.
  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

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
      setError(err instanceof Error ? err.message : "L'envoi a échoué.")
    } finally {
      setSending(false)
    }
  }

  const addFiles = async (chosen: File[]) => {
    if (chosen.length === 0) return
    setError(null)

    const room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length
    if (room <= 0) {
      setError(`Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} pièces jointes par message.`)
      return
    }

    const selected = chosen.slice(0, room)
    if (selected.length < chosen.length) {
      setError(`Seuls les ${room} premiers fichiers ont été retenus.`)
    }

    setUploading((count) => count + selected.length)
    for (const file of selected) {
      try {
        const uploaded = await uploadAttachment(file)
        setAttachments((current) => [...current, uploaded])
      } catch (err) {
        setError(err instanceof Error ? err.message : `Envoi de « ${file.name} » impossible.`)
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

  /**
   * Intitulé de la valeur en cours. Le repli sur la valeur brute couvre la sentinelle
   * `CLI_DEFAULT`, qui n'a pas d'option nommée dans les listes de modèles.
   */
  const labelOf = <T extends string>(options: SelectOption<T>[], value: T): string =>
    options.find((option) => option.value === value)?.label || value || 'Défaut'

  /** Réglages de la session, dans l'ordre où on les change. */
  const controls: ComposerControl[] = claude
    ? [
        {
          key: 'model',
          render: (variant) => (
            <Select
              variant={variant}
              label={variant === 'field' ? 'Modèle' : undefined}
              value={claude.model}
              onChange={(model) => onConfigChange({ ...claude, model, effort: clampEffort(model) })}
              options={modelOptions}
            />
          ),
          current: labelOf(modelOptions, claude.model),
        },
        // Absent plutôt que grisé quand le modèle n'a pas de niveaux d'effort : un
        // réglage sans effet n'a pas à occuper la barre.
        ...(effortOptions.length > 0
          ? [
              {
                key: 'effort',
                render: (variant: 'pill' | 'field') => (
                  <Select
                    variant={variant}
                    label={variant === 'field' ? 'Effort de réflexion' : undefined}
                    value={claude.effort}
                    onChange={(effort) => onConfigChange({ ...claude, effort })}
                    options={effortOptions}
                  />
                ),
                current: EFFORT_LABELS[claude.effort],
              },
            ]
          : []),
        {
          key: 'permission',
          render: (variant) => (
            <Select
              variant={variant}
              label={variant === 'field' ? 'Permissions' : undefined}
              tone={claude.permissionMode === 'bypassPermissions' ? 'caution' : 'neutral'}
              value={claude.permissionMode}
              onChange={(permissionMode) => onConfigChange({ ...claude, permissionMode })}
              options={PERMISSION_OPTIONS.map((option) => ({
                ...option,
                icon: <ShieldCheck size={13} />,
              }))}
            />
          ),
          current: labelOf(PERMISSION_OPTIONS, claude.permissionMode),
        },
      ]
    : codex
      ? [
          {
            key: 'model',
            render: (variant) => (
              <Select
                variant={variant}
                label={variant === 'field' ? 'Modèle' : undefined}
                value={codex.model}
                onChange={(model) =>
                  onConfigChange({ ...codex, model, reasoningEffort: clampCodexEffort(model) })
                }
                options={codexModelOptions}
              />
            ),
            current: labelOf(codexModelOptions, codex.model),
          },
          ...(codexModeOptions.length > 0
            ? [
                {
                  key: 'mode',
                  render: (variant: 'pill' | 'field') => (
                    <Select
                      variant={variant}
                      label={variant === 'field' ? 'Mode' : undefined}
                      value={codex.collaborationMode}
                      onChange={(collaborationMode) =>
                        onConfigChange({ ...codex, collaborationMode })
                      }
                      options={codexModeOptions}
                    />
                  ),
                  current: labelOf(codexModeOptions, codex.collaborationMode),
                },
              ]
            : []),
          ...(codexEffortOptions.length > 0
            ? [
                {
                  key: 'effort',
                  render: (variant: 'pill' | 'field') => (
                    <Select
                      variant={variant}
                      label={variant === 'field' ? 'Effort de réflexion' : undefined}
                      value={codex.reasoningEffort}
                      onChange={(reasoningEffort) => onConfigChange({ ...codex, reasoningEffort })}
                      options={codexEffortOptions}
                    />
                  ),
                  current: labelOf(codexEffortOptions, codex.reasoningEffort),
                },
              ]
            : []),
          {
            key: 'approval',
            render: (variant) => (
              <Select
                variant={variant}
                label={variant === 'field' ? 'Approbations' : undefined}
                tone={approval === 'never' ? 'caution' : 'neutral'}
                value={approvalValue}
                onChange={(choice) => {
                  // 'granular' n'est qu'un repère d'affichage, il n'est pas
                  // sélectionnable et ne doit jamais repartir vers le serveur.
                  if (choice === 'granular') return
                  onConfigChange({
                    ...codex,
                    askForApproval: choice === CLI_DEFAULT_CHOICE ? CLI_DEFAULT : choice,
                  })
                }}
                options={approvalOptions}
              />
            ),
            current: labelOf(approvalOptions, approvalValue),
          },
          {
            key: 'sandbox',
            render: (variant) => (
              <Select
                variant={variant}
                label={variant === 'field' ? 'Bac à sable' : undefined}
                tone={codex.sandbox === 'danger-full-access' ? 'caution' : 'neutral'}
                value={codex.sandbox}
                onChange={(sandbox) => onConfigChange({ ...codex, sandbox })}
                options={CODEX_SANDBOX_OPTIONS}
              />
            ),
            current: labelOf(CODEX_SANDBOX_OPTIONS, codex.sandbox),
          },
        ]
      : []

  /** Un garde-fou retiré doit rester visible même quand les réglages sont repliés. */
  const settingsTone: SelectTone =
    claude?.permissionMode === 'bypassPermissions' ||
    codex?.sandbox === 'danger-full-access' ||
    approval === 'never'
      ? 'caution'
      : 'neutral'

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
          <p className="mb-1.5 px-1 text-xs text-caution">
            Liste des modèles indisponible, le réglage enregistré est conservé.
          </p>
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
            placeholder={disabled ? 'Conversation en lecture seule' : 'Écris ton message...'}
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
              label="Joindre un fichier"
              size="sm"
              disabled={disabled || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              onClick={() => filePicker.current?.click()}
            >
              <Paperclip size={16} />
            </IconButton>

            <ComposerSettings controls={controls} tone={settingsTone} />

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
                aria-label="Infléchir le tour en cours"
                title="Pris en compte tout de suite, sans attendre la fin du tour"
                className={cx(
                  'flex size-9 shrink-0 items-center justify-center rounded-full',
                  'border border-accent text-accent transition-colors hover:bg-accent-wash',
                )}
              >
                <Waypoints size={16} />
              </button>
            ) : null}

            {running ? (
              <button
                type="button"
                onClick={onInterrupt}
                aria-label="Interrompre l'agent"
                title="Interrompre l'agent"
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
              aria-label={running ? 'Mettre le message en file' : 'Envoyer le message'}
              title={running ? "Sera envoyé à la fin du tour en cours" : 'Envoyer le message'}
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
