import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { LibrarySkillScope } from '@sillage/protocol'

/**
 * Disposition de la bibliothèque de skills sur le disque.
 *
 * ```
 * <racine>/global/sillage/skills/<nom>/SKILL.md …
 * <racine>/projects/<projectId>/projet/skills/<nom>/SKILL.md …
 * <racine>/disabled/<skillId>/                    hors de toute racine livrée
 * ```
 *
 * `global/sillage` et `projects/<id>/projet` sont des plugins Claude Code, et leur
 * dossier `skills/` sert tel quel de racine Codex : un seul jeu de fichiers pour les deux
 * CLI. Trois choix, tous relevés par sonde :
 *
 * - Aucun manifeste `.claude-plugin/plugin.json`. Claude n'en a pas besoin et prend le
 *   nom du dossier, d'où `sillage` et `projet`. Codex, lui, lit ce manifeste quand il
 *   le trouve au-dessus d'une racine, et préfixe alors chaque skill du nom du plugin :
 *   `$projet:nom` au lieu de `$nom`, que le composer ne retrouve plus en tapant `$nom`.
 * - Aucun lien symbolique. Claude demande la permission de lire un fichier atteint par
 *   un lien tant que les deux côtés ne sont pas dans ses répertoires autorisés.
 * - Le nom du plugin devient le préfixe des commandes Claude (`/sillage:nom`), que
 *   l'alias `/nom` rend le plus souvent invisible.
 */

export const GLOBAL_PLUGIN_NAME = 'sillage'
export const PROJECT_PLUGIN_NAME = 'projet'

/**
 * Les identifiants de projet et de skill sont des UUID. Le contrôle ne coûte rien et
 * garantit qu'aucun ne remonte l'arborescence.
 */
function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Identifiant invalide : ${value}`)
  return value
}

export class SkillLibraryLayout {
  constructor(readonly root: string) {}

  /** Racine du plugin d'une portée, celle qu'on passe à Claude. */
  scopeRoot(scope: LibrarySkillScope, projectId: string | null): string {
    if (scope === 'global') return join(this.root, 'global', GLOBAL_PLUGIN_NAME)
    if (!projectId) throw new Error('Un skill de projet doit nommer son projet.')
    return join(this.projectDir(projectId), PROJECT_PLUGIN_NAME)
  }

  /** Dossier d'un skill actif. Le nom a déjà passé `skillNameSchema`. */
  skillDir(scope: LibrarySkillScope, projectId: string | null, name: string): string {
    return join(this.scopeRoot(scope, projectId), 'skills', name)
  }

  disabledDir(skillId: string): string {
    return join(this.root, 'disabled', safeSegment(skillId))
  }

  /**
   * Zone de transit, sous la racine pour rester sur le même système de fichiers : un
   * `rename` y est atomique, et un CLI ne voit jamais un skill à moitié écrit ni à moitié
   * supprimé.
   */
  stagingDir(): string {
    return join(this.root, '.staging')
  }

  /**
   * Racines de plugin à livrer à une conversation : la globale, puis celle du projet.
   *
   * Créées à chaque appel, `skills/` compris et même vide. Sondé : un plugin lancé sans
   * dossier `skills/` ne voit jamais ce qu'on y ajoute ensuite, même après
   * `reloadSkills()`. Une portée vide au lancement doit donc exister quand même, pour
   * qu'un skill créé en cours de session y soit trouvé.
   */
  rootsFor(projectId: string): string[] {
    return [this.ensureScope('global', null), this.ensureScope('project', projectId)]
  }

  /** Crée la racine d'une portée si elle manque, et la rend. */
  ensureScope(scope: LibrarySkillScope, projectId: string | null): string {
    const root = this.scopeRoot(scope, projectId)
    mkdirSync(join(root, 'skills'), { recursive: true })
    return root
  }

  /** Supprime les skills actifs d'un projet. La cascade SQL ne touche pas au disque. */
  removeProject(projectId: string): void {
    rmSync(this.projectDir(projectId), { recursive: true, force: true })
  }

  private projectDir(projectId: string): string {
    return join(this.root, 'projects', safeSegment(projectId))
  }
}
