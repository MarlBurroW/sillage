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
const QUESTION = "Pourquoi le fichier `.env` s'affichait-il sans couleur ?"

const ANSWER = `Parce que \`extname('.env')\` rend une chaîne vide : pour Node, un fichier
qui commence par un point n'a pas d'extension, il a un **nom**.

Deux conséquences :

- aucun mode n'était trouvé, donc aucune coloration ;
- les commentaires eux-mêmes passaient en texte brut.

Le mode se décide maintenant sur le nom du fichier.`

export function ReadingPreview() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3">
      <div className="flex justify-end">
        <div className="surface flex min-w-0 max-w-[85%] flex-col gap-2 rounded-lg rounded-br-sm border border-line px-3.5 py-2.5 shadow-card">
          <Markdown text={QUESTION} />
        </div>
      </div>
      <Markdown text={ANSWER} />
    </div>
  )
}
