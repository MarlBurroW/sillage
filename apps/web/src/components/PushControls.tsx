import { Bell, BellOff, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { NotificationKind, PushDeliveryDto, PushDeviceDto, PushServiceKind } from '@sillage/protocol'
import { ApiRequestError } from '../lib/api'
import { useTranslate, type MessageKey } from '../lib/i18n'
import {
  pushAvailability,
  usePushDevices,
  usePushStatus,
  usePushTest,
  useRemovePushDevice,
  useSendPushTest,
  useSubscribePush,
  useUnsubscribePush,
} from '../lib/push'
import { useUpdateNotificationPrefs, useUserSettings } from '../lib/user-settings'
import { Badge, Banner, Button, Card, CardBody, IconButton, Select, Switch } from './ui'

const SERVICES: Record<PushServiceKind, string> = {
  apple: 'Apple',
  google: 'Google',
  mozilla: 'Mozilla',
  microsoft: 'Microsoft',
  other: '—',
}

/** Operating system and browser from the subscribed device's user agent. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return '?'
  const os = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : '?'
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent) && !/Chromium/.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : null
  return browser ? `${browser} · ${os}` : os
}

/** iPhone notifications require a home-screen-installed app. */
function iosOutsideHomeScreen(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  return ios && !standalone
}

/**
 * Notifications for this device, account devices, tests, and preferences. Subscriptions belong to
 * devices, not accounts; another device's subscription says nothing about this one.
 */
export function PushControls() {
  const availability = pushAvailability()
  const t = useTranslate()
  if (availability === 'insecure') return <Banner tone="info">{t('push.insecure')}</Banner>
  if (availability === 'unsupported') {
    return <Banner tone="info">{t(iosOutsideHomeScreen() ? 'push.iosHomeScreen' : 'push.unsupported')}</Banner>
  }
  return (
    <div className="flex flex-col gap-4">
      <ThisDevice />
      <Devices />
      <PushTest />
      <Preferences />
    </div>
  )
}

/**
 * This-device subscription only for onboarding: full device lists and tests become useful with
 * multiple devices.
 */
export function PushEnrol() {
  const availability = pushAvailability()
  const t = useTranslate()
  if (availability === 'insecure') return <Banner tone="info">{t('push.insecure')}</Banner>
  if (availability === 'unsupported') {
    return <Banner tone="info">{t(iosOutsideHomeScreen() ? 'push.iosHomeScreen' : 'push.unsupported')}</Banner>
  }
  return <ThisDevice />
}

function ThisDevice() {
  const t = useTranslate()
  const { data: status } = usePushStatus(true)
  const { data: devices } = usePushDevices(true)
  const subscribe = useSubscribePush()
  const unsubscribe = useUnsubscribePush()
  const subscribed = Boolean(devices?.current && devices.devices.some((device) => device.endpoint === devices.current))
  const busy = subscribe.isPending || unsubscribe.isPending
  const error =
    subscribe.error instanceof Error ? subscribe.error.message : unsubscribe.error instanceof ApiRequestError ? unsubscribe.error.message : null

  return (
    <Card>
      <CardBody>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{t('push.thisDevice')}</h3>
            {devices ? <Badge tone={subscribed ? 'positive' : 'neutral'}>{t(subscribed ? 'push.status.on' : 'push.status.off')}</Badge> : null}
          </div>
          <p className="text-sm text-ink-soft">{t('push.description')}</p>
          {subscribed ? (
            <Button variant="secondary" size="sm" icon={<BellOff size={15} />} disabled={busy} onClick={() => unsubscribe.mutate()} className="self-start">
              {t('push.disable')}
            </Button>
          ) : (
            <Button size="sm" icon={<Bell size={15} />} disabled={busy || !status} onClick={() => status && subscribe.mutate(status.publicKey)} className="self-start">
              {t('push.enable')}
            </Button>
          )}
          {error ? <Banner>{error}</Banner> : null}
        </div>
      </CardBody>
    </Card>
  )
}

function Devices() {
  const t = useTranslate()
  const { data } = usePushDevices(true)
  const remove = useRemovePushDevice()
  if (!data) return null
  return (
    <Card>
      <CardBody>
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">{t('push.devices.title')}</h3>
            <p className="text-xs text-ink-faint">{t('push.devices.hint')}</p>
          </div>
          {data.devices.length === 0 ? (
            <p className="text-sm text-ink-faint">{t('push.devices.none')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {data.devices.map((device: PushDeviceDto) => (
                <li key={device.endpoint} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                      {describeDevice(device.userAgent)}
                      {device.endpoint === data.current ? <Badge tone="accent">{t('push.devices.current')}</Badge> : null}
                    </p>
                    <p className="text-xs text-ink-faint">
                      {t('push.devices.meta', { service: SERVICES[device.service], date: new Date(device.createdAt).toLocaleDateString() })}
                    </p>
                  </div>
                  <IconButton size="sm" label={t('push.devices.remove')} disabled={remove.isPending} onClick={() => remove.mutate(device.endpoint)}>
                    <Trash2 size={14} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

function PushTest() {
  const t = useTranslate()
  const [delay, setDelay] = useState('10')
  const send = useSendPushTest()
  const { data: test } = usePushTest(send.data?.id ?? null)
  const waiting = send.data && !test?.deliveries
  return (
    <Card>
      <CardBody>
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">{t('push.test.title')}</h3>
            <p className="text-xs text-ink-faint">{t('push.test.hint')}</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label={t('push.test.delay')}
              value={delay}
              onChange={setDelay}
              options={[
                { value: '0', label: t('push.test.now') },
                { value: '10', label: t('push.test.seconds', { count: 10 }) },
                { value: '30', label: t('push.test.seconds', { count: 30 }) },
              ]}
            />
            <Button size="sm" icon={<Send size={14} />} disabled={send.isPending || Boolean(waiting)} onClick={() => send.mutate(Number(delay))}>
              {t('push.test.send')}
            </Button>
          </div>
          {waiting ? <p role="status" className="text-sm text-ink-soft">{t('push.test.waiting', { seconds: Math.max(0, Math.round(((send.data?.sendAt ?? 0) - Date.now()) / 1000)) })}</p> : null}
          {test?.deliveries ? <Deliveries deliveries={test.deliveries} /> : null}
          {send.isError ? <Banner>{send.error.message}</Banner> : null}
        </div>
      </CardBody>
    </Card>
  )
}

function Deliveries({ deliveries }: { deliveries: PushDeliveryDto[] }) {
  const t = useTranslate()
  const { data } = usePushDevices(true)
  if (deliveries.length === 0) return <Banner tone="caution">{t('push.test.noDevice')}</Banner>
  const label = (endpoint: string) => describeDevice(data?.devices.find((device) => device.endpoint === endpoint)?.userAgent ?? null)
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {deliveries.map((delivery) => (
        <li key={delivery.endpoint} className="flex flex-wrap items-center gap-2">
          <Badge tone={delivery.outcome === 'sent' ? 'positive' : 'critical'}>{t(`push.test.outcome.${delivery.outcome}`)}</Badge>
          <span className="text-ink-soft">{delivery.outcome === 'removed' ? SERVICES[delivery.service] : label(delivery.endpoint)}</span>
          {delivery.reason ? <span className="text-xs text-ink-faint">{delivery.status ? `${delivery.status} · ` : ''}{delivery.reason}</span> : null}
        </li>
      ))}
    </ul>
  )
}

const KINDS: Array<{ kind: NotificationKind; label: MessageKey; hint: MessageKey }> = [
  { kind: 'decision', label: 'push.prefs.decision', hint: 'push.prefs.decision.hint' },
  { kind: 'cliRequest', label: 'push.prefs.cliRequest', hint: 'push.prefs.cliRequest.hint' },
  { kind: 'turnCompleted', label: 'push.prefs.turnCompleted', hint: 'push.prefs.turnCompleted.hint' },
]

function Preferences() {
  const t = useTranslate()
  const { data: settings } = useUserSettings()
  const update = useUpdateNotificationPrefs()
  if (!settings) return null
  const prefs = settings.notifications
  return (
    <Card>
      <CardBody>
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">{t('push.prefs.title')}</h3>
            <p className="text-xs text-ink-faint">{t('push.prefs.hint')}</p>
          </div>
          <ul className="flex flex-col divide-y divide-line">
            {KINDS.map((entry) => (
              <li key={entry.kind} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{t(entry.label)}</p>
                  <p className="text-xs text-ink-faint">{t(entry.hint)}</p>
                </div>
                <Switch checked={prefs[entry.kind]} label={t(entry.label)} onCheckedChange={(value) => update.mutate({ ...prefs, [entry.kind]: value })} />
              </li>
            ))}
          </ul>
        </div>
      </CardBody>
    </Card>
  )
}
