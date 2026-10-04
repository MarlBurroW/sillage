import { FileArchive, FilePlus2, FolderInput, HardDrive, Library, Plus } from 'lucide-react'
import { useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { skillDescriptionSchema, skillNameSchema, type LibrarySkillScope } from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import { useTranslate } from '../../lib/i18n'
import { useCreateLibrarySkill, useImportLibrarySkill } from '../../lib/skill-library'
import { Banner, Button, Menu, MenuItem } from '../ui'
import { CatalogDialog } from './CatalogDialog'
import { LocalSkillsDialog } from './LocalSkillsDialog'
import { DescriptionField, NameField, SkillDialog } from './SkillDialog'

/** Ce qu'un import refusé pour son nom permet de rattraper en en choisissant un autre. */
const RENAMEABLE = new Set(['skill_name_taken', 'skill_name_invalid', 'skill_directory_exists'])

const errorOf = (error: unknown): string | null => (error instanceof ApiRequestError ? error.message : null)

/**
 * Les quatre façons de faire entrer un skill dans une portée : l'écrire, importer une
 * archive, importer un dossier, ou reprendre un skill déjà présent sur la machine.
 */
export function AddSkillMenu({ scope, projectId }: { scope: LibrarySkillScope; projectId: string | null }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const importSkill = useImportLibrarySkill()
  const archiveInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [creating, setCreating] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [cataloging, setCataloging] = useState(false)
  /** Fichiers d'un import refusé pour son nom, gardés pour réessayer sous un autre. */
  const [renaming, setRenaming] = useState<File[] | null>(null)
  const [name, setName] = useState('')

  const runImport = (files: File[], rename?: string) => {
    importSkill.mutate(
      { target: { scope, projectId, name: rename }, files },
      {
        onSuccess: (skill) => {
          setRenaming(null)
          navigate(`/skills/${skill.id}`)
        },
        onError: (error) => {
          if (error instanceof ApiRequestError && RENAMEABLE.has(error.code)) setRenaming(files)
        },
      },
    )
  }

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (files.length > 0) runImport(files)
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Menu
        trigger={
          <Button size="sm" icon={<Plus size={15} />} disabled={importSkill.isPending}>
            {importSkill.isPending ? t('skills.add.importing') : t('skills.add.action')}
          </Button>
        }
      >
        <MenuItem icon={<FilePlus2 size={15} />} onSelect={() => setCreating(true)}>
          {t('skills.add.new')}
        </MenuItem>
        <MenuItem icon={<FileArchive size={15} />} onSelect={() => archiveInput.current?.click()}>
          {t('skills.add.archive')}
        </MenuItem>
        <MenuItem icon={<FolderInput size={15} />} onSelect={() => folderInput.current?.click()}>
          {t('skills.add.folder')}
        </MenuItem>
        <MenuItem icon={<Library size={15} />} onSelect={() => setCataloging(true)}>
          {t('skills.add.catalog')}
        </MenuItem>
        <MenuItem icon={<HardDrive size={15} />} onSelect={() => setBrowsing(true)}>
          {t('skills.add.local')}
        </MenuItem>
      </Menu>

      <input ref={archiveInput} type="file" accept=".zip,.skill" hidden onChange={picked} />
      {/* `webkitdirectory` n'est pas typé par React, d'où l'attribut posé à la main. */}
      <input ref={folderInput} type="file" hidden onChange={picked} {...{ webkitdirectory: '' }} />

      {importSkill.isError && renaming === null ? <Banner>{errorOf(importSkill.error)}</Banner> : null}

      <NewSkillDialog open={creating} onClose={() => setCreating(false)} scope={scope} projectId={projectId} />
      <LocalSkillsDialog open={browsing} onClose={() => setBrowsing(false)} scope={scope} projectId={projectId} />
      <CatalogDialog open={cataloging} onClose={() => setCataloging(false)} scope={scope} projectId={projectId} />

      <SkillDialog
        open={renaming !== null}
        onClose={() => { setRenaming(null); importSkill.reset() }}
        title={t('skills.import.rename.title')}
        submitLabel={t('skills.import.rename.submit')}
        busy={importSkill.isPending}
        canSubmit={skillNameSchema.safeParse(name).success}
        onSubmit={() => renaming && runImport(renaming, name)}
      >
        {errorOf(importSkill.error) ? <Banner tone="caution">{errorOf(importSkill.error)}</Banner> : null}
        <NameField value={name} onChange={setName} />
      </SkillDialog>
    </div>
  )
}

function NewSkillDialog({
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
  const navigate = useNavigate()
  const create = useCreateLibrarySkill()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const valid = skillNameSchema.safeParse(name).success && skillDescriptionSchema.safeParse(description).success

  const close = () => {
    setName('')
    setDescription('')
    create.reset()
    onClose()
  }

  return (
    <SkillDialog
      open={open}
      onClose={close}
      title={t('skills.new.title')}
      submitLabel={create.isPending ? t('skills.new.pending') : t('skills.new.submit')}
      busy={create.isPending}
      canSubmit={valid}
      onSubmit={() =>
        create.mutate(
          { scope, projectId, name, description: description.trim(), body: t('skills.new.template') },
          { onSuccess: (skill) => { close(); navigate(`/skills/${skill.id}`) } },
        )
      }
    >
      <NameField value={name} onChange={setName} />
      <DescriptionField
        label={t('skills.field.description')}
        hint={t('skills.field.description.hint')}
        value={description}
        onChange={setDescription}
      />
      {errorOf(create.error) ? <Banner>{errorOf(create.error)}</Banner> : null}
    </SkillDialog>
  )
}
