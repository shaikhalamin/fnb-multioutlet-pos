import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import {
  generateOutletKeyId,
  generateOutletKeySecret,
  hashOutletKeySecret,
  OUTLET_KEY_SCOPES,
} from '../../common/utils/outlet-key.js';
import { resolveCompanyId } from '../../common/utils/company.js';
import type { Env } from '../../config/env.schema.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { AuditService } from '../audit/audit.service.js';
import { OutletsRepository } from '../outlets/outlets.repository.js';
import type {
  IssueOutletKeyResponse,
  OutletApiKeyResponse,
} from './dto/api-key.dto.js';
import { ApiKeysRepository } from './api-keys.repository.js';

/**
 * Outlet key lifecycle (PRD FR-10, §9.2): issue (secret revealed once),
 * rotate with a bounded overlap window on the predecessor, revoke. Secrets
 * exist in plaintext only in the issuance response — never in storage, logs
 * or list endpoints.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly keys: ApiKeysRepository,
    private readonly outlets: OutletsRepository,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async issue(
    outletId: string,
    request: { expiresInHours?: number; scopes?: string[] },
    actor: { type: 'USER' | 'SYSTEM'; id: string | null; via?: string },
  ): Promise<IssueOutletKeyResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const outlet = await this.outlets.findById(companyId, outletId);
    if (!outlet) throw new ApiException('NOT_FOUND', 'Outlet not found.', 404);

    const secret = generateOutletKeySecret();
    const keyId = generateOutletKeyId(this.config.get('NODE_ENV', { infer: true }));
    const scopes = request.scopes && request.scopes.length > 0 ? request.scopes : [...OUTLET_KEY_SCOPES];
    const expiresAt = request.expiresInHours
      ? new Date(Date.now() + request.expiresInHours * 3_600_000)
      : null;

    const created = await this.dataSource.transaction(async (manager) => {
      const row = await this.keys.insert(manager, {
        keyId,
        outletId,
        secretHash: hashOutletKeySecret(secret, this.pepper()),
        scopes,
        expiresAt,
        rotatedFromId: null,
      });
      await this.audit.record(
        {
          actorType: actor.type,
          actorId: actor.id,
          action: 'outlet_key.issued',
          entityType: 'outlet_api_key',
          entityId: row.id,
          metadata: { outletId, keyId, scopes, ...(actor.via ? { via: actor.via } : {}) },
        },
        manager,
      );
      return row;
    });

    return {
      keyId: created.keyId,
      secret,
      scopes: created.scopes,
      expiresAt: created.expiresAt?.toISOString() ?? null,
      outletId,
      rotatedFromKeyId: null,
    };
  }

  async rotate(
    outletId: string,
    keyId: string,
    request: { graceHours?: number },
    actorId: string,
  ): Promise<IssueOutletKeyResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const outlet = await this.outlets.findById(companyId, outletId);
    if (!outlet) throw new ApiException('NOT_FOUND', 'Outlet not found.', 404);

    const predecessor = await this.keys.findByKeyId(keyId);
    if (!predecessor || predecessor.outletId !== outletId) {
      throw new ApiException('NOT_FOUND', 'API key not found for this outlet.', 404);
    }
    if (predecessor.status !== 'ACTIVE') {
      throw new ApiException('CONFLICT', 'Only ACTIVE keys can be rotated.', 409, { keyId });
    }

    const graceHours =
      request.graceHours ?? this.config.get('KEY_ROTATION_GRACE_HOURS', { infer: true });
    const secret = generateOutletKeySecret();
    const newKeyId = generateOutletKeyId(this.config.get('NODE_ENV', { infer: true }));

    const created = await this.dataSource.transaction(async (manager) => {
      const row = await this.keys.insert(manager, {
        keyId: newKeyId,
        outletId,
        secretHash: hashOutletKeySecret(secret, this.pepper()),
        scopes: predecessor.scopes,
        expiresAt: null,
        rotatedFromId: predecessor.id,
      });
      // Bounded overlap: the predecessor keeps working only until the grace
      // window elapses (PRD §9.2), then the Phase 3 guard drops it on expiry.
      // Same transaction as the successor insert: if the insert rolls back,
      // the predecessor must keep its unbounded validity (AGENTS §3.4).
      await this.keys.setExpiry(
        manager,
        predecessor.id,
        new Date(Date.now() + graceHours * 3_600_000),
      );
      await this.audit.record(
        {
          actorType: 'USER',
          actorId,
          action: 'outlet_key.rotated',
          entityType: 'outlet_api_key',
          entityId: row.id,
          metadata: { outletId, newKeyId, predecessorKeyId: keyId, graceHours },
        },
        manager,
      );
      return row;
    });

    return {
      keyId: created.keyId,
      secret,
      scopes: created.scopes,
      expiresAt: null,
      outletId,
      rotatedFromKeyId: keyId,
    };
  }

  async revoke(outletId: string, keyId: string, actorId: string): Promise<void> {
    const key = await this.keys.findByKeyId(keyId);
    if (!key || key.outletId !== outletId) {
      throw new ApiException('NOT_FOUND', 'API key not found for this outlet.', 404);
    }
    if (key.status === 'REVOKED') return; // idempotent

    await this.dataSource.transaction(async (manager) => {
      await this.keys.revoke(manager, key.id);
      await this.audit.record(
        {
          actorType: 'USER',
          actorId,
          action: 'outlet_key.revoked',
          entityType: 'outlet_api_key',
          entityId: key.id,
          metadata: { outletId, keyId },
        },
        manager,
      );
    });
  }

  async list(outletId: string): Promise<OutletApiKeyResponse[]> {
    const companyId = await resolveCompanyId(this.dataSource);
    const outlet = await this.outlets.findById(companyId, outletId);
    if (!outlet) throw new ApiException('NOT_FOUND', 'Outlet not found.', 404);
    const rows = await this.keys.listByOutlet(outletId);
    const keyIds = new Map(rows.map((row) => [row.id, row.keyId]));
    return rows.map((row) => ({
      id: row.id,
      keyId: row.keyId,
      outletId: row.outletId,
      scopes: row.scopes,
      status: row.status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      rotatedFromKeyId: row.rotatedFromId ? (keyIds.get(row.rotatedFromId) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private pepper(): string {
    return this.config.get('OUTLET_KEY_PEPPER', { infer: true });
  }
}
