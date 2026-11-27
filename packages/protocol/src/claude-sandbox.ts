/**
 * Whether the host can run Claude Code's Bash sandbox, read from the CLI itself: it depends on
 * system packages (bubblewrap and socat on Linux), the platform (no native Windows) and what the
 * kernel allows, which Sillage cannot tell reliably by looking for binaries.
 */
export interface ClaudeSandboxSupportDto {
  /** `unknown` when the check itself failed: missing CLI, timeout, another startup refusal. */
  state: 'available' | 'unavailable' | 'unknown'
  /** The CLI's explanation, trimmed of its own advice about turning the requirement off. */
  reason: string | null
  checkedAt: number
}
