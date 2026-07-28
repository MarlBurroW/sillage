import { Bell, BellOff } from 'lucide-react'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
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
  const t = useTranslate()

  if (availability === 'insecure') {
    return <Banner tone="info">{t('push.insecure')}</Banner>
  }

  if (availability === 'unsupported') {
    return <Banner tone="info">{t('push.unsupported')}</Banner>
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
      <p className="text-sm text-ink-soft">{t('push.description')}</p>

      {status?.subscribed ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<BellOff size={15} />}
          disabled={busy}
          onClick={() => unsubscribe.mutate()}
          className="self-start"
        >
          {t('push.disable')}
        </Button>
      ) : (
        <Button
          size="sm"
          icon={<Bell size={15} />}
          disabled={busy || !status}
          onClick={() => status && subscribe.mutate(status.publicKey)}
          className="self-start"
        >
          {t('push.enable')}
        </Button>
      )}

      {error ? <Banner>{error}</Banner> : null}
    </div>
  )
}
