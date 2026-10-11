import { ShieldAlert } from 'lucide-react'
import type { SettingGroup } from '../chat/ComposerSettings'
import { Select } from '../ui'

/** Une catégorie de réglage en liste déroulante, comme sur l'écran des défauts du compte. */
export function GroupField({ group }: { group: SettingGroup }) {
  const selected = group.options.find((option) => option.value === group.value)
  return (
    <div className="flex flex-col gap-1.5">
      <Select label={group.label} value={group.value} options={group.options} onChange={group.onChange} />
      {selected?.tone === 'caution' ? (
        <p className="flex items-start gap-1.5 text-xs text-caution">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          <span>{selected.hint}</span>
        </p>
      ) : null}
    </div>
  )
}
