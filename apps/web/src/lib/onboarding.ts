import type { AgentConfig, InstanceProfile, OnboardingAnswers } from '@sillage/protocol'

/**
 * First-launch tour steps, in order. The list depends only on the edition: every account sees the
 * same steps, and a step adapts its content to the role (members have no global instructions to
 * write and read the instance address without editing it).
 */
export type OnboardingStepId = 'account' | 'welcome' | 'appearance' | 'agents' | 'work' | 'rules' | 'address' | 'ready'

export function onboardingSteps(profile: InstanceProfile): OnboardingStepId[] {
  const steps: OnboardingStepId[] = []
  // Server: account first, creating the first or using one opened by an administrator. Desktop
  // already has a session opened by the launcher.
  if (profile === 'server') steps.push('account')
  steps.push('welcome', 'appearance', 'agents', 'work', 'rules')
  // Following a turn from the phone is the point of a hosted instance; Desktop listens on this
  // computer only and has its own remote-access setting.
  if (profile === 'server') steps.push('address')
  steps.push('ready')
  return steps
}

/** Where the tour may land other than its default exit; `App` reads it from the address. */
export type OnboardingExit = 'sample'
export const ONBOARDING_EXIT_PARAM = 'next'

export type PermissionChoice = OnboardingAnswers['permission']

/**
 * Selected permission policy in each CLI's vocabulary. The four policies come from Claude; other
 * CLIs use the nearest available safeguard rather than an invented mode.
 */
export function withPermissionChoice(config: AgentConfig, choice: PermissionChoice): AgentConfig {
  switch (config.agent) {
    case 'claude':
      return {
        ...config,
        permissionMode: ({ manual: 'manual', auto: 'auto', acceptEdits: 'acceptEdits', bypass: 'bypassPermissions' } as const)[choice],
      }
    case 'codex':
      return {
        ...config,
        askForApproval: choice === 'manual' ? 'untrusted' : choice === 'auto' ? 'on-request' : 'never',
        sandbox: choice === 'bypass' ? 'danger-full-access' : 'workspace-write',
      }
    case 'opencode':
      return {
        ...config,
        permissions: {
          ...config.permissions,
          edit: choice === 'manual' || choice === 'auto' ? 'ask' : 'allow',
          bash: choice === 'bypass' ? 'allow' : 'ask',
        },
      }
    case 'antigravity':
      return { ...config, permissionMode: choice === 'bypass' ? 'yolo' : choice === 'acceptEdits' ? 'auto_edit' : 'default' }
    case 'grok':
      return {
        ...config,
        permissionMode: ({ manual: 'default', auto: 'auto', acceptEdits: 'auto', bypass: 'bypassPermissions' } as const)[choice],
      }
  }
}

/**
 * What an address implies about remote access. `local` identifies addresses unusable outside the
 * originating network. Private Tailscale names (`.ts.net`) and public domain names are accepted.
 */
export function describeOrigin(value: string): { valid: boolean; https: boolean; local: boolean } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { valid: false, https: false, local: true }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { valid: false, https: false, local: true }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const local =
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host) ||
    /\.(local|lan|home|internal)$/.test(host) ||
    !host.includes('.')
  return { valid: true, https: url.protocol === 'https:', local }
}

/** Current page origin without a path: the address this browser used to arrive. */
export function currentOrigin(): string {
  return window.location.origin
}
