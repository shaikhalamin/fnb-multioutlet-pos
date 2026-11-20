import { z } from 'zod'

/**
 * Build-time public configuration (PRD §14.1): no machine secrets, only the
 * API base URL the browser talks to (same-origin via the frontend's Nginx
 * reverse proxy by default). Validated with Zod so a broken build env fails
 * loudly instead of producing a client that calls the wrong origin.
 */
const envSchema = z.object({
  VITE_API_BASE_URL: z.string().min(1).default('/api/v1'),
})

const parsed = envSchema.safeParse(import.meta.env)

if (!parsed.success) {
  throw new Error(
    `Invalid frontend environment: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')}`,
  )
}

export const env = parsed.data
