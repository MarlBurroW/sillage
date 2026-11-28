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
| `apps/web/public/og.png`, `site/og.png` | 1200 × 630 | Social sharing thumbnail, one image for the site and the app. Drawn by `scripts/site-social-image.mjs` from `site/screenshots/hero-light.webp`: regenerate it after new screenshots. |

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
Every other page has a card of its own, `site/og/<page>.png` (French in `site/og/fr/`),
drawn by `renderPageCards` in the same script: the brand, the page's title and line
stacked on still water, the wake on the right, and no figure that could go stale.
The same script renders the film stills (`site/film/poster-{light,dark}.jpg`) and
`docs/images/film-poster.jpg`, the dark still with a play pill that the README links
to the film on the site.

The README reuses the site's 2x captures through `<picture>`. Keep a themed
`<picture>` out of links there: GitHub wraps its image in a link of its own, which
breaks both the theme switch and the outer link.

The public site consists of static pages, `index.html`, `features.html`,
`agents.html`, `download.html`, `docs.html`, `changelog.html` and `security.html`,
plus `404.html`, which GitHub Pages serves at any missing address (its `<base>` keeps
relative links working at any depth). One stylesheet, `style.css`. The layout is
built from ruled rows rather than cards. The header and the footer are repeated in
every page: change them everywhere at once.

The footer gives the brand its line, the latest release as a badge (`<!-- release-badge -->`,
filled by `site-changelog.mjs` in each language), three columns of links, then a base line
with the copyright, the languages (`data-lang-menu`, rebuilt per page and language by
`site-i18n.mjs`: each language named in its own language), the no-cookies note and a way
back up. Below it, the name as wide as the content (sized in `cqi` on its container), faint,
sinking under the page's edge; the word is drawn by CSS (`data-word`), so audits and screen
readers treat it as the decoration it is. No water rows in the footer: an earlier version
had them and they were dropped.

Every composition of a heading beside its text uses `--cols` (5/12 then 7/12, with a
4rem gap), so second columns start on the same vertical line down a page; give a new
section the same split rather than a ratio of its own. The current page carries a
short wake-coloured rule under its link, and a square mark on its left edge in the
phone menu. On phones, choices that wrap (gallery screens, download filters) become
pills. Disclosures animate their height where the browser supports
`interpolate-size`, and never under reduced motion.

Every capture that is a `button.shot[data-zoom]` opens the full image in the viewer
and shows a magnifier on hover or focus; a page with zoomable captures carries the
`data-zoom-dialog` markup. On pages without a hero, `main.js` gives each section's
heading a `#` link to itself. Page changes cross-fade through cross-document view
transitions with the top bar held still, and the first screen's heading, text and
actions rise a few pixels as they appear; reduced motion turns both off.

The home page shows real captures once, in the gallery under the hero. It does not line
them up section after section: with this many features, a few large screens reduce the
product to themselves. Breadth is shown by "Everything around the agent.": the names of
every feature drifting in three currents (`scripts/site-currents.mjs` fills them from the
catalog, in each language; `site-i18n.mjs` calls it after a build), then a grid of
illustrated tiles, one per kind of work, each with a drawing, a title, one line and its
features as links to the catalog. The drawings are diagrams of an idea, with the agents'
own marks as characters (`#m-…` symbols in the page's sprite): never a picture of the
interface, a conversation, a diff or a control, which only real captures may show. They
are inline SVG styled from the theme tokens and fitted whole in their box. Each tells its
idea as a short loop (an agent drops commits along its branch, which merges back; a pulse
runs back to a checkpoint; a question crosses to the phone and the answer comes back), and
rests on the moment that sums it up, which is what reduced motion shows. Off screen the
drawings wait, and each starts once its tile is well in view: `main.js` sets `data-running`,
and without the script they simply play. The closing tile says how many features the catalog
holds and how many the tiles leave out: both are static in the HTML (the figure runs up from
zero once, in the browser), and the UI check compares them, and the currents, with the
catalog.

Each page sets a `js` class on `<html>` from an inline script in its head, and takes it
back if `main.js` cannot load (`onerror`). The stylesheet uses it to lay out, from the first
paint, what the scripts will arrange: one panel per tab group, the folded phone menu, the
gallery's two columns, the search and filter controls. So nothing jumps when the script
arrives, and the captures of hidden panels are not fetched. Rules for readers without
scripts are written `html:not(.js) …`; do not show or hide such things from a script.
The UI check measures the layout shift of three pages and the fallback without `main.js`.

Cards lie flat: their surface and their border set them apart from the page. `--lift`
is a one-pixel hairline in the light theme and nothing in the dark one. Never derive a
shadow from `--ink`: it turns light in the dark theme, and the shadow becomes a white glow.
Captures keep their own shadow (`--shadow`), which is black in both themes.

Motion stays small and always about the wake: the theme switch spreads the new theme as
a circle from the toggle (a same-document view transition), the header mark's three
strokes ripple under the pointer, a wake-coloured reading line grows under the top bar
on pages without a hero, a pulse runs through the "What runs where" diagram, and
captures surface and the home page's tiles rise as they scroll into view, while its
currents shift as the page passes (scroll-driven animations behind `@supports`, so
unsupported browsers simply show them). Reduced motion turns all of it off, and none
of it hides content. The UI check only awaits finite, time-based animations: scroll-driven
ones follow the reader and never finish. A scroll-driven animation follows its nearest
scroll container: a section that only needs to clip its content uses `overflow: clip`,
since `overflow: hidden` makes it a scroller and freezes the animation. A dash that travels
along a path in a drawing has a gap longer than the path, or it shows a second time at the
far end. The 404 page reuses the home page's hero and
wake.

The install command wraps rather than scrolling, with break opportunities (`<wbr>`)
after the slashes of its address, so the whole address can be read before anyone runs
it; on phones the copy button keeps only its icon.

Inside a download panel every block follows the same pattern: a short label and its
explanation on the left, the content (packages, command and steps, requirements,
guides) on the right of the shared line. Rows that leave the site for the repository
carry the external-link mark. On the feature catalog, "/" focuses the search, and the
field shows the key while it is empty and unfocused. The changelog unfolds the three
newest releases and folds the rest.

`changelog.html` is filled by `node scripts/site-changelog.mjs` from the GitHub
releases, between `<!-- changelog:… -->` markers. The same run writes the latest
version wherever a page has `<!-- latest-release -->` markers, the release count in
`<!-- release-count -->`, the package sizes in `data-asset-size` spans and the
`softwareVersion` of the home page's structured data. The Pages workflow runs it
before every deployment, and again when release notes are edited (`gh release edit`,
which is how notes are written): the site follows the releases without a commit, and
the committed pages are the fallback. Releases whose notes were first written in
French, or without notes, take their English notes from `scripts/site-changelog/<tag>.md`.
Run it locally with `--releases <file>` to work from a saved `/releases` response.

The site is in English and French. The English pages in `site/` are the source; the
French ones in `site/fr/` are built by `node scripts/site-i18n.mjs` and must never be
edited by hand. The build reads `scripts/site-i18n/fr/<page>.json` (and `_shared.json`):
each key is an English text, the content of an element that holds only text and inline
markup, with its inline tags reduced to numbered placeholders (`<0>…</0>`, `<1/>`) and
generated regions written `{name}`; the value is its translation. After changing English
text, run `node scripts/site-i18n.mjs --extract` (new texts appear with an empty value,
unused ones are dropped), translate the empty values, then run the build. The French copy
uses "tu", like the application's French interface, and the application's own labels
(`apps/web/src/lib/i18n/catalog-fr.ts`); the build adds French no-break spaces. Each page
names its translation through `hreflang` links and the EN/FR switch in the header, and a
missing address under `/fr/` gets the French 404 page. The Pages workflow builds the French
pages before deploying, keeping English for any text not translated yet; the UI check
(`--check`) is where a missing translation fails. French changelog notes come from
`scripts/site-changelog/fr/<tag>.md`, or from the release itself when it was published in
French; English notes for the releases first published in French live in
`scripts/site-changelog/en/`. A release without French notes shows its English ones,
marked as such, until its translation is added.

French runs longer than English: check new copy at phone widths in both languages. On
phones (≤480px) the header's call to action gives way so the bar keeps one row, and between
851 and 1080px the French bar drops it too. A headline phrase that must not split on a phone
goes in a `.keep` span (no wrapping from 375px up, where it fits). The French social cards
are in `site/og/fr/`, rendered with the English ones by `scripts/site-social-image.mjs`.

The changelog has a search (`changelog.js`): it keeps the releases whose notes mention
every word typed, opens their folded notes, marks the words with the CSS Custom
Highlight API where available, and keeps the query in `?q=`. "/" focuses it, as on the
catalog. The film's poster loads only when the film opens (`data-poster`), so the home
page does not fetch it on every visit. `favicon-32.png` is the fallback for browsers that
ignore SVG favicons: render it again from `favicon.svg` when the mark changes.

`security.html` says which version its claims were checked against. Its table of the
requests Sillage makes on its own, and its statements about storage, sign-in and
updates, describe the code: check them again when a change touches those areas, and
update the version it names.

`wake.js` draws the home page's hero:
rows of water bent by a point that crosses them, which is what "sillage" means.
It is decoration only, follows the pointer, and draws a single still frame when
reduced motion is requested. The app's sign-in page draws the same wake, with the
same physics and tuning, on a lake seen in perspective under the form, with a swell
and a glittering reflection (`apps/web/src/components/login/LoginWater.tsx`).
`main.js` owns shared navigation, theme, release links and accessible dialogs.
Show the product only with real application screenshots or recordings. Do not
reconstruct conversations, tool runs, diffs or other application controls for
the website. Captures use an example project, and illustrative usage is labeled.
Every section follows the selected light or dark theme; do not alternate them.
Keep feature claims aligned with `docs/features.md` and the edition capabilities.

Run `node scripts/site-ui-check.mjs` to check every page at desktop and mobile
sizes, in both themes, with keyboard navigation and without JavaScript. The check
starts its own temporary server under the GitHub Pages `/sillage/` prefix (answering
missing addresses with `404.html`, as Pages does) and checks internal links, theme
consistency, real screenshot viewers, catalog filters, integration details,
downloads, the changelog, and that every link into the repository names a file and
heading that exist.
