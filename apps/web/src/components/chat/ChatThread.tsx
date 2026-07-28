import type { RefObject } from 'react'
import type { MessageItem } from '../../lib/chat-fold'
import type { ChatRow } from '../../lib/tool-rows'
import { Banner, cx } from '../ui'
import { ElicitationPrompt } from './ElicitationPrompt'
import { MessageBubble } from './MessageBubble'
import { PermissionPrompt } from './PermissionPrompt'
import { PlanReview } from './PlanReview'
import { QuestionPrompt } from './QuestionPrompt'
import { TaskResult } from './TaskResult'
import { ToolCall, ToolCallGroup } from './ToolCall'

/**
 * Rendu d'un fil de conversation.
 *
 * Le même composant sert au fil principal et à celui d'un sous-agent : ce sont les
 * mêmes événements, et les rendre différemment ferait de la vue d'un sous-agent une
 * seconde implémentation à tenir en accord avec la première.
 *
 * Ce que la page apporte en plus (ancres de tours, mise en évidence, fork) est
 * optionnel : le panneau n'a ni réglette ni bouton de fork à proposer.
 */
export function ChatThread({
  rows,
  conversationId,
  canDecide = false,
  onFork,
  flashedId = null,
  anchors,
}: {
  rows: ChatRow[]
  conversationId: string
  /**
   * Autorise à répondre aux sollicitations. Faux par défaut, et par défaut sur une
   * conversation partagée en lecture : les prompts s'affichent alors sans agir.
   */
  canDecide?: boolean
  /** Absent quand le fil n'est pas forkable, un sous-agent n'ayant pas d'existence propre. */
  onFork?: (message: MessageItem) => void
  /** Message que l'on vient d'atteindre, signalé le temps qu'on le repère. */
  flashedId?: string | null
  /** Position des messages utilisateur, tenue à jour pour la réglette des tours. */
  anchors?: RefObject<Map<string, HTMLElement>>
}) {
  return (
    <>
      {rows.map((row) => {
        if (row.kind === 'tool-group') return <ToolCallGroup key={row.key} tools={row.tools} />
        if (row.kind === 'tool') return <ToolCall key={row.key} tool={row.tool} />

        const item = row.item
        switch (item.kind) {
          case 'message':
            // `data-seq` sur les deux rôles : un résultat de recherche peut viser une
            // réponse de l'agent. L'ancre de tour, elle, ne concerne que les messages
            // utilisateur, qui délimitent les tours dans la réglette.
            return (
              <div
                key={item.id}
                data-seq={item.seq}
                className={cx(flashedId === item.id && 'sg-flash-turn')}
                ref={
                  anchors && item.role === 'user'
                    ? (node) => {
                        if (!node) return
                        anchors.current.set(item.id, node)
                        // Corps en bloc : `Map.delete` renvoie un booléen, or React
                        // attend une fonction de nettoyage sans valeur de retour.
                        return () => {
                          anchors.current.delete(item.id)
                        }
                      }
                    : undefined
                }
              >
                <MessageBubble
                  message={item}
                  onFork={item.role === 'user' ? onFork : undefined}
                />
              </div>
            )
          case 'permission':
            return (
              <PermissionPrompt
                key={item.id}
                conversationId={conversationId}
                permission={item}
                canDecide={canDecide}
              />
            )
          case 'question':
            return (
              <QuestionPrompt
                key={item.id}
                conversationId={conversationId}
                item={item}
                canDecide={canDecide}
              />
            )
          case 'elicitation':
            return (
              <ElicitationPrompt
                key={item.id}
                conversationId={conversationId}
                item={item}
                canDecide={canDecide}
              />
            )
          case 'plan':
            return (
              <PlanReview
                key={item.id}
                conversationId={conversationId}
                item={item}
                canDecide={canDecide}
              />
            )
          case 'error':
            return (
              <Banner key={item.id} tone={item.recoverable ? 'caution' : 'critical'}>
                {item.message}
              </Banner>
            )
          case 'task':
            return <TaskResult key={item.id} item={item} />
          case 'notice':
            return (
              <div key={item.id} className="flex items-center gap-3 py-1">
                <span className="h-px flex-1 bg-line" />
                <span className="text-[0.6875rem] text-ink-faint">{item.text}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            )
        }
      })}
    </>
  )
}
