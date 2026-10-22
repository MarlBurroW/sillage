# The brand: L’écho

Three parallel waves extend a movement. This design was selected from the logo
proposals: it evokes the trace of work and continuity of exchanges.

## Sources

| File | Use |
| --- | --- |
| `docs/brand/symbol.svg` | Reference paths, no font, in `currentColor`. |
| `docs/brand/logo-{noir,blanc,couleur}.svg` | Exportable lockups, outlined Lato Bold lettering (license included). |
| `docs/brand/wordmark.svg` | README header with its description. |
| `apps/web/src/components/Logo.tsx` | App brand, follows the theme color. |
| `apps/web/public/favicon.svg` | Default app accent, dark variant. |
| `site/favicon.svg`, `site/index.html` | Site brand, follows its palette. |

Standalone SVG copies carry the same three paths and 100 × 100 view box.
Changing the design requires updating all of them.

## Color and placement

Indigo #535CDA, the app's default accent, is the color of the standalone lockup
and app icons. In interfaces, `currentColor` preserves the site's palette and
user-selected themes. Favicons follow the system light/dark preference.

Keep a margin of at least 10% of the symbol's width around it. Use the horizontal
lockup at 150 px and above; below that, prefer the symbol alone.

## Regenerating PNGs

From the repository root: `node scripts/brand-assets.mjs`.
The script uses Playwright, already included in development dependencies.

| File | Size | Detail |
| --- | --- | --- |
| `apps/web/public/icon-192.png` | 192 × 192 | Rounded tile, manifest and notifications. |
| `apps/web/public/icon-512.png` | 512 × 512 | Rounded tile, manifest. |
| `apps/web/public/icon-maskable-512.png` | 512 × 512 | Solid background; symbol within the 80% safe circle. |
| `apps/web/public/apple-touch-icon.png` | 180 × 180 | Solid background; iOS applies its own mask. |
| `apps/web/public/og.png`, `site/og.png` | 1200 × 630 | Social sharing thumbnail. |

Product screenshots in `site/screenshots` are regenerated with
`scripts/screenshots.mjs` on an isolated demo instance.
