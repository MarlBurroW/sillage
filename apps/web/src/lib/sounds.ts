import { useEffect, useSyncExternalStore } from 'react'
import type { NotificationKind } from '@sillage/protocol'
import { wsClient } from './ws-client'

/**
 * Sounds for what happens away from the viewed conversation. Stored per device rather than per
 * account: a phone and a desk machine rarely want the same noise, and several open devices would
 * otherwise all ring at once. The server sends a `chime` to every tab of the account unless one of
 * them visibly watches the conversation; this module decides whether this device plays it.
 */

export const SOUND_EVENTS = ['done', 'attention', 'problem'] as const
export type SoundEvent = (typeof SOUND_EVENTS)[number]

export const SOUND_PRESETS = ['chime', 'bell', 'pop', 'twoTone', 'descend'] as const
export type SoundPreset = (typeof SOUND_PRESETS)[number]
export type SoundChoice = 'off' | 'custom' | SoundPreset

export interface SoundPrefs {
  enabled: boolean
  /** 0 to 1. */
  volume: number
  choices: Record<SoundEvent, SoundChoice>
}

export interface CustomSound {
  name: string
  dataUrl: string
}

/** Stored as a data URL in localStorage, whose quota is a few megabytes for the whole origin. */
export const MAX_CUSTOM_SOUND_BYTES = 512 * 1024

const PREFS_KEY = 'sillage.sounds'
const customKey = (event: SoundEvent) => `sillage.sounds.custom.${event}`

// Off until chosen: a sound nobody asked for is the fastest way to have the feature disabled.
const DEFAULTS: SoundPrefs = { enabled: false, volume: 0.6, choices: { done: 'chime', attention: 'twoTone', problem: 'descend' } }

/** Which sound answers which notification kind. */
const EVENT_OF: Record<NotificationKind, SoundEvent> = {
  turnCompleted: 'done',
  cliRequest: 'attention',
  decision: 'attention',
  usageLimit: 'problem',
  scheduleFailed: 'problem',
  credentialExpiry: 'problem',
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function load(): SoundPrefs {
  const stored = readJson<Partial<SoundPrefs>>(PREFS_KEY)
  return {
    enabled: stored?.enabled ?? DEFAULTS.enabled,
    volume: typeof stored?.volume === 'number' ? Math.min(1, Math.max(0, stored.volume)) : DEFAULTS.volume,
    choices: { ...DEFAULTS.choices, ...stored?.choices },
  }
}

let prefs = load()
let customs: Partial<Record<SoundEvent, CustomSound | null>> = {}
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Another tab of this device changed the settings: follow it, so muting once mutes them all.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (!event.key?.startsWith(PREFS_KEY)) return
    prefs = load()
    customs = {}
    emit()
  })
}

export function setSoundPrefs(patch: Partial<SoundPrefs>): void {
  prefs = { ...prefs, ...patch, choices: { ...prefs.choices, ...patch.choices } }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* private mode: keep it for this tab */ }
  emit()
}

export const toggleSounds = () => setSoundPrefs({ enabled: !prefs.enabled })

export function useSoundPrefs(): SoundPrefs {
  return useSyncExternalStore(subscribe, () => prefs, () => prefs)
}

export function readCustomSound(event: SoundEvent): CustomSound | null {
  if (!(event in customs)) customs[event] = readJson<CustomSound>(customKey(event))
  return customs[event] ?? null
}

export function useCustomSound(event: SoundEvent): CustomSound | null {
  return useSyncExternalStore(subscribe, () => readCustomSound(event), () => null)
}

/** Throws a message key when the file cannot be kept. */
export async function saveCustomSound(event: SoundEvent, file: File): Promise<void> {
  if (!file.type.startsWith('audio/')) throw new Error('sounds.custom.notAudio')
  if (file.size > MAX_CUSTOM_SOUND_BYTES) throw new Error('sounds.custom.tooLarge')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('sounds.custom.readFailed'))
    reader.readAsDataURL(file)
  })
  const sound = { name: file.name, dataUrl }
  try {
    localStorage.setItem(customKey(event), JSON.stringify(sound))
  } catch {
    throw new Error('sounds.custom.quota')
  }
  customs[event] = sound
  setSoundPrefs({ choices: { ...prefs.choices, [event]: 'custom' } })
}

export function removeCustomSound(event: SoundEvent): void {
  try { localStorage.removeItem(customKey(event)) } catch { /* nothing stored */ }
  customs[event] = null
  setSoundPrefs({ choices: { ...prefs.choices, [event]: prefs.choices[event] === 'custom' ? DEFAULTS.choices[event] : prefs.choices[event] } })
}

// --- Playback -----------------------------------------------------------------------------------

interface Note {
  /** Hz. */
  freq: number
  /** Seconds after the start. */
  at: number
  duration: number
  wave?: OscillatorType
  /** Relative loudness, before the volume setting. */
  gain?: number
  /** Hz reached at the end, for a glide. */
  to?: number
}

/** Synthesized rather than shipped files: no asset to license, nothing added to the precache. */
const PRESETS: Record<SoundPreset, Note[]> = {
  chime: [
    { freq: 1046.5, at: 0, duration: 0.35 },
    { freq: 1568, at: 0.11, duration: 0.5 },
  ],
  bell: [
    { freq: 1318.5, at: 0, duration: 1.1, wave: 'triangle' },
    { freq: 2637, at: 0, duration: 0.6, gain: 0.25 },
  ],
  pop: [{ freq: 900, to: 300, at: 0, duration: 0.12, gain: 1.2 }],
  twoTone: [
    { freq: 880, at: 0, duration: 0.16, wave: 'triangle' },
    { freq: 880, at: 0.22, duration: 0.22, wave: 'triangle' },
  ],
  descend: [
    { freq: 784, at: 0, duration: 0.2, wave: 'triangle' },
    { freq: 622.3, at: 0.18, duration: 0.2, wave: 'triangle' },
    { freq: 523.3, at: 0.36, duration: 0.4, wave: 'triangle' },
  ],
}

let context: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (context) return context
  const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Constructor) return null
  context = new Constructor()
  return context
}

/**
 * Browsers only let a page make sound after a gesture on it. Wake the context on the first one, so
 * a chime arriving later while the tab sits in the background can still play.
 */
function unlockOnGesture(): () => void {
  const unlock = () => {
    const ctx = audioContext()
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => {})
    if (ctx?.state === 'running') remove()
  }
  const remove = () => {
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
  return remove
}

function playNotes(notes: Note[], volume: number): void {
  const ctx = audioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  const start = ctx.currentTime + 0.02
  for (const note of notes) {
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = note.wave ?? 'sine'
    oscillator.frequency.setValueAtTime(note.freq, start + note.at)
    if (note.to) oscillator.frequency.exponentialRampToValueAtTime(note.to, start + note.at + note.duration)
    // A short attack and an exponential release: a bare on/off clicks.
    const peak = 0.25 * volume * (note.gain ?? 1)
    gain.gain.setValueAtTime(0.0001, start + note.at)
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + note.at + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.duration)
    oscillator.connect(gain).connect(ctx.destination)
    oscillator.start(start + note.at)
    oscillator.stop(start + note.at + note.duration + 0.05)
  }
}

/** Play what is chosen for an event, whether sounds are on or not: the settings page tests with it. */
export function playSound(event: SoundEvent, choice: SoundChoice = prefs.choices[event], volume = prefs.volume): void {
  if (choice === 'off' || volume <= 0) return
  if (choice === 'custom') {
    const custom = readCustomSound(event)
    if (!custom) return
    const audio = new Audio(custom.dataUrl)
    audio.volume = volume
    void audio.play().catch(() => {})
    return
  }
  playNotes(PRESETS[choice], volume)
}

/** Several tabs of one device receive the same chime: only the first to take the lock plays it. */
const CHIME_LOCK = 'sillage-chime'
const LOCK_HOLD_MS = 1500

function playOnce(event: SoundEvent): void {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks
  if (!locks) {
    playSound(event)
    return
  }
  void locks.request(CHIME_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return
    playSound(event)
    // Held a moment: the other tabs' copies arrive within it, and a burst of events rings once.
    await new Promise((resolve) => setTimeout(resolve, LOCK_HOLD_MS))
  })
}

/** Mounted once by the shell. */
export function useChimes(): void {
  useEffect(() => {
    const removeUnlock = unlockOnGesture()
    const removeChime = wsClient.onChime((kind) => {
      if (!prefs.enabled) return
      const event = EVENT_OF[kind]
      if (event && prefs.choices[event] !== 'off') playOnce(event)
    })
    return () => {
      removeUnlock()
      removeChime()
    }
  }, [])
}
