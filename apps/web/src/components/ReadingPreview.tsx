import { useTranslate } from '../lib/i18n'
import { Markdown } from './chat/Markdown'

/**
 * Fausse conversation, pour juger les réglages de lecture sans quitter la page.
 *
 * Les curseurs s'appliquent à `<html>` : ce bloc n'a rien à recevoir, il suit comme le
 * reste de l'application. Il reprend donc exactement les composants du fil, bulle
 * comprise, plutôt qu'une imitation qui finirait par diverger du vrai rendu.
 *
 * Le texte n'est pas du remplissage : il porte un paragraphe, du gras, du code en
 * ligne et une liste, c'est-à-dire ce qu'un message contient réellement et ce dont la
 * taille et l'interligne changent la lecture.
 */
export function ReadingPreview() {
  const t = useTranslate()

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3">
      <div className="flex justify-end">
        <div className="sg-user-bubble flex min-w-0 max-w-[85%] flex-col gap-2 rounded-lg rounded-br-sm border px-3.5 py-2.5 shadow-card">
          <Markdown text={t('readingPreview.question')} />
        </div>
      </div>
      <Markdown text={t('readingPreview.answer')} />
    </div>
  )
}
