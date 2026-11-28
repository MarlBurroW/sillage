import { Logo } from './Logo'

/**
 * Shown over a hidden thread while a long replay builds it. The Echo's waves pass one after the
 * other and a wake stretches under them, so a slow load reads as motion rather than a dead screen.
 * Larger and slower than the typing indicator, which shares the mark but signals a live turn.
 */
export function ThreadLoading({ label }: { label: string }) {
  return (
    <div className="sg-thread-loading" role="status" aria-label={label}>
      <div className="sg-thread-loading-mark">
        <Logo size={48} />
      </div>
      <span className="sg-thread-loading-wake" aria-hidden />
      <p className="sg-thread-loading-label">{label}</p>
    </div>
  )
}
