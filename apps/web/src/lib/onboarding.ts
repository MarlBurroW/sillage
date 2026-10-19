import type { AgentConfig, InstanceProfile, OnboardingAnswers } from '@sillage/protocol'

/**
 * La visite de première ouverture : quelles étapes, dans quel ordre, d'après ce que
 * l'instance est et ce que l'utilisateur a répondu.
 *
 * Calculée à chaque rendu plutôt que mémorisée : les réponses de Bienvenue changent la
 * liste, et l'index enregistré au compte ne vaut que pour la liste du moment.
 */
export type OnboardingStepId =
  | 'account'
  | 'welcome'
  | 'appearance'
  | 'agents'
  | 'project'
  | 'work'
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
  // Hébergé : le compte d'abord, créé s'il est le premier, repris s'il a été ouvert par
  // un administrateur. En bureau, le lanceur a déjà ouvert la session.
  if (profile === 'server') steps.push('account')
  steps.push('welcome', 'appearance', 'agents', 'project', 'work')
  // Les consignes globales relèvent de l'administrateur ; celles d'un projet se règlent
  // sur sa page.
  if (isAdmin) steps.push('rules')
  // L'adresse publique sert bien au-delà du téléphone (webhooks, API) : l'administrateur
  // la voit toujours. Un membre n'a que la partie téléphone, s'il compte s'en servir.
  if (profile === 'server' && (isAdmin || answers.devices === 'phone')) steps.push('address')
  steps.push('ready')
  return steps
}

export type PermissionChoice = OnboardingAnswers['permission']

/**
 * Le réflexe choisi, traduit dans le vocabulaire de chaque CLI.
 *
 * Les quatre réflexes sont ceux de Claude ; les autres CLI n'ont pas tous les quatre, et
 * la traduction prend le garde-fou le plus proche plutôt que d'inventer un mode.
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
 * Ce qu'une adresse dit de l'accès depuis ailleurs.
 *
 * `local` : une adresse qui ne mène nulle part hors du réseau où elle a été tapée.
 * Les noms d'un réseau privé Tailscale (`.ts.net`) ou d'un domaine public passent.
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

/** L'origine de la page, sans chemin : ce par quoi ce navigateur est arrivé. */
export function currentOrigin(): string {
  return window.location.origin
}
