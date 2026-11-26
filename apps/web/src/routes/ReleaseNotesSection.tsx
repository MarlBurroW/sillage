import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { ReleaseHistoryEntry } from '@sillage/protocol'
import { ReleaseNote } from '../components/ReleaseNote'
import { Badge, Button, Card, CardBody } from '../components/ui'
import { useTranslate } from '../lib/i18n'
import { useReleaseHistory } from '../lib/system'
import { SectionHeader } from './SettingsPage'

/**
 * Open at first: what an update would bring, then what the installed version brought. A
 * development build places itself nowhere, so only the latest release opens.
 */
function opensFirst(release: ReleaseHistoryEntry, index: number): boolean {
  return release.relation === 'newer' || release.relation === 'installed' || (release.relation === null && index === 0)
}

/**
 * Every recent version's notes, readable before updating and at any time after. The update
 * itself stays on the About page, which knows how this installation updates.
 */
export function ReleaseNotesSection() {
  const t = useTranslate()
  const navigate = useNavigate()
  const { data, isPending } = useReleaseHistory()
  // Rows the reader flipped away from their initial state.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set())
  const releases = data?.releases ?? []
  const latest = releases[0]

  const flip = (tag: string) =>
    setFlipped((current) => {
      const next = new Set(current)
      if (!next.delete(tag)) next.add(tag)
      return next
    })

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('settings.section.releaseNotes')} description={t('releaseNotes.description')} />

      {data?.updateAvailable && latest ? (
        <Card>
          {/* Wraps rather than sitting beside the text: on a phone the text column got three words wide. */}
          <CardBody className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="min-w-0 flex-1 basis-64">
              <h3 className="text-[0.9375rem] leading-tight font-semibold">
                {t('releaseNotes.update.title', { version: latest.tag.replace(/^v/, '') })}
              </h3>
              <p className="mt-1 text-sm text-ink-faint">{t('releaseNotes.update.description', { version: data.version })}</p>
            </div>
            <Button variant="secondary" onClick={() => navigate('/settings/a-propos')}>
              {t('releaseNotes.update.open')}
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {isPending ? (
        <p className="text-sm text-ink-faint">{t('releaseNotes.loading')}</p>
      ) : releases.length === 0 ? (
        <p className="text-sm text-ink-faint">
          {data?.checkError === 'rate_limited'
            ? t('releaseNotes.error.rateLimited')
            : data?.checkError
              ? t('releaseNotes.error.network')
              : t('releaseNotes.empty')}
        </p>
      ) : (
        <Card>
          <CardBody className="flex flex-col gap-3">
            {releases.map((release, index) => (
              <ReleaseNote
                key={release.tag}
                release={release}
                open={opensFirst(release, index) !== flipped.has(release.tag)}
                onToggle={() => flip(release.tag)}
                badge={
                  release.relation === 'newer' ? (
                    <Badge tone="accent">{t('releaseNotes.badge.newer')}</Badge>
                  ) : release.relation === 'installed' ? (
                    <Badge tone="positive">{t('releaseNotes.badge.installed')}</Badge>
                  ) : null
                }
              />
            ))}
          </CardBody>
        </Card>
      )}

      {/* GitHub returns the most recent releases only: the rest of the history lives there. */}
      {releases.length > 0 ? (
        <a
          href="https://github.com/MarlBurroW/sillage/releases"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 self-start text-sm text-ink-faint hover:text-ink"
        >
          {t('releaseNotes.older')}
          <ExternalLink size={13} />
        </a>
      ) : null}
    </div>
  )
}
