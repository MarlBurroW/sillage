import { z } from 'zod'

export const antigravityAuthMethodSchema = z.enum(['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform'])
export type AntigravityAuthMethod = z.infer<typeof antigravityAuthMethodSchema>
export const antigravityAccountSchema = z.object({
  id: z.string(), label: z.string(), status: z.enum(['pending', 'ready']),
  authMode: antigravityAuthMethodSchema.nullable(), email: z.string().nullable(), plan: z.string().nullable(),
  createdAt: z.number(), updatedAt: z.number(),
})
export type AntigravityAccount = z.infer<typeof antigravityAccountSchema>
export const createAntigravityAccountBodySchema = z.object({ label: z.string().trim().min(1).max(60) })
export const updateAntigravityAccountBodySchema = createAntigravityAccountBodySchema
export const startAntigravityLoginBodySchema = z.object({
  method: antigravityAuthMethodSchema,
  apiKey: z.string().trim().min(1).max(4096).optional(),
  project: z.string().trim().max(256).optional(),
  location: z.string().trim().max(128).optional(),
}).superRefine((value, ctx) => {
  if (value.method === 'gemini-api-key' && !value.apiKey) ctx.addIssue({ code: 'custom', message: 'An API key is required.', path: ['apiKey'] })
  if ((value.method === 'oauth-business' || (value.method === 'agent-platform' && !value.apiKey)) && !value.project) ctx.addIssue({ code: 'custom', message: 'A Google Cloud project is required.', path: ['project'] })
})
export type StartAntigravityLogin = z.infer<typeof startAntigravityLoginBodySchema>
export interface AntigravityLoginStatusDto {
  state: 'idle' | 'pending' | 'done' | 'failed'
  verificationUrl: string | null
  error: string | null
}
export interface AntigravityAccountListDto { accounts: AntigravityAccount[] }
