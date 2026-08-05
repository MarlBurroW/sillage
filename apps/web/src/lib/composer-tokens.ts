import type { AgentSkillDto, SlashCommandDto } from '@sillage/protocol'

/**
 * Une entrée proposée sous le sigle en cours de saisie.
 *
 * Commandes en `/` et compétences en `$` n'ont ni la même origine ni le même effet,
 * mais se choisissent de la même façon : les deux se réduisent ici, et une seule liste
 * sait les afficher.
 */
export interface PickerEntry {
  /** Ce qui s'écrit après le sigle une fois l'entrée choisie. */
  name: string
  /** Forme attendue des arguments, vide quand l'entrée n'en prend pas. */
  hint: string
  summary: string
}

/**
 * Première ligne de la description, seule à tenir sur une ligne de liste.
 *
 * Une compétence décrit son propre déclenchement sur plusieurs paragraphes : les
 * afficher entiers noierait les entrées voisines, dont la description tient en
 * quelques mots.
 */
function summarize(description: string): string {
  return description.split('\n')[0]?.trim() ?? ''
}

/**
 * Tri commun : le nom canonique passe devant son alias, l'ordre alphabétique tranche
 * le reste. Celui du CLI ne se garde pas, il range les compétences découvertes avant
 * les commandes intégrées, ce qui ne veut rien dire pour qui parcourt la liste.
 */
function byName(isCanonical: (entry: PickerEntry) => boolean) {
  return (a: PickerEntry, b: PickerEntry) => {
    const rank = Number(isCanonical(b)) - Number(isCanonical(a))
    return rank !== 0 ? rank : a.name.localeCompare(b.name)
  }
}

/**
 * Ce que le début de saisie désigne parmi les commandes, du plus proche au plus loin.
 *
 * Sur préfixe, et non par correspondance floue comme les fichiers : les noms sont
 * courts et connus de celui qui les tape, alors qu'un chemin se cherche. Les alias
 * concourent sous leur propre nom, `/cost` devant mener à `/usage` sans qu'il faille
 * savoir lequel des deux est le vrai.
 */
export function matchCommands(commands: SlashCommandDto[], query: string): PickerEntry[] {
  const needle = query.toLowerCase()
  const canonical = new Set<string>()
  const matches: PickerEntry[] = []

  for (const command of commands) {
    const names = [command.name, ...command.aliases]
    // Un seul nom retenu par commande : proposer `/usage`, `/cost` et `/stats` comme
    // trois entrées ferait passer une commande pour trois.
    const name = names.find((candidate) => candidate.toLowerCase().startsWith(needle))
    if (!name) continue
    if (name === command.name) canonical.add(name)
    matches.push({ name, hint: command.argumentHint, summary: summarize(command.description) })
  }

  return matches.sort(byName((entry) => canonical.has(entry.name)))
}

/** Même règle de préfixe pour les compétences, qui n'ont ni alias ni arguments. */
export function matchSkills(skills: AgentSkillDto[], query: string): PickerEntry[] {
  const needle = query.toLowerCase()
  return skills
    .filter((skill) => skill.name.toLowerCase().startsWith(needle))
    .map((skill) => ({ name: skill.name, hint: '', summary: summarize(skill.description) }))
    .sort(byName(() => true))
}
