import * as RadixSelect from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslate } from '../../lib/i18n'
import { cx } from './cx'

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** Affichée dans la liste et dans le déclencheur une fois l'option choisie. */
  icon?: ReactNode
  hint?: string
  disabled?: boolean
}

interface SelectProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: SelectOption<T>[]
  label?: string
  placeholder?: string
  disabled?: boolean
  className?: string
}

/**
 * Select applicatif, pas le natif : il porte des icônes et une ligne d'aide par
 * option, ce que `<option>` ne sait pas faire. Radix fournit la navigation clavier,
 * le rôle listbox et le comportement tactile.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  placeholder,
  disabled,
  className,
}: SelectProps<T>) {
  const t = useTranslate()
  const selected = options.find((option) => option.value === value)

  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      {label ? <span className="text-sm font-medium text-ink-soft">{label}</span> : null}

      <RadixSelect.Root
        value={value}
        // Radix interdit la chaîne vide comme valeur d'option, donc une émission vide
        // ne peut correspondre à aucun choix de l'utilisateur : elle vient du select
        // natif caché que Radix maintient pour l'intégration aux formulaires. La
        // laisser remonter écrase le réglage par une valeur que le serveur refuse.
        onValueChange={(v) => {
          if (v !== '') onChange(v as T)
        }}
        disabled={disabled}
      >
        <RadixSelect.Trigger
          className={cx(
            'group flex min-w-0 items-center',
            'transition-colors data-[state=open]:border-accent',
            'disabled:pointer-events-none disabled:opacity-45',
            'tap-target w-full gap-2 rounded-md border border-line bg-sunken px-3 text-sm',
            'text-ink hover:border-line-strong',
          )}
        >
          {selected?.icon ? <span className="shrink-0 text-ink-faint">{selected.icon}</span> : null}
          <span className="min-w-0 truncate">
            <RadixSelect.Value
              placeholder={
                <span className="text-ink-faint">{placeholder ?? t('common.select.placeholder')}</span>
              }
            />
          </span>
          <RadixSelect.Icon
            className={cx(
              'ml-auto shrink-0 text-ink-faint transition-transform',
              'group-data-[state=open]:rotate-180',
            )}
          >
            <ChevronDown size={16} />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={6}
            className={cx(
              'z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden',
              'surface rounded-lg border border-line shadow-pop',
            )}
          >
            <RadixSelect.Viewport className="p-1">
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={cx(
                    'relative flex cursor-pointer items-center gap-2.5 rounded-md py-2 pr-8 pl-2.5',
                    'text-sm text-ink-soft outline-none select-none',
                    'data-[highlighted]:bg-accent-wash data-[highlighted]:text-ink',
                    'data-[state=checked]:text-ink',
                    'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
                  )}
                >
                  {option.icon ? <span className="shrink-0">{option.icon}</span> : null}
                  <span className="min-w-0 flex-1">
                    <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                    {option.hint ? (
                      <span className="block text-xs text-ink-faint">{option.hint}</span>
                    ) : null}
                  </span>
                  <RadixSelect.ItemIndicator className="absolute right-2.5 text-accent">
                    <Check size={15} />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  )
}
