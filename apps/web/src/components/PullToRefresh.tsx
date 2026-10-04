import { useEffect, useRef, useState, type RefObject } from 'react'
import { RefreshCw } from 'lucide-react'
import { cx } from './ui'

/** Course de l'indicateur, après amortissement, qui déclenche le rafraîchissement. */
const THRESHOLD_PX = 64
/** Au-delà, l'indicateur ne descend plus. */
const MAX_PULL_PX = 88
/** Le doigt parcourt le double de ce que l'indicateur descend, comme un geste natif. */
const RESISTANCE = 0.5
/** En deçà, un doigt posé qui frémit n'a encore rien décidé. */
const SLOP_PX = 6
/** Taille de la pastille, qui attend cachée au-dessus du bord. */
const BADGE_PX = 36

/**
 * « Tirer pour rafraîchir » sur une zone qui défile.
 *
 * Une PWA installée n'a pas celui du navigateur, et le document de Sillage ne défile
 * jamais (voir `index.css`) : le geste n'existait donc nulle part sur téléphone.
 *
 * Les écouteurs sont posés à la main : React enregistre `touchmove` en passif, et seul
 * un écouteur actif peut retenir le défilement natif pendant qu'on tire. Sans ça, iOS
 * fait rebondir la liste sous le doigt en même temps que l'indicateur descend.
 */
function usePull(target: RefObject<HTMLElement | null>, onRefresh: () => void): number {
  const [distance, setDistance] = useState(0)
  // Une ref : les écouteurs sont posés une fois et doivent appeler la version courante.
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh

  useEffect(() => {
    const node = target.current
    if (!node) return

    let origin: { x: number; y: number } | null = null
    let pulling = false
    let pulled = 0

    const reset = () => {
      origin = null
      pulling = false
      pulled = 0
      setDistance(0)
    }

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      origin = event.touches.length === 1 && touch && !scrolledAway(event.target, node)
        ? { x: touch.clientX, y: touch.clientY }
        : null
    }

    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!origin || !touch) return
      // Un appui long a lancé le glissement d'une ligne, qui retient déjà le
      // défilement : le geste lui appartient.
      if (event.defaultPrevented) {
        reset()
        return
      }

      const dx = touch.clientX - origin.x
      const dy = touch.clientY - origin.y
      if (!pulling) {
        // Vers le haut, c'est un défilement : rendu au navigateur jusqu'au prochain appui.
        if (dy < 0) {
          origin = null
          return
        }
        // Retenu dès le premier pixel : iOS décide au premier mouvement si le geste
        // défile, et ne laisse plus rien annuler ensuite.
        if (event.cancelable) event.preventDefault()
        if (Math.hypot(dx, dy) < SLOP_PX) return
        if (Math.abs(dx) > dy) {
          origin = null
          return
        }
        pulling = true
      }

      if (event.cancelable) event.preventDefault()
      pulled = Math.min(MAX_PULL_PX, Math.max(0, dy) * RESISTANCE)
      setDistance(pulled)
    }

    const onEnd = () => {
      if (pulling && pulled >= THRESHOLD_PX) refreshRef.current()
      reset()
    }

    node.addEventListener('touchstart', onStart, { passive: true })
    node.addEventListener('touchmove', onMove, { passive: false })
    node.addEventListener('touchend', onEnd)
    node.addEventListener('touchcancel', reset)
    return () => {
      node.removeEventListener('touchstart', onStart)
      node.removeEventListener('touchmove', onMove)
      node.removeEventListener('touchend', onEnd)
      node.removeEventListener('touchcancel', reset)
    }
  }, [target])

  return distance
}

/** Vrai si une zone qui défile, entre le doigt et le conteneur, n'est pas tout en haut. */
function scrolledAway(target: EventTarget | null, container: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true
    if (node === container) return false
  }
  return false
}

/**
 * Pastille qui descend sous le doigt, puis tourne le temps du rafraîchissement.
 *
 * À poser dans le conteneur suivi, positionné : elle s'y superpose en haut sans rien
 * décaler, et rien de la liste n'est rendu à nouveau pendant le geste.
 */
export function PullToRefresh({ target, refreshing, onRefresh }: {
  target: RefObject<HTMLElement | null>
  refreshing: boolean
  onRefresh: () => void
}) {
  const distance = usePull(target, onRefresh)
  const offset = refreshing ? THRESHOLD_PX : distance
  const armed = refreshing || distance >= THRESHOLD_PX

  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-28 justify-center overflow-hidden">
      <span
        className={cx(
          'surface flex items-center justify-center rounded-full border border-line shadow-float',
          // Suivre le doigt sans retard pendant le geste, glisser seulement au relâché.
          distance > 0 && !refreshing ? null : 'transition-[translate,opacity] duration-200 ease-out',
        )}
        style={{
          width: BADGE_PX,
          height: BADGE_PX,
          translate: `0 ${offset - BADGE_PX}px`,
          opacity: offset > 0 ? 1 : 0,
        }}
      >
        <RefreshCw
          size={16}
          className={cx(armed ? 'text-accent' : 'text-ink-faint', refreshing && 'animate-spin')}
          style={refreshing ? undefined : { rotate: `${distance * 3}deg` }}
        />
      </span>
    </div>
  )
}
