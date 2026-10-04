import * as Dialog from '@radix-ui/react-dialog'
import { HardDrive, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { skillNameSchema, type LibrarySkillScope, type LocalSkillDto } from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import { useTranslate } from '../../lib/i18n'
import { useAdoptLocalSkill, useLocalSkills } from '../../lib/skill-library'
import { Badge, Banner, Button, EmptyState, IconButton } from '../ui'
import { NameField } from './SkillDialog'
import { originLabel } from './SkillList'

/**
 * Les skills que la machine porte déjà, chacun lu par un seul CLI. Les reprendre les
 * copie dans la bibliothèque, d'où ils servent aux deux ; l'original reste en place.
 *
 * Un skill de dépôt ne se reprend que dans son projet : c'est le seul où le serveur lit
 * ce dépôt.
 */
export function LocalSkillsDialog({
  open,
  onClose,
  scope,
  projectId,
}: {
  open: boolean
  onClose: () => void
  scope: LibrarySkillScope
  projectId: string | null
}) {
  const t = useTranslate()
  const { data, isLoading } = useLocalSkills(projectId, open)
  const skills = (data?.skills ?? []).filter((skill) => scope === 'project' || !skill.origin.endsWith('-repo'))

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(680px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">{t('skills.local.title')}</Dialog.Title>
            <IconButton label={t('skills.dialog.close')} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
            <p className="text-sm text-ink-faint">{t('skills.local.description')}</p>
            {isLoading ? (
              <p className="text-sm text-ink-faint">{t('skills.local.loading')}</p>
            ) : skills.length === 0 ? (
              <EmptyState icon={<HardDrive size={22} />} title={t('skills.local.empty')} />
            ) : (
              skills.map((skill) => (
                <LocalSkillRow key={skill.path} skill={skill} scope={scope} projectId={projectId} onAdopted={onClose} />
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function LocalSkillRow({
  skill,
  scope,
  projectId,
  onAdopted,
}: {
  skill: LocalSkillDto
  scope: LibrarySkillScope
  projectId: string | null
  onAdopted: () => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const adopt = useAdoptLocalSkill()
  /** Un nom à choisir, d'office pour un nom invalide, après coup pour un nom pris. */
  const [renaming, setRenaming] = useState(skill.problem === 'skill_name_invalid')
  const [name, setName] = useState('')

  const submit = () =>
    adopt.mutate(
      { scope, projectId, path: skill.path, ...(renaming ? { name } : {}) },
      {
        onSuccess: (created) => { onAdopted(); navigate(`/skills/${created.id}`) },
        onError: (error) => {
          if (error instanceof ApiRequestError && error.code === 'skill_name_taken') setRenaming(true)
        },
      },
    )

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium">{skill.name}</span>
            <Badge>{originLabel(skill.origin)}</Badge>
            {skill.problem ? <Badge tone="critical">{t(`skills.problem.${skill.problem}`)}</Badge> : null}
          </div>
          <p className="line-clamp-2 text-sm text-ink-faint">{skill.description}</p>
          <p className="truncate font-mono text-xs text-ink-faint">{skill.path}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={skill.problem === 'skill_unreadable' || adopt.isPending || (renaming && !skillNameSchema.safeParse(name).success)}
          onClick={submit}
        >
          {adopt.isPending ? t('skills.local.adopting') : t('skills.local.adopt')}
        </Button>
      </div>
      {renaming ? <NameField value={name} onChange={setName} /> : null}
      {adopt.error instanceof ApiRequestError ? <Banner tone="caution">{adopt.error.message}</Banner> : null}
    </div>
  )
}
