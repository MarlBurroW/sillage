import { z } from 'zod'
import type {
  McpElicitationPrimitiveSchema,
  McpElicitationSchema,
  McpServerElicitationAction,
} from '@sillage/codex-bindings/v2'

/**
 * Élicitations MCP : un serveur MCP réclame une saisie à l'utilisateur.
 *
 * Les deux CLI transportent la même chose, parce que ni l'un ni l'autre ne l'a
 * inventée : c'est `elicitation/create` du protocole MCP. Claude passe le
 * `requestedSchema` tel quel (`Record<string, unknown>`), Codex le type, mais les deux
 * décrivent le même JSON Schema plat. L'analyseur ci-dessous est donc partagé, et il
 * n'appartient à aucun des deux adaptateurs.
 *
 * La réponse est identique des deux côtés : une action, plus un contenu quand elle
 * vaut `accept`.
 */

export const elicitationActionSchema = z.enum(['accept', 'decline', 'cancel'])
export type ElicitationAction = z.infer<typeof elicitationActionSchema>

/** Valeurs qu'une réponse peut porter, telles que MCP les autorise. */
export const elicitationValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
])
export type ElicitationValue = z.infer<typeof elicitationValueSchema>

export const elicitationContentSchema = z.record(z.string(), elicitationValueSchema)

/** Un choix proposé, avec son libellé affiché. */
export const elicitationOptionSchema = z.object({ value: z.string(), label: z.string() })

const fieldBase = {
  /** Clé du champ dans l'objet de réponse. */
  name: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  required: z.boolean(),
}

/**
 * Champ normalisé. Le JSON Schema de MCP est plat et limité à des primitives : cinq
 * formes suffisent à le couvrir, ce qui évite d'embarquer un moteur de formulaire
 * générique pour rendre trois champs.
 */
export const elicitationFieldSchema = z.discriminatedUnion('kind', [
  z.object({
    ...fieldBase,
    kind: z.literal('text'),
    /** `email`, `uri`, `date`, `date-time`. Décide du type d'input HTML. */
    format: z.string().nullable(),
    minLength: z.number().nullable(),
    maxLength: z.number().nullable(),
    default: z.string().nullable(),
  }),
  z.object({
    ...fieldBase,
    kind: z.literal('number'),
    integer: z.boolean(),
    minimum: z.number().nullable(),
    maximum: z.number().nullable(),
    default: z.number().nullable(),
  }),
  z.object({
    ...fieldBase,
    kind: z.literal('boolean'),
    default: z.boolean(),
  }),
  z.object({
    ...fieldBase,
    kind: z.literal('select'),
    options: z.array(elicitationOptionSchema),
    default: z.string().nullable(),
  }),
  z.object({
    ...fieldBase,
    kind: z.literal('multiselect'),
    options: z.array(elicitationOptionSchema),
    minItems: z.number().nullable(),
    maxItems: z.number().nullable(),
    default: z.array(z.string()),
  }),
])
export type ElicitationField = z.infer<typeof elicitationFieldSchema>

/**
 * Bornes de cardinalité.
 *
 * ts-rs traduit les `u64` de Codex en `bigint`, alors que JSON ne transporte que des
 * nombres ordinaires. Les deux formes sont donc acceptées puis ramenées à un nombre :
 * n'accepter que `number` ferait échouer l'assertion de dérive plus bas, et n'accepter
 * que `bigint` ne correspondrait à rien de ce qui transite réellement.
 */
const countSchema = z
  .union([z.number(), z.bigint()])
  .transform((value) => Number(value))
  .optional()

const commonSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
})

/** Choix unique dont les libellés sont distincts des valeurs (`oneOf` de const/title). */
const titledSelectSchema = commonSchema.extend({
  type: z.literal('string'),
  oneOf: z.array(z.object({ const: z.string(), title: z.string() })),
  default: z.string().optional(),
})

/** Choix unique en `enum`, avec les libellés facultatifs de l'ancien format. */
const plainSelectSchema = commonSchema.extend({
  type: z.literal('string'),
  enum: z.array(z.string()),
  enumNames: z.array(z.string()).optional(),
  default: z.string().optional(),
})

const multiSelectSchema = commonSchema.extend({
  type: z.literal('array'),
  minItems: countSchema,
  maxItems: countSchema,
  items: z.union([
    z.object({ anyOf: z.array(z.object({ const: z.string(), title: z.string() })) }),
    z.object({ type: z.literal('string'), enum: z.array(z.string()) }),
  ]),
  default: z.array(z.string()).optional(),
})

const textSchema = commonSchema.extend({
  type: z.literal('string'),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  format: z.string().optional(),
  default: z.string().optional(),
})

const numberSchema = commonSchema.extend({
  type: z.enum(['number', 'integer']),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  default: z.number().optional(),
})

const booleanSchema = commonSchema.extend({
  type: z.literal('boolean'),
  default: z.boolean().optional(),
})

const formSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
})

/**
 * Garde-fous de compilation contre les bindings générés par le binaire Codex.
 *
 * Le schéma de formulaire ci-dessus décrit MCP, pas Codex, mais Codex en est la seule
 * source typée dont on dispose : si `pnpm codex:types` fait apparaître une variante que
 * l'analyseur ne saurait pas lire, ou renomme une action, ces alias cassent le
 * typecheck plutôt que de laisser un champ disparaître en silence de l'affichage.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type AssertTrue<T extends true> = T

export type ElicitationActionMatchesProtocol = AssertTrue<
  Exactly<ElicitationAction, McpServerElicitationAction>
>
export type ElicitationFormParsable = AssertTrue<
  McpElicitationSchema extends z.input<typeof formSchema> ? true : false
>
/** Chaque variante de champ doit trouver preneur dans l'une des formes ci-dessus. */
export type ElicitationFieldParsable = AssertTrue<
  McpElicitationPrimitiveSchema extends
    | z.input<typeof titledSelectSchema>
    | z.input<typeof plainSelectSchema>
    | z.input<typeof multiSelectSchema>
    | z.input<typeof textSchema>
    | z.input<typeof numberSchema>
    | z.input<typeof booleanSchema>
    ? true
    : false
>

/** Un nom de champ vaut mieux qu'un intitulé vide quand le serveur n'en donne pas. */
function labelFor(name: string, title: string | undefined): string {
  return title && title.length > 0 ? title : name
}

function toField(name: string, required: boolean, raw: unknown): ElicitationField | null {
  const base = { name, required, description: null as string | null }

  // Ordre significatif : un choix est aussi une chaîne, donc les variantes énumérées
  // doivent être essayées avant le texte libre, sinon elles seraient rendues en input.
  const titled = titledSelectSchema.safeParse(raw)
  if (titled.success) {
    return {
      ...base,
      kind: 'select',
      label: labelFor(name, titled.data.title),
      description: titled.data.description ?? null,
      options: titled.data.oneOf.map((entry) => ({ value: entry.const, label: entry.title })),
      default: titled.data.default ?? null,
    }
  }

  const plain = plainSelectSchema.safeParse(raw)
  if (plain.success) {
    return {
      ...base,
      kind: 'select',
      label: labelFor(name, plain.data.title),
      description: plain.data.description ?? null,
      options: plain.data.enum.map((value, index) => ({
        value,
        // `enumNames` est positionnel : un tableau plus court laisse les derniers
        // choix affichés par leur valeur brute, ce qui reste lisible.
        label: plain.data.enumNames?.[index] ?? value,
      })),
      default: plain.data.default ?? null,
    }
  }

  const multi = multiSelectSchema.safeParse(raw)
  if (multi.success) {
    const items = multi.data.items
    return {
      ...base,
      kind: 'multiselect',
      label: labelFor(name, multi.data.title),
      description: multi.data.description ?? null,
      options:
        'anyOf' in items
          ? items.anyOf.map((entry) => ({ value: entry.const, label: entry.title }))
          : items.enum.map((value) => ({ value, label: value })),
      minItems: multi.data.minItems ?? null,
      maxItems: multi.data.maxItems ?? null,
      default: multi.data.default ?? [],
    }
  }

  const bool = booleanSchema.safeParse(raw)
  if (bool.success) {
    return {
      ...base,
      kind: 'boolean',
      label: labelFor(name, bool.data.title),
      description: bool.data.description ?? null,
      default: bool.data.default ?? false,
    }
  }

  const num = numberSchema.safeParse(raw)
  if (num.success) {
    return {
      ...base,
      kind: 'number',
      label: labelFor(name, num.data.title),
      description: num.data.description ?? null,
      integer: num.data.type === 'integer',
      minimum: num.data.minimum ?? null,
      maximum: num.data.maximum ?? null,
      default: num.data.default ?? null,
    }
  }

  const text = textSchema.safeParse(raw)
  if (text.success) {
    return {
      ...base,
      kind: 'text',
      label: labelFor(name, text.data.title),
      description: text.data.description ?? null,
      format: text.data.format ?? null,
      minLength: text.data.minLength ?? null,
      maxLength: text.data.maxLength ?? null,
      default: text.data.default ?? null,
    }
  }

  // Type inconnu : le champ est ignoré plutôt que rendu au hasard. L'utilisateur peut
  // toujours refuser l'élicitation, et un champ mal deviné produirait une réponse
  // fausse que le serveur MCP accepterait sans le savoir.
  return null
}

/**
 * Champs d'un formulaire d'élicitation, à partir du `requestedSchema` brut.
 *
 * Tolérant par construction : un schéma illisible donne une liste vide, ce qui affiche
 * le message et les seuls boutons d'action. Codex accepte aussi un mode `openai/form`
 * dont le schéma n'est pas typé par le protocole, et qui passe par le même chemin.
 */
export function parseElicitationFields(requestedSchema: unknown): ElicitationField[] {
  const form = formSchema.safeParse(requestedSchema)
  if (!form.success) return []

  const required = new Set(form.data.required ?? [])
  const fields: ElicitationField[] = []

  for (const [name, raw] of Object.entries(form.data.properties)) {
    const field = toField(name, required.has(name), raw)
    if (field) fields.push(field)
  }

  return fields
}
