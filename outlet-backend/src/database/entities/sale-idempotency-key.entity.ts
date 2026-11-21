import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Client idempotency for `POST /sales` (PRD §6.2, §8.6): the same
 * `Idempotency-Key` with the same canonical request hash replays the stored
 * response (AT-07); the same key with a different payload is rejected with
 * 409 `IDEMPOTENCY_KEY_REUSED` (AT-08). Rows outlive the client retry horizon.
 */
@Entity({ name: 'sale_idempotency_keys' })
export class SaleIdempotencyKeyEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'key', type: 'text' })
  key!: string;

  /** SHA-256 over the canonicalized request lines + idempotency key. */
  @Column({ name: 'request_sha256', type: 'text' })
  requestSha256!: string;

  @Column({ name: 'sale_id', type: 'uuid' })
  saleId!: string;

  /** Serialized `SaleResponse` replayed verbatim on a duplicate POST. */
  @Column({ name: 'response_json', type: 'jsonb' })
  responseJson!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
