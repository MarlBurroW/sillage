import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePermissionMode } from '@sillage/protocol'

/**
 * La CLI et le SDK ne nomment pas le mode par défaut de la même façon : `--permission-mode`
 * accepte `manual`, le type du SDK l'appelle `default`. Sillage garde le vocabulaire de
 * la CLI, qui est celui affiché à l'utilisateur, et traduit ici.
 */
const TO_SDK: Record<ClaudePermissionMode, PermissionMode> = {
  manual: 'default',
  auto: 'auto',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  dontAsk: 'dontAsk',
  bypassPermissions: 'bypassPermissions',
}

export function toPermissionMode(mode: ClaudePermissionMode): PermissionMode {
  return TO_SDK[mode]
}
