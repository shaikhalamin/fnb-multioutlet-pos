/**
 * The wizard's confirmation once pairing succeeded. It stays up — signing in
 * is the operator's click, never a timed redirect — and answers the two
 * questions a first-run operator has next: which account, and what now.
 */

import { Link } from '@tanstack/react-router'
import type { RefObject } from 'react'
import { Check } from 'lucide-react'
import type { HqConnectionResponse } from '#/api/generated/types/HqConnectionResponse'
import { GUIDE_LIST, Ui } from '#/features/setup/SetupParts'
import type { IdentitySummary } from '#/features/setup/SetupParts'

export function DoneStep({
  headingRef,
  paired,
  identity,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>
  paired: HqConnectionResponse
  identity: IdentitySummary
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-success/10">
          <Check
            className="size-6 text-success"
            strokeWidth={2.5}
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0">
          <p className="kicker m-0 mb-1">Setup complete</p>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="m-0 font-display text-title-md text-ink"
          >
            Paired with HQ
          </h2>
        </div>
      </div>

      <p className="m-0 text-sm text-body">
        This register can now sync with HQ. Its menu usually arrives within a
        minute.
      </p>

      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Outlet</dt>
        <dd className="m-0 min-w-0 font-medium text-ink">
          {identity.outletCode ?? '—'}
          <span className="money block text-xs font-normal text-body">
            {paired.outletId}
          </span>
        </dd>
        <dt className="text-muted-foreground">Key ID</dt>
        <dd className="money m-0 min-w-0 font-medium text-ink">
          {paired.keyId}
        </dd>
        <dt className="text-muted-foreground">HQ address</dt>
        <dd className="m-0 min-w-0 font-medium break-all text-ink">
          {paired.hqApiBaseUrl}
        </dd>
        <dt className="text-muted-foreground">Sign in as</dt>
        <dd className="m-0 min-w-0 font-medium break-all text-ink">
          {identity.adminEmail ?? 'the admin account you created'}
        </dd>
      </dl>

      <div>
        <p className="kicker m-0 mb-2.5">What happens next</p>
        <ol className={GUIDE_LIST}>
          <li>Sign in with the admin account you just created.</li>
          <li>
            Add stock through <Ui>Inventory</Ui> once the menu has synced.
          </li>
          <li>
            Start selling from <Ui>POS</Ui>.
          </li>
        </ol>
      </div>

      <Link to="/login" className="btn-primary text-center no-underline">
        Sign in to the register
      </Link>
    </div>
  )
}
