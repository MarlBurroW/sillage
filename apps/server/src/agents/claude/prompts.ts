import type {
  AskUserQuestionInput,
  ExitPlanModeInput,
} from '@anthropic-ai/claude-agent-sdk/sdk-tools'
import { z } from 'zod'
import type { AgentQuestion } from '@sillage/protocol'

/** Normalizes Claude's two user-interaction tools. Both use `canUseTool` but do not ask permissions. `AskUserQuestion` expects `updatedInput.answers` keyed by question headings. Observed tool results: without `answers`, 'The user did not answer the questions.'; with them, 'Your questions have been answered: "..."="..."'. */

/** Question tool name anchored by imported types. */
export const ASK_USER_QUESTION = 'AskUserQuestion'
/** Plan-review tool name. */
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

/** Compile-time guard ensuring native CLI payloads remain accepted by schemas. SDK field renames or new requirements fail typecheck instead of silently truncating runtime questions. */
type AssertTrue<T extends true> = T
export type AskInputParsable = AssertTrue<
  AskUserQuestionInput extends z.input<typeof askUserQuestionInputSchema> ? true : false
>

/** No plan equivalent: SDK `ExitPlanModeInput` is open `[k: string]: unknown` without declared `plan`. Only installed-CLI observations reveal fields, so runtime validation must tolerate absent plans. */
export type PlanInputOpen = AssertTrue<
  ExitPlanModeInput extends Record<string, unknown> ? true : false
>

/** Normalized questions use headings as IDs because CLIs expect those keys, avoiding pointless maps. `allowOther` is always true: tool descriptions delegate Other options to interfaces and CLIs accept arbitrary strings. */
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

/** CLI responses: one string per question, multiple choices combined. CLIs copy strings verbatim to tool results, so separators concern readability only. */
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

/** Init capability under which an answer may carry `annotations[question].unanswered`. */
export const UNANSWERED_CAPABILITY = 'ask_user_question_unanswered_v1'

/** “Don't answer” is a deliberate skip. The model still reads “The user did not answer the questions”: the annotation goes only to the tool result (probed on 2.1.312), so a replay can tell a skip from a lost question. */
export function toSkippedInput(input: Record<string, unknown>): Record<string, unknown> {
  const annotations: Record<string, { unanswered: 'skipped' }> = {}
  for (const question of askUserQuestionInputSchema.parse(input).questions) {
    annotations[question.question] = { unanswered: 'skipped' }
  }
  return { ...input, answers: {}, annotations }
}

export function toPlan(input: unknown): string {
  return exitPlanModeInputSchema.parse(input).plan
}
