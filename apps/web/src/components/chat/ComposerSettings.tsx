import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, ShieldAlert, X } from 'lucide-react'
import { Fragment, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../lib/i18n'
import { useMediaQuery } from '../../lib/viewport'
import { Popover, cx } from '../ui'
import { SettingsPanel, type SettingsPanelHandle } from './SettingsPanel'

/**
 * Marque une valeur qui retire un garde-fou. Absente quand il n'y a rien à signaler :
 * un ton « neutre » explicite ne servirait qu'à nommer l'absence de signal.
 */
export type SettingTone = 'caution'

export interface SettingOption {
  value: string
  label: string
  hint?: string
  icon?: ReactNode
  disabled?: boolean
  tone?: SettingTone
}

/** Option dont la valeur reste dans son union d'origine, avant l'élargissement. */
export type SettingChoice<V extends string> = Omit<SettingOption, 'value'> & { value: V }

/**
 * Une catégorie de réglage : une ligne dans le panneau, un écran d'options derrière.
 *
 * Les options sont des données et non du JSX, contrairement à la rangée de sélecteurs
 * qui précédait : la navigation appartient au panneau, lui seul sait ce qui est ouvert,
 * vers quoi revenir et quelle ligne focaliser à l'entrée.
 */
export interface SettingGroup {
  key: string
  label: string
  icon?: ReactNode
  options: SettingOption[]
  value: string
  onChange: (value: string) => void
}

/**
 * Fabrique une catégorie sans perdre le type de la valeur.
 *
 * Le tableau des catégories est hétérogène, donc large sur `string`, et un
 * `SettingGroup<'a'|'b'>` ne s'y assigne pas puisque `onChange` est contravariant.
 * Cette fonction est l'unique point où l'on redescend vers l'union du protocole, et
 * elle vérifie que la valeur vient bien de la liste avant de le faire.
 */
export function setting<V extends string>(group: {
  key: string
  label: string
  icon?: ReactNode
  options: SettingChoice<V>[]
  value: V
  onChange: (value: V) => void
}): SettingGroup {
  return {
    ...group,
    onChange: (value) => {
      if (group.options.some((option) => option.value === value)) group.onChange(value as V)
    },
  }
}

export interface SummarySegment {
  key: string
  label: string
  tone?: SettingTone
  /**
   * Ordre d'effacement quand la barre rétrécit, du plus tenace au plus sacrifiable.
   * Un segment en `caution` reste à 0 : un garde-fou levé ne s'efface jamais.
   */
  drop?: 0 | 1 | 2
}

interface ComposerSettingsProps {
  groups: SettingGroup[]
  summary: SummarySegment[]
  /** Rendu à côté du déclencheur : le contrôle MCP, qui n'est pas un choix unique. */
  aside?: ReactNode
  disabled?: boolean
  /** Où rendre le focus une fois le réglage choisi : la zone de saisie. */
  onDone?: () => void
}

export function ComposerSettings({
  groups,
  summary,
  aside,
  disabled = false,
  onDone,
}: ComposerSettingsProps) {
  const [open, setOpen] = useState(false)
  const panel = useRef<SettingsPanelHandle>(null)
  const t = useTranslate()

  /**
   * Le doigt et le clavier virtuel décident, pas la seule largeur : un panneau ancré
   * au composer se retrouve sous le clavier dès qu'il monte, et la feuille du bas
   * reste dans la moitié d'écran atteignable au pouce.
   *
   * Choix fait en JavaScript et non en classes de conteneur : le panneau est
   * portalisé, donc hors du `@container` du composer, où ces classes ne matchent
   * jamais sans rien signaler.
   */
  const sheet = useMediaQuery('(max-width: 34rem), (pointer: coarse)')

  // Escape remonte d'un cran avant de fermer : sortir du panneau depuis une catégorie
  // ferait repartir de la racine au prochain coup.
  const onEscapeKeyDown = (event: KeyboardEvent) => {
    if (panel.current?.goBack()) event.preventDefault()
  }

  /**
   * Le focus revient à la saisie et non au déclencheur, où Radix le ramène par défaut :
   * on règle un tour pour l'écrire, et devoir recliquer dans le champ après chaque
   * réglage est un aller-retour que rien ne justifie.
   */
  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault()
    onDone?.()
  }

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-label={t('composer.settings.label', {
        // Y compris les segments que la largeur masque : ce que l'œil perd, l'oreille
        // ne doit pas le perdre aussi.
        summary: summary.map((segment) => segment.label).join(' · '),
      })}
      className={cx(
        'group flex h-8 min-w-0 items-center gap-1 rounded-full px-2 text-xs',
        // Fondu dans le composer au repos : il n'est pas un contrôle posé sur la
        // barre, il est la barre. L'affordance vient du survol et du focus.
        'border border-transparent bg-transparent transition-colors',
        'hover:bg-surface-high focus-visible:bg-surface-high',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        'data-[state=open]:bg-surface-high disabled:pointer-events-none disabled:opacity-45',
      )}
    >
      {summary.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 ? (
            <span aria-hidden className="shrink-0 text-ink-faint/60">
              ·
            </span>
          ) : null}
          <span
            className={cx(
              'min-w-0 truncate',
              segment.drop === 2 && '@max-[26rem]:hidden',
              segment.drop === 1 && '@max-[20rem]:hidden',
              segment.tone === 'caution'
                ? 'flex items-center gap-1 rounded-full bg-caution/12 px-1.5 font-medium text-caution'
                : index === 0
                  ? 'font-medium text-ink'
                  : 'text-ink-faint',
            )}
          >
            {segment.tone === 'caution' ? <ShieldAlert size={12} className="shrink-0" /> : null}
            {segment.label}
          </span>
        </Fragment>
      ))}
      <ChevronDown
        size={12}
        className={cx(
          'shrink-0 text-ink-faint opacity-0 transition-opacity',
          'group-hover:opacity-100 group-focus-visible:opacity-100',
          'group-data-[state=open]:opacity-100',
        )}
      />
    </button>
  )

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      {sheet ? (
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
            {/* Feuille ancrée en bas : la moitié d'écran atteignable au pouce, et elle
                s'ouvre à côté du composer d'où elle vient. */}
            <Dialog.Content
              onEscapeKeyDown={onEscapeKeyDown}
              onCloseAutoFocus={onCloseAutoFocus}
              className={cx(
                'surface fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden',
                'rounded-t-xl border-t border-line shadow-pop',
              )}
            >
              {/* Le titre visible est celui du panneau, qui change au fil de la
                  navigation ; Radix en réclame un stable pour l'assistif. */}
              <Dialog.Title className="sr-only">{t('composer.settings.title')}</Dialog.Title>
              <SettingsPanel
                ref={panel}
                groups={groups}
                onDone={() => setOpen(false)}
                trailing={
                  <Dialog.Close
                    aria-label={t('common.close')}
                    className="rounded-md p-1 text-ink-faint transition-colors hover:text-ink"
                  >
                    <X size={18} />
                  </Dialog.Close>
                }
              />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : (
        <Popover
          open={open}
          onOpenChange={setOpen}
          trigger={trigger}
          label={t('composer.settings.title')}
          onEscapeKeyDown={onEscapeKeyDown}
          onCloseAutoFocus={onCloseAutoFocus}
          // Largeur figée : sans elle le bord droit danse à chaque navigation.
          className="w-[min(20rem,var(--radix-popover-content-available-width))]"
        >
          <SettingsPanel ref={panel} groups={groups} onDone={() => setOpen(false)} />
        </Popover>
      )}
      {aside}
    </div>
  )
}
