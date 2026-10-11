import type { AutomationDeliveryRow, ScheduledTaskRow } from '@sillage/db'
import { renderTemplate, sessionMarker, type AutomationEvent } from '@sillage/protocol'

/**
 * Le premier message d'une session née d'un webhook : sa situation, puis le prompt de
 * l'automatisation rendu avec l'appel reçu.
 *
 * Comme pour un tir planifié, personne n'est au clavier, et l'agent doit le savoir avant
 * tout. Il apprend aussi la marque à laisser sur la forge : c'est elle qui permet de
 * reconnaître que ce qu'il publie vient d'une session, et d'arrêter une chaîne.
 */
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
    `[Automatisation Sillage « ${task.name} » — appel reçu le ${date}${input.replay ? ', rejoué à la main' : ''}]`,
    '',
    `Tu tournes seul, dans une session neuve ouverte par un webhook : personne n'est au clavier. Ne pose pas de question et ne demande pas de confirmation, personne n'y répondrait : décide, et note tes hypothèses dans ta réponse finale. Ce qui demande un accord ou sort de la consigne, ouvre une carte (create_card) plutôt que de le faire. La session est interrompue au bout de ${task.maxDurationMinutes} min.`,
    '',
    `Ce que tu publies sur une forge (issue, pull request, commentaire, revue) se termine par ${sessionMarker(input.conversationId)}, et tes messages de commit par le trailer \`Sillage-Session: ${input.conversationId}\`. Ne pose jamais un label et n'écris jamais une commande qui déclenche une automatisation, sauf si la consigne le demande.`,
  ]
  const facts = [
    delivery.summary ? `Événement : ${delivery.summary}.` : null,
    delivery.subject ? `Sujet : ${delivery.subject}.` : null,
    delivery.deliveryId ? `Livraison : ${delivery.deliveryId}.` : null,
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
