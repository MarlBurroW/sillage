import { PAGE_SCRIPT_HASHES } from './share-page.js'
import { SLIDES_SCRIPT_HASHES } from './share-slides.js'

/**
 * Policy of the documents a benchmark leaves Sillage as, the shared page and its slideshow: only
 * their own pinned scripts run (today's and every version a published snapshot may still carry),
 * and they may only frame and load the productions served beside them, which carry their own
 * sandbox policy. Kept apart from both renderers so neither imports the other.
 */
export const SHARE_PAGE_CSP =
  `default-src 'none'; style-src 'unsafe-inline'; script-src ${[...new Set([...PAGE_SCRIPT_HASHES, ...SLIDES_SCRIPT_HASHES])].map((hash) => `'sha256-${hash}'`).join(' ')}; ` +
  `img-src 'self' data:; media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
