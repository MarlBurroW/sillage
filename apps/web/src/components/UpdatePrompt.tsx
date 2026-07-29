import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useTranslate } from '../lib/i18n'
import { cx } from './ui'

/**
 * Invite au rechargement quand une nouvelle version est installée.
 *
 * Sans elle, le nouveau service worker prenait le contrôle mais la page déjà chargée
 * continuait de tourner sur l'ancien code : rien ne la prévenait, rien ne la
 * rechargeait. Sur une PWA installée, qui reprend depuis la mémoire au lieu de
 * naviguer, une correction déployée pouvait n'atteindre l'écran qu'après une fermeture
 * complète de l'application.
 *
 * Le rechargement est proposé et non imposé : le faire d'autorité perdrait un message
 * en cours de saisie.
 */

/**
 * Une PWA installée navigue rarement, donc le navigateur ne va presque jamais
 * revérifier le service worker de lui-même. Cette relance périodique est ce qui fait
 * qu'une version déployée finit par être vue sans avoir à fermer l'application.
 */
const CHECK_INTERVAL_MS = 30 * 60 * 1000

/**
 * Au-delà, on rend la main plutôt que de laisser un bouton mort.
 *
 * Le rechargement n'est pas instantané : le nouveau service worker doit prendre le
 * contrôle avant que la page reparte, ce qui prend facilement plusieurs secondes. Si
 * rien ne s'est produit passé ce délai, c'est que la prise de contrôle a échoué, et
 * l'utilisateur doit pouvoir réessayer.
 */
const STALLED_MS = 15_000

export function UpdatePrompt() {
  const t = useTranslate()
  const [updating, setUpdating] = useState(false)
  const stalled = useRef<number | null>(null)

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return

      // Vérification immédiate, et pas seulement au premier intervalle. Une PWA
      // installée reprend depuis la mémoire sans naviguer : sans cet appel, une version
      // déployée pouvait n'être proposée qu'une demi-heure après l'ouverture, ou
      // jamais si l'application était refermée avant.
      void registration.update()

      const timer = setInterval(() => void registration.update(), CHECK_INTERVAL_MS)
      // La page vit aussi longtemps que l'application : l'intervalle n'a pas de fin
      // propre, mais il ne survit pas au document.
      window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
    },
  })

  useEffect(() => {
    return () => {
      if (stalled.current !== null) clearTimeout(stalled.current)
    }
  }, [])

  if (!needRefresh) return null

  const reload = () => {
    setUpdating(true)
    stalled.current = window.setTimeout(() => setUpdating(false), STALLED_MS)
    void updateServiceWorker(true)
  }

  return (
    <div
      role="status"
      className={cx(
        // En haut, et non en bas : posée au-dessus de la barre de saisie, elle
        // recouvrait ce qu'on est en train d'écrire.
        'surface fixed top-[calc(var(--sg-safe-top)+0.75rem)] left-1/2 z-50',
        'flex -translate-x-1/2 items-center gap-3',
        'rounded-full border border-line py-1.5 pr-1.5 pl-4 shadow-pop',
      )}
    >
      <span className="text-sm text-ink-soft">{t('update.available')}</span>
      <button
        type="button"
        onClick={reload}
        // Le rechargement prend plusieurs secondes sans que rien ne bouge à l'écran :
        // sans cet état, l'invite semblait inerte et invitait à cliquer en rafale.
        disabled={updating}
        className={cx(
          'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium',
          'gradient-accent text-accent-ink transition-[filter] hover:brightness-110',
          'disabled:pointer-events-none disabled:opacity-70',
        )}
      >
        <RefreshCw size={14} className={cx(updating && 'animate-spin')} />
        {updating ? t('update.reloading') : t('update.reload')}
      </button>
    </div>
  )
}
