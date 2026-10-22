import type { InstanceCapabilities, InstanceInfo, InstanceProfile } from '@sillage/protocol'

/** Instance profile read once from launcher-provided environment. Never request-controlled: it decides passwordless session creation, which clients must not assign themselves. Evaluate at import before `scrubLauncherEnv` removes child-environment variables. */
export const INSTANCE_PROFILE: InstanceProfile =
  process.env.SILLAGE_PROFILE === 'desktop' ? 'desktop' : 'server'

export function instanceCapabilities(profile: InstanceProfile): InstanceCapabilities {
  const desktop = profile === 'desktop'
  return {
    passwordAuth: !desktop,
    // Desktop apps have no push service, and phones cannot reach servers
    // listening only on 127.0.0.1.
    webPush: !desktop,
    pwa: !desktop,
    // Desktop has one account: nothing to share or hide.
    sharedProjects: !desktop,
  }
}

/** Profile and capabilities; the route adds database and machine information. */
export function instanceInfo(): Omit<InstanceInfo, 'needsSetup' | 'hostname' | 'homeDir'> {
  return { profile: INSTANCE_PROFILE, capabilities: instanceCapabilities(INSTANCE_PROFILE) }
}
