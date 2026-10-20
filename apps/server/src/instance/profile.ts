import type { InstanceCapabilities, InstanceInfo, InstanceProfile } from '@sillage/protocol'

/**
 * Le profil de l'instance, lu une fois dans l'environnement que pose le lanceur.
 *
 * Jamais dans une requête : c'est lui qui décide qu'une session s'ouvre sans mot de
 * passe, et aucun client ne doit pouvoir se l'attribuer. Évalué à l'import, avant que
 * `scrubLauncherEnv` ne retire la variable de l'environnement des processus enfants.
 */
export const INSTANCE_PROFILE: InstanceProfile =
  process.env.SILLAGE_PROFILE === 'desktop' ? 'desktop' : 'server'

export function instanceCapabilities(profile: InstanceProfile): InstanceCapabilities {
  const desktop = profile === 'desktop'
  return {
    passwordAuth: !desktop,
    // L'application de bureau n'a pas de service de push, et un téléphone ne joindrait
    // pas un serveur qui n'écoute que sur 127.0.0.1.
    webPush: !desktop,
    pwa: !desktop,
    // Un seul compte en bureau : rien à partager, rien à cacher.
    sharedProjects: !desktop,
  }
}

/** Le profil et ses capacités ; la route y ajoute ce qui se lit en base ou sur la machine. */
export function instanceInfo(): Omit<InstanceInfo, 'needsSetup' | 'hostname' | 'homeDir'> {
  return { profile: INSTANCE_PROFILE, capabilities: instanceCapabilities(INSTANCE_PROFILE) }
}
