import { z } from 'zod'
import { conversationStatusSchema, type ConversationMetrics } from './api.js'
import type { AgentConfig } from './agent-config.js'
import type { SillageEvent } from './events.js'

/**
 * Une seule connexion WebSocket par onglet, multiplexée sur plusieurs conversations
 * (la sidebar suit les statuts pendant que la vue principale suit un fil).
 */

/** Au-delà, l'explorateur déplié coûte plus de veilles que la machine n'en accorde. */
export const MAX_WATCHED_PATHS = 200

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('subscribe'),
    conversationId: z.string(),
    afterSeq: z.number().int().min(0),
  }),
  z.object({ t: z.literal('unsubscribe'), conversationId: z.string() }),
  /**
   * Dossiers dont le client affiche le contenu, et qu'il veut donc voir suivis sur le
   * disque. L'ensemble est déclaré entier à chaque fois plutôt que par ajouts et
   * retraits : le client connaît ses niveaux dépliés, et un delta perdu laisserait un
   * dossier suivi pour toujours ou plus du tout.
   */
  z.object({
    t: z.literal('watch-tree'),
    /**
     * L'explorateur vit aussi en vue projet, où aucune conversation n'existe : le
     * répertoire suivi est alors le workspace du projet plutôt que celui d'un fil.
     */
    scope: z.enum(['conversation', 'project']),
    id: z.string(),
    // Borné parce que chaque dossier coûte une veille inotify, ressource comptée par
    // utilisateur sur la machine hôte.
    paths: z.array(z.string()).max(MAX_WATCHED_PATHS),
  }),
  z.object({ t: z.literal('ping') }),
])
export type ClientMessage = z.infer<typeof clientMessageSchema>

export type ServerMessage =
  | {
      t: 'event'
      conversationId: string
      seq: number
      ts: number
      event: SillageEvent
    }
  | {
      t: 'status'
      conversationId: string
      status: z.infer<typeof conversationStatusSchema>
      /**
       * Vrai si un process CLI est encore vivant pour cette conversation.
       *
       * Distinct du statut : une conversation au repos peut avoir gardé sa session
       * chargée, ou l'avoir laissée expirer. Le prochain message coûte alors le
       * redémarrage du CLI et le rechargement du contexte, ce que l'utilisateur a
       * intérêt à savoir avant de se demander pourquoi la réponse tarde.
       */
      warm: boolean
      /**
       * Nombre de travaux de fond vivants pour cette conversation.
       *
       * Doublonne l'événement `background.updated` du journal, et pour la même raison
       * que `warm` : la sidebar suit des conversations qu'elle n'a pas ouvertes, donc
       * sans journal à replier. C'est un état de process, jamais persisté : une
       * conversation froide n'a plus de CLI, donc plus de travail de fond.
       */
      background: number
      /**
       * Nombre de boucles armées pour cette conversation.
       *
       * Doublonne `loops.updated` pour la même raison que `background` : la sidebar
       * doit distinguer une conversation au repos d'une conversation qui repartira
       * seule, sans avoir son journal à replier.
       */
      loops: number
      /**
       * Configuration sous laquelle la session tourne réellement, `null` à froid.
       *
       * Un réglage que le CLI ne sait pas changer en vol reste celui du lancement
       * jusqu'au redémarrage, alors que la valeur demandée est déjà enregistrée et
       * affichée : c'est le seul moyen de savoir que le tour en cours n'obéit pas encore
       * à ce qui est à l'écran. Envoyée entière plutôt que réduite au réglage qui pose
       * problème, les deux CLI n'ayant pas les mêmes ; le client compare et n'annonce
       * que ce qui diffère. À froid il n'y a rien à comparer : le prochain lancement
       * prendra la configuration enregistrée.
       */
      appliedConfig: AgentConfig | null
      /**
       * Dernier `seq` qui valait qu'on prévienne le lecteur, pour la même raison que les
       * trois précédents.
       *
       * Porté par le statut plutôt que par un flux propre : le moment qui intéresse la
       * sidebar est la fin du tour, pas chaque jeton. Un fil qui repasse au repos a fini
       * de produire, et c'est là que le point de non-lu doit apparaître. Le suivre
       * événement par événement le ferait clignoter pendant toute la réponse.
       *
       * Le `seq` brut du journal ne conviendrait pas : il avance encore après le départ
       * de tout le monde, quand la session se refroidit ou qu'un relevé d'usage tombe.
       */
      lastNotableSeq: number
      /**
       * Métriques de volume, relues en base à chaque diffusion.
       *
       * Portées par le statut pour la même raison que `lastNotableSeq`, et pour le même prix :
       * la ligne de conversation est déjà lue pour lui. Ce qui les fait bouger arrive en
       * fin de tour, moment où le statut change de toute façon.
       */
      metrics: ConversationMetrics
    }
  /**
   * Le CLI a proposé un titre pour la conversation. Poussé plutôt que redécouvert par
   * rafraîchissement : le titre arrive après la fin du tour, donc une invalidation
   * déclenchée sur ce même signal courrait après lui.
   */
  | { t: 'title'; conversationId: string; title: string }
  /**
   * Le contenu d'un dossier suivi a bougé sur le disque : le client relit ce niveau.
   *
   * Un chemin par message, la veille étant déjà amortie côté serveur : regrouper
   * demanderait de retarder les dossiers calmes derrière celui qui s'agite.
   *
   * Ce que le rafraîchissement de fin de tour ne voit pas passe par ici : un terminal
   * du panneau, un éditeur hors de Sillage, une autre conversation sur le même
   * worktree.
   */
  | { t: 'tree-changed'; scope: 'conversation' | 'project'; id: string; path: string }
  /**
   * Le retard dépasse CATCHUP_THRESHOLD : le client doit recharger par la route REST
   * paginée plutôt que de recevoir le delta sur le socket.
   */
  | { t: 'catchup'; conversationId: string; fromSeq: number; toSeq: number }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string; params?: Record<string, string | number> }

export const CATCHUP_THRESHOLD = 500
export const HEARTBEAT_INTERVAL_MS = 25_000
