import { Maximize2, Minimize2 } from 'lucide-react'
import { toggleConcentration, useConcentration } from '../../lib/concentration'
import { useTranslate } from '../../lib/i18n'
import { IconButton } from '../ui'

export function ConcentrationButton() {
  const active = useConcentration()
  const t = useTranslate()
  return <IconButton data-concentration-toggle aria-pressed={active}
    label={t(active ? 'concentration.exit' : 'concentration.enter')} onClick={toggleConcentration}>
    {active ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
  </IconButton>
}
