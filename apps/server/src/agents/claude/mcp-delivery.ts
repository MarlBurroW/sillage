import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { compareVersions } from '../../update/version.js'

export type McpServersDelivery = 'argv' | 'initialize'

/**
 * Claude Code version bundled with the SDK, read from its package rather than restated: the
 * 'initialize' delivery requires that version or newer (SDK 0.3.326 onwards), and the SDK is
 * bumped independently of the CLI users keep. Null when unreadable, which keeps the command line.
 */
function bundledClaudeCodeVersion(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { claudeCodeVersion?: unknown }
    return typeof manifest.claudeCodeVersion === 'string' ? manifest.claudeCodeVersion : null
  } catch {
    return null
  }
}

export const BUNDLED_CLAUDE_CODE_VERSION = bundledClaudeCodeVersion()

/**
 * How launch-time MCP servers reach the CLI. On the command line (`--mcp-config`), their `env`
 * and `headers` are readable by every user of the machine through `ps`; over the initialize
 * request they stay off it. That request needs a CLI at least as new as the SDK's own: an older
 * one exits at startup or has its session ended by the SDK. Sillage lets users keep their CLI,
 * so an older, unknown or unparseable version keeps the command line, explicitly: leaving the
 * option unset logs a deprecation warning, and its future default would break those CLIs.
 */
export function mcpServersDelivery(cliVersion: string | null, bundled = BUNDLED_CLAUDE_CODE_VERSION): McpServersDelivery {
  if (!cliVersion || !bundled) return 'argv'
  // compareVersions ranks unparseable versions lowest: a suffixed build string reads as older.
  return compareVersions(cliVersion, bundled) >= 0 ? 'initialize' : 'argv'
}
