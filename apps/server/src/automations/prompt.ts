import type { AutomationDeliveryRow, ScheduledTaskRow } from '@sillage/db'
import { renderTemplate, sessionMarker, type AutomationEvent } from '@sillage/protocol'

/** First message for a webhook-created session: situation followed by the automation prompt rendered with the received call. As for scheduled runs, nobody is at the keyboard and the agent must know immediately. Also provides the forge marker identifying session-originated publications so launch chains can be stopped. */
export function buildWebhookPrompt(input: {
  task: Pick<ScheduledTaskRow, 'name' | 'prompt' | 'maxDurationMinutes'>
  delivery: Pick<AutomationDeliveryRow, 'receivedAt' | 'subject' | 'summary' | 'deliveryId' | 'vars'>
  event: AutomationEvent
  conversationId: string
  replay: boolean
}): string {
  const { task, delivery, event } = input
  const date = stamp(delivery.receivedAt)
  const vars = delivery.vars ? (JSON.parse(delivery.vars) as Record<string, unknown>) : {}

  const header = [
    `[Sillage automation “${task.name}” — call received at ${date}${input.replay ? ', replayed manually' : ''}]`,
    '',
    `You are running unattended in a fresh session opened by a webhook: nobody is at the keyboard. Do not ask questions or request confirmation, as nobody would answer. Decide and state your assumptions in your final reply. For work requiring approval or outside your instructions, create a card (create_card) instead of doing it. The session is interrupted after ${task.maxDurationMinutes} min.`,
    '',
    `End anything you publish on a forge (issue, pull request, comment, review) with ${sessionMarker(input.conversationId)}, and commit messages with the trailer \`Sillage-Session: ${input.conversationId}\`. Never apply a label or post a command that triggers an automation unless instructed to do so.`,
  ]
  const facts = [
    delivery.summary ? `Event: ${delivery.summary}.` : null,
    delivery.subject ? `Subject: ${delivery.subject}.` : null,
    delivery.deliveryId ? `Delivery: ${delivery.deliveryId}.` : null,
  ].filter((line) => line !== null)
  if (facts.length > 0) header.push('', facts.join(' '))

  const prompt = renderTemplate(task.prompt, {
    ...event,
    vars,
    subject: delivery.subject ?? '',
    date,
    delivery_id: delivery.deliveryId ?? '',
  })
  return `${header.join('\n')}\n\n---\n\n${prompt}`
}

function stamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
