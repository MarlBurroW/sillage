import {
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CornerDownRight,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  ListTodo,
  Loader,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import { isSpawnTool } from '@sillage/protocol'
import type { ToolItem } from '../../lib/chat-fold'
import { languageFromPath } from '../../lib/highlight'
import { useTranslate } from '../../lib/i18n'
import { showSubAgent } from '../../lib/panel'
import { readableView } from '../tools/registry'
import { cx } from '../ui'
import { HighlightedCode } from './HighlightedCode'

/**
 * Rendu d'un appel d'outil, et d'une suite d'appels repliée derrière une ligne.
 *
 * Les deux vivent dans le même module parce qu'un groupe déplié rend des appels :
 * les séparer donnerait un cycle d'imports pour rien.
 */

/** Icône par outil. Le rendu détaillé, lui, passe par le registre de vues (`tools/`). */
const TOOL_ICONS: Record<string, ReactNode> = {
  Bash: <SquareTerminal size={14} />,
  Read: <FileText size={14} />,
  Write: <Pencil size={14} />,
  Edit: <Pencil size={14} />,
  Glob: <FolderSearch size={14} />,
  Grep: <Search size={14} />,
  WebFetch: <Globe size={14} />,
  WebSearch: <Globe size={14} />,
  TodoWrite: <ListTodo size={14} />,
  Task: <Bot size={14} />,
  Agent: <Bot size={14} />,
  ExitPlanMode: <ListChecks size={14} />,
}

/** `mono` distingue un fragment de code d'une phrase : les deux ne se lisent pas pareil. */
interface ToolSummary {
  text: string
  mono: boolean
}

/**
 * Résumé d'une ligne.
 *
 * La description passe avant tout le reste : elle dit ce que l'appel cherche à faire,
 * là où la commande ou le chemin ne disent que comment. Claude Code en joint une à ses
 * appels `Bash` et à ses sous-agents, et elle vaut mieux qu'un `sed -n '334,364p'`
 * tronqué au milieu. Elle n'est pas garantie pour autant : Codex n'en produit aucune,
 * et le repli sur le paramètre identifiant reprend alors la main.
 *
 * La commande, elle, ne disparaît pas : elle reste sous l'entrée de l'appel déplié.
 */
function summarize(name: string, input: unknown): ToolSummary | null {
  if (typeof input !== 'object' || input === null) return null
  const fields = input as Record<string, unknown>

  const description = fields.description
  if (typeof description === 'string' && description.length > 0) {
    return { text: description, mono: false }
  }

  const candidates =
    name === 'Bash'
      ? ['command']
      : name === 'WebFetch' || name === 'WebSearch'
        ? ['url', 'query']
        : ['file_path', 'path', 'pattern', 'prompt']

  for (const key of candidates) {
    const value = fields[key]
    if (typeof value === 'string' && value.length > 0) return { text: value, mono: true }
  }
  return null
}

/**
 * L'issue d'un appel, en une icône.
 *
 * « Interrompu » n'est pas un échec : l'appel n'a simplement jamais rendu sa réponse,
 * le CLI ayant été coupé. Le confondre avec une erreur ferait chercher une cause qui
 * n'existe pas.
 */
export function ToolStatusIcon({ status }: { status: ToolItem['status'] }) {
  if (status === 'running') return <Loader size={13} className="shrink-0 animate-spin text-accent" />
  if (status === 'failed') return <CircleAlert size={13} className="shrink-0 text-critical" />
  if (status === 'interrupted') return <CircleSlash size={13} className="shrink-0 text-ink-faint" />
  return <CircleCheck size={13} className="shrink-0 text-positive" />
}

/**
 * Une durée, à la précision qu'elle mérite.
 *
 * Les minutes sont nommées plutôt que comptées en secondes : un sous-agent tourne
 * couramment plusieurs minutes, et « 185.0 s » demande une conversion mentale à
 * chaque coup d'œil.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`

  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`
}

/** Langage du fichier que l'appel déclare, quand il en déclare un. */
function languageOfInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  const path = fields.file_path ?? fields.path
  return typeof path === 'string' ? languageFromPath(path) : ''
}

/**
 * Un payload d'outil, avec le langage à lui appliquer.
 *
 * La sortie est tantôt du JSON, tantôt du texte : le contenu d'un fichier, la sortie
 * d'une commande. Colorer une sortie de commande comme du JSON la rendrait illisible,
 * donc `fallback` ne sert qu'aux chaînes, et seulement quand l'appel dit de quel
 * fichier elles viennent.
 */
function asPayload(value: unknown, fallback = ''): { content: string; language: string } {
  if (value === null || value === undefined) return { content: '', language: '' }
  if (typeof value === 'string') return { content: value, language: fallback }
  return { content: JSON.stringify(value, null, 2), language: 'json' }
}

export const ToolCall = memo(function ToolCall({ tool }: { tool: ToolItem }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState(false)
  const summary = summarize(tool.name, tool.input)
  const readable = open ? readableView(tool) : null

  return (
    <div
      className={cx(
        'rounded-md border bg-surface/60 text-sm',
        tool.status === 'failed' ? 'border-critical/40' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <ChevronRight
          size={14}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <span className="shrink-0 text-ink-faint">
          {TOOL_ICONS[tool.name] ?? <Wrench size={14} />}
        </span>
        <span className="shrink-0 font-medium text-ink">{tool.name}</span>
        {summary ? (
          <span
            className={cx('min-w-0 flex-1 truncate text-xs text-ink-faint', summary.mono && 'font-mono')}
            title={summary.text}
          >
            {summary.text}
          </span>
        ) : (
          <span className="flex-1" />
        )}

        <ToolStatusIcon status={tool.status} />
        {tool.durationMs !== null ? (
          <span className="shrink-0 text-[0.6875rem] text-ink-faint">
            {formatDuration(tool.durationMs)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-line px-2.5 py-2">
          {readable ? <ViewSwitch raw={raw} onChange={setRaw} /> : null}

          {readable && !raw ? (
            readable
          ) : (
            <>
              <Payload label={t('toolcall.payload.input')} {...asPayload(tool.input)} />
              {tool.status !== 'running' ? (
                <Payload
                  label={t('toolcall.payload.output')}
                  {...asPayload(tool.output, languageOfInput(tool.input))}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* Le fil du sous-agent est ailleurs, dans le panneau : sans ce passage, la
          seule façon d'y arriver serait de le retrouver dans une liste. */}
      {isSpawnTool(tool.name) ? (
        <button
          type="button"
          onClick={() => showSubAgent(tool.id)}
          className={cx(
            'flex w-full items-center gap-1.5 border-t border-line px-2.5 py-1.5',
            'text-left text-[0.6875rem] text-ink-faint hover:text-accent',
          )}
        >
          <CornerDownRight size={11} className="shrink-0" />
          {t('toolcall.subagent.view')}
        </button>
      ) : null}
    </div>
  )
})

/**
 * Bascule entre la vue lisible et le payload natif.
 *
 * Le brut n'est pas un mode dégradé qu'on cacherait : c'est ce que le CLI a réellement
 * envoyé, et la seule façon de vérifier qu'une vue ne ment pas ou de retrouver un champ
 * qu'elle a jugé secondaire. Il reste donc à un clic, sur chaque appel.
 */
function ViewSwitch({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }) {
  const t = useTranslate()
  return (
    <div className="flex w-fit gap-0.5 rounded-md border border-line bg-sunken p-0.5">
      {[
        { label: t('toolcall.view.readable'), value: false },
        { label: t('toolcall.view.raw'), value: true },
      ].map((mode) => (
        <button
          key={mode.label}
          type="button"
          onClick={() => onChange(mode.value)}
          aria-pressed={raw === mode.value}
          className={cx(
            'rounded px-2 py-0.5 text-[0.6875rem]',
            raw === mode.value ? 'bg-surface-high text-ink' : 'text-ink-faint hover:text-ink',
          )}
        >
          {mode.label}
        </button>
      ))}
    </div>
  )
}

function Payload({
  label,
  content,
  language,
}: {
  label: string
  content: string
  language: string
}) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.6875rem] font-medium tracking-wide text-ink-faint uppercase">
        {label}
      </span>
      {content ? (
        <HighlightedCode
          code={content}
          language={language}
          wrap
          className="max-h-80 overflow-auto rounded-md border border-line bg-sunken p-2 font-mono text-xs"
        />
      ) : (
        <p className="rounded-md border border-line bg-sunken p-2 font-mono text-xs text-ink-faint">
          {t('toolcall.payload.empty')}
        </p>
      )}
    </div>
  )
}

/** Au-delà, l'énumération des noms d'outils déborde de la ligne. */
const NAMES_SHOWN = 3

function summarizeNames(tools: ToolItem[]): string {
  const names = [...new Set(tools.map((tool) => tool.name))]
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  return names.length > NAMES_SHOWN ? `${shown}, +${names.length - NAMES_SHOWN}` : shown
}

/**
 * Suite d'appels d'outils terminés, repliée derrière une ligne.
 *
 * Les échecs sont comptés dans l'en-tête : replier ne doit jamais faire disparaître
 * une erreur du champ de vision.
 *
 * La comparaison porte sur le contenu du tableau, pas sur son identité : `buildRows`
 * regroupe à chaque appel, donc à chaque lot de deltas, et rend un tableau neuf pour
 * des appels inchangés. Comparé par référence, le `memo` ratait toujours et chaque
 * groupe du fil se redessinait seize fois par seconde pendant un tour.
 */
const ToolCallGroupInner = function ToolCallGroup({ tools }: { tools: ToolItem[] }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)

  const failed = tools.filter((tool) => tool.status === 'failed').length
  const total = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0)

  return (
    <div className="rounded-md border border-line bg-surface/60 text-sm">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <ChevronRight
          size={14}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <Wrench size={14} className="shrink-0 text-ink-faint" />
        <span className="shrink-0 font-medium text-ink">
          {t(
            tools.length > 1 ? 'toolcall.group.count.other' : 'toolcall.group.count.one',
            { count: tools.length },
          )}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-faint">
          {summarizeNames(tools)}
        </span>

        {failed > 0 ? (
          <span className="shrink-0 text-[0.6875rem] font-medium text-critical">
            {t(
              failed > 1 ? 'toolcall.group.failed.other' : 'toolcall.group.failed.one',
              { count: failed },
            )}
          </span>
        ) : null}
        {total > 0 ? (
          <span className="shrink-0 text-[0.6875rem] text-ink-faint">{formatDuration(total)}</span>
        ) : null}
      </button>

      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-line p-1.5">
          {tools.map((tool) => (
            <ToolCall key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export const ToolCallGroup = memo(
  ToolCallGroupInner,
  (prev, next) =>
    prev.tools.length === next.tools.length &&
    // Le fold remplace l'objet d'un appel qui change : la comparaison par référence
    // sur chaque élément est donc exacte, sans avoir à comparer champ par champ.
    prev.tools.every((tool, index) => tool === next.tools[index]),
)
