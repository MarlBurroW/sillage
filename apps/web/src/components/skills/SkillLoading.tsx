import { LoaderCircle } from 'lucide-react'

export function SkillSpinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} aria-hidden="true" className="shrink-0 motion-safe:animate-spin" />
}

/** Keep loading in the space its content will occupy, without inventing a percentage. */
export function SkillLoading({ label, detail, rows = 0, compact = false, progress }: {
  label: string
  detail?: string
  rows?: number
  compact?: boolean
  progress?: { done: number; total: number }
}) {
  return <div className={compact ? 'py-2' : 'my-2'}>
    <div role="status" aria-live="polite" className={compact
      ? 'flex items-center gap-2 text-sm text-ink-soft'
      : 'flex items-start gap-3 border-l-2 border-accent bg-accent-wash px-4 py-4'}>
      <span className={compact ? 'text-accent' : 'pt-0.5 text-accent'}><SkillSpinner size={compact ? 16 : 20} /></span>
      <div className="min-w-0 flex-1">
        <p className={compact ? '' : 'text-sm font-medium text-ink'}>{label}</p>
        {detail ? <p className="mt-1 break-words text-sm text-ink-soft">{detail}</p> : null}
      </div>
      {progress ? <span className="shrink-0 text-sm tabular-nums text-ink-soft">{progress.done} / {progress.total}</span> : null}
    </div>
    {progress && progress.total > 0 ? <progress aria-label={label} value={progress.done} max={progress.total} className="block h-1 w-full accent-accent" /> : null}
    {rows > 0 ? <div aria-hidden="true" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, index) => <div key={index} className="space-y-3 py-5 motion-safe:animate-pulse">
        <div className="h-3 w-1/3 rounded-sm bg-ink/10" />
        <div className="h-2 w-1/4 rounded-sm bg-ink/5" />
        <div className="h-3 w-5/6 rounded-sm bg-ink/5" />
        <div className="h-3 w-2/3 rounded-sm bg-ink/5" />
      </div>)}
    </div> : null}
  </div>
}
