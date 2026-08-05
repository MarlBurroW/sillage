import type { SlashCommandDto } from '@sillage/protocol'

/** Une commande et le nom sous lequel elle a été trouvée, alias compris. */
export interface CommandMatch {
  command: SlashCommandDto
  /** Ce qui s'écrit après la barre oblique une fois la commande choisie. */
  name: string
}

/**
 * Ce que le début de saisie désigne, du plus proche au plus lointain.
 *
 * Sur préfixe, et non par correspondance floue comme les fichiers : les noms sont
 * courts et connus de celui qui les tape, alors qu'un chemin se cherche. Les alias
 * concourent sous leur propre nom, `/cost` devant mener à `/usage` sans qu'il faille
 * savoir lequel des deux est le vrai.
 */
export function matchCommands(commands: SlashCommandDto[], query: string): CommandMatch[] {
  const needle = query.toLowerCase()
  const matches: CommandMatch[] = []

  for (const command of commands) {
    const names = [command.name, ...command.aliases]
    // Un seul nom retenu par commande : proposer `/usage`, `/cost` et `/stats` comme
    // trois entrées ferait passer une commande pour trois.
    const name = names.find((candidate) => candidate.toLowerCase().startsWith(needle))
    if (name) matches.push({ command, name })
  }

  // Le nom canonique passe devant son alias, et l'ordre alphabétique tranche le reste.
  // Celui du CLI ne se garde pas : il range les compétences découvertes avant les
  // commandes intégrées, ce qui ne veut rien dire pour qui parcourt la liste.
  return matches.sort((a, b) => {
    const canonical = Number(b.name === b.command.name) - Number(a.name === a.command.name)
    return canonical !== 0 ? canonical : a.name.localeCompare(b.name)
  })
}

/**
 * Première ligne de la description, seule à tenir sur une ligne de liste.
 *
 * Une compétence décrit son propre déclenchement sur plusieurs paragraphes : les
 * afficher entiers noierait les commandes voisines, dont la description tient en
 * quelques mots.
 */
export function commandSummary(command: SlashCommandDto): string {
  return command.description.split('\n')[0]?.trim() ?? ''
}
