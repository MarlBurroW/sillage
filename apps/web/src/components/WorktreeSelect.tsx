import { FolderTree, GitBranch, Plus } from 'lucide-react'
import { useState } from 'react'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import { useBranches, useCreateWorktree, useWorktrees } from '../lib/worktrees'
import { Banner, Button, ChoiceList, Field, Select, cx, type SelectOption } from './ui'

/** Valeur sentinelle : travailler dans le dossier du projet, sans worktree. */
const ROOT = '__root__'
const NEW = '__new__'

interface WorktreeSelectProps {
  projectId: string
  value: string | null
  onChange: (worktreeId: string | null) => void
  /** Masqué quand le projet n'est pas un dépôt git : un worktree n'y a aucun sens. */
  isRepository: boolean
  /**
   * `list` déplie les options au lieu de les cacher derrière une liste déroulante.
   * Réservé à l'écran de création, où il n'y a rien d'autre à regarder et où le choix
   * mérite d'être vu ; ailleurs la place manque.
   */
  layout?: 'select' | 'list'
}

/**
 * Choix du répertoire de travail d'une conversation. Sillage gère les worktrees
 * lui-même pour que le comportement soit identique entre Claude et Codex.
 */
export function WorktreeSelect({
  projectId,
  value,
  onChange,
  isRepository,
  layout = 'select',
}: WorktreeSelectProps) {
  const { data: worktrees } = useWorktrees(isRepository ? projectId : undefined)
  const { data: branchInfo } = useBranches(isRepository ? projectId : undefined)
  const createWorktree = useCreateWorktree(projectId)
  const t = useTranslate()

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [baseRef, setBaseRef] = useState('')

  if (!isRepository) return null

  const options: SelectOption<string>[] = [
    {
      value: ROOT,
      label: t('worktree.root.label'),
      icon: <FolderTree size={15} />,
      hint: branchInfo?.current ? t('worktree.root.hint', { branch: branchInfo.current }) : undefined,
    },
    ...(worktrees ?? []).map((worktree) => ({
      value: worktree.id,
      label: worktree.name,
      icon: <GitBranch size={15} />,
      hint: worktree.git?.isDirty ? t('worktree.dirty') : t('worktree.label'),
    })),
    { value: NEW, label: t('worktree.new'), icon: <Plus size={15} /> },
  ]

  const submit = () => {
    const branch = name.trim()
    if (!branch) return
    createWorktree.mutate(
      { name: branch, baseRef: baseRef.trim() || branchInfo?.current || 'HEAD' },
      {
        onSuccess: (created) => {
          onChange(created.id)
          setCreating(false)
          setName('')
          setBaseRef('')
        },
      },
    )
  }

  const error =
    createWorktree.error instanceof ApiRequestError ? createWorktree.error.message : null

  const pick = (choice: string) => {
    if (choice === NEW) {
      setCreating(true)
      return
    }
    setCreating(false)
    onChange(choice === ROOT ? null : choice)
  }

  const selected = creating ? NEW : (value ?? ROOT)

  return (
    <div className="flex flex-col gap-2">
      {layout === 'list' ? (
        <ChoiceList
          label={t('worktree.select.label')}
          value={selected}
          options={options.map(({ value: option, label, icon, hint }) => ({
            value: option,
            label,
            icon,
            hint,
          }))}
          onChange={pick}
        />
      ) : (
        <Select
          label={t('worktree.select.label')}
          value={selected}
          onChange={pick}
          options={options}
        />
      )}

      {creating ? (
        <div className={cx('flex flex-col gap-2 rounded-md border border-line bg-sunken p-3')}>
          <Field
            label={t('worktree.branch.label')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('worktree.branch.placeholder')}
            hint={t('worktree.branch.hint')}
            className="font-mono"
            autoCapitalize="none"
            spellCheck={false}
          />
          <Field
            label={t('worktree.branch.from')}
            value={baseRef}
            onChange={(event) => setBaseRef(event.target.value)}
            placeholder={branchInfo?.current ?? 'HEAD'}
            className="font-mono"
            autoCapitalize="none"
            spellCheck={false}
          />
          {error ? <Banner>{error}</Banner> : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={submit} disabled={!name.trim() || createWorktree.isPending}>
              {createWorktree.isPending ? t('worktree.create.pending') : t('worktree.create.action')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
