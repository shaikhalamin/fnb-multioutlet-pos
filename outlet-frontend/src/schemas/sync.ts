import { z } from 'zod'

/**
 * Extend-grace form (PRD §8.8). Mirrors the backend DTO bounds — hours 1–72,
 * reason 10–500 chars — but the backend re-validates authoritatively
 * (AGENTS §4.2); this schema is UX only.
 */
export const extendGraceFormSchema = z.object({
  hours: z.coerce
    .number({ error: 'Hours must be a number.' })
    .int('Whole hours only.')
    .min(1, 'At least 1 hour.')
    .max(72, 'At most 72 hours.'),
  reason: z
    .string()
    .trim()
    .min(10, 'A reason of at least 10 characters is audited with the override.')
    .max(500, 'Keep the reason under 500 characters.'),
})

export type ExtendGraceForm = z.infer<typeof extendGraceFormSchema>
