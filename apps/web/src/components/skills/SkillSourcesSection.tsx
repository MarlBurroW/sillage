import { SkillLoading } from './SkillLoading'
import { GitBranch, Library, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { SkillSourceDto } from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import { relativeDate } from '../../lib/dates'
import { useTranslate } from '../../lib/i18n'
import {
  shortCommit,
  useCreateSkillSource,
  useDeleteSkillSource,
  useRefreshSkillSource,
  useSkillSources,
  useUpdateSkillSource,
} from '../../lib/skill-sources'
import { Badge, Banner, Button, Card, CardBody, ConfirmDialog, Field, IconButton, Menu, MenuItem, MenuSeparator } from '../ui'
import { CatalogDialog } from './CatalogDialog'
import { SkillDialog } from './SkillDialog'

const errorOf = (error: unknown): string | null => (error instanceof ApiRequestError ? error.message : null)

/** Catalog destination: source and optional initial skill. */
interface Browsing {
  sourceId: string
  skillName: string | null
}

/**
 * Repositories supplying library skills. Administrators declare and refresh sources; everyone can
 * browse to install within owned projects.
 */
export function SkillSourcesSection({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslate()
  const { data, isLoading, error } = useSkillSources()
  const sources = data?.sources ?? []
  const [browsing, setBrowsing] = useState<Browsing | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-soft">{t('skills.sources.title')}</h2>
          <p className="text-xs text-ink-faint">{t('skills.sources.description')}</p>
        </div>
        {isAdmin ? (
          <Button size="sm" variant="secondary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>
            {t('skills.sources.add')}
          </Button>
        ) : null}
      </div>

      {adding ? <AddSourceDialog onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setBrowsing({ sourceId: id, skillName: null }) }} /> : null}
      {isLoading ? <SkillLoading label={t('skills.loading.sources')} rows={3} /> : null}
      {error ? <Banner>{error.message}</Banner> : null}
      {!isLoading && !error && sources.length === 0 ? <p className="py-8 text-center text-sm text-ink-faint">{t('skills.sources.empty')}</p> : null}

      {sources.map((source) => (
        <SourceRow
          key={source.id}
          source={source}
          isAdmin={isAdmin}
          onBrowse={() => setBrowsing({ sourceId: source.id, skillName: null })}
        />
      ))}

      {browsing ? <CatalogDialog
        key={browsing ? `${browsing.sourceId}:${browsing.skillName ?? ''}` : 'none'}
        open
        onClose={() => setBrowsing(null)}
        sourceId={browsing?.sourceId ?? null}
        skillName={browsing?.skillName ?? null}
        scope="global"
        projectId={null}
      /> : null}
    </section>
  )
}

function SourceRow({ source, isAdmin, onBrowse }: { source: SkillSourceDto; isAdmin: boolean; onBrowse: () => void }) {
  const t = useTranslate()
  const refresh = useRefreshSkillSource()
  const update = useUpdateSkillSource()
  const remove = useDeleteSkillSource()
  const [confirming, setConfirming] = useState(false)
  const fetched = source.lastCommit !== null

  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-wash text-accent">
            <GitBranch size={15} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{source.name}</span>
              {source.builtin ? <Badge>{t('skills.sources.builtin')}</Badge> : null}
              {!source.enabled ? <Badge>{t('skills.state.disabled')}</Badge> : null}
            </div>
            <p className="truncate font-mono text-xs text-ink-faint">
              {source.url}
              {source.ref ? ` @ ${source.ref}` : ''}
              {source.subpath ? ` · ${source.subpath}/` : ''}
            </p>
            <p className="text-xs text-ink-faint">
              {fetched && source.lastFetchedAt !== null
                ? t('skills.sources.fetched', {
                    count: source.skillCount ?? 0,
                    commit: shortCommit(source.lastCommit),
                    when: relativeDate(source.lastFetchedAt),
                  })
                : t('skills.sources.never')}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {fetched && source.enabled ? (
              <Button size="sm" variant="ghost" icon={<Library size={14} />} onClick={onBrowse}>
                {t('skills.sources.browse')}
              </Button>
            ) : null}
            {isAdmin ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RefreshCw size={14} />}
                  busy={refresh.isPending} disabled={update.isPending}
                  onClick={() => refresh.mutate(source.id)}
                >
                  {refresh.isPending ? t('skills.sources.refreshing') : t('skills.sources.refresh')}
                </Button>
                <Menu trigger={<IconButton disabled={refresh.isPending || update.isPending} label={t('skills.sources.actions')} size="sm"><MoreHorizontal size={16} /></IconButton>}>
                  <MenuItem onSelect={() => update.mutate({ id: source.id, enabled: !source.enabled })}>
                    {t(source.enabled ? 'skills.action.disable' : 'skills.action.enable')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 size={15} />} tone="critical" onSelect={() => setConfirming(true)}>
                    {t('skills.action.delete')}
                  </MenuItem>
                </Menu>
              </>
            ) : null}
          </div>
        </div>
        {refresh.isPending ? <SkillLoading label={t('skills.sources.refreshing')} detail={source.name} /> : null}
        {update.isPending ? <SkillLoading compact label={t('skills.editor.saving')} /> : null}
        {source.lastError && !refresh.isPending ? <Banner tone="caution">{source.lastError}</Banner> : null}
        {errorOf(update.error) ? <Banner>{errorOf(update.error)}</Banner> : null}
        {errorOf(refresh.error) ? <Banner>{errorOf(refresh.error)}</Banner> : null}
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('skills.sources.delete.title', { name: source.name })}
          confirmLabel={t('skills.sources.delete.confirm')}
          tone="critical"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(source.id)}
        >
          {t('skills.sources.delete.body')}
          {remove.error ? <Banner>{remove.error.message}</Banner> : null}
        </ConfirmDialog>
      </CardBody>
    </Card>
  )
}

/** Retain the created source on fetch failure so retry never attempts to register it again. */
export function AddSourceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const t = useTranslate()
  const create = useCreateSkillSource()
  const refresh = useRefreshSkillSource()
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subpath, setSubpath] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const busy = create.isPending || refresh.isPending
  const retrieve = (id: string) => refresh.mutate(id, { onSuccess: () => onAdded(id) })
  return <SkillDialog open onClose={onClose} title={t('skills.sources.add')}
    submitLabel={t(busy ? 'skills.sources.adding' : created ? 'skills.sources.retry' : 'skills.sources.add.submit')}
    busy={busy} canSubmit={!!created || url.trim().length > 0}
    onSubmit={() => {
      if (created) return retrieve(created)
      create.mutate({ url: url.trim(), ref: ref.trim() || null, subpath: subpath.trim().replace(/^\/|\/$/g, '') || null }, {
        onSuccess: (source) => { setCreated(source.id); retrieve(source.id) },
      })
    }}>
    <Field label={t('skills.sources.url')} hint={t('skills.sources.url.hint')} value={url}
      onChange={(event) => setUrl(event.target.value)} disabled={busy || !!created}
      autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
    <Field label={t('skills.sources.ref')} hint={t('skills.sources.ref.hint')} value={ref}
      onChange={(event) => setRef(event.target.value)} disabled={busy || !!created} autoCapitalize="none" />
    <Field label={t('skills.sources.subpath')} hint={t('skills.sources.subpath.hint')} value={subpath}
      onChange={(event) => setSubpath(event.target.value)} disabled={busy || !!created} autoCapitalize="none" />
    {busy ? <SkillLoading label={t(refresh.isPending ? 'skills.sources.refreshing' : 'skills.sources.adding')} detail={url} /> : null}
    {create.error ? <Banner>{create.error.message}</Banner> : null}
    {refresh.error ? <Banner>{refresh.error.message}</Banner> : null}
  </SkillDialog>
}
