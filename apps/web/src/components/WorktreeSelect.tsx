import { FolderTree, GitBranch, Plus } from 'lucide-react'
import { useState } from 'react'
import { ApiRequestError } from '../lib/api'
import { useBranches, useCreateWorktree, useWorktrees } from '../lib/worktrees'
import { Banner, Button, Field, Select, cx, type SelectOption } from './ui'

/** Valeur sentinelle : travailler dans le dossier du projet, sans worktree. */
const ROOT = '__root__'
const NEW = '__new__'

interface WorktreeSelectProps {
  projectId: string
  value: string | null
  onChange: (worktreeId: string | null) => void
  /** Masqué quand le projet n'est pas un dépôt git : un worktree n'y a aucun sens. */
  isRepository: boolean
}

/**
 * Choix du répertoire de travail d'une conversation. Sillage gère les worktrees
 * lui-même pour que le comportement soit identique entre Claude et Codex.
 */
export function WorktreeSelect({ projectId, value, onChange, isRepository }: WorktreeSelectProps) {
  const { data: worktrees } = useWorktrees(isRepository ? projectId : undefined)
  const { data: branchInfo } = useBranches(isRepository ? projectId : undefined)
  const createWorktree = useCreateWorktree(projectId)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [baseRef, setBaseRef] = useState('')

  if (!isRepository) return null

  const options: SelectOption<string>[] = [
    {
      value: ROOT,
      label: 'Dossier du projet',
      icon: <FolderTree size={15} />,
      hint: branchInfo?.current ? `Branche ${branchInfo.current}` : undefined,
    },
    ...(worktrees ?? []).map((worktree) => ({
      value: worktree.id,
      label: worktree.name,
      icon: <GitBranch size={15} />,
      hint: worktree.git?.isDirty ? 'Modifications non commitées' : 'Worktree',
    })),
    { value: NEW, label: 'Nouveau worktree...', icon: <Plus size={15} /> },
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

  return (
    <div className="flex flex-col gap-2">
      <Select
        label="Répertoire de travail"
        value={creating ? NEW : (value ?? ROOT)}
        onChange={(choice) => {
          if (choice === NEW) {
            setCreating(true)
            return
          }
          setCreating(false)
          onChange(choice === ROOT ? null : choice)
        }}
        options={options}
      />

      {creating ? (
        <div className={cx('flex flex-col gap-2 rounded-md border border-line bg-sunken p-3')}>
          <Field
            label="Nom de branche"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="feat/mon-chantier"
            hint="Une branche existante est réutilisée telle quelle."
            className="font-mono"
            autoCapitalize="none"
            spellCheck={false}
          />
          <Field
            label="Depuis"
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
              {createWorktree.isPending ? 'Création...' : 'Créer'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Annuler
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
