import type { ContentBlock } from '@sillage/protocol'
import type { OutgoingAttachment } from './types.js'

/** Shared outgoing-message preparation: journal blocks describing user input and actual model text augmented with non-inline attachment lists. Runners then translate native protocols: Claude base64 images, Codex `localImage` paths and separate mentions. This function ensures identical journals across CLIs. */
export function describeOutgoingMessage(
  text: string,
  attachments: OutgoingAttachment[],
  referenceContext?: string | null,
): { blocks: ContentBlock[]; promptText: string } {
  const blocks: ContentBlock[] = []

  const files = attachments.filter((entry) => !entry.inlineImage)
  const attachmentText = files.length
    ? [
        text,
        '',
        'Fichiers joints à ce message :',
        ...files.map((file) => `- ${file.filename} : ${file.path}`),
      ]
        .join('\n')
        .trim()
    : text

  const promptText = referenceContext ? `${attachmentText}\n\n${referenceContext}` : attachmentText

  if (attachmentText) {
    blocks.push({ type: 'text', text })
  }

  for (const attachment of attachments) {
    if (attachment.inlineImage) {
      blocks.push({
        type: 'image',
        mimeType: attachment.mimeType,
        url: `/api/attachments/${attachment.id}`,
      })
    } else {
      blocks.push({
        type: 'file',
        name: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: `/api/attachments/${attachment.id}`,
      })
    }
  }

  return { blocks, promptText }
}
