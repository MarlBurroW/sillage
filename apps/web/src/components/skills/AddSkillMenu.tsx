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

/** Import data recoverable by choosing another name after name rejection. */
const RENAMEABLE = new Set(['skill_name_taken', 'skill_name_invalid', 'skill_directory_exists'])

const errorOf = (error: unknown): string | null => (error instanceof ApiRequestError ? error.message : null)

/** Four ways to add skills: write, import archive, import directory, or adopt existing machine skills. */
export function AddSkillMenu({ scope, projectId, onDiscover }: { scope: LibrarySkillScope; projectId: string | null; onDiscover?: () => void }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const importSkill = useImportLibrarySkill()
  const archiveInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [creating, setCreating] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [cataloging, setCataloging] = useState(false)
  /** Retain files after name rejection for retry with another name. */
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
          <Button size="sm" icon={<Plus size={15} />} busy={importSkill.isPending}>
            {importSkill.isPending ? t('skills.add.importing') : t('skills.add.action')}
          </Button>
        }
      >
        {onDiscover ? <MenuItem icon={<Library size={15} />} onSelect={onDiscover}>
          {t('skills.tabs.discover')}
        </MenuItem> : null}
        <MenuItem icon={<FilePlus2 size={15} />} onSelect={() => setCreating(true)}>
          {t('skills.add.new')}
        </MenuItem>
        <MenuItem icon={<FileArchive size={15} />} onSelect={() => archiveInput.current?.click()}>
          {t('skills.add.archive')}
        </MenuItem>
        <MenuItem icon={<FolderInput size={15} />} onSelect={() => folderInput.current?.click()}>
          {t('skills.add.folder')}
        </MenuItem>
        {!onDiscover ? <MenuItem icon={<Library size={15} />} onSelect={() => setCataloging(true)}>
          {t('skills.add.catalog')}
        </MenuItem> : null}
        <MenuItem icon={<HardDrive size={15} />} onSelect={() => setBrowsing(true)}>
          {t('skills.add.local')}
        </MenuItem>
      </Menu>

      <input ref={archiveInput} type="file" accept=".zip,.skill" hidden onChange={picked} />
      {/* React lacks webkitdirectory typing, so set the attribute manually. */}
      <input ref={folderInput} type="file" hidden onChange={picked} {...{ webkitdirectory: '' }} />

      {importSkill.isError && renaming === null ? <Banner>{errorOf(importSkill.error)}</Banner> : null}

      <NewSkillDialog open={creating} onClose={() => setCreating(false)} scope={scope} projectId={projectId} />
      <LocalSkillsDialog open={browsing} onClose={() => setBrowsing(false)} scope={scope} projectId={projectId} />
      {cataloging ? <CatalogDialog open onClose={() => setCataloging(false)} scope={scope} projectId={projectId} /> : null}

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
