import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { resolveCompanyId } from '../../common/utils/company.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { AuditService } from '../audit/audit.service.js';
import type { CreateOutletRequest, UpdateOutletRequest } from './dto/outlet.dto.js';
import type { OutletResponse } from './dto/outlet.dto.js';
import { OutletsRepository } from './outlets.repository.js';

/**
 * Outlet provisioning (PRD §7.2, FR-02 prerequisite). Codes are unique per
 * company; every new outlet immediately owns a revision-0 catalog row so
 * assignment fan-out always has a lock target (§8.2).
 */
@Injectable()
export class OutletsService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly outlets: OutletsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<OutletResponse[]> {
    const companyId = await resolveCompanyId(this.dataSource);
    const outlets = await this.outlets.list(companyId);
    return outlets.map(toOutletResponse);
  }

  async create(request: CreateOutletRequest, actorId: string): Promise<OutletResponse> {
    const companyId = await resolveCompanyId(this.dataSource);

    const duplicate = await this.outlets.findByCode(companyId, request.code);
    if (duplicate) {
      throw new ApiException('CONFLICT', 'An outlet with this code already exists.', 409, {
        code: request.code,
      });
    }
    this.assertValidTimeZone(request.timezone);

    const outlet = await this.outlets.insertOutlet({ companyId, ...request });
    await this.audit.record({
      actorType: 'USER',
      actorId,
      action: 'outlet.created',
      entityType: 'outlet',
      entityId: outlet.id,
      metadata: { code: outlet.code, name: outlet.name, timezone: outlet.timezone },
    });
    return toOutletResponse(outlet);
  }

  async update(outletId: string, request: UpdateOutletRequest, actorId: string): Promise<OutletResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const outlet = await this.outlets.findById(companyId, outletId);
    if (!outlet) {
      throw new ApiException('NOT_FOUND', 'Outlet not found.', 404);
    }
    await this.outlets.update(outletId, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.status !== undefined ? { status: request.status } : {}),
    });
    await this.audit.record({
      actorType: 'USER',
      actorId,
      action: 'outlet.updated',
      entityType: 'outlet',
      entityId: outletId,
      metadata: { name: request.name, status: request.status },
    });
    const updated = await this.outlets.findById(companyId, outletId);
    return toOutletResponse(updated ?? outlet);
  }

  private assertValidTimeZone(timezone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new ApiException('UNPROCESSABLE_ENTITY', 'Unknown IANA time zone.', 422, { timezone });
    }
  }
}

function toOutletResponse(outlet: {
  id: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
  catalogRevision: string;
  createdAt: Date;
}): OutletResponse {
  return {
    id: outlet.id,
    code: outlet.code,
    name: outlet.name,
    timezone: outlet.timezone,
    status: outlet.status,
    catalogRevision: outlet.catalogRevision,
    createdAt: outlet.createdAt.toISOString(),
  };
}
