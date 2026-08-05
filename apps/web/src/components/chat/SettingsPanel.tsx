import { ArrowLeft, Check, ChevronRight } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'
import type { SettingGroup } from './ComposerSettings'

export interface SettingsPanelHandle {
  /** Remonte d'un cran. Faux quand on est déjà à la racine, à la coque de conclure. */
  goBack: () => boolean
}

interface SettingsPanelProps {
  groups: SettingGroup[]
  /** Appelé quand une valeur est choisie : le panneau a fini son office. */
  onDone: () => void
  /** Coin de l'en-tête laissé à la coque, pour son bouton de fermeture. */
  trailing?: ReactNode
}

/**
 * Réglages de la conversation, en deux étages : la liste des catégories, puis les
 * options de celle qu'on ouvre.
 *
 * Sans positionnement ni coque : c'est ce qui permet au panneau ancré du bureau et à
 * la feuille du tactile d'être le même écran, au lieu de deux interfaces à faire
 * dériver l'une de l'autre.
 */
export const SettingsPanel = forwardRef<SettingsPanelHandle, SettingsPanelProps>(
  function SettingsPanel({ groups, onDone, trailing }, ref) {
    const t = useTranslate()
    const titleId = useId()
    const [openKey, setOpenKey] = useState<string | null>(null)
    const open = groups.find((group) => group.key === openKey) ?? null

    // D'où l'on vient, pour y reposer le focus au retour. Sans cela il retombe sur
    // le document et le panneau devient impraticable au clavier.
    const rows = useRef(new Map<string, HTMLButtonElement | null>())
    const heading = useRef<HTMLHeadingElement>(null)

    // Entrer dans une catégorie remplace tout le contenu : le lecteur d'écran doit
    // être emmené sur le nouveau titre, sinon il continue d'annoncer une ligne partie.
    useEffect(() => {
      if (openKey) heading.current?.focus()
    }, [openKey])

    const back = () => {
      const from = openKey
      setOpenKey(null)
      // Après le rendu de la racine, pas avant : la ligne n'existe pas encore.
      requestAnimationFrame(() => from && rows.current.get(from)?.focus())
    }

    useImperativeHandle(ref, () => ({
      goBack: () => {
        if (!openKey) return false
        back()
        return true
      },
    }))

    // La catégorie ouverte s'est volatilisée : le catalogue a changé sous nos pieds
    // (modèle sans niveaux d'effort, modes que le CLI ne déclare plus).
    useEffect(() => {
      if (openKey && !groups.some((group) => group.key === openKey)) setOpenKey(null)
    }, [groups, openKey])

    if (open) {
      return (
        <>
          <header className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
            <button
              type="button"
              onClick={back}
              aria-label={t('composer.settings.back')}
              className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-accent-wash hover:text-ink"
            >
              <ArrowLeft size={16} />
            </button>
            <h2
              ref={heading}
              id={titleId}
              // Focalisable sans entrer dans le parcours de tabulation : cible d'un
              // déplacement programmatique, pas une étape de la navigation.
              tabIndex={-1}
              className="min-w-0 flex-1 truncate text-sm font-semibold outline-none"
            >
              {open.label}
            </h2>
            {trailing}
          </header>

          <OptionList
            group={open}
            labelledBy={titleId}
            onPick={(value) => {
              open.onChange(value)
              onDone()
            }}
          />
        </>
      )
    }

    return (
      <>
        <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold">
            {t('composer.settings.title')}
          </h2>
          {trailing}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-1 pb-safe">
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              ref={(node) => {
                rows.current.set(group.key, node)
              }}
              onClick={() => setOpenKey(group.key)}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm',
                'text-ink-soft transition-colors outline-none',
                'hover:bg-accent-wash hover:text-ink focus-visible:bg-accent-wash focus-visible:text-ink',
              )}
            >
              {group.icon ? <span className="shrink-0 text-ink-faint">{group.icon}</span> : null}
              <span className="flex min-w-0 flex-col items-start">
                <span className="shrink-0">{group.label}</span>
                {group.notice ? (
                  <span className="max-w-full truncate text-[0.6875rem] text-caution">
                    {group.notice}
                  </span>
                ) : null}
              </span>
              <ValueLabel group={group} />
              <ChevronRight size={14} className="shrink-0 text-ink-faint" />
            </button>
          ))}
        </div>
      </>
    )
  },
)

/** Valeur en cours, à droite de la ligne. Elle est le résumé de la catégorie. */
function ValueLabel({ group }: { group: SettingGroup }) {
  const selected = group.options.find((option) => option.value === group.value)
  return (
    <span
      className={cx(
        'ml-auto min-w-0 truncate text-xs',
        selected?.tone === 'caution' ? 'font-medium text-caution' : 'text-ink-faint',
      )}
    >
      {selected?.label ?? group.value}
    </span>
  )
}

/**
 * Les options en groupe de boutons radio, et non en liste de boutons : c'est la seule
 * forme qui fasse annoncer laquelle est active. Le focus se déplace aux flèches sans
 * choisir, Entrée ou Espace valide — choisir au passage fermerait le panneau à la
 * première flèche.
 */
function OptionList({
  group,
  labelledBy,
  onPick,
}: {
  group: SettingGroup
  labelledBy: string
  onPick: (value: string) => void
}) {
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const selectable = group.options
    .map((option, index) => ({ option, index }))
    .filter((entry) => !entry.option.disabled)

  const move = (from: number, step: number) => {
    if (selectable.length === 0) return
    const at = selectable.findIndex((entry) => entry.index === from)
    const next = selectable[(at + step + selectable.length) % selectable.length]
    if (next) items.current[next.index]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0
    if (step !== 0) {
      event.preventDefault()
      move(index, step)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const edge = event.key === 'Home' ? selectable[0] : selectable[selectable.length - 1]
      if (edge) items.current[edge.index]?.focus()
    }
  }

  const checkedIndex = group.options.findIndex((option) => option.value === group.value)

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="min-h-0 flex-1 overflow-y-auto p-1 pb-safe"
    >
      {group.options.map((option, index) => {
        const checked = index === checkedIndex
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={option.disabled}
            ref={(node) => {
              items.current[index] = node
            }}
            // Un seul arrêt de tabulation pour tout le groupe : celui qui est coché,
            // ou le premier si la valeur en cours n'est pas dans la liste.
            tabIndex={checked || (checkedIndex === -1 && index === 0) ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => onPick(option.value)}
            className={cx(
              'relative flex w-full items-start gap-2.5 rounded-md py-2 pr-2.5 pl-8 text-left',
              'text-sm transition-colors outline-none',
              'hover:bg-accent-wash focus-visible:bg-accent-wash',
              'disabled:pointer-events-none disabled:opacity-45',
              option.tone === 'caution' ? 'text-caution' : checked ? 'text-ink' : 'text-ink-soft',
            )}
          >
            {checked ? <Check size={15} className="absolute top-2.5 left-2.5 text-accent" /> : null}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                {option.icon ? <span className="shrink-0">{option.icon}</span> : null}
                {option.label}
              </span>
              {option.hint ? (
                <span className="block text-xs text-ink-faint">{option.hint}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
