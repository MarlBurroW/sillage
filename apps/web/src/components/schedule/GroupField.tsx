import { ShieldAlert } from 'lucide-react'
import type { SettingGroup } from '../chat/ComposerSettings'
import { Select } from '../ui'

/** Settings category as a select, matching account defaults. */
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
