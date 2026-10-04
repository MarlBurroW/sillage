import { BookOpen } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslate } from '../../lib/i18n'
import { useLocalSkills, useSkillLibrary } from '../../lib/skill-library'
import { Badge, Banner, Card, CardBody, CardHeader } from '../ui'
import { AddSkillMenu } from './AddSkillMenu'
import { SkillList, originLabel } from './SkillList'

/**
 * Les skills d'un projet, sur sa page : ceux de la bibliothèque, éditables par le
 * propriétaire, et ceux que le dépôt porte déjà, en lecture seule.
 *
 * Ces derniers sont montrés parce qu'ils ne servent qu'à un CLI chacun : un
 * `.claude/skills` n'existe pas pour Codex, ni un `.agents/skills` pour Claude. Le menu
 * d'ajout propose de les reprendre, ce qui les livre aux deux.
 */
export function ProjectSkills({ projectId, isOwner }: { projectId: string; isOwner: boolean }) {
  const t = useTranslate()
  const { data } = useSkillLibrary(projectId)
  const { data: local } = useLocalSkills(projectId, true)
  const skills = data?.skills ?? []
  const own = skills.filter((skill) => skill.scope === 'project')
  const globals = skills.length - own.length
  const repository = (local?.skills ?? []).filter((skill) => skill.origin.endsWith('-repo'))

  return (
    <Card>
      <CardHeader
        title={t('skills.project.title')}
        description={t('skills.project.description')}
        icon={<BookOpen size={16} />}
        actions={isOwner ? <AddSkillMenu scope="project" projectId={projectId} /> : null}
      />
      <CardBody className="flex flex-col gap-4">
        {data && !data.enabled ? <Banner tone="caution">{t('skills.instanceDisabled')}</Banner> : null}
        {own.length > 0 ? (
          <SkillList skills={own} />
        ) : (
          <p className="text-sm text-ink-faint">{t('skills.project.empty')}</p>
        )}
        <p className="text-xs text-ink-faint">
          {t('skills.project.globals', { count: globals })}{' '}
          <Link to="/settings/skills" className="text-accent hover:underline">
            {t('skills.project.globals.link')}
          </Link>
        </p>

        {repository.length > 0 ? (
          <section className="flex flex-col gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink-soft">{t('skills.project.repo.title')}</h3>
              <p className="text-xs text-ink-faint">{t('skills.project.repo.hint')}</p>
            </div>
            <ul className="flex flex-col gap-1.5">
              {repository.map((skill) => (
                <li key={skill.path} className="flex flex-wrap items-center gap-2 rounded-md bg-sunken px-3 py-2">
                  <span className="font-mono text-sm">{skill.name}</span>
                  <Badge>{originLabel(skill.origin)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-faint">{skill.description}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardBody>
    </Card>
  )
}
