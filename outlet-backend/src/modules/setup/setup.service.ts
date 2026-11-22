import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutletAuditService } from '../audit/outlet-audit.service.js';
// Value imports (not `import type`): classes are injection tokens.
import { HqCredentialChecker } from '../sync/clients/hq-credential-checker.js';
import { IdentityRepository, type HqConnectionValues } from '../identity/identity.repository.js';
// Value import (not `import type`): the class is an injection token.
import { IdentityService } from '../identity/identity.service.js';
import type {
  CreateOutletIdentityRequest,
  HqConnectionResponse,
  SaveHqConnectionRequest,
  SetupIdentityResponse,
  SetupStatusResponse,
} from './dto/setup.dto.js';
import { ensureCounters, ensurePermissionsAndRoles, ensureSyncState, ensureUserWithRoles } from './provisioning.js';

/**
 * First-run provisioning service (PRD §8.7 bootstrap, §9.2 secure
 * provisioning channel): the setup wizard writes this terminal's HQ-issued
 * identity (step 1) and HQ machine credentials (step 2). Both endpoints are
 * open ONLY while unprovisioned and seal permanently once their row exists;
 * later credential changes go through the authenticated sync surface.
 *
 * The HQ key is validated live BEFORE anything is saved, and the key's
 * outlet (HQ derives it from the key record, PRD §7.4) must match this
 * terminal's identity — a key minted for another outlet is refused.
 */
@Injectable()
export class SetupService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly identities: IdentityRepository,
    private readonly identity: IdentityService,
    private readonly checker: HqCredentialChecker,
    private readonly audit: OutletAuditService,
  ) {}

  async getStatus(): Promise<SetupStatusResponse> {
    const [identity, connection] = await Promise.all([
      this.identities.findIdentity(),
      this.identities.findConnection(),
    ]);
    return {
      identity: identity !== null,
      hqConnection: connection !== null,
      provisioned: identity !== null && connection !== null,
      outletId: identity?.outletId ?? null,
      outletCode: identity?.outletCode ?? null,
      lastValidatedAt: connection?.lastValidatedAt.toISOString() ?? null,
    };
  }

  /**
   * Step 1 — terminal identity: ONE transaction writes the identity row,
   * permission catalog + default roles, the first admin account, receipt
   * and outbox counters, and the sync checkpoint (revision 0). A crash
   * anywhere leaves no half-provisioned terminal.
   */
  async createIdentity(request: CreateOutletIdentityRequest): Promise<SetupIdentityResponse> {
    if (await this.identities.findIdentity()) {
      throw new ApiException(
        'FORBIDDEN',
        'Outlet identity is already provisioned; setup is sealed.',
        403,
      );
    }

    const adminEmail = request.adminEmail.toLowerCase();
    await this.dataSource.transaction(async (manager) => {
      await this.identities.insertIdentity(manager, {
        outletId: request.outletId,
        outletCode: request.outletCode,
      });
      const roleIds = await ensurePermissionsAndRoles(manager);
      const managerRoleId = roleIds.get('OUTLET_MANAGER');
      if (!managerRoleId) {
        throw new Error('OUTLET_MANAGER role missing from the default role catalog');
      }
      await ensureUserWithRoles(manager, {
        email: adminEmail,
        password: request.adminPassword,
        roleId: managerRoleId,
      });
      await ensureCounters(manager, request.outletId, request.outletCode);
      await ensureSyncState(manager, request.outletId, '0');
      await this.audit.record(
        {
          actorType: 'SYSTEM',
          action: 'setup.identity_provisioned',
          entityId: request.outletId,
          // The admin password hash/secret never appears here — email only.
          metadata: { outletCode: request.outletCode, adminEmail },
        },
        manager,
      );
    });

    return { outletId: request.outletId, outletCode: request.outletCode, adminEmail };
  }

  /**
   * Step 2 — pair with HQ: validate the candidate credentials live, then
   * save. Sealed once a connection row exists.
   */
  async saveHqConnection(request: SaveHqConnectionRequest): Promise<HqConnectionResponse> {
    const identity = await this.identities.findIdentity();
    if (!identity) {
      throw new ApiException(
        'CONFLICT',
        'Provision the outlet identity (setup step 1) before pairing with HQ.',
        409,
      );
    }
    if (await this.identities.findConnection()) {
      throw new ApiException(
        'FORBIDDEN',
        'HQ connection is already paired; rotate the key via Sync settings.',
        403,
      );
    }
    return this.validateAndPersist(request, identity, 'insert', {
      actorType: 'SYSTEM',
      action: 'setup.hq_connection_paired',
      entityId: identity.outletId,
    });
  }

  /**
   * Authenticated rotation path (PRD FR-10 switch-worker-secret step): the
   * same live validation, replacing the stored credentials without restart.
   */
  async updateHqConnection(
    request: SaveHqConnectionRequest,
    actor: { id: string; email: string },
  ): Promise<HqConnectionResponse> {
    const identity = await this.identity.requireIdentity();
    if (!(await this.identities.findConnection())) {
      throw new ApiException(
        'CONFLICT',
        'No HQ connection to update; pair the terminal from the setup wizard first.',
        409,
      );
    }
    return this.validateAndPersist(request, identity, 'replace', {
      actorType: 'USER',
      actorId: actor.id,
      action: 'sync.hq_connection_updated',
      entityId: identity.outletId,
      metadata: { actorEmail: actor.email },
    });
  }

  private async validateAndPersist(
    request: SaveHqConnectionRequest,
    identity: { outletId: string },
    mode: 'insert' | 'replace',
    auditEvent: {
      actorType: 'USER' | 'SYSTEM';
      actorId?: string;
      action: string;
      entityId: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<HqConnectionResponse> {
    const check = await this.checker.check({
      hqApiBaseUrl: request.hqApiBaseUrl,
      keyId: request.keyId,
      keySecret: request.keySecret,
    });
    if (!check.ok) {
      if (check.kind === 'REJECTED') {
        throw new ApiException(
          'UNAUTHENTICATED',
          'HQ rejected this key — check the key ID and one-time secret.',
          401,
        );
      }
      throw new ApiException(
        'SYNC_TEMPORARILY_UNAVAILABLE',
        'HQ is unreachable at that URL; nothing was saved.',
        503,
      );
    }
    // The key must belong to THIS terminal: HQ derives outletId from the key
    // record (PRD §7.4) — a key minted for another outlet is refused outright.
    if (check.outletId !== identity.outletId) {
      throw new ApiException(
        'UNAUTHENTICATED',
        'This key belongs to a different outlet; pairing refused.',
        401,
        { keyOutletId: check.outletId, outletId: identity.outletId },
      );
    }

    const validatedAt = new Date();
    await this.dataSource.transaction(async (manager) => {
      const values: HqConnectionValues = {
        outletId: identity.outletId,
        hqBaseUrl: request.hqApiBaseUrl,
        keyId: request.keyId,
        keySecret: request.keySecret,
        lastValidatedAt: validatedAt,
      };
      if (mode === 'replace') {
        await this.identities.replaceConnection(manager, values);
      } else {
        await this.identities.insertConnection(manager, values);
      }
      // The key secret never appears in audit metadata — keyId only.
      await this.audit.record(
        {
          ...auditEvent,
          metadata: {
            ...auditEvent.metadata,
            hqApiBaseUrl: request.hqApiBaseUrl,
            keyId: request.keyId,
            validatedAt: validatedAt.toISOString(),
          },
        },
        manager,
      );
    });

    return {
      outletId: identity.outletId,
      hqApiBaseUrl: request.hqApiBaseUrl,
      keyId: request.keyId,
      lastValidatedAt: validatedAt.toISOString(),
      highestContiguousSequence: check.highestContiguousSequence,
    };
  }
}
