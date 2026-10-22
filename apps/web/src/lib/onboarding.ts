import type { AgentConfig, InstanceProfile, OnboardingAnswers } from '@sillage/protocol'

/**
 * First-launch tour steps and order based on instance type and user answers. Recompute each render:
 * Welcome answers change the list, so the stored account index applies only to the current list.
 */
export type OnboardingStepId =
  | 'account'
  | 'welcome'
  | 'appearance'
  | 'agents'
  | 'work'
  | 'memory'
  | 'rules'
  | 'address'
  | 'ready'

export interface OnboardingShape {
  profile: InstanceProfile
  isAdmin: boolean
  answers: OnboardingAnswers
}

export function onboardingSteps({ profile, isAdmin, answers }: OnboardingShape): OnboardingStepId[] {
  const steps: OnboardingStepId[] = []
  // Server: account first, creating the first or using one opened by an administrator. Desktop
  // already has a session opened by the launcher.
  if (profile === 'server') steps.push('account')
  steps.push('welcome', 'appearance', 'agents', 'work')
  // Storage for project instructions and memory: an account default for each.
  steps.push('memory')
  // Global instructions belong to administrators; project instructions are configured on the project page.
  if (isAdmin) steps.push('rules')
  // The public address serves more than phones (webhooks, API), so administrators always see it.
  // Members see only the phone section if they plan to use it.
  if (profile === 'server' && (isAdmin || answers.devices === 'phone')) steps.push('address')
  steps.push('ready')
  return steps
}

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
