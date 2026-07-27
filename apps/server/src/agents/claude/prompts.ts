import type {
  AskUserQuestionInput,
  ExitPlanModeInput,
} from '@anthropic-ai/claude-agent-sdk/sdk-tools'
import { z } from 'zod'
import type { AgentQuestion } from '@sillage/protocol'

/**
 * Traduction des deux outils par lesquels Claude Code interroge l'utilisateur.
 *
 * Ce ne sont pas des demandes de permission : ils passent par le même rappel
 * `canUseTool`, mais la réponse attendue n'est pas « autorisé » ou « refusé ». Pour
 * `AskUserQuestion`, la réponse voyage dans `updatedInput.answers`, sous une clé qui
 * est l'intitulé de la question. Ce comportement a été relevé sur le CLI installé, en
 * observant le résultat d'outil produit dans les deux cas :
 *
 *   sans `answers`  ->  « The user did not answer the questions. »
 *   avec `answers`  ->  « Your questions have been answered: "..."="..." »
 */

/** Nom de l'outil qui pose des questions. Les types importés ancrent l'orthographe. */
export const ASK_USER_QUESTION = 'AskUserQuestion'
/** Nom de l'outil qui soumet un plan à validation. */
export const EXIT_PLAN_MODE = 'ExitPlanMode'

const askUserQuestionInputSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string(),
      multiSelect: z.boolean().default(false),
      options: z
        .array(
          z.object({
            label: z.string(),
            description: z.string(),
            preview: z.string().optional(),
          }),
        )
        .default([]),
    }),
  ),
})

const exitPlanModeInputSchema = z.object({ plan: z.string().default('') })

/**
 * Garde-fou de compilation : la forme réellement envoyée par le CLI doit rester
 * acceptable par le schéma ci-dessus. Si une mise à jour du SDK renomme un champ ou
 * en rend un obligatoire, l'alias devient invalide et le typecheck échoue, plutôt que
 * de laisser une question s'afficher amputée à l'exécution.
 */
type AssertTrue<T extends true> = T
export type AskInputParsable = AssertTrue<
  AskUserQuestionInput extends z.input<typeof askUserQuestionInputSchema> ? true : false
>

/**
 * Pas d'équivalent pour le plan : le SDK déclare `ExitPlanModeInput` comme un
 * enregistrement ouvert (`[k: string]: unknown`) où `plan` n'apparaît même pas. Le
 * champ n'est connu que par observation du CLI installé, donc seule la validation à
 * l'exécution peut en dire quelque chose, et un plan absent doit rester supportable.
 */
export type PlanInputOpen = AssertTrue<
  ExitPlanModeInput extends Record<string, unknown> ? true : false
>

/**
 * Questions normalisées.
 *
 * L'identifiant est l'intitulé lui-même : c'est la clé sous laquelle le CLI attend la
 * réponse, donc en choisir un autre obligerait à maintenir une table de
 * correspondance pour rien.
 *
 * `allowOther` est toujours vrai : la description de l'outil précise que l'option
 * « autre » est fournie d'office par l'interface qui affiche la question, et le CLI
 * accepte n'importe quelle chaîne en réponse.
 */
export function toQuestions(input: unknown): AgentQuestion[] {
  const parsed = askUserQuestionInputSchema.parse(input)

  return parsed.questions.map((question) => ({
    id: question.question,
    header: question.header,
    question: question.question,
    multiSelect: question.multiSelect,
    allowOther: true,
    secret: false,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
      preview: option.preview ?? null,
    })),
  }))
}

/**
 * Réponses telles que le CLI les attend : une chaîne par question, les choix
 * multiples étant énumérés dans une seule valeur. Le CLI recopie cette chaîne telle
 * quelle dans le résultat d'outil, donc le séparateur ne relève que de la lisibilité.
 */
export function toUpdatedInput(
  input: Record<string, unknown>,
  answers: Record<string, string[]>,
): Record<string, unknown> {
  const flattened: Record<string, string> = {}
  for (const [id, values] of Object.entries(answers)) {
    if (values.length > 0) flattened[id] = values.join(', ')
  }
  return { ...input, answers: flattened }
}

export function toPlan(input: unknown): string {
  return exitPlanModeInputSchema.parse(input).plan
}
