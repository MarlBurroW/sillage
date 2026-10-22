import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePermissionMode } from '@sillage/protocol'

/** CLI `--permission-mode` calls default mode `manual`; SDK calls it `default`. Keep user-visible CLI terminology and translate here. */
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
