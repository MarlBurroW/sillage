import { z } from 'zod'

/** Keep explicit agent titles useful in navigation without imposing a language-specific word count. */
export const MAX_SESSION_TITLE_CHARS = 60

export const renameSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(MAX_SESSION_TITLE_CHARS)
    .regex(/^[^\u0000-\u001f\u007f]+$/u, 'Use a single-line title without control characters.'),
}).strict()
