import { useLayoutEffect, useMemo, useRef, useState } from 'react'

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
 *
 * Au-delà de ce que la hauteur permet, la réglette n'affiche plus toute la
 * conversation mais une fenêtre glissante autour de la position courante. Tasser les
 * traits jusqu'à les coller donnait une cible de clic inatteignable et une bouillie
 * illisible ; le pas reste donc constant et c'est le contenu qui défile.
 */
/** Écart vertical entre deux traits. */
const TICK_PITCH_PX = 15

/** En dessous, la fenêtre ne situe plus rien : mieux vaut déborder un peu du plafond. */
const MIN_WINDOW = 8

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
  const nav = useRef<HTMLElement>(null)
  const [capacity, setCapacity] = useState(0)

  // La hauteur du `nav` est menée par le nombre de tours et le plafond CSS, jamais par
  // la capacité qu'on en déduit : la mesure ne peut pas se réalimenter.
  useLayoutEffect(() => {
    const node = nav.current
    if (!node) return

    const observer = new ResizeObserver(([entry]) => {
      setCapacity(Math.max(MIN_WINDOW, Math.floor(entry.contentRect.height / TICK_PITCH_PX)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Gardé d'un rendu à l'autre : entre deux synchronisations du défilement, aucun tour
  // n'est marqué visible et la fenêtre sauterait au début du fil.
  const lastStart = useRef(0)

  const start = useMemo(() => {
    if (capacity <= 0 || turns.length <= capacity) return 0

    let first = -1
    let last = -1
    turns.forEach((turn, index) => {
      if (!visibleIds.has(turn.id)) return
      if (first < 0) first = index
      last = index
    })

    const max = turns.length - capacity
    if (first < 0) return Math.min(lastStart.current, max)

    const centered = Math.round((first + last) / 2 - capacity / 2)
    const next = Math.max(0, Math.min(centered, max))
    lastStart.current = next
    return next
  }, [capacity, turns, visibleIds])

  // Un seul tour ne se situe pas : la réglette n'apporterait rien.
  if (turns.length < 2) return null

  const end = capacity > 0 ? Math.min(start + capacity, turns.length) : turns.length
  const shown = turns.slice(start, end)

  return (
    <nav
      ref={nav}
      aria-label={t('minimap.nav.label')}
      className={cx(
        'pointer-events-none absolute top-1/2 left-5 z-10 hidden -translate-y-1/2',
        // Seuil aligné sur la gouttière que le fil réserve à cette largeur : au-delà,
        // la réglette a sa place garantie sans jamais chevaucher le texte.
        '@min-[40rem]:flex',
      )}
      /**
       * Hauteur menée par le nombre de tours, plafonnée à la place disponible : le pas
       * reste constant tant que ça tient. Une hauteur fixe, elle, écartait les traits
       * d'autant plus que l'écran était grand.
       */
      style={{ height: `min(90%, ${turns.length * TICK_PITCH_PX}px)` }}
    >
      <ul className="pointer-events-auto flex h-full flex-col justify-between">
        {shown.map((turn, index) => {
          const visible = visibleIds.has(turn.id)
          // Les traits d'extrémité s'estompent du côté où la conversation continue :
          // c'est ce qui distingue une fenêtre glissante d'une réglette complète.
          const faded =
            (start > 0 && index < 2) || (end < turns.length && index >= shown.length - 2)

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
                    faded && !visible ? 'opacity-40' : null,
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
