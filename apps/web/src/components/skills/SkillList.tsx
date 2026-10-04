import { BookOpen, ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { LibrarySkillDto, LocalSkillOrigin } from '@sillage/protocol'
import { translate, useTranslate, type MessageKey } from '../../lib/i18n'
import { Badge } from '../ui'

/**
 * Liste des skills de la bibliothèque. Chaque ligne mène à l'éditeur, qui porte les
 * actions : la liste se parcourt, elle ne s'édite pas.
 */
export function SkillList({ skills, showScope = false }: { skills: LibrarySkillDto[]; showScope?: boolean }) {
  return (
    <ul className="flex flex-col gap-2">
      {skills.map((skill) => (
        <li key={skill.id}>
          <SkillRow skill={skill} showScope={showScope} />
        </li>
      ))}
    </ul>
  )
}

function SkillRow({ skill, showScope }: { skill: LibrarySkillDto; showScope: boolean }) {
  const t = useTranslate()
  return (
    <Link
      to={`/skills/${skill.id}`}
      className="surface flex items-start gap-3 rounded-lg border border-line px-4 py-3 transition-colors hover:border-line-strong"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-wash text-accent">
        <BookOpen size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium text-ink">{skill.name}</span>
          <SkillBadges skill={skill} showScope={showScope} />
        </span>
        <span className="line-clamp-2 text-sm text-ink-faint">
          {skill.description || t('skills.description.empty')}
        </span>
      </span>
      <ChevronRight size={16} className="mt-2 shrink-0 text-ink-faint" />
    </Link>
  )
}

/** Ce qu'on doit savoir d'un skill sans l'ouvrir : où il vit, s'il est livré, s'il cloche. */
export function SkillBadges({ skill, showScope }: { skill: LibrarySkillDto; showScope: boolean }) {
  const t = useTranslate()
  return (
    <>
      {showScope ? (
        <Badge tone="accent">{t(skill.scope === 'global' ? 'skills.scope.global' : 'skills.scope.project')}</Badge>
      ) : null}
      {skill.origin?.sourceName ? <Badge>{skill.origin.sourceName}</Badge> : null}
      {skill.updateAvailable ? <Badge tone="accent">{t('skills.badge.update')}</Badge> : null}
      {!skill.enabled ? <Badge>{t('skills.state.disabled')}</Badge> : null}
      {skill.problem ? <Badge tone="critical">{t(`skills.problem.${skill.problem}`)}</Badge> : null}
      {skill.compat.some((note) => note.code === 'runs_scripts') ? (
        <Badge tone="caution">{t('skills.badge.scripts')}</Badge>
      ) : null}
      {skill.locallyModified ? <Badge tone="caution">{t('skills.badge.modified')}</Badge> : null}
    </>
  )
}

const ORIGIN_KEYS: Record<LocalSkillOrigin, MessageKey> = {
  'claude-user': 'skills.origin.claude-user',
  'agents-user': 'skills.origin.agents-user',
  'codex-user': 'skills.origin.codex-user',
  'claude-repo': 'skills.origin.claude-repo',
  'agents-repo': 'skills.origin.agents-repo',
}

/** D'où vient un skill trouvé sur la machine, et donc quel CLI le voit aujourd'hui. */
export function originLabel(origin: LocalSkillOrigin): string {
  return translate(ORIGIN_KEYS[origin])
}
