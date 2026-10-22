import type { ReactNode } from 'react'

/** Consistent tab centering with scrolling on short screens. */
export function PanelEmptyState({ children }: { children: ReactNode }) {
  return (
    <div data-panel-empty className="flex min-h-0 min-w-0 flex-1 overflow-auto p-4">
      {/* Auto margins center when possible without clipping message tops when content exceeds height. */}
      <div className="m-auto flex max-w-full shrink-0 flex-col items-center gap-3 text-center">
        {children}
      </div>
    </div>
  )
}
