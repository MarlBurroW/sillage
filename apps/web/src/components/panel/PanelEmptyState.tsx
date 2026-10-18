import type { ReactNode } from 'react'

/** Un même centrage pour tous les onglets, avec défilement sur les écrans peu hauts. */
export function PanelEmptyState({ children }: { children: ReactNode }) {
  return (
    <div data-panel-empty className="flex min-h-0 min-w-0 flex-1 overflow-auto p-4">
      {/* Les marges automatiques centrent quand la place suffit, sans rogner le haut
          du message quand son contenu dépasse la hauteur disponible. */}
      <div className="m-auto flex max-w-full shrink-0 flex-col items-center gap-3 text-center">
        {children}
      </div>
    </div>
  )
}
