import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { OutletPermission } from './permissions.js';

export const REQUIRE_PERMISSIONS_KEY = 'fnb:requirePermissions';

/**
 * Declares the permission(s) a route requires; every listed permission must
 * be held by the authenticated user (PRD §3, §9.3). Enforced by
 * `JwtAuthGuard` — services never re-derive permissions from the request.
 */
export const RequirePermissions = (...permissions: OutletPermission[]): CustomDecorator<string> =>
  SetMetadata(REQUIRE_PERMISSIONS_KEY, permissions);
