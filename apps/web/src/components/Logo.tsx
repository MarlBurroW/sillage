/**
 * La marque de Sillage.
 *
 * Un point qui avance, et les rides qu'il laisse derrière lui : les trois arcs sont le
 * même événement à trois instants, ce qu'un journal contient. Ils s'élargissent et
 * s'effacent en s'éloignant, comme les vagues transversales d'un vrai sillage.
 *
 * Tracée en `currentColor` plutôt qu'en dégradé figé : posée sur `text-accent`, elle
 * suit le curseur de teinte des réglages, ce qu'un dégradé codé en dur ne saurait pas
 * faire. Le dégradé ne sert que là où la marque est posée sur une tuile, c'est-à-dire
 * dans les icônes d'application.
 *
 * Le même tracé existe en trois autres exemplaires, qui ne peuvent pas importer
 * celui-ci : `apps/web/public/favicon.svg`, `docs/brand/wordmark.svg`, et les PNG
 * dérivés du premier. Toucher à la géométrie ici demande de les reprendre.
 */
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden
      focusable="false"
    >
      <circle cx="16" cy="6.4" r="3.4" fill="currentColor" />
      <path
        d="M10.8 13.8Q16 17.4 21.2 13.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M7.4 19.2Q16 24.6 24.6 19.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M4 24.6Q16 31.4 28 24.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  )
}
