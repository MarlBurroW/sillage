import { Circle, CircleCheck, CircleDot } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ToolItem } from '../../lib/chat-fold'
import { parseUnifiedDiff } from '../../lib/diff'
import { languageFromPath } from '../../lib/highlight'
import { translate, type MessageKey } from '../../lib/i18n'
import { DiffHunks } from '../DiffHunks'
import { Markdown } from '../chat/Markdown'
import { cx } from '../ui'
import { Code, Empty, Plain, Section } from './parts'
import { fields, flag, imageBlock, list, outputLines, outputText, scalar, stripLineNumbers, text } from './payload'

/**
 * Rendu lisible d'un appel d'outil.
 *
 * Une vue rend ce que l'appel a fait, pas la forme sous laquelle le CLI l'a dit : une
 * commande shell colorée plutôt qu'un objet JSON, une liste de tâches cochées plutôt
 * qu'un tableau d'objets, un diff plutôt que deux chaînes échappées. Elle rend `null`
 * quand le payload ne correspond pas à ce qu'elle sait lire, et le registre se rabat
 * alors sur la vue générique, puis sur la vue brute (`registry.tsx`).
 *
 * Le payload natif reste consultable en entier dans tous les cas : une vue a le droit
 * de choisir ce qu'elle montre, jamais d'être la seule chose qu'on puisse consulter.
 */
export type ToolView = (tool: ToolItem) => ReactNode

/** Vrai tant que la sortie n'existe pas encore : il n'y a pas de bloc vide à afficher. */
function pending(tool: ToolItem): boolean {
  return tool.status === 'running'
}

/** La sortie telle quelle, en texte. Rien à afficher tant que l'appel tourne. */
function TextOutput({ tool, label = translate('tool.output.label') }: { tool: ToolItem; label?: string }) {
  if (pending(tool)) return null

  const content = outputText(tool.output)
  if (content === null || content.length === 0) {
    return (
      <Section label={label}>
        <Empty>{translate('tool.output.empty')}</Empty>
      </Section>
    )
  }

  return (
    <Section label={label}>
      <Plain content={content} tone={tool.status === 'failed' ? 'text-critical' : undefined} />
    </Section>
  )
}

const bash: ToolView = (tool) => {
  const command = text(tool.input, 'command')
  if (command === null) return null

  const hints = [
    text(tool.input, 'cwd'),
    flag(tool.input, 'run_in_background') ? translate('tool.bash.background') : null,
  ].filter((hint): hint is string => hint !== null)

  return (
    <>
      <Section label={translate('tool.bash.command')} hint={hints.join(' · ')}>
        <Code content={command} language="bash" wrap />
      </Section>
      <TextOutput tool={tool} />
    </>
  )
}

const read: ToolView = (tool) => {
  const path = text(tool.input, 'file_path') ?? text(tool.input, 'path')
  if (path === null) return null

  const offset = scalar(tool.input, 'offset')
  const limit = scalar(tool.input, 'limit')
  const hint = [
    path,
    offset === null ? null : translate('tool.read.fromLine', { line: offset }),
    limit === null ? null : translate('tool.read.lines', { count: limit }),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  const image = pending(tool) ? null : imageBlock(tool.output)
  if (image !== null) {
    return (
      <Section label={translate('tool.read.content')} hint={hint}>
        <img
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={path}
          className="max-h-80 rounded-md border border-line object-contain"
        />
      </Section>
    )
  }

  const content = pending(tool) ? null : outputText(tool.output)
  const stripped = content === null ? null : stripLineNumbers(content)

  return (
    <Section label={translate('tool.read.content')} hint={hint}>
      {content === null ? (
        <Empty>{translate('tool.read.loading')}</Empty>
      ) : stripped === null ? (
        <Plain content={content} />
      ) : (
        // Numéroté par le CLI : la gouttière retirée, on retrouve du code, donc de la
        // coloration et un copier-coller utilisable.
        <Code content={stripped} language={languageFromPath(path)} />
      )}
    </Section>
  )
}

const write: ToolView = (tool) => {
  const path = text(tool.input, 'file_path')
  const content = text(tool.input, 'content')
  if (path === null || content === null) return null

  return (
    <Section label={translate('tool.write.label')} hint={path}>
      <Code content={content} language={languageFromPath(path)} />
    </Section>
  )
}

/**
 * Une édition, sous les deux formes que les CLI en donnent.
 *
 * Claude Code transmet l'extrait remplacé et son remplaçant, sans état antérieur du
 * fichier : les deux sont affichés côte à côte plutôt que maquillés en diff complet,
 * dont les numéros de ligne seraient inventés. Codex transmet un vrai diff unifié par
 * fichier, qui se rend comme n'importe quel diff.
 */
const edit: ToolView = (tool) => {
  const changes = list(tool.input, 'changes')
  if (changes !== null) return <CodexChanges changes={changes} />

  const path = text(tool.input, 'file_path')
  const before = fields(tool.input)?.old_string
  const after = fields(tool.input)?.new_string
  if (path === null || typeof before !== 'string' || typeof after !== 'string') return null

  const language = languageFromPath(path)

  return (
    <>
      <Section
        label={translate('tool.edit.replaced')}
        hint={[path, flag(tool.input, 'replace_all') ? translate('tool.edit.allOccurrences') : null]
          .filter(Boolean)
          .join(' · ')}
      >
        <Code content={before} language={language} />
      </Section>
      <Section label={translate('tool.edit.by')}>
        <Code content={after} language={language} />
      </Section>
    </>
  )
}

/** Nature d'un changement Codex, dans le vocabulaire qu'il emploie lui-même. */
const CHANGE_LABELS: Record<string, MessageKey> = {
  add: 'tool.change.created',
  delete: 'tool.change.deleted',
  update: 'tool.change.modified',
}

function CodexChanges({ changes }: { changes: unknown[] }) {
  return (
    <>
      {changes.map((change, index) => {
        const path = text(change, 'path') ?? ''
        const diff = text(change, 'diff') ?? ''
        const kind = text(fields(change)?.kind, 'type') ?? 'update'
        const label = translate(CHANGE_LABELS[kind] ?? 'tool.change.modified')

        return (
          <Section key={`${path}-${index}`} label={label} hint={path}>
            {/* Un `update` porte un diff unifié auquel il ne manque que l'en-tête qui
                dit de quel fichier il parle ; un ajout ou une suppression porte le
                contenu brut, qui n'a rien à comparer. */}
            {kind === 'update' ? (
              <div className="overflow-hidden rounded-md border border-line bg-sunken">
                {parseUnifiedDiff(`diff --git a/${path} b/${path}\n${diff}`).map((file) => (
                  <DiffHunks key={file.path} hunks={file.hunks} path={path} />
                ))}
              </div>
            ) : (
              <Code content={diff} language={languageFromPath(path)} />
            )}
          </Section>
        )
      })}
    </>
  )
}

/** Recherches dont la sortie est une liste de résultats, un par ligne. */
function matchesView(inputLabelKey: MessageKey, keys: string[]): ToolView {
  return (tool) => {
    const query = keys.map((key) => text(tool.input, key)).find((value) => value !== null)
    if (!query) return null

    const scope = [text(tool.input, 'path'), text(tool.input, 'glob')]
      .filter((hint): hint is string => hint !== null)
      .join(' · ')
    const lines = pending(tool) ? null : outputLines(tool.output)

    return (
      <>
        <Section label={translate(inputLabelKey)} hint={scope || null}>
          <Plain content={query} />
        </Section>
        {pending(tool) ? null : (
          <Section
            label={translate('tool.search.results')}
            hint={
              lines === null
                ? null
                : lines.length > 1
                  ? translate('tool.search.lineCountMany', { count: lines.length })
                  : translate('tool.search.lineCountOne', { count: lines.length })
            }
          >
            {lines === null ? (
              <Empty>{translate('tool.search.noResults')}</Empty>
            ) : (
              <Plain content={lines.join('\n')} />
            )}
          </Section>
        )}
      </>
    )
  }
}

/** Icône et teinte par état d'une tâche, dans l'ordre où l'agent les traverse. */
interface TodoState {
  icon: ReactNode
  tone: string
}

const WAITING: TodoState = { icon: <Circle size={12} />, tone: 'text-ink-faint' }

const TODO_STATES: Record<string, TodoState> = {
  pending: WAITING,
  in_progress: { icon: <CircleDot size={12} />, tone: 'text-accent' },
  completed: { icon: <CircleCheck size={12} />, tone: 'text-positive' },
}

const todos: ToolView = (tool) => {
  const entries = list(tool.input, 'todos')
  if (entries === null) return null

  return (
    <Section label={translate('tool.todo.label')}>
      <ul className="flex flex-col gap-1 rounded-md border border-line bg-sunken p-2">
        {entries.map((entry, index) => {
          const status = text(entry, 'status') ?? 'pending'
          const state = TODO_STATES[status] ?? WAITING

          return (
            <li key={index} className="flex items-start gap-2 text-xs">
              <span className={cx('mt-0.5 shrink-0', state.tone)}>{state.icon}</span>
              <span
                className={cx(
                  'min-w-0',
                  status === 'completed' ? 'text-ink-faint line-through' : 'text-ink-soft',
                )}
              >
                {text(entry, 'content') ?? text(entry, 'activeForm') ?? ''}
              </span>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/** Le rapport d'un sous-agent est du markdown : il se lit comme un message, pas comme un log. */
const subAgent: ToolView = (tool) => {
  const prompt = text(tool.input, 'prompt')
  if (prompt === null) return null

  const report = pending(tool) ? null : outputText(tool.output)

  return (
    <>
      <Section label={translate('tool.subagent.instructions')} hint={text(tool.input, 'subagent_type')}>
        <Plain content={prompt} />
      </Section>
      {report === null ? null : (
        <Section label={translate('tool.subagent.report')}>
          <div className="max-h-80 overflow-auto rounded-md border border-line bg-sunken px-2 py-1.5">
            <Markdown text={report} />
          </div>
        </Section>
      )}
    </>
  )
}

const webFetch: ToolView = (tool) => {
  const url = text(tool.input, 'url')
  if (url === null) return null

  const question = text(tool.input, 'prompt')
  const answer = pending(tool) ? null : outputText(tool.output)

  return (
    <>
      <Section label={translate('tool.webfetch.page')}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="truncate rounded-md border border-line bg-sunken p-2 font-mono text-xs text-accent underline"
        >
          {url}
        </a>
      </Section>
      {question === null ? null : (
        <Section label={translate('tool.webfetch.question')}>
          <Plain content={question} />
        </Section>
      )}
      {answer === null ? null : (
        <Section label={translate('tool.webfetch.answer')}>
          <div className="max-h-80 overflow-auto rounded-md border border-line bg-sunken px-2 py-1.5">
            <Markdown text={answer} />
          </div>
        </Section>
      )}
    </>
  )
}

const plan: ToolView = (tool) => {
  const content = text(tool.input, 'plan')
  if (content === null) return null

  return (
    <Section label={translate('tool.plan.label')}>
      <div className="max-h-80 overflow-auto rounded-md border border-line bg-sunken px-2 py-1.5">
        <Markdown text={content} />
      </div>
    </Section>
  )
}

/**
 * Vue de repli, pour les outils sans vue dédiée : les serveurs MCP, ceux qu'un CLI
 * ajoutera demain, ceux dont le payload ne correspond pas à ce que leur vue attendait.
 *
 * Les champs courts tiennent dans une liste de définitions, ce qui donne d'un coup
 * d'œil les paramètres de l'appel ; les longs et les structurés prennent chacun leur
 * bloc. Un JSON indenté disait déjà tout cela, mais en obligeant à le lire.
 */
export const genericView: ToolView = (tool) => {
  const input = fields(tool.input)
  const entries = input === null ? [] : Object.entries(input)
  const short = entries.filter(([, value]) => isShort(value))
  const long = entries.filter(([, value]) => !isShort(value))
  const output = pending(tool) ? null : tool.output

  if (entries.length === 0 && output === null) return null

  return (
    <>
      {short.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-line bg-sunken p-2 text-xs">
          {short.map(([key, value]) => (
            <div key={key} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-ink-faint">{key}</dt>
              <dd className="min-w-0 truncate font-mono text-ink-soft">{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {long.map(([key, value]) => (
        <Section key={key} label={key}>
          {typeof value === 'string' ? (
            <Plain content={value} />
          ) : (
            <Code content={JSON.stringify(value, null, 2)} language="json" />
          )}
        </Section>
      ))}

      {output === null ? null : typeof output === 'string' || Array.isArray(output) ? (
        <TextOutput tool={tool} />
      ) : (
        <Section label={translate('tool.output.label')}>
          <Code content={JSON.stringify(output, null, 2)} language="json" />
        </Section>
      )}
    </>
  )
}

/** Assez court pour tenir sur une ligne de liste, sans passer par un bloc à part. */
function isShort(value: unknown): boolean {
  if (value === null || typeof value === 'object') return false
  const rendered = String(value)
  return rendered.length <= 80 && !rendered.includes('\n')
}

/**
 * Les vues par nom d'outil.
 *
 * Les noms sont ceux du journal, donc déjà normalisés par les adaptateurs : Codex
 * publie ses exécutions de commande sous `Bash` et ses changements de fichier sous
 * `Edit` (I3). `Task` et `Agent` désignent le même outil selon la version du CLI.
 */
export const VIEWS: Record<string, ToolView> = {
  Bash: bash,
  Read: read,
  Write: write,
  Edit: edit,
  Glob: matchesView('tool.search.patternLabel', ['pattern']),
  Grep: matchesView('tool.search.patternLabel', ['pattern']),
  WebSearch: matchesView('tool.search.queryLabel', ['query']),
  TodoWrite: todos,
  Task: subAgent,
  Agent: subAgent,
  WebFetch: webFetch,
  ExitPlanMode: plan,
}
