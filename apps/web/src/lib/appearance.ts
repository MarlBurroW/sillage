import { useCallback, useState } from 'react'

/**
 * Réglages fins du thème, appliqués sur `<html>` pour que toute l'application suive.
 *
 * `hue` est partagée avec la couleur d'accent, `tint` multiplie la chroma des surfaces
 * sans toucher aux accents, `lift` décale leur luminosité sans toucher au texte.
 */

export interface AppearanceSetting {
  key: string
  property: string
  fallback: number
  min: number
  max: number
  step: number
}

export const APPEARANCE_SETTINGS = {
  hue: { key: 'sillage.hue', property: '--sg-hue', fallback: 275, min: 0, max: 360, step: 1 },
  tint: { key: 'sillage.tint', property: '--sg-tint', fallback: 1, min: 0, max: 2.5, step: 0.05 },
  // Bornes volontairement étroites : au-delà, les surfaces rejoignent le texte et le
  // contraste s'effondre au lieu de simplement s'éclaircir.
  lift: { key: 'sillage.lift', property: '--sg-lift', fallback: 0, min: -0.06, max: 0.12, step: 0.005 },
} satisfies Record<string, AppearanceSetting>

export type AppearanceKey = keyof typeof APPEARANCE_SETTINGS

function read({ key, fallback }: AppearanceSetting): number {
  const raw = localStorage.getItem(key)
  if (raw === null) return fallback
  const parsed = Number(raw)
  // `lift` accepte le zéro et les valeurs négatives : ne filtrer que sur la finitude.
  return Number.isFinite(parsed) ? parsed : fallback
}

export function useAppearance() {
  const [values, setValues] = useState<Record<AppearanceKey, number>>(() => ({
    hue: read(APPEARANCE_SETTINGS.hue),
    tint: read(APPEARANCE_SETTINGS.tint),
    lift: read(APPEARANCE_SETTINGS.lift),
  }))

  const set = useCallback((name: AppearanceKey, value: number) => {
    const setting = APPEARANCE_SETTINGS[name]
    document.documentElement.style.setProperty(setting.property, String(value))
    localStorage.setItem(setting.key, String(value))
    setValues((current) => ({ ...current, [name]: value }))
  }, [])

  const reset = useCallback(() => {
    for (const setting of Object.values(APPEARANCE_SETTINGS)) {
      document.documentElement.style.removeProperty(setting.property)
      localStorage.removeItem(setting.key)
    }
    setValues({
      hue: APPEARANCE_SETTINGS.hue.fallback,
      tint: APPEARANCE_SETTINGS.tint.fallback,
      lift: APPEARANCE_SETTINGS.lift.fallback,
    })
  }, [])

  return { values, set, reset }
}

/** Couleur résolue d'un token, pour afficher les valeurs réelles à l'écran. */
export function resolveToken(token: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value
}
