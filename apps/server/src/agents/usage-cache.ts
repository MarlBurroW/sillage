/** Usage cache freshness shared by CLIs. Caching is the only guard because each read spawns processes and drafts request usage automatically. Five minutes makes openings HTTP-only without misleading gauges; refresh buttons bypass caches when exact values matter. */
export const USAGE_CACHE_TTL_MS = 300_000
