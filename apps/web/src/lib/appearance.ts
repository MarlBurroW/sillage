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

  /*
   * Confort de lecture du fil. Ces trois-là ne touchent qu'au texte des messages, pas
   * à l'interface : agrandir la conversation ne doit pas déplacer la barre latérale.
   *
   * `readingSoftness` mélange l'encre vers sa nuance atténuée plutôt que de baisser une
   * opacité : un texte translucide laisse passer le fond, et le rendu change selon ce
   * qu'il y a derrière. Plafonné à 0,6, au-delà le texte cesse d'être lisible plutôt
   * que de devenir doux.
   */
  readingSize: {
    key: 'sillage.readingSize',
    property: '--sg-read-size',
    fallback: 0.9375,
    min: 0.8125,
    max: 1.25,
    step: 0.0625,
  },
  readingLeading: {
    key: 'sillage.readingLeading',
    property: '--sg-read-leading',
    fallback: 1.65,
    min: 1.4,
    max: 2.1,
    step: 0.05,
  },
  readingSoftness: {
    key: 'sillage.readingSoftness',
    property: '--sg-read-softness',
    fallback: 0,
    min: 0,
    max: 0.6,
    step: 0.05,
  },
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
  const [values, setValues] = useState<Record<AppearanceKey, number>>(
    () =>
      Object.fromEntries(
        Object.entries(APPEARANCE_SETTINGS).map(([name, setting]) => [name, read(setting)]),
      ) as Record<AppearanceKey, number>,
  )

  const set = useCallback((name: AppearanceKey, value: number) => {
    const setting = APPEARANCE_SETTINGS[name]
    document.documentElement.style.setProperty(setting.property, String(value))
    localStorage.setItem(setting.key, String(value))
    setValues((current) => ({ ...current, [name]: value }))
  }, [])

  /**
   * Remise à zéro, bornée aux réglages qu'on a sous les yeux : le bouton posé sous les
   * curseurs de typographie ne doit pas emporter la teinte choisie ailleurs.
   */
  const reset = useCallback((names?: AppearanceKey[]) => {
    const targets = names ?? (Object.keys(APPEARANCE_SETTINGS) as AppearanceKey[])
    for (const name of targets) {
      const setting = APPEARANCE_SETTINGS[name]
      document.documentElement.style.removeProperty(setting.property)
      localStorage.removeItem(setting.key)
    }
    setValues((current) => {
      const next = { ...current }
      for (const name of targets) next[name] = APPEARANCE_SETTINGS[name].fallback
      return next
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
