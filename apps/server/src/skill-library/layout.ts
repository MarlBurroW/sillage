import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { LibrarySkillScope } from '@sillage/protocol'

/** Skill library disk layout: `<racine>/global/sillage/skills/<nom>/SKILL.md …`, `<racine>/projects/<projectId>/projet/skills/<nom>/SKILL.md …`, `<racine>/disabled/<skillId>/` outside delivered roots. `global/sillage` and `projects/<id>/projet` are Claude Code plugins; their `skills/` directories directly serve as Codex roots, sharing files between CLIs. Three probed choices: omit `.claude-plugin/plugin.json` manifests because Claude uses directory names (`sillage`, `projet`) without them, while Codex reads parent manifests and prefixes skills (`$projet:nom` instead of `$nom`), breaking composer lookup; avoid symlinks because Claude requests read permission unless both ends are allowed; plugin names prefix Claude commands (`/sillage:nom`), usually hidden by `/nom` aliases. */

export const GLOBAL_PLUGIN_NAME = 'sillage'
export const PROJECT_PLUGIN_NAME = 'projet'

/** Project and skill IDs are UUIDs. Checking is cheap and ensures neither traverses directories. */
function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Identifiant invalide : ${value}`)
  return value
}

export class SkillLibraryLayout {
  constructor(readonly root: string) {}

  /** Scope plugin root passed to Claude. */
  scopeRoot(scope: LibrarySkillScope, projectId: string | null): string {
    if (scope === 'global') return join(this.root, 'global', GLOBAL_PLUGIN_NAME)
    if (!projectId) throw new Error('Un skill de projet doit nommer son projet.')
    return join(this.projectDir(projectId), PROJECT_PLUGIN_NAME)
  }

  /** Active skill directory; its name already passed `skillNameSchema`. */
  skillDir(scope: LibrarySkillScope, projectId: string | null, name: string): string {
    return join(this.scopeRoot(scope, projectId), 'skills', name)
  }

  disabledDir(skillId: string): string {
    return join(this.root, 'disabled', safeSegment(skillId))
  }

  /** Staging area under the root to remain on the same filesystem: `rename` is atomic, so CLIs never see partially written or deleted skills. */
  stagingDir(): string {
    return join(this.root, '.staging')
  }

  /** Plugin roots delivered to conversations: global then project. Create them including empty `skills/` directories on every call. Probing showed plugins launched without `skills/` never see subsequently added skills, even after `reloadSkills()`. Empty scopes must exist at launch so skills created during sessions are discovered. */
  rootsFor(projectId: string | null): string[] {
    return [this.ensureScope('global', null), ...(projectId ? [this.ensureScope('project', projectId)] : [])]
  }

  /** Creates missing scope roots and returns them. */
  ensureScope(scope: LibrarySkillScope, projectId: string | null): string {
    const root = this.scopeRoot(scope, projectId)
    mkdirSync(join(root, 'skills'), { recursive: true })
    return root
  }

  /** Deletes active project skills; SQL cascades do not touch disk. */
  removeProject(projectId: string): void {
    rmSync(this.projectDir(projectId), { recursive: true, force: true })
  }

  private projectDir(projectId: string): string {
    return join(this.root, 'projects', safeSegment(projectId))
  }
}
