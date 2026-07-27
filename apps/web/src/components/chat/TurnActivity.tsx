/**
 * Indicateur d'activité en bas du fil, présent du début à la fin du tour.
 *
 * L'ancien repère vivait dans le bloc de réflexion, donc il s'effaçait dès qu'un
 * message se terminait, y compris au milieu d'un tour qui enchaînait ensuite des
 * outils. Ici, la seule condition d'affichage est « un tour est en cours ».
 */
export function TurnActivity({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-ink-faint" aria-live="polite">
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="size-1.5 rounded-full bg-accent"
            style={{
              animation: 'sg-pulse-dot 1.1s ease-in-out infinite',
              // Décalage par point : c'est ce qui donne la vague plutôt qu'un
              // clignotement synchrone des trois.
              animationDelay: `${index * 0.18}s`,
            }}
          />
        ))}
      </span>
      <span className="font-medium">{label}</span>
    </div>
  )
}
