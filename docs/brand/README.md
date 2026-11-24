# The brand: L’écho

Three parallel waves extend a movement. This design was selected from the logo
proposals: it evokes the trace of work and continuity of exchanges.

## Sources

| File | Use |
| --- | --- |
| `docs/brand/symbol.svg` | Reference paths, no font, in `currentColor`. |
| `docs/brand/logo-{noir,blanc,couleur}.svg` | Exportable lockups, outlined Lato Bold lettering (license included). |
| `docs/brand/wordmark.svg` | README header with what the name means. |
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
`scripts/screenshots.mjs` on an isolated demo instance. Set `SILLAGE_SHOT_FORMAT=webp`
for the website and the README; PNG remains the script's default. Each view
is captured twice, at 1x and with `SILLAGE_SHOT_SCALE=2` (`<name>-2x-<theme>.webp`),
and the pages offer both through `srcset`.

The website sets everything in self-hosted Archivo, a variable family whose width
axis gives the headlines their wider cut; JetBrains Mono is kept for code. Both
licenses are in `site/fonts`. Primary buttons use the ink colour; indigo is kept
for links and for the wake.

To regenerate only the site's social card, run `node scripts/site-social-image.mjs`.
It uses the same font, logo and current product screenshot as the landing page.
The same script renders the film stills (`site/film/poster-{light,dark}.jpg`) and
`docs/images/film-poster.jpg`, the dark still with a play pill that the README links
to the film on the site.

The README reuses the site's 2x captures through `<picture>`. Keep a themed
`<picture>` out of links there: GitHub wraps its image in a link of its own, which
breaks both the theme switch and the outer link.

The public site consists of four static pages: `index.html`, `features.html`,
`agents.html` and `download.html`, with one stylesheet, `style.css`. The layout is
built from ruled rows rather than cards. `wake.js` draws the home page's hero:
rows of water bent by a point that crosses them, which is what "sillage" means.
It is decoration only, follows the pointer, and draws a single still frame when
reduced motion is requested.
`main.js` owns shared navigation, theme, release links and accessible dialogs.
Show the product only with real application screenshots or recordings. Do not
reconstruct conversations, tool runs, diffs or other application controls for
the website. Captures use an example project, and illustrative usage is labeled.
Every section follows the selected light or dark theme; do not alternate them.
Keep feature claims aligned with `docs/features.md` and the edition capabilities.

Run `node scripts/site-ui-check.mjs` to check all four pages at desktop and mobile
sizes, in both themes, with keyboard navigation and without JavaScript. The check
starts its own temporary server under the GitHub Pages `/sillage/` prefix and
checks internal links, theme consistency, real screenshot viewers, catalog
filters, integration details and downloads.
