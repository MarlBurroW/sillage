import { z } from 'zod'

/**
 * Les commandes en `/` que le CLI de la session reconnaît.
 *
 * Elles ne sont pas déduites d'un catalogue écrit ici : chaque CLI publie les siennes,
 * et la liste dépend du poste et du projet autant que de la version. Les compétences
 * découvertes en cours de route, les commandes de projet et celles des extensions y
 * entrent sans que Sillage ait à les connaître.
 */
export const slashCommandSchema = z.object({
  /** Sans la barre oblique, telle que le CLI la nomme. */
  name: z.string(),
  description: z.string(),
  /** Forme attendue des arguments (`<file>`, `[on|off]`), vide quand il n'en prend pas. */
  argumentHint: z.string(),
  /** Autres noms menant à la même commande : `/cost` et `/stats` pour `/usage`. */
  aliases: z.array(z.string()).default([]),
})

export type SlashCommandDto = z.infer<typeof slashCommandSchema>

/**
 * Commandes que Sillage exécute lui-même au lieu de les transmettre comme du texte.
 *
 * Le CLI sait déjà les faire, mais par un chemin que Sillage a dû doubler pour ses
 * propres boutons. Passer par la plomberie maison plutôt que par la frappe donne le
 * même retour visuel des deux côtés : la même bannière de compaction, la même erreur,
 * le même bouton grisé pendant l'opération.
 */
export const NATIVE_SLASH_COMMANDS = new Set(['compact'])

/**
 * Commandes retirées de la liste proposée.
 *
 * Trois motifs, et rien d'autre. Elles ne servent qu'au harnais qui les a lancées
 * (`__remote-workflow`), elles s'adressent au terminal que Sillage n'a pas (`color`
 * repeint une barre de saisie absente, `heapdump` écrit sur le bureau de la machine
 * serveur), ou elles déplacent sous Sillage un état dont il rend compte : `/clear`
 * échange la session du CLI sans que le journal en sache rien, et `/model`, `/effort`,
 * `/fast` et `/config` changent la configuration appliquée pendant que les réglages du
 * composer continuent d'afficher l'ancienne.
 *
 * Les commandes que Sillage double sans les contredire ne sont pas ici : `/usage` et
 * `/context` répondent par du texte, et rien ne se désynchronise à les lire deux fois.
 */
const HIDDEN_SLASH_COMMANDS = new Set([
  '__remote-workflow',
  'workflow-launch-exec',
  'color',
  'heapdump',
  'clear',
  'config',
  'model',
  'effort',
  'fast',
])

/**
 * Ce que le CLI annonce, réduit à ce qui a un sens depuis un navigateur.
 *
 * Appliqué à la source, avant que la liste entre au journal : ce qui n'est pas
 * proposable n'a pas à voyager ni à être refiltré par chaque lecteur.
 *
 * Les commandes dépréciées passent par leur description, faute de champ pour le dire :
 * le CLI garde `/agents` et `/extra-usage` pour rediriger celui qui les tape encore, et
 * les annonce « (removed) » et « Renamed to ... ». Les proposer serait offrir une
 * commande dont la seule réponse est qu'elle n'existe plus.
 */
export function usableSlashCommands(commands: SlashCommandDto[]): SlashCommandDto[] {
  return commands.filter((command) => {
    if (HIDDEN_SLASH_COMMANDS.has(command.name)) return false
    if (command.name.startsWith('__')) return false
    return !/^\((removed|deprecated)\)|^Renamed to /i.test(command.description)
  })
}

/**
 * La commande écrite en tête du message, s'il en porte une.
 *
 * Seulement en tête : c'est la seule position où les CLI la reconnaissent, et un `/`
 * accepté ailleurs ferait passer pour une commande le chemin qu'on est en train
 * d'écrire.
 */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  return { name: match[1] ?? '', args: match[2]?.trim() ?? '' }
}
