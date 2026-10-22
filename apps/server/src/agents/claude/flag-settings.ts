import type { Query, Settings } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeConfig } from '@sillage/protocol'

/** CLI flag settings from startup `--settings` and live `applyFlagSettings`, overriding host files. Always write fast mode even false so conversations decide rather than settings.json; SDK opt-in is required (`sdk_opt_in_required`, probed). Write Ultracode only when enabled; omit other unspecified keys to retain CLI defaults. Library deny rules, repository instruction masks and memory directories are launch-only. Live `applyFlagSettings` removes only explicitly null keys, so omit `permissions`, `claudeMdExcludes` and `autoMemoryDirectory` to preserve them. */
export function flagSettings(
  config: ClaudeConfig,
  deny: string[] = [],
  excludes: string[] = [],
  memoryDir: string | null = null,
): Settings {
  return {
    fastMode: config.fastMode,
    ...(config.ultracode ? { ultracode: true } : {}),
    ...(config.outputStyle ? { outputStyle: config.outputStyle } : {}),
    ...(config.advisorModel ? { advisorModel: config.advisorModel } : {}),
    ...(deny.length > 0 ? { permissions: { deny } } : {}),
    ...(excludes.length > 0 ? { claudeMdExcludes: excludes } : {}),
    // Claude automatic memory stored by Sillage for Codex sharing and interface display;
    // Claude writes normally without permission prompts.
    ...(memoryDir ? { autoMemoryDirectory: memoryDir } : {}),
  }
}

/** Live flag transition from `previous` to `next`. Null removes keys and restores CLI defaults, whereas omission retains old values. Fast mode applies next turn and reports via `result`; probes confirm `applyFlagSettings({ fastMode: true })` needs no restart. */
export function liveFlagSettings(
  previous: ClaudeConfig,
  next: ClaudeConfig,
): Parameters<Query['applyFlagSettings']>[0] {
  // Send Ultracode only on changes: toggles inject 'Ultracode is on/off' model notices
  // (probed) that unrelated settings need not repeat. Null disables it
  // while retaining configured effort. Also resend when effort changes while enabled:
  // since 2.1.284, changing `effortLevel` without resending `ultracode` disables it
  // (probed 2.1.286 and 2.1.291),
  // while the composer would still display it as enabled.
  const ultracodeKey =
    next.ultracode !== previous.ultracode || (next.ultracode && next.effort !== previous.effort)
  return {
    effortLevel: next.effort,
    fastMode: next.fastMode,
    outputStyle: next.outputStyle || null,
    advisorModel: next.advisorModel || null,
    ...(ultracodeKey ? { ultracode: next.ultracode ? true : null } : {}),
  }
}
