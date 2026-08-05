import type { AttachmentDto } from '@sillage/protocol'

/**
 * Message en cours de rédaction, par conversation.
 *
 * Le composer est remonté par sa clé quand la conversation change : sans mémoire
 * extérieure, passer d'un fil à l'autre effaçait le texte tapé et la liste des pièces
 * jointes déjà téléversées, sans rien annoncer.
 *
 * Hors de React parce que le brouillon doit survivre au démontage du composant, ce
 * qui est précisément ce qui se produit à chaque changement de fil.
 *
 * Volontairement non persisté : les pièces jointes ne sont ici que des identifiants
 * de fichiers téléversés, que le serveur ramasse comme orphelins ; un brouillon relu
 * après un redémarrage désignerait des fichiers disparus et l'envoi échouerait.
 */
export interface ComposerDraft {
  text: string
  attachments: AttachmentDto[]
  /** Chemins choisis dans la liste des mentions, à distinguer des `@` tapés à la main. */
  mentions: string[]
  /** Compétences choisies dans la liste, par leur nom. */
  skills: string[]
}

const EMPTY: ComposerDraft = { text: '', attachments: [], mentions: [], skills: [] }

const drafts = new Map<string, ComposerDraft>()

export function readDraft(key: string): ComposerDraft {
  return drafts.get(key) ?? EMPTY
}

export function saveDraft(key: string, draft: ComposerDraft): void {
  // Un brouillon vide n'en est pas un : le retenir ferait grossir la table au fil des
  // conversations visitées, et masquerait le `initialText` d'un fork.
  if (draft.text.length === 0 && draft.attachments.length === 0) {
    drafts.delete(key)
    return
  }
  drafts.set(key, draft)
}
