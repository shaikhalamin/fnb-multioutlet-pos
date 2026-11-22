import { Injectable } from '@nestjs/common';
import { ApiException } from '../../common/exceptions/api.exception.js';
import type { OutletIdentityEntity } from '../../database/entities/outlet-identity.entity.js';
import { IdentityRepository } from './identity.repository.js';

/**
 * Runtime outlet-identity reads (PRD §3, §6.2): this database belongs to
 * exactly one outlet whose identity is provisioned once (setup wizard or
 * dev seed) and then immutable. Every consumer that used to read the env
 * `OUTLET_ID` resolves it here instead — identity still never comes from
 * request JSON.
 */
@Injectable()
export class IdentityService {
  constructor(private readonly repository: IdentityRepository) {}

  async findIdentity(): Promise<OutletIdentityEntity | null> {
    return this.repository.findIdentity();
  }

  /** Identity or a 409 — callers are authenticated surfaces where absence means setup is incomplete. */
  async requireIdentity(): Promise<OutletIdentityEntity> {
    const identity = await this.repository.findIdentity();
    if (!identity) {
      throw new ApiException(
        'CONFLICT',
        'This terminal is not provisioned yet. Complete setup first.',
        409,
      );
    }
    return identity;
  }
}
