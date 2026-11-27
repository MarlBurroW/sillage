import { Eye, EyeOff } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { useTranslate } from '../../lib/i18n'
import { IconButton } from './Button'
import { Field, type FieldProps } from './Field'

/**
 * Password input that can show what was typed and warns when Caps Lock is on: the two usual
 * reasons a correct password is refused, a slip on a phone keyboard and a key left locked.
 */
export function PasswordField({ hint, onKeyDown, onKeyUp, onBlur, ...props }: Omit<FieldProps, 'type' | 'trailing'>) {
  const t = useTranslate()
  const [revealed, setRevealed] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  // Read on every key, not only on Caps Lock itself: the field may gain focus with it already on.
  const readCapsLock = (event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState('CapsLock'))

  return (
    <Field
      {...props}
      type={revealed ? 'text' : 'password'}
      hint={capsLock ? t('common.password.capsLock') : hint}
      onKeyDown={(event) => {
        readCapsLock(event)
        onKeyDown?.(event)
      }}
      onKeyUp={(event) => {
        readCapsLock(event)
        onKeyUp?.(event)
      }}
      onBlur={(event) => {
        setCapsLock(false)
        onBlur?.(event)
      }}
      trailing={
        <IconButton
          type="button"
          size="sm"
          label={t(revealed ? 'common.password.hide' : 'common.password.show')}
          onClick={() => setRevealed((shown) => !shown)}
          className="-mr-2"
        >
          {revealed ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </IconButton>
      }
    />
  )
}
