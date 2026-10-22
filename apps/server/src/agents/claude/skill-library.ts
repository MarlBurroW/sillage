import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk'

/** Skill library additions to Claude launch. Roots are local plugins exposing native commands (`/sillage:nom`, alias `/nom`) and description-triggered skills without writing `~/.claude`. Probed requirements: `skipMcpDiscovery` keeps plugin MCP outside registry authority; allowed root directories prevent supporting-file read prompts; `Edit`/`Write` deny rules prevent unintended global-skill edits when `acceptEdits` grants directory writes. This is a safeguard, not a security boundary, because Bash redirection remains possible. Initial `//` denotes absolute paths in Claude rules. */
export interface SkillLibraryLaunchOptions {
  plugins: SdkPluginConfig[]
  additionalDirectories: string[]
  deny: string[]
}

export function skillLibraryLaunchOptions(roots: string[]): SkillLibraryLaunchOptions {
  return {
    plugins: roots.map((path) => ({ type: 'local', path, skipMcpDiscovery: true })),
    additionalDirectories: roots,
    deny: roots.flatMap((root) => [`Edit(/${root}/**)`, `Write(/${root}/**)`]),
  }
}
