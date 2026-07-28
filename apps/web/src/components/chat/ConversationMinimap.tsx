import type { TurnMarker } from '../../lib/turns'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Réglette des tours, à gauche du fil.
 *
 * Un trait par échange, ceux visibles à l'écran mis en évidence, et le survol montre
 * le début des deux messages. Sur une conversation longue, c'est le seul moyen de
 * situer où on se trouve sans faire défiler à l'aveugle.
 *
 * Les traits sont répartis uniformément plutôt que proportionnellement à la hauteur
 * du contenu : un tour de trois lignes et un tour de trois écrans comptent pareil
 * quand on cherche à retrouver un échange.
 */
/** Écart vertical entre deux traits tant que la hauteur disponible le permet. */
const TICK_PITCH_PX = 15

export function ConversationMinimap({
  turns,
  visibleIds,
  agentLabel,
  onJump,
}: {
  turns: TurnMarker[]
  visibleIds: Set<string>
  agentLabel: string
  onJump: (id: string) => void
}) {
  const t = useTranslate()

  // Un seul tour ne se situe pas : la réglette n'apporterait rien.
  if (turns.length < 2) return null

  return (
    <nav
      aria-label={t('minimap.nav.label')}
      className={cx(
        'pointer-events-none absolute top-1/2 left-5 z-10 hidden -translate-y-1/2',
        // Seuil aligné sur la gouttière que le fil réserve à cette largeur : au-delà,
        // la réglette a sa place garantie sans jamais chevaucher le texte.
        '@min-[40rem]:flex',
      )}
      /**
       * Hauteur menée par le nombre de tours, plafonnée à la place disponible : le pas
       * reste constant tant que ça tient, puis `justify-between` le resserre tout seul
       * sur les conversations longues. Une hauteur fixe, elle, écartait les traits
       * d'autant plus que l'écran était grand.
       */
      style={{ height: `min(78%, ${turns.length * TICK_PITCH_PX}px)` }}
    >
      <ul className="pointer-events-auto flex h-full flex-col justify-between">
        {turns.map((turn) => {
          const visible = visibleIds.has(turn.id)

          return (
            <li key={turn.id} className="group/tick relative flex min-h-0 shrink items-center">
              <button
                type="button"
                onClick={() => onJump(turn.id)}
                aria-label={turn.user || t('minimap.turn.untitled')}
                className="flex h-3 w-6 items-center justify-start"
              >
                <span
                  className={cx(
                    'h-0.5 rounded-full transition-all',
                    visible ? 'w-4 bg-ink-soft' : 'w-3 bg-line-strong group-hover/tick:bg-ink-faint',
                  )}
                />
              </button>

              {/* Infobulle en CSS pur : un positionnement calculé en JavaScript se
                  recalculerait à chaque delta reçu pendant qu'un tour est en cours. */}
              <div
                className={cx(
                  'invisible absolute top-1/2 left-full z-20 ml-1 w-72 -translate-y-1/2 opacity-0',
                  'surface rounded-lg border border-line p-2.5 shadow-pop transition-opacity',
                  'group-hover/tick:visible group-hover/tick:opacity-100',
                  // `:focus-visible` et pas `:focus-within` : un clic laisse le focus sur le
                  // bouton, et l'infobulle restait affichée après le saut.
                  'group-has-[:focus-visible]/tick:visible group-has-[:focus-visible]/tick:opacity-100',
                )}
              >
                <p className="text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
                  {t('minimap.turn.you')}
                </p>
                <p className="mt-0.5 text-xs text-ink">{turn.user || t('minimap.turn.attachmentOnly')}</p>

                {turn.assistant ? (
                  <>
                    <p className="mt-2 text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
                      {agentLabel}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-soft">{turn.assistant}</p>
                  </>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
