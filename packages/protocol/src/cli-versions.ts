import type { AgentKind } from './events.js'

/**
 * Le paquet npm de chaque CLI, et la version sur laquelle Sillage est testé.
 *
 * Sillage ne transporte plus les binaires : ils viennent du système, donc leur version
 * n'est plus garantie par la release et les écarts de comportement entre versions
 * deviennent visibles pour l'utilisateur. Ce tableau est ce à quoi on compare, pour
 * pouvoir le dire plutôt que de le subir.
 *
 * Ce n'est pas un minimum requis ni une borne : un CLI d'une autre version fonctionne
 * probablement, et rien ne le bloque. C'est ce que l'écran affiche quand il signale un
 * écart, et ce que l'installation posera quand elle existera.
 *
 * À bumper délibérément, après avoir testé. Un numéro qu'on relève sans vérifier vaut
 * moins que pas de numéro du tout : il ferait passer pour testé ce qui ne l'est pas.
 *
 * Une seule table plutôt que deux : le paquet et la version qu'on en attend sont le
 * même fait, et les séparer les laisserait diverger au premier bump.
 *
 * Source unique, partagée par le serveur et le frontend, comme `AGENT_CAPABILITIES` :
 * le serveur installe et compare, l'écran affiche la version attendue à côté de celle
 * trouvée.
 */
export interface TestedCliRelease {
  /** Paquet npm, tel que l'installation depuis l'interface le posera. */
  readonly package: string
  readonly version: string
}

export const TESTED_CLI_RELEASES: Record<AgentKind, TestedCliRelease> = {
  claude: { package: '@anthropic-ai/claude-code', version: '2.1.220' },
  codex: { package: '@openai/codex', version: '0.145.0' },
}
