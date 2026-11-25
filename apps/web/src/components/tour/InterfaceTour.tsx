import { Suspense } from 'react'
import { lazyWithReload } from '../../lib/lazy-reload'
import { useUpdateOnboarding, useUserSettings } from '../../lib/user-settings'

const TourOverlay = lazyWithReload(() => import('./TourOverlay').then((module) => ({ default: module.TourOverlay })))

/**
 * Mounted with the shell. Nothing is rendered, and nothing is loaded, until this account's tour is
 * due; ending or skipping clears the flag on the account, so the tour is seen once whatever the
 * device.
 */
export function InterfaceTour() {
  const { data: settings } = useUserSettings()
  const update = useUpdateOnboarding()
  if (!settings?.onboarding.interfaceTourPending) return null
  return (
    <Suspense fallback={null}>
      <TourOverlay onEnd={() => update.mutate({ ...settings.onboarding, interfaceTourPending: false })} />
    </Suspense>
  )
}
