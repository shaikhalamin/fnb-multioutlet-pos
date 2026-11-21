import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { OutletKeyScope } from '../utils/outlet-key.js';

export const REQUIRE_KEY_SCOPES_KEY = 'fnb:requireKeyScopes';

/**
 * Declares the outlet-key scopes a machine sync route requires (PRD §7.4):
 * `menu.pull`, `events.push`, `status.write`. The `OutletKeyGuard` enforces
 * the intersection against the authenticated key record.
 */
export const RequireKeyScopes = (...scopes: readonly OutletKeyScope[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_KEY_SCOPES_KEY, scopes) as MethodDecorator & ClassDecorator;

/** Server-derived machine identity attached by `OutletKeyGuard` (§7.4). */
export type OutletKeyIdentity = {
  keyId: string;
  outletId: string;
  scopes: string[];
};

/**
 * Injects the authenticated outlet-key identity. The outlet scope comes ONLY
 * from the HQ key record — request bodies never influence it (PRD §3, §15).
 */
export const CurrentOutletKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OutletKeyIdentity => {
    const request = context.switchToHttp().getRequest<{ outletKey?: OutletKeyIdentity }>();
    if (!request.outletKey) {
      throw new Error('CurrentOutletKey used outside an OutletKey-guarded route');
    }
    return request.outletKey;
  },
);
