/**
 * Serveur MCP de Sillage : rend au CLI ce que la plateforme sait et qu'il ignore.
 *
 * Un CLI redémarre amnésique à chaque conversation, alors que Sillage garde le journal
 * de toutes les précédentes et le board du projet. Les outils exposés ici ouvrent cette
 * mémoire et cet état, cadrés au projet courant.
 *
 * Les outils qui écrivent le font tous dans un flux ajouté : notes de carte, messages
 * entre sessions, surveillances, cartes neuves et sessions lancées, ces deux dernières
 * par le daemon. Deux exceptions. L'image du projet, qu'un agent pose ou remplace :
 * elle n'est la consigne ni le jugement de personne, et l'utilisateur la reprend d'un
 * clic. Et SILLAGE.md, qu'un agent lit et réécrit comme il le ferait d'un fichier de
 * consignes du dépôt, à la demande de l'utilisateur, qui en voit la dernière main. La frontière est là et pas ailleurs : un agent peut
 * raconter ce qu'il a fait ou prévenir une autre session, il ne peut ni déplacer une
 * carte ni réécrire sa description. Déplacer serait se donner un satisfecit, et la
 * colonne cesserait d'être la position choisie qu'elle est censée rester ; réécrire la
 * description ferait qu'un compte rendu de session efface la consigne qu'il était censé
 * suivre.
 *
 * Un message entre sessions n'est que déposé ici. Ce process n'a que la base, il ne
 * tient aucun runner : c'est le daemon qui le remet, en l'injectant dans le tour en
 * cours du destinataire ou en le réveillant (`apps/server/src/sessions/session-relay.ts`).
 *
 * En `.mjs` plutôt qu'en TypeScript compilé, comme la sonde : le process est lancé par
 * le CLI, pas par Sillage, et le garder hors du graphe de modules du serveur évite
 * qu'il n'embarque un jour la moitié de l'application par un import distrait. Sa seule
 * dépendance est `better-sqlite3`, déjà présente.
 *
 * Il lit la base directement, en lecture seule, plutôt que d'appeler l'API HTTP. Pas de
 * jeton à faire circuler, pas de port à ouvrir : l'environnement ne porte qu'une portée,
 * jamais un secret. Ce n'est pas une frontière de sécurité pour autant, l'agent ayant
 * déjà un shell et le fichier sur le disque ; c'est le même accès, en plus commode.
 */
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const DB_PATH = process.env.SILLAGE_MCP_DB
const PROJECT_ID = process.env.SILLAGE_MCP_PROJECT
/** Exclue des résultats : sans ça l'agent se relit lui-même et tourne en rond. */
const CURRENT_CONVERSATION = process.env.SILLAGE_MCP_CONVERSATION ?? ''
/** Dossier de mémoire du projet, partagé avec la mémoire automatique de Claude. */
const MEMORY_DIR = process.env.SILLAGE_MCP_MEMORY ?? ''

/** Au-delà, le fil ne tient plus dans un contexte sans en chasser le travail en cours. */
const MAX_THREAD_CHARS = 20000

/**
 * Part du budget qu'un seul message peut prendre.
 *
 * Un quart et non une valeur fixe basse : une session de vérification tient parfois
 * toute entière dans son dernier message, et un plafond serré coupait exactement la
 * conclusion qu'on venait chercher. Un quart laisse passer un rapport de plusieurs
 * milliers de caractères sans qu'un seul message puisse monopoliser un long fil.
 */
const MAX_MESSAGE_CHARS = Math.floor(MAX_THREAD_CHARS / 4)

/**
 * Fenêtre par défaut de `list_sessions`.
 *
 * Quinze minutes répond à « qui travaille en ce moment », qui est la question posée dans
 * la plupart des cas. Un défaut plus large inviterait à tout ramener à chaque appel ;
 * un modèle qui veut savoir sur quoi on a travaillé aujourd'hui demande vingt-quatre
 * heures de lui-même.
 */
const RECENT_MINUTES = 15

/**
 * Fenêtre par défaut de `find_file_edits`.
 *
 * Plus large que celle des sessions : une modification non commitée reste dans l'arbre
 * après la fin de la session qui l'a faite, et c'est justement quand plus rien ne tourne
 * qu'on cherche d'où elle vient. Bornée quand même, et c'est le point : le journal garde
 * les éditions indéfiniment, y compris celles commitées depuis des jours, qui
 * n'expliquent plus rien de l'état de l'arbre et feraient passer une session close pour
 * une session en train d'écrire.
 */
const EDIT_MINUTES = 120

/** Plafond de couples session-fichier rendus, annoncé quand il mord. */
const EDIT_ROW_LIMIT = 40

/**
 * Libellés des colonnes du board, en clair.
 *
 * Les valeurs stockées (`todo`, `in_progress`) sont des identifiants, pas de la langue :
 * les rendre telles quelles obligerait le modèle à deviner que `review` veut dire « à
 * relire par un humain » et non « en cours de relecture par un agent ».
 */
const COLUMN_LABELS = {
  todo: 'à faire',
  in_progress: 'en cours',
  review: 'à vérifier',
  done: 'terminé',
  abandoned: 'abandonné',
}

/** Au-delà, le board pèse plus qu'il n'oriente. Annoncé quand il mord. */
const CARD_LIMIT = 40

/** Une description entière peut faire des pages ; le board n'en rend qu'un aperçu. */
const CARD_EXCERPT_CHARS = 160

/**
 * Taille maximale d'un message entre sessions.
 *
 * Il arrive dans le contexte du destinataire sans qu'il l'ait demandé, au milieu de son
 * propre travail : c'est un mot glissé à un collègue, pas un rapport. Ce qui demande plus
 * se met dans un fichier, ou se lit par read_conversation.
 */
const MAX_PEER_MESSAGE_CHARS = 4000

/**
 * Combien de temps un outil attend que le daemon ait traité sa demande.
 *
 * Lancer une session démarre un CLI, et parfois un worktree avant lui : quelques
 * secondes d'ordinaire, davantage sur une machine chargée. Passé ce délai, l'agent
 * apprend que la demande court toujours plutôt que de rester suspendu.
 */
const REQUEST_WAIT_MS = { start_session: 90000, create_card: 15000, list_models: 30000 }
const REQUEST_POLL_MS = 200

/** Doit rester d'accord avec `MAX_LAUNCH_PROMPT_CHARS` de `agent-requests.ts`. */
const MAX_LAUNCH_PROMPT_CHARS = 20000

/** Messages rendus par read_session_messages, les plus récents. */
const PEER_HISTORY_LIMIT = 20

/**
 * Garde-fous du relais, pour prévenir l'expéditeur dès l'envoi qu'un message sera
 * retenu plutôt que de le lui laisser découvrir.
 *
 * Doivent rester d'accord avec `apps/server/src/sessions/session-relay.ts`, qui seul
 * décide ; ce module ne peut pas l'importer, étant hors du graphe de modules du serveur.
 */
const MAX_HOPS = 6
const WAKES_PER_HOUR = 6

/**
 * Plafond d'une image de projet, et tri de ce qui en est une.
 *
 * Doivent rester d'accord avec `MAX_PROJECT_IMAGE_BYTES` du protocole et avec
 * `apps/server/src/projects/image.ts`, que ce module ne peut pas importer.
 */
const MAX_PROJECT_IMAGE_BYTES = 1024 * 1024

function sniffProjectImage(buffer) {
  const head = buffer.subarray(0, 4).toString('latin1')
  if (head === '\x89PNG') return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (head === 'GIF8') return 'image/gif'
  if (head === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (!buffer.includes(0) && /<svg[\s>]/i.test(buffer.subarray(0, 4096).toString('utf8'))) {
    return 'image/svg+xml'
  }
  return null
}

/** Plafond d'une partie de SILLAGE.md, d'accord avec `MAX_INSTRUCTIONS_CHARS` du protocole. */
const MAX_INSTRUCTIONS_CHARS = 40000

/**
 * Mémoire du projet. Doivent rester d'accord avec `memoryFileSchema`, `MEMORY_INDEX_FILE`
 * et `MAX_MEMORY_FILE_CHARS` du protocole, et avec `apps/server/src/memory/store.ts`.
 */
const MEMORY_INDEX = 'MEMORY.md'
const MEMORY_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/
const MAX_MEMORY_FILE_CHARS = 100000

/** Doit rester d'accord avec `REPO_INSTRUCTION_FILES` du protocole. */
const REPO_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']

const log = (msg) => process.stderr.write(`[sillage-mcp] ${msg}\n`)
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)

if (!DB_PATH || !PROJECT_ID) {
  log('SILLAGE_MCP_DB et SILLAGE_MCP_PROJECT sont requis')
  process.exit(1)
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

/**
 * Connexion d'écriture, ouverte au premier besoin et gardée ensuite.
 *
 * Séparée de la connexion de lecture, qui reste en lecture seule : la quasi-totalité de
 * ce serveur observe, et un seul outil écrit. Deux handles rendent cette asymétrie
 * visible et empêchent qu'une requête de lecture mal écrite touche quoi que ce soit.
 *
 * Le `busy_timeout` compte : le daemon écrit son journal en continu pendant que l'agent
 * travaille, et sans attente une note de carte échouerait au premier chevauchement.
 * Même valeur que la connexion du serveur, dans `packages/db`.
 */
let writable = null
function writeDb() {
  if (!writable) {
    writable = new Database(DB_PATH, { fileMustExist: true })
    writable.pragma('busy_timeout = 5000')
    writable.pragma('foreign_keys = ON')
  }
  return writable
}

const TOOLS = [
  {
    name: 'search_history',
    description:
      "Cherche dans les conversations passées de ce projet sur Sillage, celles menées avec ce CLI comme avec les autres. Rend une liste de conversations avec un extrait, pas leur contenu : utiliser read_conversation ensuite pour en lire une. Appelle cet outil avant de conclure qu'un sujet est neuf, quand une décision semble avoir déjà été prise, quand un bug ressemble à du déjà-vu, ou quand l'utilisateur fait référence à un travail antérieur.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Mots à chercher. Recherche plein texte sur le corps des messages.',
        },
        limit: {
          type: 'integer',
          description: 'Nombre maximum de conversations rendues. 10 par défaut, 50 au plus.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_conversation',
    description:
      "Lit le fil d'une conversation passée de ce projet, identifiée par le `id` rendu par search_history. Rend les messages de l'utilisateur et de l'agent, sans les appels d'outils. D'un fil trop long pour tenir d'un coup, rend la demande initiale et la fin, en annonçant combien de messages ont été élidés et comment les lire.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant rendu par search_history.' },
        before: {
          type: 'integer',
          description:
            "Remonte dans le fil : rend la tranche qui précède ce numéro de message, tel qu'annoncé par un appel précédent. Omettre pour lire la demande et la fin.",
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_sessions',
    description:
      "Liste les conversations de ce projet qui travaillent en ce moment, et celles qui ont travaillé récemment, avec leur worktree, la branche où il se trouve et son nombre de fichiers modifiés. Appelle cet outil avant d'ouvrir un chantier, pour vérifier qu'une autre session n'est pas déjà dessus, et avant toute manipulation de l'arbre de travail git : une autre conversation peut l'avoir laissé sur sa propre branche.",
    inputSchema: {
      type: 'object',
      properties: {
        within_minutes: {
          type: 'integer',
          description:
            "Fenêtre de « récemment », en minutes. 15 par défaut. Élargir à 1440 pour voir le travail de la journée. Les conversations qui travaillent en ce moment sont rendues quelle que soit la fenêtre.",
        },
      },
    },
  },
  {
    name: 'find_file_edits',
    description:
      "Dit quelle autre session a modifié un fichier, et ce qu'elle fait maintenant. Appelle cet outil quand tu trouves dans l'arbre de travail des modifications que tu n'as pas faites, avant de les annuler, de les contourner ou d'abandonner le tour : elles viennent souvent d'une session qui travaille en ce moment sur le même arbre, et la réponse dit si elle est encore active. Sans `path`, rend les fichiers récemment modifiés par les autres sessions du même arbre.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "Chemin du fichier, relatif au répertoire de travail. À défaut de correspondance exacte, un fichier de même nom ailleurs est rendu, avec son chemin réel. Omettre pour voir tous les fichiers récemment modifiés.",
        },
        within_minutes: {
          type: 'integer',
          description:
            "Fenêtre de recherche, en minutes. 120 par défaut. Élargir si la réponse est vide alors qu'une modification inexpliquée est bien là : les éditions restent dans le journal indéfiniment, mais celles d'hier n'expliquent en général plus l'état de l'arbre.",
        },
      },
    },
  },
  {
    name: 'list_cards',
    description:
      "Liste le board de ce projet : les cartes, c'est-à-dire le travail à faire, en cours, à vérifier ou terminé. Une carte est un chantier, distinct des conversations qui l'exécutent : elle leur survit et en porte plusieurs. Appelle cet outil avant d'ouvrir un sujet neuf, pour vérifier que ce qu'on te demande n'est pas déjà décrit dans une carte, et quand l'utilisateur cite une carte par son numéro (`#12`). Rend un résumé par carte, pas les descriptions entières : utiliser read_card ensuite pour en lire une.",
    inputSchema: {
      type: 'object',
      properties: {
        column: {
          type: 'string',
          enum: ['todo', 'in_progress', 'review', 'done', 'abandoned'],
          description:
            "Ne rendre que cette colonne. Omettre pour tout le board, terminé et abandonné compris.",
        },
      },
    },
  },
  {
    name: 'read_card',
    description:
      "Lit une carte de ce projet en entier : sa description, ses pièces jointes avec leurs chemins locaux, la colonne où elle est posée, les sessions qui l'ont déjà traitée et les cartes qui la citent. Appelle cet outil quand une carte t'est assignée ou citée, avant de commencer : la description dit ce qui est attendu, et les sessions passées disent ce qui a déjà été tenté. La colonne d'une carte se change dans l'interface, par une personne, jamais par toi.",
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'integer',
          description: "Numéro de la carte, tel qu'il s'écrit après le `#`.",
        },
      },
      required: ['number'],
    },
  },
  {
    name: 'add_card_note',
    description:
      "Ajoute une note au fil de la carte que traite cette conversation. Sert à laisser aux sessions suivantes ce qu'elles ne pourront pas redécouvrir seules : ce qui a été fait et où en est le travail, ce qui a été essayé sans marcher et pourquoi, une décision prise en route, une contrainte trouvée dans le code. Appelle cet outil en fin de travail, et avant toute interruption longue. N'y recopie pas ce que le dépôt dit déjà, ni ce que `git log` raconte : une note utile est celle qui aurait fait gagner du temps si on l'avait lue au début. Les notes s'ajoutent et ne s'effacent pas ; elles ne remplacent pas la description de la carte, qui appartient à la personne qui l'a écrite.",
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description:
            "Texte de la note, en markdown. Quelques phrases ou une courte liste, pas un rapport : elle sera relue en entier au début de chaque session suivante.",
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'create_card',
    description:
      "Ouvre une carte dans la colonne « à faire » du board de ce projet. Sert à noter un travail qui sort du sujet de cette conversation, pour qu'il ne se perde pas : un bug croisé en route, une dette repérée, une suite que l'utilisateur a évoquée. C'est le geste par défaut pour ce que tu découvres seul ; ne lance une session (start_session) que si l'utilisateur l'a demandé. Appelle list_cards avant, pour ne pas doubler une carte qui existe. Tu ne peux ni déplacer une carte ni réécrire une description existante : la colonne et la consigne appartiennent aux personnes.",
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Titre court, à la manière d\'un ticket : ce qu\'il faut faire, pas ce qu\'on a vu.',
        },
        description: {
          type: 'string',
          description:
            "Description en markdown, compréhensible sans ce fil : symptôme, fichiers et lignes en cause, comment reproduire, piste de correction si tu en as une. `#12` cite une autre carte.",
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'start_session',
    description:
      "Lance une nouvelle conversation Sillage dans ce projet, que l'utilisateur suit et reprend comme les autres. Sert quand l'utilisateur te demande de confier un travail à une autre session (« lance ça dans une autre session », « lance une session Codex en effort max pour… »), ou de traiter une carte du board à part. Pas pour ce que tu découvres seul sans qu'on te l'ait demandé : crée plutôt une carte avec create_card. Pas non plus pour un travail qui sert ta propre tâche : tes sous-agents sont faits pour ça. La nouvelle session ne connaît rien de ce fil : `prompt` doit se suffire. Elle démarre avec les réglages par défaut du projet pour ce CLI (permissions comprises), modèle et effort en plus si tu les donnes. Rend son identifiant : enchaîne avec notify_when_done si tu dois reprendre quand elle aura fini.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: `La mission, en markdown, ${MAX_LAUNCH_PROMPT_CHARS} caractères au plus. Elle doit se comprendre seule : contexte, fichiers en cause, ce qui est attendu, comment vérifier, et ce qu'il ne faut pas toucher. Ne cite pas « ce dont on parlait » : la session n'a pas ce fil.`,
        },
        title: {
          type: 'string',
          description: 'Titre de la conversation dans Sillage. Omettre pour le laisser venir de la mission.',
        },
        agent: {
          type: 'string',
          enum: ['claude', 'codex', 'opencode'],
          description: 'CLI de la session. Omettre pour le même que le tien.',
        },
        model: {
          type: 'string',
          description:
            "Modèle, par sa valeur ou son nom affiché tel que l'utilisateur le dit (« opus », « Astra »). Omettre pour le défaut du projet. list_models donne ce qui existe.",
        },
        effort: {
          type: 'string',
          description:
            "Niveau d'effort (`low`, `medium`, `high`…, selon le modèle). `max` désigne le niveau de ce nom, ou à défaut le plus haut que le modèle accepte. Omettre pour le défaut du projet.",
        },
        worktree: {
          type: 'string',
          description:
            "Où elle travaille. Omettre pour le même arbre que toi. `@root` pour la racine du projet. Sinon le nom d'un worktree existant, ou d'une branche à créer en worktree depuis HEAD (par exemple `fix/titre-tronque`) : à préférer pour un travail sans rapport avec le tien, pour que vos modifications ne se mêlent pas.",
        },
        card: {
          type: 'integer',
          description: 'Numéro de la carte que la session traite. Elle y est rattachée et passe « en cours » si elle était « à faire ».',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_models',
    description:
      "Liste les modèles que chaque CLI propose, avec leurs niveaux d'effort, et les réglages par défaut d'une session lancée dans ce projet. Appelle cet outil quand l'utilisateur nomme un modèle pour start_session et que tu n'es pas sûr de sa valeur.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['claude', 'codex', 'opencode'],
          description: 'Ne rendre que ce CLI. Omettre pour tous.',
        },
      },
    },
  },
  {
    name: 'set_project_image',
    description:
      "Pose ou remplace l'image de ce projet dans Sillage, celle qui le fait reconnaître d'un coup d'œil dans la navigation. Elle s'affiche en tout petit, dans un carré : préfère une icône ou un logo sans texte à une bannière. Sources, dans l'ordre : un logo ou une icône déjà dans le dépôt ; à défaut un SVG simple que tu dessines pour évoquer le projet, ou une image générée si tu as un outil pour ça, et dans ces deux cas passe `provisional: true`. Appelle aussi cet outil quand le projet gagne un vrai logo ou en change, pour que l'image suive.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "Chemin absolu du fichier image : PNG, JPEG, GIF, WebP ou SVG, carré de préférence, 1 Mo au plus. Le fichier est copié, il peut être supprimé ensuite.",
        },
        provisional: {
          type: 'boolean',
          description:
            "Vrai quand l'image est une solution d'attente, dessinée ou générée faute de logo dans le projet : les sessions suivantes se verront rappeler de la remplacer dès qu'un vrai logo existe. Faux, par défaut, quand c'est le logo du projet.",
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'send_session_message',
    description:
      "Envoie un message à une autre conversation de ce projet, identifiée par le `id` rendu par list_sessions ou find_file_edits. Sillage le lui remet dans quelques secondes : injecté dans son tour si elle travaille, sinon en la relançant pour qu'elle le lise. Sa réponse, si elle en fait une, te parvient de la même façon. Sert quand la coordination ne peut pas attendre l'utilisateur : prévenir qu'on va toucher à un fichier qu'elle modifie, lui demander de libérer l'arbre ou une branche, lui signaler qu'un travail dont elle dépend est fini, lui poser une question sur un choix qu'elle a fait. Pas pour bavarder ni pour rendre compte : chaque message coûte un tour à son destinataire. Si tu attends une réponse pour continuer, termine ton tour après l'envoi plutôt que d'attendre en boucle ; la réponse te relancera.",
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Identifiant de la conversation destinataire, tel que rendu par list_sessions.',
        },
        body: {
          type: 'string',
          description: `Texte du message, en markdown, ${MAX_PEER_MESSAGE_CHARS} caractères au plus. Il doit se comprendre seul : le destinataire ne connaît ni ton fil ni ce que l'utilisateur t'a demandé.`,
        },
        reply_to: {
          type: 'string',
          description:
            "Identifiant du message auquel tu réponds, quand c'en est une. Il figure dans le message reçu. Permet à Sillage de borner un échange qui tournerait en rond.",
        },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'broadcast_session_message',
    description:
      "Annonce un message à toutes les autres conversations de ce projet qui travaillent en ce moment, et à elles seules : celles au repos ne sont pas relancées. Sert aux gestes qui touchent tout le monde : redémarrer le service Sillage ou un serveur de dev partagé, changer de branche ou faire un rebase sur l'arbre commun, régénérer des fichiers que d'autres lisent. Les destinataires n'y répondent pas. Pour une question à une session précise, utiliser send_session_message.",
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description: `Texte de l'annonce, ${MAX_PEER_MESSAGE_CHARS} caractères au plus : ce que tu vas faire, quand, et ce que les autres doivent éviter d'ici là.`,
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'notify_when_done',
    description:
      "Demande à être prévenu quand une autre conversation de ce projet aura fini de travailler : plus de tour en cours, ni de travail de fond, ni de boucle. Sillage te relance alors avec son état et son dernier message. Sert quand tu dépends de son travail, ou qu'elle occupe un fichier ou l'arbre dont tu as besoin : appelle cet outil puis termine ton tour, au lieu de rappeler list_sessions en boucle. La surveillance expire au bout de 24 heures.",
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Identifiant de la conversation à surveiller, tel que rendu par list_sessions.',
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'read_session_messages',
    description:
      "Relit les messages échangés entre cette conversation et les autres sessions du projet, reçus comme envoyés, avec leur état de remise. Les messages reçus arrivent d'eux-mêmes dans le fil : cet outil sert à les retrouver après une compaction, à voir si un message envoyé a été remis, ou à lire un message que Sillage a retenu sans réveiller la session.",
    inputSchema: {
      type: 'object',
      properties: {
        with: {
          type: 'string',
          description: "Ne rendre que l'échange avec cette conversation. Omettre pour tous.",
        },
      },
    },
  },
  {
    name: 'read_instructions',
    description:
      "Lit SILLAGE.md, les consignes que Sillage injecte dans le prompt de chaque session, de Claude comme de Codex : la partie de ce projet ou la partie globale. Ce que ton prompt en contient date du démarrage de la session ; lis la version courante avant de la modifier.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description:
            "`project` (par défaut) pour la partie de ce projet, `global` pour celle qui vaut dans tous les projets. Écrire dans la portée globale est réservé aux comptes administrateurs.",
        },
      },
    },
  },
  {
    name: 'edit_instructions',
    description:
      "Modifie SILLAGE.md comme l'outil d'édition de fichiers : remplace un passage exact par un autre. `old_text` doit apparaître une seule fois, sauf avec `replace_all`. Lis d'abord avec read_instructions. Sert à ajouter, corriger ou retirer une consigne quand l'utilisateur le demande, ou à retenir une consigne durable qu'il te donne (« retiens que… », « à partir de maintenant… ») ; pas pour ce qui ne vaut que pour la tâche en cours. Prend effet aux sessions qui démarrent ensuite.",
    inputSchema: {
      type: 'object',
      properties: {
        old_text: {
          type: 'string',
          description: "Passage à remplacer, au caractère près, retours à la ligne compris. Vide pour ajouter `new_text` à la fin.",
        },
        new_text: { type: 'string', description: 'Texte de remplacement, vide pour supprimer le passage.' },
        replace_all: { type: 'boolean', description: 'Remplacer toutes les occurrences. Faux par défaut.' },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description:
            "`project` (par défaut) pour la partie de ce projet, `global` pour celle qui vaut dans tous les projets. Écrire dans la portée globale est réservé aux comptes administrateurs.",
        },
      },
      required: ['old_text', 'new_text'],
    },
  },
  {
    name: 'write_instructions',
    description:
      "Réécrit entièrement une partie de SILLAGE.md, comme on réécrit un fichier : le contenu donné remplace tout l'existant. Pour une retouche, préfère edit_instructions. Lis d'abord avec read_instructions, pour ne pas effacer ce qui y était.",
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Le nouveau contenu entier, en markdown. Vide pour tout effacer.' },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description:
            "`project` (par défaut) pour la partie de ce projet, `global` pour celle qui vaut dans tous les projets. Écrire dans la portée globale est réservé aux comptes administrateurs.",
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'read_memory',
    description:
      "Lit la mémoire de ce projet, les notes que les sessions précédentes, Claude comme Codex, ont prises : sans `file`, l'index `MEMORY.md` et la liste des notes ; avec `file`, la note entière. Une note peut avoir vieilli : vérifie-la avant de t'appuyer dessus.",
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Note à lire. Omettre pour l\'index.' } } },
  },
  {
    name: 'write_memory',
    description:
      "Écrit une note dans la mémoire de ce projet, comme on écrit un fichier : le contenu remplace la note s'il y en a une. Sert à retenir ce qui servira aux sessions suivantes et que le dépôt ne dit pas : une préférence de l'utilisateur, une décision et sa raison, un piège rencontré, une ressource externe. Une note commence par un en-tête `---` avec `name`, `description` (une ligne, sert à juger de sa pertinence) et `type` (`user`, `feedback`, `project` ou `reference`), puis le fait. L'index `MEMORY.md` gagne seul une ligne pour une note nouvelle ; il s'écrit aussi directement. Mets à jour une note existante plutôt que d'en créer une seconde sur le même sujet. Une règle que l'utilisateur fixe pour tous ses agents va plutôt dans SILLAGE.md.",
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: "Nom du fichier, à plat et en `.md` : `MEMORY.md` pour l'index, sinon un nom court en kebab-case (`port-du-serveur-de-dev.md`).",
        },
        content: { type: 'string', description: 'Contenu entier de la note, en markdown.' },
      },
      required: ['file', 'content'],
    },
  },
  {
    name: 'delete_memory',
    description:
      "Retire une note de la mémoire de ce projet, et sa ligne de l'index. Pour une note devenue fausse ou sans objet.",
    inputSchema: { type: 'object', properties: { file: {
          type: 'string',
          description: "Nom du fichier, à plat et en `.md` : `MEMORY.md` pour l'index, sinon un nom court en kebab-case (`port-du-serveur-de-dev.md`).",
        }, }, required: ['file'] },
  },
  {
    name: 'count_active_sessions',
    description:
      "Compte, sur toute l'instance et non plus sur le seul projet, les conversations en train de travailler. Sert à décider s'il est sûr de redémarrer le service Sillage, ce qui tue tous les process CLI en cours, y compris celui de cette conversation. Ne rend que des nombres : ni titres, ni projets, ni contenu.",
    inputSchema: { type: 'object', properties: {} },
  },
]

/**
 * Traduit une saisie libre en requête FTS5.
 *
 * Chaque terme est cité, ce qui neutralise la syntaxe du moteur : sans ça un `-` ou un
 * `"` au milieu d'une phrase fait échouer la requête entière. Pas de préfixe sur le
 * dernier terme, contrairement à la recherche de l'interface : ici la requête arrive
 * complète, personne n'est en train de la taper.
 *
 * Doit rester d'accord avec `apps/server/src/search/search-messages.ts`.
 */
function toMatchQuery(input) {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' ')
}

/**
 * Conversations du projet dont un message contient la requête.
 *
 * Une conversation peut avoir plusieurs messages qui répondent ; seul le mieux classé
 * est gardé, l'agent cherchant une conversation à ouvrir et non un message isolé. D'où
 * la marge sur la limite SQL, réduite ensuite au nombre demandé.
 *
 * Lit `search_messages`, l'index plein texte que le serveur maintient à l'écriture
 * (`apps/server/src/search/search-index.ts`). Table dérivée, jamais source : un journal
 * indexé de travers se rattrape par `pnpm search:reindex`.
 */
function searchHistory(query, limit) {
  const match = toMatchQuery(query)
  if (!match) return []

  const rows = db
    .prepare(
      `SELECT m.conversation_id AS id,
              c.title AS title,
              c.agent AS agent,
              m.ts AS ts,
              snippet(search_messages, 0, '', '', '...', 15) AS excerpt
       FROM search_messages AS m
       JOIN conversations AS c ON c.id = m.conversation_id
       WHERE search_messages MATCH ?
         AND c.project_id = ?
         AND c.id != ?
         AND c.archived_at IS NULL
       ORDER BY bm25(search_messages)
       LIMIT ?`,
    )
    .all(match, PROJECT_ID, CURRENT_CONVERSATION, limit * 5)

  const best = new Map()
  for (const row of rows) {
    if (!best.has(row.id)) best.set(row.id, row)
    if (best.size >= limit) break
  }
  return [...best.values()]
}

/**
 * Messages d'un fil, appels d'outils exclus.
 *
 * L'extraction reprend celle de l'index de recherche : mêmes blocs de texte, même
 * exclusion des messages de sous-agents, qui appartiennent à un panneau latéral et non
 * au fil. Le `project_id` est vérifié ici et pas seulement à la recherche : rien
 * n'empêche l'agent de fabriquer un identifiant.
 */
function readConversation(id) {
  const conversation = db
    .prepare(
      `SELECT id, title, agent, created_at AS createdAt
       FROM conversations
       WHERE id = ? AND project_id = ?`,
    )
    .get(id, PROJECT_ID)
  if (!conversation) return null

  const messages = db
    .prepare(
      `SELECT event.seq AS seq,
              event.payload ->> '$.role' AS role,
              event.ts AS ts,
              group_concat(block.value ->> '$.text', char(10)) AS text
       FROM events AS event, json_each(event.payload ->> '$.blocks') AS block
       WHERE event.conversation_id = ?
         AND event.type = 'message.completed'
         AND block.value ->> '$.type' = 'text'
         AND coalesce(event.payload ->> '$.parentToolCallId', '') = ''
       GROUP BY event.seq
       ORDER BY event.seq`,
    )
    .all(id)

  return { conversation, messages }
}

/**
 * Une conversation travaille si un tour est en cours, ou si un travail détaché continue
 * après lui.
 *
 * Les deux compteurs sont sur la ligne de conversation et non déduits du journal : le
 * statut retombe à `idle` à la fin du tour, pas à la fin du travail, et le déduire
 * demanderait de replier le journal de chaque ligne énumérée. Ils sont remis à zéro au
 * démarrage du daemon, donc une valeur non nulle décrit bien un process vivant.
 */
const WORKING = `(c.status = 'running' OR c.background_count > 0 OR c.loop_count > 0)`

/**
 * Conversations du projet qui travaillent, plus celles vues récemment.
 *
 * Celles qui travaillent sortent quelle que soit la fenêtre : une session lancée il y a
 * trois heures et toujours en train de tourner est exactement ce qu'on cherche à ne pas
 * manquer. La fenêtre ne gouverne que les autres.
 */
function listSessions(withinMinutes) {
  return db
    .prepare(
      `SELECT c.id AS id,
              c.title AS title,
              c.agent AS agent,
              c.status AS status,
              c.background_count AS background,
              c.loop_count AS loops,
              c.updated_at AS updatedAt,
              w.name AS worktree,
              coalesce(w.path, p.workspace_path) AS path
       FROM conversations AS c
       JOIN projects AS p ON p.id = c.project_id
       LEFT JOIN worktrees AS w ON w.id = c.worktree_id
       WHERE c.project_id = ?
         AND c.id != ?
         AND c.archived_at IS NULL
         AND (${WORKING} OR c.updated_at >= ?)
       ORDER BY c.updated_at DESC
       LIMIT 50`,
    )
    .all(PROJECT_ID, CURRENT_CONVERSATION, Date.now() - withinMinutes * 60_000)
}

/**
 * Branche et nombre de fichiers modifiés d'un arbre de travail, ou null si git ne
 * répond pas.
 *
 * Lu sur le disque à l'appel et non tiré du journal : la question est « où en est
 * l'arbre maintenant », et c'est justement quand une session a changé de branche sous
 * une autre que le journal ne le dit pas. Un appel par arbre distinct, pas par session :
 * dix sessions à la racine du projet ne coûtent qu'un `git status`.
 */
function gitState(path, cache) {
  if (cache.has(path)) return cache.get(path)
  let state = null
  try {
    const out = execFileSync('git', ['-C', path, 'status', '--porcelain=v1', '--branch'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const [head = '', ...files] = out.split('\n').filter(Boolean)
    const branch = head.startsWith('## HEAD (no branch)')
      ? 'HEAD détachée'
      : head.replace(/^## (No commits yet on )?/, '').split('...')[0].split(' ')[0]
    state = { branch, dirty: files.length }
  } catch {
    // Pas un dépôt, dossier disparu, git absent : l'information manque, rien de plus.
  }
  cache.set(path, state)
  return state
}

/** Une conversation travaille-t-elle, d'après une ligne qui porte statut et compteurs. */
const isWorking = (row) => row.status === 'running' || row.background > 0 || row.loops > 0

/**
 * Le message serait-il retenu plutôt que de relancer son destinataire au repos.
 *
 * Même règle que le relais, évaluée à l'envoi : l'expéditeur qui attend une réponse
 * doit savoir tout de suite qu'elle ne viendra pas sans une personne.
 */
function predictHold(to, replyTo) {
  let depth = 0
  let parent = replyTo
  const up = db.prepare(`SELECT reply_to AS replyTo FROM session_messages WHERE id = ?`)
  while (parent && depth < MAX_HOPS) {
    depth++
    parent = up.get(parent)?.replyTo ?? null
  }
  if (depth >= MAX_HOPS) return 'loop'

  const row = db
    .prepare(
      `SELECT count(*) AS total FROM session_messages
       WHERE to_conversation_id = ? AND kind = 'message' AND delivered_via = 'wake'
         AND delivered_at > ?`,
    )
    .get(to, Date.now() - 60 * 60 * 1000)
  return row.total >= WAKES_PER_HOUR ? 'rate' : null
}

function broadcast(body) {
  const targets = db
    .prepare(
      `SELECT c.id AS id FROM conversations AS c
       WHERE c.project_id = ? AND c.id != ? AND c.archived_at IS NULL AND ${WORKING}`,
    )
    .all(PROJECT_ID, CURRENT_CONVERSATION)
  if (targets.length === 0) return 0

  const insert = writeDb().prepare(
    `INSERT INTO session_messages
       (id, project_id, from_conversation_id, to_conversation_id, kind, body, created_at)
     VALUES (?, ?, ?, ?, 'broadcast', ?, ?)`,
  )
  const now = Date.now()
  writeDb().transaction(() => {
    for (const target of targets) insert.run(randomUUID(), PROJECT_ID, CURRENT_CONVERSATION, target.id, body, now)
  })()
  return targets.length
}

/** Pose une surveillance, sauf s'il en existe déjà une ouverte sur la même cible. */
function watch(target) {
  const open = db
    .prepare(
      `SELECT 1 AS yes FROM session_watches
       WHERE watcher_conversation_id = ? AND target_conversation_id = ? AND fired_at IS NULL`,
    )
    .get(CURRENT_CONVERSATION, target)
  if (open) return false
  writeDb()
    .prepare(
      `INSERT INTO session_watches (id, project_id, watcher_conversation_id, target_conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), PROJECT_ID, CURRENT_CONVERSATION, target, Date.now())
  return true
}

/**
 * Le worktree de la conversation courante, `undefined` si on ne sait pas qui elle est.
 *
 * Sert à ne comparer que ce qui est comparable : deux conversations dans deux worktrees
 * différents éditent le même chemin relatif sans jamais se marcher dessus, ce sont deux
 * fichiers distincts sur le disque. Ne restent donc que celles qui partagent l'arbre.
 */
function currentWorktree() {
  const row = db
    .prepare(`SELECT worktree_id AS worktreeId FROM conversations WHERE id = ?`)
    .get(CURRENT_CONVERSATION)
  return row ? row.worktreeId : undefined
}

/**
 * Qui d'autre a touché à ce fichier, et où en est cette session.
 *
 * L'activité de la conversation voyage avec la modification plutôt que d'être à
 * rechercher ensuite : la question n'est jamais « qui a édité » seule, elle est « qui a
 * édité, et est-ce que ça bouge encore », dont dépend le fait d'attendre ou de passer.
 *
 * Un chemin donné cherche sans fenêtre de temps : une modification non commitée reste
 * dans l'arbre longtemps après la session qui l'a faite, et la borner ferait répondre
 * « personne » au moment où la question se pose. La fenêtre ne sert qu'à la liste
 * générale, qui n'aurait sinon pas de fin.
 *
 * Balayage de la table d'événements, sans index sur le type : mesuré à 30 ms sur 115 000
 * lignes, pour un outil appelé quand un doute survient et non en boucle. Un index
 * partiel serait la sortie si ça devenait chaud.
 */
/**
 * La modification la plus récente hors fenêtre, pour que la réponse vide dise s'il y a
 * quelque chose à aller chercher.
 *
 * Sans ça, « rien dans les 120 dernières minutes » se lit comme « personne n'y a
 * touché », et l'appelant conclut à tort plutôt que d'élargir. Une requête de plus,
 * seulement quand la réponse est vide.
 */
function oldestOutsideWindow({ path, byName, withinMinutes }) {
  const worktree = currentWorktree()
  const filters = [
    `e.type = 'file.edited'`,
    `c.project_id = ?`,
    `c.id != ?`,
    worktree === undefined ? null : `c.worktree_id IS ?`,
    `e.ts < ?`,
    path === null
      ? null
      : byName
        ? `e.payload ->> '$.path' LIKE '%/' || ?`
        : `e.payload ->> '$.path' = ?`,
  ].filter(Boolean)

  const params = [PROJECT_ID, CURRENT_CONVERSATION]
  if (worktree !== undefined) params.push(worktree)
  params.push(Date.now() - withinMinutes * 60_000)
  if (path !== null) params.push(path)

  const row = db
    .prepare(
      `SELECT max(e.ts) AS ts
       FROM events AS e
       JOIN conversations AS c ON c.id = e.conversation_id
       WHERE ${filters.join(' AND ')}`,
    )
    .get(...params)
  return row?.ts ?? null
}

function findFileEdits({ path, withinMinutes }) {
  const exact = path ? path.replace(/^\.\//, '') : null
  const rows = queryEdits({ path: exact, byName: false, withinMinutes })
  if (rows.length > 0 || !exact) return rows

  // Repli et non cumul : tant qu'un chemin exact répond, un homonyme ailleurs dans
  // l'arbre n'est que du bruit. Il ne sert qu'au cas où l'appelant ne connaît que le
  // nom du fichier, ou l'a écrit depuis un autre répertoire que celui du journal.
  return queryEdits({ path: exact.split('/').pop(), byName: true, withinMinutes })
}

function queryEdits({ path, byName, withinMinutes }) {
  const worktree = currentWorktree()

  const filters = [
    `e.type = 'file.edited'`,
    `c.project_id = ?`,
    `c.id != ?`,
    // `IS` et non `=` : le worktree nul, qui vaut « racine du projet », est le cas le
    // plus courant et une égalité SQL ne le rapproche de rien.
    worktree === undefined ? null : `c.worktree_id IS ?`,
    // La fenêtre vaut aussi pour une recherche par chemin. Le journal garde les
    // éditions indéfiniment, y compris celles commitées depuis longtemps : sans borne,
    // la réponse mêle des modifications qui n'expliquent plus rien de l'état de l'arbre
    // à celles qu'on cherche, et laisse croire qu'une session travaille encore dessus.
    `e.ts >= ?`,
    path === null
      ? null
      : byName
        ? `e.payload ->> '$.path' LIKE '%/' || ?`
        : `e.payload ->> '$.path' = ?`,
  ].filter(Boolean)

  const params = [PROJECT_ID, CURRENT_CONVERSATION]
  if (worktree !== undefined) params.push(worktree)
  params.push(Date.now() - withinMinutes * 60_000)
  if (path !== null) params.push(path)

  return db
    .prepare(
      `SELECT e.conversation_id AS id,
              c.title AS title,
              c.agent AS agent,
              c.status AS status,
              c.background_count AS background,
              c.loop_count AS loops,
              w.name AS worktree,
              e.payload ->> '$.path' AS path,
              e.payload ->> '$.action' AS action,
              max(e.ts) AS ts,
              count(*) AS edits
       FROM events AS e
       JOIN conversations AS c ON c.id = e.conversation_id
       LEFT JOIN worktrees AS w ON w.id = c.worktree_id
       WHERE ${filters.join(' AND ')}
       -- Sur les expressions et non sur les alias : la table worktrees a une colonne
       -- path et la table events une colonne ts, que SQLite préfère aux alias de
       -- sortie. Le regroupement se faisait alors par conversation seulement, avec des
       -- comptes cumulés sur tous les fichiers et un chemin pris au hasard dans le lot.
       GROUP BY e.conversation_id, e.payload ->> '$.path'
       ORDER BY max(e.ts) DESC
       LIMIT ${EDIT_ROW_LIMIT}`,
    )
    .all(...params)
}

/**
 * Décompte sur toute l'instance, pour la seule question qui justifie d'en sortir :
 * peut-on redémarrer le service.
 *
 * Des nombres et rien d'autre. Le besoin est de savoir si on va couper quelqu'un, pas
 * de savoir qui ni sur quoi, et rendre des titres ferait de cet outil une fenêtre sur
 * les projets auxquels la conversation n'a pas affaire.
 */
function countActiveSessions() {
  const row = db
    .prepare(
      `SELECT
         sum(CASE WHEN ${WORKING} THEN 1 ELSE 0 END) AS working,
         sum(CASE WHEN ${WORKING} AND c.project_id = ? THEN 1 ELSE 0 END) AS here,
         sum(CASE WHEN c.status = 'awaiting_input' THEN 1 ELSE 0 END) AS awaiting,
         min(CASE WHEN ${WORKING} THEN c.updated_at END) AS oldest
       FROM conversations AS c
       WHERE c.archived_at IS NULL`,
    )
    .get(PROJECT_ID)

  const self = db
    .prepare(`SELECT 1 AS yes FROM conversations AS c WHERE c.id = ? AND ${WORKING}`)
    .get(CURRENT_CONVERSATION)

  return {
    working: row?.working ?? 0,
    here: row?.here ?? 0,
    awaiting: row?.awaiting ?? 0,
    oldest: row?.oldest ?? null,
    includesSelf: Boolean(self),
  }
}

const asDate = (ts) => new Date(ts).toISOString().slice(0, 10)

/** Ancienneté en clair : un horodatage absolu obligerait le modèle à faire la soustraction. */
function ago(ts) {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} j`
}

const STATUS_LABELS = {
  running: 'en cours',
  idle: 'au repos',
  awaiting_input: 'attend une réponse',
  interrupted: 'interrompue',
  error: 'en erreur',
}

/** Ce que fait une conversation, statut et travail détaché réunis en une clause. */
function describeActivity(row) {
  const parts = [STATUS_LABELS[row.status] ?? row.status]
  if (row.background > 0) parts.push(`${row.background} travail(aux) de fond`)
  if (row.loops > 0) parts.push(`${row.loops} boucle(s)`)
  return parts.join(', ')
}

function renderSessions(rows, withinMinutes) {
  if (rows.length === 0) {
    return `Aucune autre conversation de ce projet n'a travaillé dans les ${withinMinutes} dernières minutes.`
  }

  const cache = new Map()
  const lines = rows.map((row) => {
    const where = row.worktree ? `worktree ${row.worktree}` : 'racine du projet'
    const git = row.path ? gitState(row.path, cache) : null
    const tree = git
      ? `, branche ${git.branch}${git.dirty > 0 ? `, ${git.dirty} fichier(s) modifié(s)` : ''}`
      : ''
    return `- ${row.id} | ${row.agent} | ${describeActivity(row)} | ${where}${tree} | ${ago(row.updatedAt)}\n  ${row.title}`
  })
  return `${rows.length} conversation(s), fenêtre de ${withinMinutes} min :\n${lines.join('\n')}`
}

const ACTION_LABELS = { created: 'créé', modified: 'modifié', deleted: 'supprimé' }

/**
 * Une conclusion en tête plutôt qu'une table à interpréter.
 *
 * L'outil est appelé au moment d'un doute, et ce que l'appelant doit décider est
 * d'attendre ou de passer. La réponse le dit donc explicitement quand une des sessions
 * travaille encore, au lieu de laisser déduire d'un statut noyé dans une liste.
 */
function renderFileEdits(rows, { path, withinMinutes, older }) {
  if (rows.length === 0) {
    const scope = path ? `n'a touché à « ${path} »` : `n'a modifié de fichier`
    const head = `Aucune autre session de cet arbre de travail ${scope} dans les ${withinMinutes} dernières minutes.`
    return older === null
      ? `${head} Rien de plus ancien non plus.`
      : `${head} La dernière fois remonte à ${ago(older)} : rappeler avec une fenêtre plus large pour la voir.`
  }

  const busy = rows.filter((row) => row.status === 'running' || row.background > 0 || row.loops > 0)
  const lead = busy.length > 0
    ? `Attention, ${busy.length} de ces sessions travaillent encore : attendre peut valoir mieux qu'annuler leurs modifications.`
    : "Aucune de ces sessions ne travaille plus : leurs modifications sont figées."

  // Deux regroupements pour deux questions. Sur un chemin, le sujet est le fichier et
  // chaque ligne dit une session qui y a touché. Sans chemin, le sujet est la session :
  // regrouper par fichier y répétait son titre et son état à chaque ligne, quinze fois
  // à l'identique sur un cas réel, pour un outil censé économiser du contexte.
  const lines = path ? renderByFile(rows) : renderBySession(rows)
  const capped =
    rows.length >= EDIT_ROW_LIMIT
      ? `\n\n[Liste plafonnée à ${EDIT_ROW_LIMIT} couples session-fichier : il peut en manquer.]`
      : ''

  return `${lead}\n\n${lines.join('\n')}${capped}`
}

function renderByFile(rows) {
  return rows.map((row) => {
    const where = row.worktree ? `worktree ${row.worktree}` : 'racine du projet'
    const times = row.edits > 1 ? ` (${row.edits} fois)` : ''
    return `- ${row.path} | ${ACTION_LABELS[row.action] ?? row.action}${times} | ${ago(row.ts)}\n  par ${row.id} (${row.agent}, ${describeActivity(row)}, ${where})\n  ${row.title}`
  })
}

/** Au-delà, la liste de fichiers d'une seule session noie les autres. */
const FILES_PER_SESSION = 8

function renderBySession(rows) {
  const sessions = new Map()
  for (const row of rows) {
    const found = sessions.get(row.id)
    if (found) found.files.push(row)
    else sessions.set(row.id, { head: row, files: [row] })
  }

  return [...sessions.values()].map(({ head, files }) => {
    const where = head.worktree ? `worktree ${head.worktree}` : 'racine du projet'
    // Par nombre d'éditions et non par date : le fichier le plus remué est celui sur
    // lequel une collision est la plus probable, et c'est ce qu'on cherche à voir en tête.
    const sorted = [...files].sort((a, b) => b.edits - a.edits)
    const shown = sorted
      .slice(0, FILES_PER_SESSION)
      .map((file) => `${file.path}${file.edits > 1 ? ` (${file.edits}×)` : ''}`)
    const rest = sorted.length - shown.length
    const tail = rest > 0 ? `, et ${rest} autre(s)` : ''

    return `- ${head.id} (${head.agent}, ${describeActivity(head)}, ${where}), ${ago(head.ts)}\n  ${head.title}\n  ${files.length} fichier(s) : ${shown.join(', ')}${tail}`
  })
}

/**
 * Le board du projet, une ligne par carte.
 *
 * Le compte de sessions vient d'une sous-requête et non d'une jointure : joindre
 * `conversations` dupliquerait la carte autant de fois qu'elle a de sessions, et le
 * `GROUP BY` qu'il faudrait ensuite masquerait les cartes qui n'en ont aucune.
 */
function listCards(column) {
  return db
    .prepare(
      `SELECT c.number   AS number,
              c.title    AS title,
              c.column   AS column,
              c.description AS description,
              c.updated_at  AS updatedAt,
              (SELECT COUNT(*) FROM conversations AS v WHERE v.card_id = c.id) AS sessions
       FROM cards AS c
       WHERE c.project_id = ?
         AND (? IS NULL OR c.column = ?)
       ORDER BY CASE c.column
                  WHEN 'todo' THEN 0
                  WHEN 'in_progress' THEN 1
                  WHEN 'review' THEN 2
                  WHEN 'done' THEN 3
                  ELSE 4
                END,
                c.position
       LIMIT ?`,
    )
    .all(PROJECT_ID, column, column, CARD_LIMIT + 1)
}

function readCard(number) {
  const card = db
    .prepare(
      `SELECT id, number, title, column, description, created_at AS createdAt
       FROM cards WHERE project_id = ? AND number = ?`,
    )
    .get(PROJECT_ID, number)
  if (!card) return null

  card.sessions = db
    .prepare(
      `SELECT v.id AS id, v.title AS title, v.agent AS agent, v.status AS status,
              v.background_count AS background, v.loop_count AS loops,
              v.updated_at AS updatedAt, w.name AS worktree
       FROM conversations AS v
       LEFT JOIN worktrees AS w ON w.id = v.worktree_id
       WHERE v.card_id = ?
       ORDER BY v.created_at`,
    )
    .all(card.id)

  card.references = db
    .prepare(
      `SELECT t.number AS number, t.title AS title, t.column AS column
       FROM card_refs AS r JOIN cards AS t ON t.id = r.target_id
       WHERE r.source_id = ? ORDER BY t.number`,
    )
    .all(card.id)

  card.referencedBy = db
    .prepare(
      `SELECT sc.number AS number, sc.title AS title, sc.column AS column
       FROM card_refs AS r JOIN cards AS sc ON sc.id = r.source_id
       WHERE r.target_id = ? ORDER BY sc.number`,
    )
    .all(card.id)

  card.attachments = db.prepare(
    'SELECT filename, mime_type AS mimeType, size_bytes AS sizeBytes, storage_path AS path FROM attachments WHERE card_id = ? ORDER BY created_at'
  ).all(card.id)
  return card
}

/** La carte que traite la conversation courante, s'il y en a une. */
function currentCard() {
  return (
    db
      .prepare(
        `SELECT c.id AS id, c.number AS number, c.title AS title
         FROM conversations AS v JOIN cards AS c ON c.id = v.card_id
         WHERE v.id = ?`,
      )
      .get(CURRENT_CONVERSATION) ?? null
  )
}

/** Les notes d'une carte, du plus ancien au plus récent, avec leur auteur. */
function cardNotes(cardId) {
  return db
    .prepare(
      `SELECT n.body AS body, n.created_at AS createdAt,
              n.conversation_id AS conversationId,
              v.title AS conversationTitle, v.agent AS agent,
              u.display_name AS userName
       FROM card_notes AS n
       LEFT JOIN conversations AS v ON v.id = n.conversation_id
       LEFT JOIN users AS u ON u.id = n.user_id
       WHERE n.card_id = ?
       ORDER BY n.created_at`,
    )
    .all(cardId)
}

function addCardNote(cardId, body) {
  writeDb()
    .prepare(
      `INSERT INTO card_notes (id, card_id, conversation_id, user_id, body, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(randomUUID(), cardId, CURRENT_CONVERSATION || null, body, Date.now())
}

function setProjectImage(mimeType, data, provisional) {
  writeDb()
    .prepare(
      `INSERT INTO project_images (project_id, mime_type, data, provisional, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         mime_type = excluded.mime_type, data = excluded.data,
         provisional = excluded.provisional, updated_at = excluded.updated_at`,
    )
    .run(PROJECT_ID, mimeType, data, provisional ? 1 : 0, Date.now())
}

/**
 * Le mode de consignes du projet. Doit rester d'accord avec `resolveInstructionsMode` de
 * `apps/server/src/instructions/store.ts` : un projet d'avant le réglage suit son dépôt
 * s'il porte un fichier de consignes.
 */
function projectInstructionsMode() {
  const project = db
    .prepare('SELECT instructions_mode AS mode, workspace_path AS path FROM projects WHERE id = ?')
    .get(PROJECT_ID)
  if (!project) return { mode: 'repo', chosen: true }
  if (project.mode) return { mode: project.mode, chosen: true }
  const hasFile = REPO_INSTRUCTION_FILES.some((name) => {
    try {
      return statSync(resolve(project.path, name)).isFile()
    } catch {
      return false
    }
  })
  return { mode: hasFile ? 'repo' : 'sillage', chosen: false }
}

/** Le compte qui a ouvert cette conversation est-il administrateur. */
function conversationOwnerIsAdmin() {
  if (!CURRENT_CONVERSATION) return false
  const row = db
    .prepare(
      `SELECT u.is_admin AS admin FROM conversations c JOIN users u ON u.id = c.user_id
       WHERE c.id = ?`,
    )
    .get(CURRENT_CONVERSATION)
  return Boolean(row?.admin)
}

/** La partie de SILLAGE.md visée, telle qu'elle est en base. */
function readInstructionsRow(projectId) {
  return db
    .prepare('SELECT content, updated_at AS updatedAt FROM instructions WHERE id = ?')
    .get(projectId ?? 'global')
}

/**
 * Réécrit une partie de SILLAGE.md d'après sa version courante, dans une transaction :
 * une édition calculée sur un contenu qu'une autre session vient de changer ne doit pas
 * effacer ce changement. `transform` rend le nouveau contenu, ou une chaîne d'erreur
 * dans `{ error }`.
 */
function saveInstructions(projectId, transform, fixMode) {
  const write = writeDb()
  return write.transaction(() => {
    const id = projectId ?? 'global'
    const current = write.prepare('SELECT content FROM instructions WHERE id = ?').get(id)
    const result = transform(current?.content ?? '')
    if (typeof result !== 'string') return result
    if (result.length > MAX_INSTRUCTIONS_CHARS) {
      return {
        error: `SILLAGE.md dépasserait ${MAX_INSTRUCTIONS_CHARS} caractères dans cette portée (${result.length}). Elle entre dans le contexte de chaque session : resserre-la.`,
      }
    }

    write
      .prepare(
        `INSERT INTO instructions
           (id, project_id, content, updated_at, updated_by_user_id, updated_by_conversation_id)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT (id) DO UPDATE SET
           content = excluded.content, updated_at = excluded.updated_at,
           updated_by_user_id = NULL,
           updated_by_conversation_id = excluded.updated_by_conversation_id`,
      )
      .run(id, projectId, result, Date.now(), CURRENT_CONVERSATION || null)
    if (fixMode) {
      write
        .prepare(`UPDATE projects SET instructions_mode = 'sillage' WHERE id = ? AND instructions_mode IS NULL`)
        .run(PROJECT_ID)
    }
    return { content: result }
  })()
}

/**
 * La portée demandée, ou le refus à rendre tel quel. `writing` parce que lire la partie
 * globale est permis à tous, comme dans l'interface.
 */
function instructionsTarget(args, writing) {
  const scope = args?.scope === 'global' ? 'global' : 'project'
  if (scope === 'global') {
    if (writing && !conversationOwnerIsAdmin()) {
      return {
        refusal:
          "La partie globale de SILLAGE.md entre dans toutes les sessions de l'instance : seul un compte administrateur peut y écrire, et cette conversation n'appartient pas à l'un d'eux. Écris dans la partie du projet (`scope: project`), ou propose à l'utilisateur de faire la modification lui-même.",
      }
    }
    return { scope, projectId: null, fixMode: false }
  }

  const { mode, chosen } = projectInstructionsMode()
  if (mode === 'repo') {
    return {
      refusal:
        "Ce projet garde ses consignes dans son dépôt, dans `AGENTS.md` ou `CLAUDE.md` : lis-les et modifie-les avec tes outils de fichiers. Les outils SILLAGE.md ne servent pour lui qu'à la partie globale (`scope: global`).",
    }
  }
  return { scope, projectId: PROJECT_ID, fixMode: !chosen }
}

const scopeLabel = (scope) => (scope === 'global' ? 'partie globale' : 'partie de ce projet')

/** Les notes de la mémoire, index d'abord. */
function memoryFiles() {
  let names = []
  try {
    names = readdirSync(MEMORY_DIR)
  } catch {
    return []
  }
  return names
    .filter((name) => MEMORY_FILE_PATTERN.test(name))
    .sort((a, b) => (a === MEMORY_INDEX ? -1 : b === MEMORY_INDEX ? 1 : a.localeCompare(b)))
}

function readMemoryFile(file) {
  try {
    return readFileSync(join(MEMORY_DIR, file), 'utf8')
  } catch {
    return null
  }
}

/** Ce que l'en-tête d'une note dit d'elle, pour sa ligne d'index. */
function frontmatterField(content, field) {
  const head = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? ''
  const line = head.split('\n').find((candidate) => candidate.startsWith(`${field}:`))
  return line ? line.slice(field.length + 1).trim().replace(/^["']|["']$/g, '') : null
}

/**
 * Ajoute à l'index la ligne d'une note qu'il ne cite pas encore. Claude tient son index
 * lui-même ; ici l'outil le fait pour que Codex n'ait pas à y penser, et une note absente
 * de l'index est une note que personne ne lira.
 */
function indexNote(file, content) {
  const index = readMemoryFile(MEMORY_INDEX) ?? ''
  if (index.includes(`](${file})`)) return false
  const name = frontmatterField(content, 'name') ?? file.replace(/\.md$/, '')
  const description = frontmatterField(content, 'description')
  const line = `- [${name}](${file})${description ? ` — ${description}` : ''}`
  writeFileSync(join(MEMORY_DIR, MEMORY_INDEX), index.trimEnd() ? `${index.trimEnd()}\n${line}\n` : `${line}\n`)
  return true
}

/** Une conversation du projet que cette session peut joindre, ou null. */
function peerConversation(id) {
  return (
    db
      .prepare(
        `SELECT c.id AS id, c.title AS title, c.agent AS agent, c.status AS status,
                c.background_count AS background, c.loop_count AS loops,
                c.archived_at AS archivedAt
         FROM conversations AS c
         WHERE c.id = ? AND c.project_id = ?`,
      )
      .get(id, PROJECT_ID) ?? null
  )
}

function sendSessionMessage({ to, body, replyTo }) {
  const id = randomUUID()
  writeDb()
    .prepare(
      `INSERT INTO session_messages
         (id, project_id, from_conversation_id, to_conversation_id, body, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, PROJECT_ID, CURRENT_CONVERSATION, to, body, replyTo, Date.now())
  return id
}

/**
 * L'échange de cette conversation avec les autres, du plus ancien au plus récent.
 *
 * Les messages reçus et pas encore remis sont marqués lus au passage : les avoir sous
 * les yeux ici rend leur injection ultérieure redondante, et elle tomberait en plein
 * travail pour redire ce qui vient d'être lu.
 */
function readSessionMessages(withId) {
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.from_conversation_id AS fromId, m.to_conversation_id AS toId,
              m.body AS body, m.kind AS kind, m.reply_to AS replyTo, m.created_at AS createdAt,
              m.delivered_at AS deliveredAt, m.delivered_via AS via,
              o.title AS otherTitle, o.agent AS otherAgent
       FROM session_messages AS m
       LEFT JOIN conversations AS o
         ON o.id = CASE WHEN m.from_conversation_id = @me THEN m.to_conversation_id
                        ELSE m.from_conversation_id END
       WHERE m.project_id = @project
         AND (m.from_conversation_id = @me OR m.to_conversation_id = @me)
         AND (@with IS NULL OR m.from_conversation_id = @with OR m.to_conversation_id = @with)
       ORDER BY m.created_at DESC
       LIMIT ${PEER_HISTORY_LIMIT}`,
    )
    .all({ me: CURRENT_CONVERSATION, project: PROJECT_ID, with: withId })
    .reverse()

  const unread = rows.filter((row) => row.toId === CURRENT_CONVERSATION && row.deliveredAt === null)
  if (unread.length > 0) {
    const mark = writeDb().prepare(
      `UPDATE session_messages SET delivered_at = ?, delivered_via = 'read'
       WHERE id = ? AND delivered_at IS NULL`,
    )
    const now = Date.now()
    for (const row of unread) mark.run(now, row.id)
  }
  return rows
}

function renderCards(rows, column) {
  const truncated = rows.length > CARD_LIMIT
  const shown = truncated ? rows.slice(0, CARD_LIMIT) : rows

  if (shown.length === 0) {
    return column
      ? `Aucune carte dans la colonne « ${COLUMN_LABELS[column]} » de ce projet.`
      : "Ce projet n'a aucune carte. Le board est vide, ce qui ne veut pas dire qu'il n'y a rien à faire : tout n'y est pas forcément décrit."
  }

  const mine = currentCard()?.number ?? null
  const lines = shown.map((row) => {
    const excerpt = (row.description ?? '').trim().replace(/\s+/g, ' ')
    const summary = excerpt
      ? `\n  ${excerpt.length > CARD_EXCERPT_CHARS ? `${excerpt.slice(0, CARD_EXCERPT_CHARS)}...` : excerpt}`
      : ''
    const sessions = row.sessions > 0 ? `, ${row.sessions} session(s)` : ''
    const self = row.number === mine ? ' <- celle de cette conversation' : ''
    return `- #${row.number} [${COLUMN_LABELS[row.column] ?? row.column}] ${row.title}${sessions}${self}${summary}`
  })

  const head = `${shown.length} carte(s)${column ? ` en « ${COLUMN_LABELS[column]} »` : ''} :`
  const tail = truncated
    ? `\n\n${rows.length - CARD_LIMIT} carte(s) de plus ne sont pas rendues. Filtrer par colonne pour voir le reste.`
    : ''
  return `${head}\n${lines.join('\n')}${tail}`
}

function renderCard(card) {
  const parts = [
    `#${card.number} [${COLUMN_LABELS[card.column] ?? card.column}] ${card.title}`,
  ]

  parts.push(card.description.trim() || '(aucune description)')
  if (card.attachments.length) {
    parts.push('Pièces jointes — fichiers locaux consultables avec tes outils de lecture :\n' +
      card.attachments.map((file) => JSON.stringify(file)).join('\n'))
  }

  if (card.sessions.length > 0) {
    const lines = card.sessions.map((session) => {
      const where = session.worktree ? `worktree ${session.worktree}` : 'racine du projet'
      const self = session.id === CURRENT_CONVERSATION ? ' <- celle-ci' : ''
      return `- ${session.agent} | ${describeActivity(session)} | ${where} | ${ago(session.updatedAt)}${self}\n  ${session.title}`
    })
    parts.push(`${card.sessions.length} session(s) sur cette carte :\n${lines.join('\n')}`)
  } else {
    parts.push("Aucune session n'a encore travaillé sur cette carte.")
  }

  const notes = cardNotes(card.id)
  if (notes.length > 0) {
    const lines = notes.map((note) => {
      const who = note.userName
        ? note.userName
        : note.conversationId === CURRENT_CONVERSATION
          ? 'cette conversation'
          : `session ${note.agent ?? '?'}${note.conversationTitle ? ` « ${note.conversationTitle} »` : ''}`
      return `[${who}, ${ago(note.createdAt)}]\n${note.body}`
    })
    parts.push(`${notes.length} note(s) laissée(s) sur cette carte :\n\n${lines.join('\n\n')}`)
  }

  const link = (rows) =>
    rows.map((row) => `- #${row.number} [${COLUMN_LABELS[row.column] ?? row.column}] ${row.title}`).join('\n')
  if (card.references.length > 0) parts.push(`Cette carte cite :\n${link(card.references)}`)
  if (card.referencedBy.length > 0) parts.push(`Citée par :\n${link(card.referencedBy)}`)

  return parts.join('\n\n')
}

const DELIVERY_LABELS = {
  steer: 'remis dans son tour en cours',
  queue: 'remis à la fin de son tour',
  wake: 'remis en la relançant',
  read: 'lu par read_session_messages',
  failed: 'remise échouée',
  discarded: 'écarté par une personne',
  expired: 'expiré sans être remis',
  skipped: "pas remis, elle ne travaillait plus",
}

const KIND_LABELS = { message: '', broadcast: 'annonce ', done: 'fin de travail ' }

function renderPeerMessages(rows) {
  if (rows.length === 0) {
    return "Aucun message échangé avec les autres sessions de ce projet."
  }

  const lines = rows.map((row) => {
    const outgoing = row.fromId === CURRENT_CONVERSATION
    const other = outgoing ? row.toId : row.fromId
    const who = `${other}${row.otherTitle ? ` « ${row.otherTitle} »` : ''}`
    const state = row.deliveredAt === null
      ? outgoing
        ? 'pas encore remis'
        : 'retenu, lu à l\'instant'
      : DELIVERY_LABELS[row.via] ?? row.via
    const reply = row.replyTo ? `, en réponse à ${row.replyTo}` : ''
    const kind = KIND_LABELS[row.kind] ?? ''
    return `[${kind}${outgoing ? 'envoyé à' : 'reçu de'} ${who}, ${ago(row.createdAt)}, ${state}${reply}] id ${row.id}\n${row.body}`
  })
  return lines.join('\n\n')
}

function renderCount(state) {
  if (state.working === 0) {
    const suffix =
      state.awaiting > 0
        ? ` ${state.awaiting} attend(ent) une réponse : un redémarrage expirera ces sollicitations.`
        : ''
    return `Aucune conversation ne travaille sur l'instance.${suffix}`
  }

  const parts = [`${state.working} conversation(s) travaillent sur l'instance`]
  if (state.here > 0) parts.push(`dont ${state.here} dans ce projet`)
  if (state.includesSelf) parts.push('dont celle-ci')
  if (state.oldest !== null) parts.push(`la plus ancienne active depuis ${ago(state.oldest)}`)

  const awaiting =
    state.awaiting > 0
      ? ` ${state.awaiting} autre(s) attend(ent) une réponse : un redémarrage expirera ces sollicitations.`
      : ''
  return `${parts.join(', ')}. Un redémarrage du service les coupe toutes.${awaiting}`
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[...]` : text
}

function renderSearch(query, results) {
  if (results.length === 0) {
    return `Aucune conversation de ce projet ne contient « ${query} ».`
  }

  const lines = results.map(
    (row) =>
      `- ${row.id} | ${row.agent} | échange du ${asDate(row.ts)} | ${row.title}\n  ${row.excerpt}`,
  )
  return `${results.length} conversation(s) pour « ${query} » :\n${lines.join('\n')}`
}

const block = (role, body) => `## ${role === 'user' ? 'Utilisateur' : 'Agent'}\n${body}`

/**
 * Remplit un budget en partant de la fin, sans casser l'ordre chronologique.
 *
 * Un message seul plus gros que le budget entier est rendu quand même, tronqué : rendre
 * une tranche vide en disant qu'elle ne tient pas laisserait l'appelant sans recours.
 */
function fillFromEnd(messages, budget) {
  const kept = []
  let total = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const body = clip(messages[i].text ?? '', MAX_MESSAGE_CHARS)
    if (total + body.length > budget && kept.length > 0) break
    total += body.length
    kept.unshift({ ...messages[i], body })
  }
  return kept
}

/**
 * Le fil, ou ce qui en tient dans le budget.
 *
 * Les deux bouts plutôt que le début : la fin porte les conclusions, mais le premier
 * message porte la demande, et des conclusions sans énoncé se lisent de travers. Le
 * milieu est ce qu'on sacrifie, en annonçant combien de messages manquent et par où les
 * reprendre.
 *
 * Le curseur est le numéro de message et non un numéro de page : les messages ont des
 * tailles très inégales, donc une page n'est pas une unité stable, et une conversation
 * reprise plus tard décalerait toute numérotation partant de la fin.
 */
function renderThread(found, before) {
  const { conversation, messages } = found
  // « ouverte le » et non une date nue : search_history date le message qui correspond,
  // celle-ci date la création du fil. Deux dates justes pour un même objet se lisent
  // comme une contradiction tant qu'aucune des deux ne dit ce qu'elle mesure.
  const header = `${conversation.title} (${conversation.agent}, ouverte le ${asDate(conversation.createdAt)})`
  if (messages.length === 0) return `${header}\n\nAucun message dans ce fil.`

  const scoped = before === null ? messages : messages.filter((message) => message.seq < before)
  if (scoped.length === 0) return `${header}\n\nAucun message avant ${before} dans ce fil.`

  // La demande n'est reprise qu'à la première lecture : en remontant le fil, l'appelant
  // l'a déjà, et la lui resservir mangerait le budget de ce qu'il est venu chercher.
  const head = before === null && scoped[0].role === 'user' ? scoped[0] : null
  const rest = head ? scoped.slice(1) : scoped
  const headBody = head ? clip(head.text ?? '', MAX_MESSAGE_CHARS) : ''
  const tail = fillFromEnd(rest, MAX_THREAD_CHARS - headBody.length)

  const parts = head ? [block(head.role, headBody)] : []

  const elided = rest.length - tail.length
  if (elided > 0) {
    parts.push(
      `[${elided} message(s) élidés. Rappeler read_conversation avec before=${tail[0].seq} pour lire ce qui précède.]`,
    )
  }
  for (const message of tail) parts.push(block(message.role, message.body))

  return `${header}\n\n${parts.join('\n\n')}`
}

const text = (value) => ({ content: [{ type: 'text', text: value }] })

/**
 * Dépose une demande pour le daemon et attend qu'il y réponde.
 *
 * Le daemon balaie la table toutes les demi-secondes ; ce process relit la ligne
 * jusqu'à la trouver traitée, sur sa connexion en lecture seule.
 */
async function requestDaemon(kind, payload) {
  const id = randomUUID()
  writeDb()
    .prepare(
      `INSERT INTO agent_requests (id, project_id, conversation_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, PROJECT_ID, CURRENT_CONVERSATION, kind, JSON.stringify(payload), Date.now())

  const read = db.prepare('SELECT settled_at, result, is_error FROM agent_requests WHERE id = ?')
  const deadline = Date.now() + REQUEST_WAIT_MS[kind]
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, REQUEST_POLL_MS))
    const row = read.get(id)
    if (row?.settled_at) return { ...text(row.result ?? ''), ...(row.is_error ? { isError: true } : {}) }
  }
  return {
    ...text(
      kind === 'start_session'
        ? "Sillage n'a pas encore fini de lancer la session (le CLI met du temps à démarrer, ou le service ne tourne pas). Ne relance pas la demande : vérifie avec list_sessions dans un moment."
        : "Sillage n'a pas répondu à temps : le service ne tourne peut-être pas. Réessaie plus tard.",
    ),
    isError: true,
  }
}

async function callTool(name, args) {
  if (name === 'search_history') {
    const query = typeof args?.query === 'string' ? args.query : ''
    if (!query.trim()) return { ...text('Le paramètre `query` est requis.'), isError: true }

    const asked = Number.isInteger(args?.limit) ? args.limit : 10
    const limit = Math.min(Math.max(asked, 1), 50)
    return text(renderSearch(query, searchHistory(query, limit)))
  }

  if (name === 'read_conversation') {
    const id = typeof args?.id === 'string' ? args.id : ''
    const found = id ? readConversation(id) : null
    if (!found) {
      return {
        ...text(`Aucune conversation « ${id} » dans ce projet.`),
        isError: true,
      }
    }
    const before = Number.isInteger(args?.before) ? args.before : null
    return text(renderThread(found, before))
  }

  if (name === 'list_sessions') {
    const asked = Number.isInteger(args?.within_minutes) ? args.within_minutes : RECENT_MINUTES
    const within = Math.min(Math.max(asked, 1), 60 * 24 * 7)
    return text(renderSessions(listSessions(within), within))
  }

  if (name === 'find_file_edits') {
    const path = typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : null
    const asked = Number.isInteger(args?.within_minutes) ? args.within_minutes : EDIT_MINUTES
    const withinMinutes = Math.min(Math.max(asked, 1), 60 * 24 * 7)
    const rows = findFileEdits({ path, withinMinutes })
    // Sondé seulement quand la fenêtre ne rend rien : c'est le seul cas où la réponse
    // risque de se lire comme « personne n'y a touché ».
    const older =
      rows.length === 0
        ? oldestOutsideWindow({
            path: path ? path.replace(/^\.\//, '') : null,
            byName: false,
            withinMinutes,
          })
        : null
    return text(renderFileEdits(rows, { path, withinMinutes, older }))
  }

  if (name === 'list_cards') {
    const column = typeof args?.column === 'string' && COLUMN_LABELS[args.column] ? args.column : null
    return text(renderCards(listCards(column), column))
  }

  if (name === 'read_card') {
    const number = Number.isInteger(args?.number) ? args.number : null
    if (number === null) {
      return { ...text('Le paramètre `number` est requis, et doit être un entier.'), isError: true }
    }
    const card = readCard(number)
    if (!card) {
      return {
        ...text(`Aucune carte #${number} dans ce projet. Appeler list_cards pour voir celles qui existent.`),
        isError: true,
      }
    }
    return text(renderCard(card))
  }

  if (name === 'add_card_note') {
    const body = typeof args?.body === 'string' ? args.body.trim() : ''
    if (!body) return { ...text('Le paramètre `body` est requis.'), isError: true }

    const card = currentCard()
    if (!card) {
      return {
        ...text(
          "Cette conversation n'est rattachée à aucune carte, il n'y a donc pas de fil où écrire. Le rattachement se fait dans l'interface de Sillage, sur la carte ou depuis la conversation ; demande-le plutôt que de choisir une carte toi-même.",
        ),
        isError: true,
      }
    }

    addCardNote(card.id, body)
    return text(`Note ajoutée à la carte #${card.number} « ${card.title} ».`)
  }

  if (name === 'set_project_image') {
    const path = typeof args?.path === 'string' ? args.path.trim() : ''
    if (!path) return { ...text('Le paramètre `path` est requis.'), isError: true }
    const provisional = args?.provisional === true

    const file = resolve(path)
    let data
    try {
      // La taille avant la lecture : un chemin qui désigne par erreur une vidéo ou une
      // archive ne doit pas passer par la mémoire pour être refusé.
      const info = statSync(file)
      if (!info.isFile()) return { ...text(`${file} n'est pas un fichier.`), isError: true }
      if (info.size > MAX_PROJECT_IMAGE_BYTES) {
        return {
          ...text(
            `Image trop lourde (${Math.round(info.size / 1024)} Ko, ${MAX_PROJECT_IMAGE_BYTES / 1024} Ko au plus). Elle s'affiche en quelques dizaines de pixels : réduis-la à 256 pixels de côté et recommence.`,
          ),
          isError: true,
        }
      }
      data = readFileSync(file)
    } catch (error) {
      return { ...text(`Lecture de ${file} impossible : ${error.message}`), isError: true }
    }

    const mimeType = sniffProjectImage(data)
    if (!mimeType) {
      return {
        ...text(`${file} n'est pas une image reconnue. Formats acceptés : PNG, JPEG, GIF, WebP, SVG.`),
        isError: true,
      }
    }

    setProjectImage(mimeType, data, provisional)
    return text(
      provisional
        ? "Image du projet posée, marquée provisoire : les sessions suivantes se verront rappeler de la remplacer quand le projet aura un vrai logo."
        : 'Image du projet mise à jour.',
    )
  }

  if (name === 'send_session_message') {
    const to = typeof args?.to === 'string' ? args.to.trim() : ''
    const body = typeof args?.body === 'string' ? args.body.trim() : ''
    const replyTo = typeof args?.reply_to === 'string' && args.reply_to.trim() ? args.reply_to.trim() : null
    if (!to || !body) return { ...text('Les paramètres `to` et `body` sont requis.'), isError: true }
    if (body.length > MAX_PEER_MESSAGE_CHARS) {
      return {
        ...text(`Message trop long (${body.length} caractères, ${MAX_PEER_MESSAGE_CHARS} au plus). Résume, ou mets le détail dans un fichier et donne son chemin.`),
        isError: true,
      }
    }
    if (!CURRENT_CONVERSATION) {
      return { ...text("Cette session ne sait pas qui elle est : elle ne peut pas signer un message."), isError: true }
    }
    if (to === CURRENT_CONVERSATION) {
      return { ...text("C'est l'identifiant de cette conversation-ci."), isError: true }
    }

    const peer = peerConversation(to)
    if (!peer) {
      return {
        ...text(`Aucune conversation « ${to} » dans ce projet. Appeler list_sessions pour voir celles qui existent.`),
        isError: true,
      }
    }
    if (peer.archivedAt !== null) {
      return { ...text(`La conversation « ${peer.title} » est archivée : personne ne lira ce message.`), isError: true }
    }

    const id = sendSessionMessage({ to, body, replyTo })
    if (peer.status === 'running' || peer.status === 'awaiting_input') {
      return text(
        `Message ${id} déposé pour « ${peer.title} » (${peer.agent}). Elle travaille en ce moment : il lui sera remis dans son tour, ou juste après. Si tu attends sa réponse, termine ton tour : elle te relancera.`,
      )
    }

    const held = predictHold(to, replyTo)
    if (held) {
      const why = held === 'loop'
        ? `votre échange compte déjà ${MAX_HOPS} allers-retours`
        : `elle a déjà été relancée ${WAKES_PER_HOUR} fois dans l'heure par d'autres sessions`
      return text(
        `Message ${id} déposé pour « ${peer.title} », mais il ne la relancera pas : ${why}. Il est retenu, et son fil le montre jusqu'à ce qu'une personne le remette ou l'écarte ; il lui sera aussi remis si elle se remet à travailler. Ne compte pas sur une réponse rapide, et ne renvoie pas le message.`,
      )
    }
    return text(
      `Message ${id} déposé pour « ${peer.title} » (${peer.agent}). Elle est ${STATUS_LABELS[peer.status] ?? peer.status} : Sillage va la relancer pour qu'elle le lise. Si tu attends sa réponse, termine ton tour : elle te relancera.`,
    )
  }

  if (name === 'broadcast_session_message') {
    const body = typeof args?.body === 'string' ? args.body.trim() : ''
    if (!body) return { ...text('Le paramètre `body` est requis.'), isError: true }
    if (body.length > MAX_PEER_MESSAGE_CHARS) {
      return {
        ...text(`Annonce trop longue (${body.length} caractères, ${MAX_PEER_MESSAGE_CHARS} au plus).`),
        isError: true,
      }
    }
    if (!CURRENT_CONVERSATION) {
      return { ...text("Cette session ne sait pas qui elle est : elle ne peut pas signer une annonce."), isError: true }
    }
    const sent = broadcast(body)
    return text(
      sent === 0
        ? "Aucune autre session de ce projet ne travaille en ce moment : l'annonce n'a été envoyée à personne."
        : `Annonce déposée pour ${sent} session(s) en train de travailler. Elle leur sera remise dans leur tour ; celles qui auront fini d'ici là ne la recevront pas.`,
    )
  }

  if (name === 'notify_when_done') {
    const target = typeof args?.session === 'string' ? args.session.trim() : ''
    if (!target) return { ...text('Le paramètre `session` est requis.'), isError: true }
    if (!CURRENT_CONVERSATION) {
      return { ...text("Cette session ne sait pas qui elle est : Sillage ne saurait pas qui prévenir."), isError: true }
    }
    if (target === CURRENT_CONVERSATION) {
      return { ...text("C'est l'identifiant de cette conversation-ci."), isError: true }
    }
    const peer = peerConversation(target)
    if (!peer) {
      return {
        ...text(`Aucune conversation « ${target} » dans ce projet. Appeler list_sessions pour voir celles qui existent.`),
        isError: true,
      }
    }
    if (!isWorking(peer) && peer.status !== 'awaiting_input') {
      return text(
        `« ${peer.title} » ne travaille pas : elle est ${STATUS_LABELS[peer.status] ?? peer.status}. Il n'y a rien à attendre ; read_conversation dit où elle s'est arrêtée.`,
      )
    }
    const created = watch(target)
    const pause = peer.status === 'awaiting_input'
      ? " Elle attend en ce moment une réponse de l'utilisateur : la surveillance ne se déclenchera qu'après."
      : ''
    return text(
      `${created ? 'Surveillance posée' : 'Une surveillance était déjà posée'} sur « ${peer.title} ». Tu seras relancé quand elle aura fini.${pause} Termine ton tour maintenant si tu n'as rien d'autre à faire en attendant.`,
    )
  }

  if (name === 'read_session_messages') {
    const withId = typeof args?.with === 'string' && args.with.trim() ? args.with.trim() : null
    return text(renderPeerMessages(readSessionMessages(withId)))
  }

  if (name === 'count_active_sessions') {
    return text(renderCount(countActiveSessions()))
  }

  if (name === 'create_card' || name === 'start_session' || name === 'list_models') {
    if (!CURRENT_CONVERSATION) {
      return { ...text("Cette session ne sait pas qui elle est : Sillage ne saurait pas pour qui agir."), isError: true }
    }
    if (name === 'create_card' && !(typeof args?.title === 'string' && args.title.trim())) {
      return { ...text('Le paramètre `title` est requis.'), isError: true }
    }
    if (name === 'start_session') {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (!prompt) return { ...text('Le paramètre `prompt` est requis.'), isError: true }
      if (prompt.length > MAX_LAUNCH_PROMPT_CHARS) {
        return {
          ...text(`Mission trop longue (${prompt.length} caractères, ${MAX_LAUNCH_PROMPT_CHARS} au plus). Mets le détail dans un fichier et cite-le.`),
          isError: true,
        }
      }
    }
    return requestDaemon(name, args ?? {})
  }

  if (name === 'read_memory' || name === 'write_memory' || name === 'delete_memory') {
    if (!MEMORY_DIR) return { ...text("La mémoire n'est pas disponible dans cette session."), isError: true }
    const file = typeof args?.file === 'string' ? args.file.trim() : ''

    if (name === 'read_memory') {
      if (!file) {
        const files = memoryFiles()
        if (files.length === 0) return text(`Mémoire vide (${MEMORY_DIR}).`)
        const index = readMemoryFile(MEMORY_INDEX)
        return text(
          [
            `Mémoire du projet, dans ${MEMORY_DIR} :`,
            index ? `${MEMORY_INDEX} :\n\n${index.trim()}` : `Pas de ${MEMORY_INDEX}.`,
            `Notes : ${files.filter((candidate) => candidate !== MEMORY_INDEX).join(', ') || 'aucune'}.`,
          ].join('\n\n'),
        )
      }
      const content = MEMORY_FILE_PATTERN.test(file) ? readMemoryFile(file) : null
      if (content === null) return { ...text(`Aucune note « ${file} ». read_memory sans \`file\` les liste.`), isError: true }
      return text(content)
    }

    if (!MEMORY_FILE_PATTERN.test(file)) {
      return {
        ...text("`file` doit être un nom de fichier `.md` à plat : lettres, chiffres, points, tirets et soulignés, sans dossier."),
        isError: true,
      }
    }

    if (name === 'delete_memory') {
      if (readMemoryFile(file) === null) return { ...text(`Aucune note « ${file} ».`), isError: true }
      rmSync(join(MEMORY_DIR, file), { force: true })
      if (file !== MEMORY_INDEX) {
        const index = readMemoryFile(MEMORY_INDEX)
        if (index !== null) {
          const kept = index.split('\n').filter((line) => !line.includes(`](${file})`))
          writeFileSync(join(MEMORY_DIR, MEMORY_INDEX), kept.join('\n'))
        }
      }
      return text(`Note « ${file} » retirée de la mémoire.`)
    }

    if (typeof args?.content !== 'string') return { ...text('Le paramètre `content` est requis.'), isError: true }
    if (args.content.length > MAX_MEMORY_FILE_CHARS) {
      return { ...text(`Note trop longue (${args.content.length} caractères, ${MAX_MEMORY_FILE_CHARS} au plus).`), isError: true }
    }
    mkdirSync(MEMORY_DIR, { recursive: true })
    writeFileSync(join(MEMORY_DIR, file), args.content)
    const indexed = file !== MEMORY_INDEX && indexNote(file, args.content)
    return text(
      `Note « ${file} » écrite dans la mémoire du projet${indexed ? `, et ajoutée à ${MEMORY_INDEX}` : ''}. Les sessions suivantes, de Claude comme de Codex, la verront.`,
    )
  }

  if (name === 'read_instructions') {
    const target = instructionsTarget(args, false)
    if (target.refusal) return { ...text(target.refusal), isError: true }
    const row = readInstructionsRow(target.projectId)
    if (!row?.content.trim()) return text(`SILLAGE.md, ${scopeLabel(target.scope)} : vide.`)
    return text(`SILLAGE.md, ${scopeLabel(target.scope)} (${row.content.length} caractères) :\n\n${row.content}`)
  }

  if (name === 'edit_instructions' || name === 'write_instructions') {
    const target = instructionsTarget(args, true)
    if (target.refusal) return { ...text(target.refusal), isError: true }

    let transform
    if (name === 'write_instructions') {
      if (typeof args?.content !== 'string') return { ...text('Le paramètre `content` est requis.'), isError: true }
      transform = () => args.content
    } else {
      const oldText = typeof args?.old_text === 'string' ? args.old_text : null
      const newText = typeof args?.new_text === 'string' ? args.new_text : null
      if (oldText === null || newText === null) {
        return { ...text('Les paramètres `old_text` et `new_text` sont requis.'), isError: true }
      }
      transform = (current) => {
        if (oldText === '') {
          const before = current.trimEnd()
          return before ? `${before}\n${newText}` : newText
        }
        const count = current.split(oldText).length - 1
        if (count === 0) {
          return { error: "`old_text` n'apparaît pas dans SILLAGE.md. Relis la version courante avec read_instructions : elle a pu changer depuis le début de la session." }
        }
        if (count > 1 && args?.replace_all !== true) {
          return { error: `\`old_text\` apparaît ${count} fois. Donne plus de contexte pour n'en désigner qu'une, ou passe \`replace_all: true\`.` }
        }
        return args?.replace_all === true ? current.split(oldText).join(newText) : current.replace(oldText, () => newText)
      }
    }

    const result = saveInstructions(target.projectId, transform, target.fixMode)
    if (result.error) return { ...text(result.error), isError: true }
    return text(
      `SILLAGE.md mis à jour (${scopeLabel(target.scope)}, ${result.content.length} caractères). Vaut pour les sessions qui démarrent ensuite, de Claude comme de Codex ; l'utilisateur voit la modification dans Sillage.`,
    )
  }

  return { ...text(`Outil inconnu : ${name}`), isError: true }
}

log(`prêt, projet=${PROJECT_ID}`)

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return

  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log('ligne illisible, ignorée')
    return
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        // La version demandée par le client : le CLI décide, pas nous.
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sillage', version: '1' },
      },
    })
    return
  }

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    return
  }

  if (msg.method === 'tools/call') {
    let result
    try {
      result = await callTool(msg.params?.name, msg.params?.arguments ?? {})
    } catch (err) {
      // Rendu en résultat d'outil et non en erreur JSON-RPC : le modèle peut corriger
      // sa requête, là où une erreur de protocole ne lui apprend rien.
      log(`échec de ${msg.params?.name} : ${err.message}`)
      result = { ...text(`La recherche a échoué : ${err.message}`), isError: true }
    }
    send({ jsonrpc: '2.0', id: msg.id, result })
    return
  }

  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }

  // Les notifications n'ont pas d'id et n'attendent pas de réponse.
  if (msg.id === undefined) return

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `méthode inconnue : ${msg.method}` },
  })
})
