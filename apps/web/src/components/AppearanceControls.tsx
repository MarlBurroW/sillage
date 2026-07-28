import { RotateCcw } from 'lucide-react'
import { APPEARANCE_SETTINGS, type AppearanceKey, type useAppearance } from '../lib/appearance'
import { Button, cx } from './ui'

const LABELS: Record<AppearanceKey, { title: string; hint: string }> = {
  hue: { title: 'Teinte', hint: 'Partagée avec la couleur d’accent' },
  tint: { title: 'Intensité', hint: 'Chroma des surfaces, sans toucher aux accents' },
  lift: { title: 'Luminosité', hint: 'Éclaircit ou assombrit le shading, texte inchangé' },
  readingSize: { title: 'Taille du texte', hint: 'Messages du fil uniquement' },
  readingLeading: { title: 'Interligne', hint: 'Air entre les lignes d’un paragraphe' },
  readingSoftness: {
    title: 'Douceur du texte',
    hint: 'Rapproche l’encre du gris : moins dur sur fond très sombre',
  },
}

/**
 * Réglages fins du thème : teinte, intensité, luminosité.
 *
 * Le hook vit chez l'appelant plutôt qu'ici : la page de design affiche les valeurs
 * sRGB résolues et doit donc se redessiner au bougé du curseur, ce qu'un état interne
 * au composant ne déclencherait pas.
 */
export function AppearanceControls({
  appearance,
  /** Curseurs à afficher : tous les thèmes ne réagissent pas aux mêmes réglages. */
  keys = ['hue', 'tint', 'lift'],
  swatches = true,
}: {
  appearance: ReturnType<typeof useAppearance>
  keys?: AppearanceKey[]
  /** La bande de surfaces ne dit rien des réglages de typographie. */
  swatches?: boolean
}) {
  const { values, set, reset } = appearance

  return (
    <div className="flex flex-col gap-4">
      {keys.map((name) => (
        <Slider
          key={name}
          name={name}
          value={values[name]}
          onChange={(value) => set(name, value)}
        />
      ))}

      {/* Aperçu vivant : les curseurs s'appliquent à <html>, ces surfaces suivent donc
          en direct, comme le reste de l'application. Il ne s'affiche que pour les
          réglages de couleur : sous des curseurs de typographie, une bande de surfaces
          ne montrerait rien de ce qu'ils changent. */}
      <div className="flex items-center gap-2">
        {swatches ? (
          <div className="flex flex-1 overflow-hidden rounded-md border border-line">
            <span className="h-8 flex-1 bg-canvas" />
            <span className="h-8 flex-1 bg-surface" />
            <span className="h-8 flex-1 bg-surface-high" />
            <span className="h-8 flex-1 bg-accent-wash" />
            <span className="gradient-accent h-8 flex-1" />
          </div>
        ) : (
          <span className="flex-1" />
        )}
        <Button variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => reset(keys)}>
          Défaut
        </Button>
      </div>
    </div>
  )
}

/**
 * Roue des teintes en fond du curseur, aux mêmes luminosité et chroma que l'accent
 * réel : choisir sa couleur à vue plutôt qu'en balayant le curseur à l'aveugle.
 *
 * Les arrêts sont calculés une fois : `oklch()` n'interpole pas dans un dégradé CSS,
 * un `linear-gradient` de deux teintes traverserait le gris au lieu du spectre.
 */
const HUE_STOPS = Array.from({ length: 13 }, (_, index) => {
  const hue = (index * 360) / 12
  return `oklch(0.62 0.19 ${hue}) ${(index * 100) / 12}%`
}).join(', ')

function Slider({
  name,
  value,
  onChange,
}: {
  name: AppearanceKey
  value: number
  onChange: (value: number) => void
}) {
  const setting = APPEARANCE_SETTINGS[name]
  const { title, hint } = LABELS[name]
  const spectrum = name === 'hue'

  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-3 text-sm font-medium text-ink-soft">
        <span className="min-w-0 truncate">
          {title} <span className="text-xs font-normal text-ink-faint">{hint}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-ink">
          {spectrum ? (
            <span
              aria-hidden
              className="size-3 rounded-full border border-line"
              style={{ background: `oklch(0.62 0.19 ${value})` }}
            />
          ) : null}
          {spectrum ? `${value}°` : value}
        </span>
      </span>
      <input
        type="range"
        min={setting.min}
        max={setting.max}
        step={setting.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={cx('h-9 w-full', spectrum ? 'sg-hue-slider' : 'accent-[var(--sg-accent)]')}
        style={spectrum ? { background: `linear-gradient(90deg, ${HUE_STOPS})` } : undefined}
      />
    </label>
  )
}
