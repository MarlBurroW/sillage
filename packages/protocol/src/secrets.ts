import { z } from 'zod'

/**
 * Instance secret store.
 *
 * Secrets are written once and never read back through the API: routes return only names and
 * dates. Unlike a simple configuration field, this requires replacement rather than correction,
 * since the UI cannot show the current value.
 *
 * Values are decrypted only server-side when launching a runner, for MCP server environment
 * variables or headers. They never cross the WebSocket or journal.
 */

/**
 * Names identify secrets in `{{secret.NOM}}`: accepted characters must work in a pattern
 * without escaping or ambiguous token boundaries.
 */
export const secretNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]+$/)

/** What the API returns for a secret: everything except its value. */
export const secretSchema = z.object({
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /**
   * Where this secret is used, calculated on read.
   *
   * Otherwise deleting a secret is a gamble: nothing indicates that an MCP server depends on
   * it, and failure appears only at the next launch.
   */
  usedBy: z.array(z.string()).default([]),
})
export type Secret = z.infer<typeof secretSchema>

export const putSecretBodySchema = z.object({
  name: secretNameSchema,
  value: z.string().min(1),
})

export interface SecretListDto {
  secrets: Secret[]
}

/** Substitution pattern recognized in environment and header values. */
const SECRET_PATTERN = /\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}/g

/** Secret names referenced in text, deduplicated in reading order. */
export function referencedSecrets(text: string): string[] {
  return [...new Set([...text.matchAll(SECRET_PATTERN)].map((match) => match[1] as string))]
}

/**
 * Replaces patterns with values.
 *
 * `resolve` returns `undefined` for missing secrets, leaving callers to decide what to do.
 * Here, substitute nothing and report the missing name: silently emptying an authentication
 * header would cause a remote error disconnected from its cause.
 */
export function applySecrets(
  text: string,
  resolve: (name: string) => string | undefined,
): { text: string; missing: string[] } {
  const missing: string[] = []
  const out = text.replace(SECRET_PATTERN, (whole, name: string) => {
    const value = resolve(name)
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return value
  })
  return { text: out, missing }
}
