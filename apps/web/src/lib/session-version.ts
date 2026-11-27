import { PREFERRED_CLI_RELEASES, compareCliVersions, type AgentKind } from '@sillage/protocol'
import { translate } from './i18n'

/*
 * Kept apart from lib/agents, whose query hooks pull in browser-only modules: this stays a pure
 * function the unit tests can import.
 */

/**
 * Gap between the CLI version a session runs and the one Sillage targets. Unlike `versionMismatch`
 * (lib/agents), which judges the binary installed now, this judges the process holding the
 * conversation: it keeps its binary until it exits, so an update leaves open sessions behind.
 * Any difference is reported, since the point is to explain behaviour, not to judge compatibility.
 * Null when the session reports no version, matches the target, or cannot be compared.
 */
export function sessionVersionGap(agent: AgentKind, version: string | null | undefined): string | null {
  if (!version) return null
  const preferred = PREFERRED_CLI_RELEASES[agent].version
  const order = compareCliVersions(version, preferred)
  if (order === null || order === 0) return null
  return translate(order < 0 ? 'conversation.meta.cliVersionOlder' : 'conversation.meta.cliVersionNewer', { preferred })
}
