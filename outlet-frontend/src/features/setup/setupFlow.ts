import { z } from 'zod'
import { ApiError } from '#/api/axios'

/**
 * Validation and error copy for the first-run setup wizard (PRD §8.7
 * bootstrap, §9.2 secure provisioning channel): step 1 saves the HQ-issued
 * outlet ID + code and creates the first admin; step 2 pairs with HQ using
 * the one-time key issued in the HQ console.
 */

/** Pre-filled for the bundled Docker Compose network (README §4, step 4). */
export const DEFAULT_HQ_API_BASE_URL = 'http://hq-api:3000/api/v1'

export const identitySchema = z.object({
  outletId: z
    .string()
    .uuid(
      'Paste the Outlet ID from HQ — it looks like 11111111-1111-4111-8111-111111111111.',
    ),
  outletCode: z
    .string()
    .min(1, 'Enter the outlet code from HQ (up to 8 characters).')
    .max(8, 'The outlet code is at most 8 characters.'),
  adminEmail: z
    .string()
    .email(
      'Enter a valid email — you will use it to sign in to this register.',
    ),
  adminPassword: z
    .string()
    .min(8, 'Use at least 8 characters.')
    .max(128, 'Use at most 128 characters.'),
})

export const connectionSchema = z.object({
  hqApiBaseUrl: z
    .string()
    .url(
      'Enter the API URL HQ is reachable at, e.g. https://hq.example.com/api/v1.',
    ),
  keyId: z
    .string()
    .min(8, 'Paste the Key ID from HQ — it starts with ok_.')
    .max(128, 'The Key ID is at most 128 characters.'),
  keySecret: z
    .string()
    .min(16, 'Paste the Key secret shown once by HQ.')
    .max(256, 'The Key secret is at most 256 characters.'),
})

export type IdentityForm = z.infer<typeof identitySchema>
export type ConnectionForm = z.infer<typeof connectionSchema>

/** Field key → message shown under that field. */
export type FieldMessages = Partial<Record<string, string>>

/** Schema issues → one message per field (the first issue per field wins). */
export function fieldMessagesOf(error: {
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>
    message: string
  }>
}): FieldMessages {
  const messages: FieldMessages = {}
  for (const issue of error.issues) {
    const key = issue.path[0]
    if (typeof key === 'string' && messages[key] === undefined) {
      messages[key] = issue.message
    }
  }
  return messages
}

/**
 * The HQ console presents a key as two separate values, each with its own
 * copy button. A combined `keyId.secret` string is still accepted if one
 * lands in a single field: key IDs are `ok_<env>_<hex>` and secrets are
 * base64url, so a dot can only come from that form and the first dot splits
 * it exactly.
 */
export function splitCombinedKey(
  value: string,
): { keyId: string; keySecret: string } | null {
  const trimmed = value.trim()
  const dot = trimmed.indexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1) return null
  return { keyId: trimmed.slice(0, dot), keySecret: trimmed.slice(dot + 1) }
}

/**
 * A combined key that ended up in one field (pasted, dropped or typed there)
 * is split before it is sent — the two separate fields are what HQ expects.
 */
export function splitConnectionKey(form: ConnectionForm): ConnectionForm {
  const fromKeyId = form.keySecret ? null : splitCombinedKey(form.keyId)
  const fromSecret = form.keyId ? null : splitCombinedKey(form.keySecret)
  const combined = fromKeyId ?? fromSecret
  return combined
    ? { ...form, keyId: combined.keyId, keySecret: combined.keySecret }
    : form
}

/**
 * How long each part of a step change takes, in milliseconds. A step that
 * just succeeded stays up so its button can confirm the save, then fades out
 * before the next step fades in.
 */
export const STEP_CHANGE = {
  /** The finished step stays on screen with its confirmation — long enough
   * for the connector sweep and for the scroll back to the stepper to land. */
  confirmMs: 600,
  /** The finished step fades out before the next step appears. */
  exitMs: 150,
} as const

/** How a failed setup request is explained to the operator. */
export type SetupFailure = {
  /** The cause, in one line. */
  title: string
  /** How to fix it. */
  fix: string
  /** Field-level messages to show inline. */
  fields?: FieldMessages
  /** Open the HQ address field — the address is the likely cause. */
  showHqAddress?: boolean
  /** The server is at a different step than the wizard shows: re-read it. */
  resync?: boolean
  requestId?: string
}

type FailureContext = {
  step: 'identity' | 'connection'
  outletCode: string | null
}

const CHECK_KEY_VALUE = 'Check this against the one-time key card in HQ.'

/**
 * The HQ console path to this outlet's key panel — where key problems are
 * fixed — written the same way the step's guide shows it.
 */
function hqKeyPath(outletCode: string | null): string {
  const outlet = outletCode ? `Outlet ${outletCode}` : 'this outlet'
  return `In HQ, go to Outlets → ${outlet} → Settings → Outlet sync keys → Issue new key`
}

/** `details.errors` of a `VALIDATION_FAILED` response → field messages. */
function serverFieldMessages(
  details: Record<string, unknown> | undefined,
): FieldMessages | undefined {
  if (!details || !Array.isArray(details.errors)) return undefined
  const messages: FieldMessages = {}
  for (const entry of details.errors) {
    if (
      entry &&
      typeof entry === 'object' &&
      'path' in entry &&
      'message' in entry &&
      typeof entry.path === 'string' &&
      typeof entry.message === 'string'
    ) {
      messages[entry.path] ??= entry.message
    }
  }
  return Object.keys(messages).length > 0 ? messages : undefined
}

/**
 * Stable backend error codes (PRD §12) → what went wrong and where to fix it.
 * Every pairing refusal points back to the HQ console panel that issues keys.
 */
export function describeFailure(
  cause: unknown,
  context: FailureContext,
): SetupFailure {
  if (!(cause instanceof ApiError)) {
    return {
      title: 'Setup failed',
      fix: 'Nothing was saved. Try again.',
    }
  }

  const { step, outletCode } = context
  const requestId = cause.requestId

  // The backend tags the cross-outlet refusal with the key's real outlet
  // (details.keyOutletId) — it has a different fix than a plain rejection.
  if (
    cause.code === 'UNAUTHENTICATED' &&
    cause.details &&
    'keyOutletId' in cause.details
  ) {
    return {
      requestId,
      title: 'This key was issued for a different outlet',
      fix: `${hqKeyPath(outletCode)}. HQ refuses a key that belongs to another outlet.`,
      fields: { keyId: CHECK_KEY_VALUE, keySecret: CHECK_KEY_VALUE },
    }
  }

  switch (cause.code) {
    case 'UNAUTHENTICATED':
      return {
        requestId,
        title: 'HQ rejected this key',
        fix: `${hqKeyPath(outletCode)}, then copy the Key ID and the Key secret from the one-time card — the secret is shown only once.`,
        fields: { keyId: CHECK_KEY_VALUE, keySecret: CHECK_KEY_VALUE },
      }
    case 'SYNC_TEMPORARILY_UNAVAILABLE':
      return {
        requestId,
        title: "HQ can't be reached",
        fix: 'Nothing was saved. If HQ runs at another address, update the HQ address below — otherwise check that HQ is up, then try again.',
        showHqAddress: true,
      }
    case 'FORBIDDEN':
      return step === 'identity'
        ? {
            requestId,
            title: "This register's identity is already saved",
            fix: 'Continuing to the next step.',
            resync: true,
          }
        : {
            requestId,
            title: 'This register is already paired with HQ',
            fix: 'Taking you to sign-in.',
            resync: true,
          }
    case 'CONFLICT':
      return {
        requestId,
        title: 'Save the outlet identity first',
        fix: 'Returning to step 1.',
        resync: true,
      }
    case 'RATE_LIMITED':
      return {
        requestId,
        title: 'Too many attempts',
        fix: 'Wait a minute, then try again.',
      }
    case 'VALIDATION_FAILED':
      return {
        requestId,
        title: 'Check the highlighted fields',
        fix: 'This register rejected some of the values you entered.',
        fields: serverFieldMessages(cause.details),
      }
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
      return {
        requestId,
        title: "This register's backend didn't answer",
        fix: 'Check that the outlet backend is running, then try again. Nothing was saved.',
      }
    default:
      return { requestId, title: 'Setup failed', fix: cause.message }
  }
}
