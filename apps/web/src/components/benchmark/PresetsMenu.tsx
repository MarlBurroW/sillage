import { Bookmark, BookmarkCheck, BookmarkPlus, FlaskConical, Settings2 } from 'lucide-react'
import type { BenchmarkDto, BenchmarkPresetDto } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { Menu, MenuItem, MenuLabel, MenuSeparator, cx } from '../ui'
import { TooltipButton } from '../ui/Tooltip'
import { presetSummary } from './PresetDialogs'

/** Recent benchmarks offered as starting lineups: enough to find last week's, short enough for a phone. */
const RECENT_BENCHMARKS = 5

/**
 * Where a lineup comes from and goes to: saved presets, the lineups of recent benchmarks, and
 * saving or updating a preset. Loading replaces the lineup at once; the form offers to undo it.
 */
export function PresetsMenu({ presets, benchmarks, loaded, updateBlocked, onLoadPreset, onLoadBenchmark, onSaveAs, onUpdate, onManage }: {
  presets: BenchmarkPresetDto[] | undefined
  benchmarks: BenchmarkDto[] | undefined
  /** Preset the form was loaded from, and whether the form changed since. */
  loaded: { name: string; modified: boolean } | null
  /** Why the form cannot be written to a preset right now (an invalid run setting); null when it can. */
  updateBlocked: string | null
  onLoadPreset: (preset: BenchmarkPresetDto) => void
  onLoadBenchmark: (benchmark: BenchmarkDto) => void
  onSaveAs: () => void
  onUpdate: () => void
  onManage: () => void
}) {
  const t = useTranslate()
  const recent = (benchmarks ?? []).slice(0, RECENT_BENCHMARKS)
  return (
    <Menu
      align="end"
      scrollable
      trigger={
        <TooltipButton
          type="button"
          title={t('benchmark.preset.menuHint')}
          aria-label={t('benchmark.preset.menu')}
          className={cx(
            'surface inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-line px-3 text-sm font-medium text-ink transition-colors hover:border-line-strong md:h-9 pointer-coarse:h-11',
            'max-sm:w-11 max-sm:justify-center max-sm:px-0',
          )}
          data-presets-menu
        >
          {loaded ? <BookmarkCheck size={15} className="text-accent" /> : <Bookmark size={15} />}
          <span className="max-sm:sr-only">{t('benchmark.preset.menu')}</span>
        </TooltipButton>
      }
    >
      <MenuLabel>{t('benchmark.preset.saved')}</MenuLabel>
      {presets?.length ? presets.map((preset) => (
        <MenuItem key={preset.id} icon={<Bookmark size={14} />} onSelect={() => onLoadPreset(preset)}>
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{preset.name}</span>
            <span className="text-xs text-ink-faint">{presetSummary(t, preset.variants.length, preset.repetitions)}</span>
          </span>
        </MenuItem>
      )) : <p className="max-w-64 px-2.5 pb-2 text-xs text-ink-faint">{t('benchmark.preset.none')}</p>}
      {recent.length ? <>
        <MenuSeparator />
        <MenuLabel>{t('benchmark.preset.recent')}</MenuLabel>
        {recent.map((benchmark) => (
          <MenuItem key={benchmark.id} icon={<FlaskConical size={14} />} onSelect={() => onLoadBenchmark(benchmark)}>
            <span className="flex min-w-0 flex-col">
              <span className="max-w-64 truncate">{benchmark.name}</span>
              <span className="text-xs text-ink-faint">{presetSummary(t, benchmark.variants.length, benchmark.repetitions)}</span>
            </span>
          </MenuItem>
        ))}
      </> : null}
      <MenuSeparator />
      <MenuItem icon={<BookmarkPlus size={14} />} onSelect={onSaveAs}>{t('benchmark.preset.saveAs')}</MenuItem>
      {loaded?.modified ? <>
        <MenuItem icon={<BookmarkCheck size={14} />} disabled={updateBlocked !== null} onSelect={onUpdate}>{t('benchmark.preset.update', { name: loaded.name })}</MenuItem>
        {updateBlocked ? <p className="max-w-64 px-2.5 pb-1.5 text-xs text-caution">{updateBlocked}</p> : null}
      </> : null}
      <MenuItem icon={<Settings2 size={14} />} disabled={!presets?.length} onSelect={onManage}>{t('benchmark.preset.manage')}</MenuItem>
    </Menu>
  )
}
