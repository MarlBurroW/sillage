/**
 * The Echo: three parallel waves extend the motion. currentColor preserves selected hues. Reference
 * path lives in docs/brand/symbol.svg; standalone favicon/site/signature copies must match.
 * Regenerate PNGs with node scripts/brand-assets.mjs.
 */
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="currentColor"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path d="M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79Z" />
      <path d="M23 79C47 79 39 21 65 21H78C54 21 62 79 36 79Z" />
      <path d="M42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z" />
    </svg>
  )
}
