import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ApiException } from '../exceptions/api.exception.js';
import { outletKeySecretMatches, type OutletKeyScope } from '../utils/outlet-key.js';
import type { Env } from '../../config/env.schema.js';
import { AuditService } from '../../modules/audit/audit.service.js';
import { ApiKeysRepository } from '../../modules/api-keys/api-keys.repository.js';
import type { OutletKeyIdentity } from './require-key-scopes.decorator.js';
import { REQUIRE_KEY_SCOPES_KEY } from './require-key-scopes.decorator.js';

declare module 'express' {
  interface Request {
    outletKey?: OutletKeyIdentity;
  }
}

/** `Authorization: OutletKey <keyId>.<secret>` (PRD §7.4, §9.2). */
function parseOutletKeyHeader(header: string): { keyId: string; secret: string } | null {
  const scheme = 'OutletKey ';
  if (!header.startsWith(scheme)) return null;
  const token = header.slice(scheme.length).trim();
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  return { keyId: token.slice(0, dot), secret: token.slice(dot + 1) };
}

/**
 * Machine-key authentication for the `/sync/v1` surface (PRD §7.4, §9.2).
 * Module-scoped — applied with `@UseGuards(OutletKeyGuard)` on the sync
 * controllers only; human JWT routes never pass through it (and vice versa).
 *
 * The outlet identity is derived exclusively from the HQ key record; the
 * secret is verified in constant time against the peppered HMAC, and every
 * authentication failure leaves an audit row (repeated failures feed AT-16
 * evidence). `last_used_at` is refreshed non-blocking on success.
 */
@Injectable()
export class OutletKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly keys: ApiKeysRepository,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const parsed = parseOutletKeyHeader(request.headers?.authorization ?? '');

    if (!parsed) {
      await this.auditAuthFailure('malformed_authorization', null);
      throw new ApiException('UNAUTHENTICATED', 'Missing or malformed outlet key credentials.', 401);
    }
    const { keyId, secret } = parsed;

    const key = await this.keys.findByKeyId(keyId);
    if (!key) {
      await this.auditAuthFailure('unknown_key', keyId);
      throw new ApiException('UNAUTHENTICATED', 'Outlet key not recognized.', 401);
    }
    if (key.status !== 'ACTIVE') {
      await this.auditAuthFailure('key_revoked', keyId);
      throw new ApiException('UNAUTHENTICATED', 'Outlet key is no longer active.', 401);
    }
    if (key.expiresAt !== null && key.expiresAt.getTime() <= Date.now()) {
      // Includes predecessors whose rotation overlap window has elapsed.
      await this.auditAuthFailure('key_expired', keyId);
      throw new ApiException('UNAUTHENTICATED', 'Outlet key has expired; rotate to the current key.', 401);
    }
    if (!outletKeySecretMatches(secret, key.secretHash, this.config.get('OUTLET_KEY_PEPPER', { infer: true }))) {
      await this.auditAuthFailure('secret_mismatch', keyId);
      throw new ApiException('UNAUTHENTICATED', 'Outlet key verification failed.', 401);
    }

    const required = this.reflector.getAllAndOverride<OutletKeyScope[]>(REQUIRE_KEY_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0) {
      const held = new Set(key.scopes);
      const missing = required.filter((scope) => !held.has(scope));
      if (missing.length > 0) {
        await this.auditAuthFailure('scope_missing', keyId, { missingScopes: missing });
        throw new ApiException('FORBIDDEN', 'The outlet key lacks a required scope for this route.', 403, {
          requiredScopes: required,
        });
      }
    }

    request.outletKey = { keyId: key.keyId, outletId: key.outletId, scopes: key.scopes };
    // Non-blocking liveness signal for rotation confirmation (PRD §9.2).
    this.keys.touchLastUsed(key.id);
    return true;
  }

  private async auditAuthFailure(reason: string, keyId: string | null, extra?: Record<string, unknown>): Promise<void> {
    await this.audit.record({
      actorType: 'OUTLET_KEY',
      actorId: null,
      action: 'outlet_key.auth_failed',
      metadata: { reason, keyId, ...extra },
    });
  }
}
