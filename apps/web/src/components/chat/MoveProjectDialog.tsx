import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState } from 'react'
import type { ConversationDto } from '@sillage/protocol'
import { ProjectSelector } from '../ProjectSelector'
import { Banner, Button, IconButton } from '../ui'
import { useMoveConversation } from '../../lib/conversations'
import { useProjects } from '../../lib/projects'
import { useTranslate } from '../../lib/i18n'

export function MoveProjectDialog({ source, onClose }: { source: ConversationDto; onClose: () => void }) {
  const t = useTranslate()
  const { data: projects } = useProjects()
  const move = useMoveConversation()
  const [project, setProject] = useState('')
  const eligible = projects?.filter(item => item.id !== source.projectId && !item.archivedAt) ?? []
  const selected = eligible.find(item => item.id === project)
  return <Dialog.Root open onOpenChange={open => { if (!open && !move.isPending) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
      <Dialog.Content className="surface fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-line p-4 shadow-pop">
        <div className="flex items-center justify-between gap-3">
          <Dialog.Title className="text-[0.9375rem] font-semibold">{t('conversation.move.title')}</Dialog.Title>
          <Dialog.Close asChild><IconButton label={t('common.close')} disabled={move.isPending}><X size={18} /></IconButton></Dialog.Close>
        </div>
        <Dialog.Description className="text-sm text-ink-soft">{t('conversation.move.description')}</Dialog.Description>
        <ProjectSelector label={t('conversation.move.project')} value={project} onChange={setProject}
          options={eligible.map(item => ({ value: item.id, label: item.name, project: item }))} disabled={move.isPending} />
        {selected?.visibility === 'shared' && <Banner>{t('conversation.move.shared')}</Banner>}
        <p className="text-xs text-ink-soft">{t('conversation.move.files')}</p>
        {move.error && <Banner tone="critical">{move.error.message}</Banner>}
        <div className="flex justify-end gap-2">
          <Dialog.Close asChild><Button variant="ghost" disabled={move.isPending}>{t('dialog.cancel')}</Button></Dialog.Close>
          <Button variant="primary" disabled={!project || move.isPending} onClick={() => move.mutate({ id: source.id, project }, { onSuccess: onClose })}>
            {move.isPending ? t('conversation.move.busy') : t('conversation.move.action')}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

