import './prototype.css'
import type { AgentKind } from '@sillage/protocol'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { AGENT_LABELS, AgentIcon } from '../../../apps/web/src/components/AgentIcon'
import { Segmented, cx } from '../../../apps/web/src/components/ui'
import { TooltipProvider } from '../../../apps/web/src/components/ui/Tooltip'
import { useMediaQuery } from '../../../apps/web/src/lib/viewport'
import { ConfigDialog } from './ConfigDialog'
import { AGENTS, CATALOG, PRESETS, type Entry, type Scenario } from './data'
import { Stage } from './Stage'

type Screen = 'desktop' | 'phone'
type Theme = 'dark' | 'dark-contrast' | 'light'
type Tint = 'mine' | 'sillage'

/** "Mine" approximates the teal, nearly neutral look of the user's screenshot; the other is the product default. */
const TINTS: Record<Tint, { hue: string; tint: string }> = { mine: { hue: '200', tint: '0.1' }, sillage: { hue: '318', tint: '0.25' } }

const embedded = new URLSearchParams(location.search).has('embed')

/** Study state shared with the phone frame (same origin): storage events keep both in step. */
function useStored<T>(key: string, initial: T, normalize: (value: T) => T = (value) => value): [T, (value: T) => void] {
  const read = (raw: string | null) => (raw === null ? initial : normalize(JSON.parse(raw) as T))
  const [value, setValue] = useState<T>(() => read(localStorage.getItem(key)))
  useEffect(() => {
    const listen = (event: StorageEvent) => { if (event.key === key) setValue(read(event.newValue)) }
    addEventListener('storage', listen)
    return () => removeEventListener('storage', listen)
  })
  return [value, (next: T) => { setValue(next); localStorage.setItem(key, JSON.stringify(next)) }]
}

/** Keep stored layouts in step with the catalog as the study adds items. */
function normalizeEntries(entries: Entry[]): Entry[] {
  const known = entries.filter((entry) => CATALOG.some((spec) => spec.key === entry.key))
  const missing = CATALOG.filter((spec) => !known.some((entry) => entry.key === spec.key))
  return [...known, ...missing.map((spec) => ({ key: spec.key, on: false, format: spec.formats?.[0] }))]
}

function App() {
  const [agent, setAgent] = useStored<AgentKind>('status-bar.agent', 'claude')
  const [scenario, setScenario] = useStored<Scenario>('status-bar.scenario', 'idle')
  const [entries, setEntries] = useStored<Entry[]>('status-bar.entries', PRESETS.default.entries, normalizeEntries)
  const [screen, setScreen] = useStored<Screen>('status-bar.screen', 'desktop')
  const [theme, setTheme] = useStored<Theme>('status-bar.theme', 'dark')
  const [tint, setTint] = useStored<Tint>('status-bar.tint', 'mine')
  const [configOpen, setConfigOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [clock, setClock] = useState(134)
  const narrowViewport = useMediaQuery('(max-width: 639px)')
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => {
    document.documentElement.style.setProperty('--sg-hue', TINTS[tint].hue)
    document.documentElement.style.setProperty('--sg-tint', TINTS[tint].tint)
  }, [tint])
  useEffect(() => {
    if (scenario !== 'running') return
    const timer = setInterval(() => setClock((seconds) => seconds + 1), 1000)
    return () => clearInterval(timer)
  }, [scenario])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    const listen = (event: MessageEvent) => { if (event.data?.type === 'configure') setConfigOpen(true) }
    addEventListener('message', listen)
    return () => removeEventListener('message', listen)
  }, [])

  const configure = () => {
    if (!embedded && screen === 'phone' && !narrowViewport) frame.current?.contentWindow?.postMessage({ type: 'configure' }, '*')
    else setConfigOpen(true)
  }

  const stage = (
    <Stage agent={agent} scenario={scenario} entries={entries} narrow={narrowViewport} clock={clock}
      onConfigure={() => setConfigOpen(true)} onOpen={(place) => setToast(place)} />
  )
  const dialogs = <>
    <ConfigDialog open={configOpen} onOpenChange={setConfigOpen} entries={entries} onChange={setEntries} agent={agent} narrow={narrowViewport} clock={clock} />
    {toast ? (
      <div role="status" className="surface fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 rounded-md border border-dashed border-line-strong px-3 py-1.5 text-xs text-ink-soft shadow-pop">
        Ouvrirait : <span className="text-ink">{toast}</span>
      </div>
    ) : null}
  </>

  if (embedded) return <div className="h-full">{stage}{dialogs}</div>

  const study = (
    <Study agent={agent} setAgent={setAgent} scenario={scenario} setScenario={setScenario} screen={screen} setScreen={setScreen}
      theme={theme} setTheme={setTheme} tint={tint} setTint={setTint} setEntries={setEntries} onConfigure={configure} phoneViewport={narrowViewport} />
  )

  if (narrowViewport) {
    return (
      <div className="flex h-full flex-col">
        <PhoneStudy>{study}</PhoneStudy>
        <div className="min-h-0 flex-1">{stage}</div>
        {dialogs}
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-dashed border-line-strong bg-sunken">{study}</aside>
      <div className="min-w-0 flex-1">
        {screen === 'desktop' ? stage : <PhoneFrame frame={frame} />}
      </div>
      {dialogs}
    </div>
  )
}

/** A 390 × 844 frame loading the page itself, so media queries see a phone. */
function PhoneFrame({ frame }: { frame: React.RefObject<HTMLIFrameElement | null> }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setScale(Math.min(1, (entry.contentRect.height - 48) / 844)))
    if (box.current) observer.observe(box.current)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={box} className="flex h-full items-center justify-center bg-canvas">
      <div style={{ width: 390 * scale + 20, height: 844 * scale + 20 }} className="rounded-[2.75rem] border border-line-strong bg-black p-2.5 shadow-pop">
        <iframe ref={frame} title="Téléphone" src="?embed=1" style={{ width: 390, height: 844, transform: `scale(${scale})`, transformOrigin: 'top left' }}
          className="rounded-[2.2rem] border-0 bg-canvas" />
      </div>
    </div>
  )
}

function PhoneStudy({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="shrink-0 border-b border-dashed border-line-strong bg-sunken">
      <button type="button" onClick={() => setOpen(!open)} className="flex min-h-9 w-full items-center gap-1.5 px-3 text-xs text-ink-soft">
        Étude de la barre d’état<ChevronDown size={13} className={cx('transition-transform', open && 'rotate-180')} />
      </button>
      {open ? <div className="max-h-[60dvh] overflow-y-auto border-t border-dashed border-line-strong">{children}</div> : null}
    </div>
  )
}

function Study(props: {
  agent: AgentKind
  setAgent: (agent: AgentKind) => void
  scenario: Scenario
  setScenario: (scenario: Scenario) => void
  screen: Screen
  setScreen: (screen: Screen) => void
  theme: Theme
  setTheme: (theme: Theme) => void
  tint: Tint
  setTint: (tint: Tint) => void
  setEntries: (entries: Entry[]) => void
  onConfigure: () => void
  phoneViewport: boolean
}) {
  const choice = (active: boolean) => cx(
    'flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm',
    active ? 'bg-accent-wash text-ink' : 'text-ink-soft hover:bg-surface-high hover:text-ink',
  )
  return (
    <div className="flex flex-col gap-5 p-4">
      <div>
        <h1 className="text-sm font-semibold">Barre d’état · maquette</h1>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">Données fictives. Ce panneau en pointillés sert à l’étude ; il n’existe pas dans l’app.</p>
      </div>

      <Group title="CLI de la session">
        {AGENTS.map((kind) => (
          <button key={kind} type="button" onClick={() => props.setAgent(kind)} className={choice(props.agent === kind)}>
            <AgentIcon agent={kind} size={14} />{AGENT_LABELS[kind]}
          </button>
        ))}
      </Group>

      <Group title="Moment">
        {([['idle', 'Au repos'], ['running', 'Tour en cours'], ['limit', 'Quota presque plein']] as const).map(([value, label]) => (
          <button key={value} type="button" onClick={() => props.setScenario(value)} className={choice(props.scenario === value)}>{label}</button>
        ))}
      </Group>

      {props.phoneViewport ? null : (
        <Group title="Écran">
          <Segmented label="Écran" value={props.screen} onChange={props.setScreen}
            options={[{ value: 'desktop', label: 'Grand écran', text: 'Grand écran' }, { value: 'phone', label: 'Téléphone', text: 'Téléphone' }]} />
        </Group>
      )}

      <Group title="Disposition">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((key) => (
            <button key={key} type="button" onClick={() => props.setEntries(PRESETS[key].entries)}
              className="min-h-8 rounded-md border border-line px-2.5 text-xs text-ink-soft hover:border-line-strong hover:text-ink">
              {PRESETS[key].label}
            </button>
          ))}
        </div>
        <button type="button" onClick={props.onConfigure} className={cx(choice(false), 'mt-1')}>
          <SlidersHorizontal size={14} />Personnaliser…
        </button>
      </Group>

      <Group title="Thème">
        <Segmented label="Thème" value={props.theme} onChange={props.setTheme}
          options={[{ value: 'dark', label: 'Sombre', text: 'Sombre' }, { value: 'dark-contrast', label: 'Contraste', text: 'Contraste' }, { value: 'light', label: 'Clair', text: 'Clair' }]} />
        <Segmented label="Teinte" value={props.tint} onChange={props.setTint} className="mt-1.5"
          options={[{ value: 'mine', label: 'Comme ta capture', text: 'Comme ta capture' }, { value: 'sillage', label: 'Par défaut', text: 'Par défaut' }]} />
      </Group>

      <Group title="À essayer">
        <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed text-ink-soft">
          <li>Survoler une info pour son détail, cliquer pour voir où elle mène.</li>
          <li>« Chargée » sur un écran étroit : ce qui ne tient pas passe derrière « +N ».</li>
          <li>Au téléphone, toucher la ligne ouvre la liste complète.</li>
          <li>Mettre « Contexte » dans la barre retire la jauge du composer.</li>
          <li>Changer de CLI : le quota s’adapte, certaines infos disparaissent.</li>
        </ul>
      </Group>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="mb-1 text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">{title}</h2>
      {children}
    </section>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><TooltipProvider><App /></TooltipProvider></StrictMode>)
