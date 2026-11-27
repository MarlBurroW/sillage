import { useSyncExternalStore } from 'react'

/**
 * Optional Google Fonts, bundled through Fontsource rather than fetched from Google: no request
 * leaves the instance, the Desktop edition works offline, and each family downloads only once
 * chosen (`load` is a lazy CSS chunk). `system` keeps the platform stack declared in index.css,
 * which stays the default and the fallback behind every choice.
 *
 * Only variable families: one file per script covers the 400–700 weights the interface uses.
 */

export type FontSlot = 'sans' | 'mono'

export interface FontOption {
  id: string
  /** Name declared by the Fontsource `@font-face` rules. */
  family: string
  /** Display name when the family's own is too long for a card. */
  label?: string
  load: () => Promise<unknown>
}

export const SYSTEM_FONT = 'system'

export const FONT_OPTIONS: Record<FontSlot, readonly FontOption[]> = {
  sans: [
    { id: 'inter', family: 'Inter Variable', load: () => import('@fontsource-variable/inter') },
    { id: 'geist', family: 'Geist Variable', load: () => import('@fontsource-variable/geist') },
    { id: 'ibm-plex-sans', family: 'IBM Plex Sans Variable', load: () => import('@fontsource-variable/ibm-plex-sans') },
    { id: 'dm-sans', family: 'DM Sans Variable', load: () => import('@fontsource-variable/dm-sans') },
    { id: 'figtree', family: 'Figtree Variable', load: () => import('@fontsource-variable/figtree') },
    { id: 'manrope', family: 'Manrope Variable', load: () => import('@fontsource-variable/manrope') },
    { id: 'plus-jakarta-sans', family: 'Plus Jakarta Sans Variable', load: () => import('@fontsource-variable/plus-jakarta-sans') },
    { id: 'source-sans-3', family: 'Source Sans 3 Variable', load: () => import('@fontsource-variable/source-sans-3') },
    { id: 'atkinson-hyperlegible-next', family: 'Atkinson Hyperlegible Next Variable', label: 'Atkinson Hyperlegible', load: () => import('@fontsource-variable/atkinson-hyperlegible-next') },
    { id: 'nunito', family: 'Nunito Variable', load: () => import('@fontsource-variable/nunito') },
  ],
  mono: [
    { id: 'jetbrains-mono', family: 'JetBrains Mono Variable', load: () => import('@fontsource-variable/jetbrains-mono') },
    { id: 'fira-code', family: 'Fira Code Variable', load: () => import('@fontsource-variable/fira-code') },
    { id: 'geist-mono', family: 'Geist Mono Variable', load: () => import('@fontsource-variable/geist-mono') },
    { id: 'cascadia-code', family: 'Cascadia Code Variable', load: () => import('@fontsource-variable/cascadia-code') },
    { id: 'source-code-pro', family: 'Source Code Pro Variable', load: () => import('@fontsource-variable/source-code-pro') },
    { id: 'roboto-mono', family: 'Roboto Mono Variable', load: () => import('@fontsource-variable/roboto-mono') },
    { id: 'ubuntu-sans-mono', family: 'Ubuntu Sans Mono Variable', load: () => import('@fontsource-variable/ubuntu-sans-mono') },
    { id: 'victor-mono', family: 'Victor Mono Variable', load: () => import('@fontsource-variable/victor-mono') },
  ],
}

/**
 * The system stacks of index.css, for previews only: the page itself renders in the chosen family,
 * so the "System" card must name the stack explicitly. Keep in sync with `@theme` in index.css.
 */
export const SYSTEM_STACKS: Record<FontSlot, string> = {
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, monospace",
}

export function previewFamily(slot: FontSlot, id: string): string {
  const option = findOption(slot, id)
  return option ? `'${option.family}', ${SYSTEM_STACKS[slot]}` : SYSTEM_STACKS[slot]
}

const STORAGE_KEYS: Record<FontSlot, string> = { sans: 'sillage.fontSans', mono: 'sillage.fontMono' }
// index.css puts these first in `--font-sans` / `--font-mono`, ahead of the system stack.
const PROPERTIES: Record<FontSlot, string> = { sans: '--sg-font-sans', mono: '--sg-font-mono' }

export type FontChoice = Record<FontSlot, string>

function findOption(slot: FontSlot, id: string): FontOption | undefined {
  return FONT_OPTIONS[slot].find((option) => option.id === id)
}

/** Unknown IDs (a family removed since saving) fall back to the system stack. */
export function resolveFont(slot: FontSlot, id: string | null | undefined): string {
  return id && findOption(slot, id) ? id : SYSTEM_FONT
}

let choice: FontChoice = {
  sans: resolveFont('sans', localStorage.getItem(STORAGE_KEYS.sans)),
  mono: resolveFont('mono', localStorage.getItem(STORAGE_KEYS.mono)),
}
const listeners = new Set<() => void>()

export function currentFonts(): FontChoice {
  return choice
}

export function subscribeFonts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Resolve once the family's files are usable, so a caller that measures glyphs (the terminal)
 * measures the right ones. Never rejects: a failed chunk leaves the system stack showing.
 */
export async function loadFont(slot: FontSlot, id: string): Promise<void> {
  const option = findOption(slot, id)
  if (!option) return
  try {
    await option.load()
    // Declaring `@font-face` does not fetch anything: ask for the regular weight explicitly.
    await document.fonts.load(`400 1em "${option.family}"`)
  } catch (error) {
    console.warn(`Font ${option.family} failed to load`, error)
  }
}

function setProperty(slot: FontSlot, id: string): void {
  const option = findOption(slot, id)
  const root = document.documentElement
  if (option) root.style.setProperty(PROPERTIES[slot], `'${option.family}'`)
  else root.style.removeProperty(PROPERTIES[slot])
}

export function applyFont(slot: FontSlot, id: string): void {
  const next = resolveFont(slot, id)
  if (next === SYSTEM_FONT) localStorage.removeItem(STORAGE_KEYS[slot])
  else localStorage.setItem(STORAGE_KEYS[slot], next)
  choice = { ...choice, [slot]: next }
  // The property goes on immediately: `font-display: swap` shows the fallback until files arrive.
  setProperty(slot, next)
  void loadFont(slot, next)
  for (const listener of listeners) listener()
}

/**
 * Apply the cached choice before first render. Waits for the files, capped so a slow network
 * never holds the interface back: past the cap the fonts swap in when they arrive.
 */
export function restoreFonts(capMs = 400): Promise<void> {
  const pending: Promise<void>[] = []
  for (const slot of ['sans', 'mono'] as const) {
    if (choice[slot] === SYSTEM_FONT) continue
    setProperty(slot, choice[slot])
    pending.push(loadFont(slot, choice[slot]))
  }
  if (pending.length === 0) return Promise.resolve()
  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, capMs)),
  ])
}

export function useFonts(): [FontChoice, (slot: FontSlot, id: string) => void] {
  const fonts = useSyncExternalStore(subscribeFonts, currentFonts)
  return [fonts, applyFont]
}
