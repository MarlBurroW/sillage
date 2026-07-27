import {
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
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
import { languageFromPath } from '../../lib/highlight'
import { isSettled, type ToolNode } from '../../lib/tool-rows'
import { readableView } from '../tools/registry'
import { cx } from '../ui'
import { HighlightedCode } from './HighlightedCode'

/**
 * Rendu de l'arbre d'appels d'outils : un appel, et la suite d'appels repliée.
 *
 * Les deux vivent dans le même module parce qu'ils se rendent mutuellement, un groupe
 * contenant des appels et un appel repliant en groupe ce que son sous-agent a produit.
 * Les séparer donnerait un cycle d'imports pour rien.
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

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
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

export const ToolCall = memo(function ToolCall({ node }: { node: ToolNode }) {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState(false)
  const tool = node.tool
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

        {tool.status === 'running' ? (
          <Loader size={13} className="shrink-0 animate-spin text-accent" />
        ) : tool.status === 'failed' ? (
          <CircleAlert size={13} className="shrink-0 text-critical" />
        ) : (
          <CircleCheck size={13} className="shrink-0 text-positive" />
        )}
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
              <Payload label="Entrée" {...asPayload(tool.input)} />
              {tool.status !== 'running' ? (
                <Payload label="Sortie" {...asPayload(tool.output, languageOfInput(tool.input))} />
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* Les appels du sous-agent vivent dans la carte de l'outil qui l'a lancé :
          l'appartenance est visible, y compris quand deux sous-agents tournent en
          parallèle et que leurs appels s'entremêlent dans le journal. */}
      {node.children.length > 0 ? (
        <div className="border-t border-line px-2 py-2">
          <SubAgentCalls nodes={node.children} />
        </div>
      ) : null}
    </div>
  )
})

/**
 * Appels produits par un sous-agent.
 *
 * Même règle qu'au premier niveau : tant qu'un appel tourne la liste reste dépliée,
 * c'est le moment où on veut la voir ; une fois tout terminé elle se replie derrière
 * son décompte. Un sous-agent en produit couramment vingt, qui repoussaient sa
 * conclusion hors de l'écran.
 *
 * Le basculement se fait par changement de composant plutôt que par un état qui
 * s'inverserait tout seul : le repliement mémorise ainsi une décision de
 * l'utilisateur, jamais l'avancement du tour.
 */
function SubAgentCalls({ nodes }: { nodes: ToolNode[] }) {
  const label = `${nodes.length} appel${nodes.length > 1 ? 's' : ''} du sous-agent`

  if (nodes.every(isSettled)) return <ToolCallGroup nodes={nodes} label={label} />

  return (
    <>
      <p className="mb-1.5 flex items-center gap-1.5 text-[0.6875rem] text-ink-faint">
        <CornerDownRight size={11} className="shrink-0" />
        {label}
      </p>
      <div className="flex flex-col gap-1.5 border-l-2 border-accent-wash pl-2">
        {nodes.map((child) => (
          <ToolCall key={child.tool.id} node={child} />
        ))}
      </div>
    </>
  )
}

/**
 * Bascule entre la vue lisible et le payload natif.
 *
 * Le brut n'est pas un mode dégradé qu'on cacherait : c'est ce que le CLI a réellement
 * envoyé, et la seule façon de vérifier qu'une vue ne ment pas ou de retrouver un champ
 * qu'elle a jugé secondaire. Il reste donc à un clic, sur chaque appel.
 */
function ViewSwitch({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }) {
  return (
    <div className="flex w-fit gap-0.5 rounded-md border border-line bg-sunken p-0.5">
      {[
        { label: 'Lisible', value: false },
        { label: 'Brut', value: true },
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
          (vide)
        </p>
      )}
    </div>
  )
}

/** Au-delà, l'énumération des noms d'outils déborde de la ligne. */
const NAMES_SHOWN = 3

/** Parcourt un appel et tout ce que ses sous-agents ont déclenché. */
function flatten(nodes: ToolNode[]): ToolNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

function summarizeNames(nodes: ToolNode[]): string {
  const names = [...new Set(nodes.map((node) => node.tool.name))]
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  return names.length > NAMES_SHOWN ? `${shown}, +${names.length - NAMES_SHOWN}` : shown
}

/**
 * Suite d'appels d'outils terminés, repliée derrière une ligne.
 *
 * Les échecs sont comptés dans l'en-tête, sous-agents compris : replier ne doit
 * jamais faire disparaître une erreur du champ de vision.
 */
export const ToolCallGroup = memo(function ToolCallGroup({
  nodes,
  label,
}: {
  nodes: ToolNode[]
  /** Remplace le décompte d'outils quand la suite a une provenance à nommer. */
  label?: string
}) {
  const [open, setOpen] = useState(false)

  const all = flatten(nodes)
  const failed = all.filter((node) => node.tool.status === 'failed').length
  // Somme des seules racines : la durée d'un `Agent` couvre déjà celle de ses appels.
  const total = nodes.reduce((sum, node) => sum + (node.tool.durationMs ?? 0), 0)

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
        {label ? (
          <CornerDownRight size={13} className="shrink-0 text-ink-faint" />
        ) : (
          <Wrench size={14} className="shrink-0 text-ink-faint" />
        )}
        <span className="shrink-0 font-medium text-ink">{label ?? `${all.length} outils`}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-faint">
          {summarizeNames(all)}
        </span>

        {failed > 0 ? (
          <span className="shrink-0 text-[0.6875rem] font-medium text-critical">
            {failed} échec{failed > 1 ? 's' : ''}
          </span>
        ) : null}
        {total > 0 ? (
          <span className="shrink-0 text-[0.6875rem] text-ink-faint">{formatDuration(total)}</span>
        ) : null}
      </button>

      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-line p-1.5">
          {nodes.map((node) => (
            <ToolCall key={node.tool.id} node={node} />
          ))}
        </div>
      ) : null}
    </div>
  )
})
