import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, UpdateResult } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { HqRefreshSessionEntity } from '../../database/entities/hq-refresh-session.entity.js';

/**
 * Refresh-token session store (PRD §6.1, §9.1). One row per refresh JWT `jti`.
 * Rotation is a compare-and-swap on `rotated_at` — the winner mints the
 * successor row in the same family; a loser (or any later re-presentation of
 * a rotated token) revokes the whole family.
 */
@Injectable()
export class RefreshSessionRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async findByJti(jti: string): Promise<HqRefreshSessionEntity | null> {
    return this.dataSource.getRepository(HqRefreshSessionEntity).findOne({ where: { jti } });
  }

  async insert(session: {
    userId: string;
    familyId: string;
    jti: string;
    expiresAt: Date;
  }): Promise<HqRefreshSessionEntity> {
    return this.dataSource.getRepository(HqRefreshSessionEntity).save(
      this.dataSource.getRepository(HqRefreshSessionEntity).create({
        userId: session.userId,
        familyId: session.familyId,
        jti: session.jti,
        expiresAt: session.expiresAt,
        revokedAt: null,
        rotatedAt: null,
      }),
    );
  }

  /** CAS step of the rotation: succeeds exactly once per session row. */
  async markRotated(id: string): Promise<boolean> {
    const result: UpdateResult = await this.dataSource
      .getRepository(HqRefreshSessionEntity)
      .createQueryBuilder()
      .update()
      .set({ rotatedAt: new Date() })
      .where('id = :id AND revoked_at IS NULL AND rotated_at IS NULL', { id })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async revokeFamily(familyId: string): Promise<number> {
    const result = await this.dataSource
      .getRepository(HqRefreshSessionEntity)
      .createQueryBuilder()
      .update()
      .set({ revokedAt: new Date() })
      .where('family_id = :familyId AND revoked_at IS NULL', { familyId })
      .execute();
    return result.affected ?? 0;
  }
}
