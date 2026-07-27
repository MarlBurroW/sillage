import { Bell, BellOff } from 'lucide-react'
import { ApiRequestError } from '../lib/api'
import {
  pushAvailability,
  useSubscribePush,
  useUnsubscribePush,
  usePushStatus,
} from '../lib/push'
import { Banner, Button } from './ui'

/**
 * Réglage des notifications système.
 *
 * L'abonnement vaut pour cet appareil : le même compte sur un téléphone et sur un
 * ordinateur a deux abonnements distincts, et couper l'un ne coupe pas l'autre.
 */
export function PushControls() {
  const availability = pushAvailability()
  const { data: status } = usePushStatus(availability === 'ok')
  const subscribe = useSubscribePush()
  const unsubscribe = useUnsubscribePush()

  if (availability === 'insecure') {
    return (
      <Banner tone="info">
        Les notifications exigent une connexion HTTPS. Le navigateur ne donne accès ni au
        service worker ni à l&apos;API Push en clair.
      </Banner>
    )
  }

  if (availability === 'unsupported') {
    return <Banner tone="info">Ce navigateur ne gère pas les notifications push.</Banner>
  }

  const error =
    subscribe.error instanceof Error
      ? subscribe.error.message
      : unsubscribe.error instanceof ApiRequestError
        ? unsubscribe.error.message
        : null

  const busy = subscribe.isPending || unsubscribe.isPending

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft">
        Prévenu quand un agent réclame une décision, ou termine un tour pendant que tu
        regardes ailleurs. Rien n&apos;est envoyé tant que la conversation est ouverte sous
        tes yeux.
      </p>

      {status?.subscribed ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<BellOff size={15} />}
          disabled={busy}
          onClick={() => unsubscribe.mutate()}
          className="self-start"
        >
          Désactiver sur cet appareil
        </Button>
      ) : (
        <Button
          size="sm"
          icon={<Bell size={15} />}
          disabled={busy || !status}
          onClick={() => status && subscribe.mutate(status.publicKey)}
          className="self-start"
        >
          Activer sur cet appareil
        </Button>
      )}

      {error ? <Banner>{error}</Banner> : null}
    </div>
  )
}
