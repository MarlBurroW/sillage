import type { AgentKind } from '@sillage/protocol'
import {
  ArrowRightLeft, ArrowUp, BookOpen, ChevronDown, ChevronRight, FolderInput, GaugeCircle, GitBranch, Info,
  LoaderCircle, Maximize2, Menu, Mic, PanelRight, Paperclip, PlugZap, Search, Share2, ShieldCheck, Shrink,
  SlidersHorizontal, Sparkles, Square, SquareKanban, UsersRound, Zap,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { AGENT_LABELS, AgentIcon } from '../../../apps/web/src/components/AgentIcon'
import { ContextMeter } from '../../../apps/web/src/components/chat/ContextMeter'
import { toolButtonClass } from '../../../apps/web/src/components/chat/composer-buttons'
import { Logo } from '../../../apps/web/src/components/Logo'
import { TooltipProvider } from '../../../apps/web/src/components/ui/Tooltip'
import { IconButton, cx } from '../../../apps/web/src/components/ui'
import { AGENT_DATA, type Entry, type Scenario } from './data'
import { StatusBar } from './StatusBar'

/**
 * A static copy of the conversation page, with the classes of ConversationHeader, MessageBubble
 * and Composer, so the status line is judged in its real surroundings.
 */
export function Stage({ agent, scenario, entries, narrow, clock, onConfigure, onOpen }: {
  agent: AgentKind
  scenario: Scenario
  entries: Entry[]
  narrow: boolean
  clock: number
  onConfigure: () => void
  onOpen: (place: string) => void
}) {
  const running = scenario === 'running'
  const data = AGENT_DATA[agent]
  const contextInBar = entries.some((entry) => entry.key === 'context' && entry.on)
  const context = { usedTokens: data.context.used, maxTokens: data.context.max, ratio: data.context.used / data.context.max }

  return (
    <TooltipProvider delayDuration={120}>
      <div className="@container/thread relative flex h-full min-w-0 flex-1 flex-col bg-canvas">
        <Header agent={agent} narrow={narrow} onOpen={onOpen} />

        <main className="fade-bottom min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex sg-conversation-width flex-col gap-5 px-4 py-6">
            <Assistant time="16:15">
              <p>C’est commité et fusionné : <code>main</code> est maintenant sur <code>81825d7fe8 Add extra GitHub Copilot accounts</code>.</p>
              <ul>
                <li><strong>Commit</strong> : un seul, sur <code>feat/copilot-accounts</code>, message en anglais.</li>
                <li><strong>Fusion</strong> : en avance rapide (<code>--ff-only</code>). L’arbre principal était propre.</li>
                <li><strong>Pas poussé, pas déployé</strong> : comme il y a une migration (<strong>0080</strong>), il faudra une release serveur.</li>
              </ul>
            </Assistant>
            <User time="16:16">pousse et supprime le worktree</User>
            <Tools running={false} />
            <Assistant time="16:16">
              <p><code>main</code> est poussé sur <code>origin</code> et le worktree est supprimé.</p>
              <p>Il reste à faire :</p>
              <ul>
                <li>Ce n’est pas déployé sur marldev. Ça demande une release serveur, à cause de la migration 0080.</li>
                <li>La connexion avec un vrai deuxième compte GitHub n’a toujours pas été testée.</li>
              </ul>
            </Assistant>
            {running ? <>
              <User time="16:18">prépare la release et vérifie la migration sur une copie de la base</User>
              <Tools running />
            </> : null}
          </div>
        </main>

        <div className="shrink-0 px-3 pt-1 pb-6">
          <form onSubmit={(event) => event.preventDefault()} className="@container mx-auto sg-conversation-width">
            <div className="sg-composer-frame surface flex flex-col gap-1 rounded-xl border border-line p-1.5 shadow-float">
              <textarea rows={1} placeholder="Écris ton message…"
                className="relative max-h-[200px] w-full resize-none bg-transparent px-2 py-2 text-[0.9375rem] leading-relaxed text-ink outline-none placeholder:text-ink-faint" />
              <div className="flex items-center gap-1">
                <div className="order-1 flex shrink-0 items-center gap-1">
                  <button type="button" aria-label="Joindre" className={toolButtonClass(narrow)}><Paperclip size={16} /></button>
                  {narrow ? null : <button type="button" aria-label="Dicter" className={toolButtonClass(narrow)}><Mic size={16} /></button>}
                  {narrow ? null : <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />}
                </div>
                <div className="order-2 flex min-w-0 items-center gap-1 overflow-hidden">
                  <Chip narrow={narrow} strong icon={<Sparkles size={14} />}>
                    {data.chip}<span className="font-normal text-ink-soft"> · Moyen</span>
                  </Chip>
                  {narrow ? null : <>
                    <Chip narrow={false} caution icon={<ShieldCheck size={14} />}>Tout autoriser</Chip>
                    <button type="button" aria-label="Sous-agents" className={cx(toolButtonClass(false), 'text-ink-soft')}><UsersRound size={16} /></button>
                  </>}
                </div>
                <div className="order-3 ml-auto flex shrink-0 items-center gap-1">
                  <button type="button" aria-label="Serveurs MCP" className={cx(toolButtonClass(narrow), 'relative')}>
                    <PlugZap size={16} />
                    <span className="absolute top-0.5 right-0.5 rounded-full bg-accent px-1 text-[0.5625rem] leading-3.5 font-semibold text-accent-ink">8</span>
                  </button>
                  <button type="button" aria-label="Skills" className={toolButtonClass(narrow)}><BookOpen size={16} /></button>
                  {/* The gauge moves to the status line when the user puts the context there. */}
                  {contextInBar ? null : <span className="flex items-center px-1"><ContextMeter context={context} compact={narrow} /></span>}
                  {narrow ? null : <button type="button" aria-label="Réglages" className={toolButtonClass(false)}><SlidersHorizontal size={16} /></button>}
                  {running ? (
                    <button type="button" aria-label="Interrompre"
                      className={cx('flex shrink-0 items-center justify-center rounded-full border border-line bg-surface-high text-ink', narrow ? 'size-9' : 'size-11 md:size-9')}>
                      <Square size={13} fill="currentColor" />
                    </button>
                  ) : null}
                  <button type="submit" aria-label="Envoyer" disabled
                    className={cx('gradient-accent flex shrink-0 items-center justify-center rounded-full text-accent-ink disabled:opacity-35', narrow ? 'size-9' : 'size-11 md:size-9')}>
                    <ArrowUp size={16} />
                  </button>
                </div>
              </div>
            </div>
          </form>

          <div className="mx-auto flex sg-conversation-width items-start gap-2">
            <button type="button" aria-label="Raccourcis"
              className="mt-1 flex min-h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-ink-soft hover:bg-surface-high hover:text-ink">
              {['@', '#', '/'].map((prefix) => (
                <code key={prefix} aria-hidden className="rounded border border-line bg-surface-high px-1 font-mono text-[0.6875rem] leading-4 text-ink">{prefix}</code>
              ))}
              {narrow ? null : <span className="ml-0.5">Raccourcis</span>}<ChevronDown size={12} aria-hidden />
            </button>
            <div className="min-w-0 flex-1">
              <StatusBar entries={entries} context={{ agent, scenario, compact: narrow, clock }} onConfigure={onConfigure} onOpen={onOpen} />
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

function Header({ agent, narrow, onOpen }: { agent: AgentKind; narrow: boolean; onOpen: (place: string) => void }) {
  const tool = (label: string, icon: ReactNode) => <IconButton key={label} label={label} onClick={() => onOpen(label)}>{icon}</IconButton>
  return (
    <header className="surface sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1 @min-[44rem]/thread:gap-3 @min-[44rem]/thread:px-4">
      {narrow ? <IconButton label="Navigation"><Menu size={18} /></IconButton> : null}
      <span role="img" aria-label={AGENT_LABELS[agent]} className="flex size-8 shrink-0 items-center justify-center">
        <AgentIcon agent={agent} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
          <span className="max-w-[60%] shrink-0 truncate">sillage</span>
          <span className="flex min-w-0 items-center gap-1"><GitBranch size={12} className="shrink-0" /><span className="truncate font-mono">main</span></span>
        </div>
        <p className="truncate text-sm font-medium">Contenu de la prochaine release</p>
      </div>
      <div className="order-last flex w-full shrink-0 items-center justify-start gap-0.5 overflow-x-auto @min-[56rem]/thread:order-none @min-[56rem]/thread:w-auto @min-[56rem]/thread:justify-end">
        {tool('Consommation du compte', <GaugeCircle size={18} />)}
        {tool('Consignes', <Logo size={18} />)}
        {tool('Rechercher', <Search size={18} />)}
        {tool('Exporter', <Share2 size={18} />)}
        {tool('Compacter', <Shrink size={18} />)}
        {tool('Détails', <Info size={18} />)}
        {tool('Transférer', <ArrowRightLeft size={18} />)}
        {tool('Déplacer', <FolderInput size={18} />)}
        {tool('Ticket', <SquareKanban size={18} />)}
        {tool('Actions', <Zap size={18} />)}
        {tool('Concentration', <Maximize2 size={18} />)}
      </div>
      <IconButton label="Panneau"><PanelRight size={18} /></IconButton>
    </header>
  )
}

function Chip({ children, icon, narrow, strong, caution }: { children: ReactNode; icon: ReactNode; narrow: boolean; strong?: boolean; caution?: boolean }) {
  return (
    <button type="button"
      className={cx(
        'flex items-center gap-1.5 rounded-md px-2 text-xs hover:bg-surface-high',
        narrow ? 'relative h-9 min-w-0 flex-initial text-[0.8125rem]' : 'min-h-11 shrink-0 md:min-h-8',
        strong ? 'font-medium text-ink' : caution ? 'text-caution' : 'text-ink-soft',
      )}>
      {narrow ? null : <span className={cx('shrink-0', caution ? 'text-caution' : 'text-accent')}>{icon}</span>}
      <span className="min-w-0 truncate text-left">{children}</span>
      <ChevronDown size={12} className="shrink-0 text-ink-faint" />
    </button>
  )
}

function Assistant({ children, time }: { children: ReactNode; time: string }) {
  return (
    <div className="group flex flex-col gap-2">
      <div className="sg-bubble min-w-0 rounded-lg"><div className="sg-markdown">{children}</div></div>
      <span className="px-1.5 text-[0.6875rem] text-ink-faint">{time}</span>
    </div>
  )
}

function User({ children, time }: { children: ReactNode; time: string }) {
  return (
    <div className="group flex flex-col items-end gap-0.5">
      <div className="sg-bubble sg-user-bubble flex min-w-0 max-w-[85%] flex-col gap-2 rounded-lg rounded-br-sm border px-3.5 py-2.5 shadow-card">
        <p className="whitespace-pre-wrap">{children}</p>
      </div>
      <span className="px-1.5 text-[0.6875rem] text-ink-faint">{time}</span>
    </div>
  )
}

function Tools({ running }: { running: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-xs">
      {running ? <LoaderCircle size={14} className="shrink-0 animate-spin text-accent" /> : <ChevronRight size={14} className="shrink-0 text-ink-faint" />}
      <span className="shrink-0 font-semibold">{running ? '3 sous-agents' : '5 outils'}</span>
      <span className="min-w-0 truncate text-ink-soft">{running ? 'Explore, Explore, Plan' : 'Bash, ToolSearch, Supprimer un worktree'}</span>
      <span className="ml-auto shrink-0 text-ink-faint">{running ? 'en cours' : '4.5 s'}</span>
    </div>
  )
}
