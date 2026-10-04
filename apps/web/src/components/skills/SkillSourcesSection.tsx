import { GitBranch, Library, MoreHorizontal, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { SkillSourceDto } from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import { relativeDate } from '../../lib/dates'
import { useTranslate } from '../../lib/i18n'
import {
  shortCommit,
  useCreateSkillSource,
  useDeleteSkillSource,
  useRefreshSkillSource,
  useSkillSearch,
  useSkillSources,
  useUpdateSkillSource,
} from '../../lib/skill-sources'
import { Badge, Banner, Button, Card, CardBody, ConfirmDialog, Field, IconButton, Menu, MenuItem, MenuSeparator } from '../ui'
import { CatalogDialog } from './CatalogDialog'

const errorOf = (error: unknown): string | null => (error instanceof ApiRequestError ? error.message : null)

/**
 * Les dépôts d'où la bibliothèque s'installe. Les déclarer et les rafraîchir revient aux
 * administrateurs ; parcourir un catalogue est ouvert à tous, pour installer dans les
 * projets qu'on possède.
 */
export function SkillSourcesSection({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslate()
  const { data } = useSkillSources()
  const sources = data?.sources ?? []
  const [browsing, setBrowsing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-soft">{t('skills.sources.title')}</h2>
          <p className="text-xs text-ink-faint">{t('skills.sources.description')}</p>
        </div>
        {isAdmin ? (
          <Button size="sm" variant="secondary" icon={<Plus size={15} />} onClick={() => setAdding(!adding)}>
            {t('skills.sources.add')}
          </Button>
        ) : null}
      </div>

      {adding ? <AddSourceForm onDone={(id) => { setAdding(false); if (id) setBrowsing(id) }} /> : null}
      {isAdmin ? <SkillsShSearch onBrowse={setBrowsing} /> : null}

      {sources.map((source) => (
        <SourceRow key={source.id} source={source} isAdmin={isAdmin} onBrowse={() => setBrowsing(source.id)} />
      ))}

      <CatalogDialog
        key={browsing ?? 'none'}
        open={browsing !== null}
        onClose={() => setBrowsing(null)}
        sourceId={browsing}
        scope="global"
        projectId={null}
      />
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
        <div className="flex items-start gap-3">
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
          <div className="flex shrink-0 items-center gap-1">
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
                  icon={<RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : undefined} />}
                  disabled={refresh.isPending}
                  onClick={() => refresh.mutate(source.id)}
                >
                  {refresh.isPending ? t('skills.sources.refreshing') : t('skills.sources.refresh')}
                </Button>
                <Menu trigger={<IconButton label={t('skills.sources.actions')} size="sm"><MoreHorizontal size={16} /></IconButton>}>
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
        {source.lastError && !refresh.isPending ? <Banner tone="caution">{source.lastError}</Banner> : null}
        {errorOf(update.error) ? <Banner>{errorOf(update.error)}</Banner> : null}
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
        </ConfirmDialog>
      </CardBody>
    </Card>
  )
}

/** Déclarer une source, puis la récupérer d'office : une source vide ne sert à rien. */
function AddSourceForm({ onDone }: { onDone: (sourceId: string | null) => void }) {
  const t = useTranslate()
  const create = useCreateSkillSource()
  const refresh = useRefreshSkillSource()
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subpath, setSubpath] = useState('')
  const busy = create.isPending || refresh.isPending

  const submit = (event: FormEvent) => {
    event.preventDefault()
    create.mutate(
      { url: url.trim(), ref: ref.trim() || null, subpath: subpath.trim().replace(/^\/|\/$/g, '') || null },
      { onSuccess: (source) => refresh.mutate(source.id, { onSettled: () => onDone(source.id) }) },
    )
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field
            label={t('skills.sources.url')}
            hint={t('skills.sources.url.hint')}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('skills.sources.ref')} hint={t('skills.sources.ref.hint')} value={ref} onChange={(event) => setRef(event.target.value)} autoCapitalize="none" />
            <Field label={t('skills.sources.subpath')} hint={t('skills.sources.subpath.hint')} value={subpath} onChange={(event) => setSubpath(event.target.value)} autoCapitalize="none" />
          </div>
          {errorOf(create.error) ? <Banner>{errorOf(create.error)}</Banner> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onDone(null)}>{t('skills.dialog.cancel')}</Button>
            <Button type="submit" disabled={busy || url.trim().length === 0}>
              {busy ? t('skills.sources.adding') : t('skills.sources.add.submit')}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

/**
 * Trouver un dépôt sur skills.sh. Masquée quand l'annuaire ne répond pas comme prévu :
 * son API n'est pas documentée, et rien ici ne dépend de l'utilisateur.
 */
function SkillsShSearch({ onBrowse }: { onBrowse: (sourceId: string) => void }) {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  // Une requête par pause de frappe, pas une par lettre : l'annuaire n'est pas à nous.
  const [settled, setSettled] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const { data, isFetching } = useSkillSearch(settled)
  const create = useCreateSkillSource()
  const refresh = useRefreshSkillSource()
  const [pending, setPending] = useState<string | null>(null)

  if (data && !data.available) return null

  const add = (repository: string) => {
    setPending(repository)
    create.mutate(
      { url: repository },
      {
        onSuccess: (source) => refresh.mutate(source.id, { onSettled: () => { setPending(null); onBrowse(source.id) } }),
        onError: () => setPending(null),
      },
    )
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <Field
          label={t('skills.search.label')}
          hint={t('skills.search.hint')}
          icon={<Search size={15} />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('skills.search.placeholder')}
        />
        {isFetching ? <p className="text-xs text-ink-faint">{t('skills.search.loading')}</p> : null}
        {data && settled.trim().length >= 2 && data.results.length === 0 && !isFetching ? (
          <p className="text-xs text-ink-faint">{t('skills.search.empty')}</p>
        ) : null}
        {data && settled.trim().length >= 2 ? (
          <ul className="flex flex-col gap-1">
            {data.results.map((result) => (
              <li key={`${result.repository}/${result.name}`} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-high">
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-sm">{result.name}</span>
                  <span className="ml-2 font-mono text-xs text-ink-faint">{result.repository}</span>
                </span>
                <span className="shrink-0 text-xs text-ink-faint">{t('skills.search.installs', { count: result.installs })}</span>
                {result.sourceId ? (
                  <Button size="sm" variant="ghost" onClick={() => onBrowse(result.sourceId!)}>{t('skills.sources.browse')}</Button>
                ) : (
                  <Button size="sm" variant="secondary" disabled={pending !== null} onClick={() => add(result.repository)}>
                    {pending === result.repository ? t('skills.sources.adding') : t('skills.search.add')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {errorOf(create.error) ? <Banner>{errorOf(create.error)}</Banner> : null}
      </CardBody>
    </Card>
  )
}
