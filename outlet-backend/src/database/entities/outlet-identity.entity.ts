import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Singleton row describing this outlet's provisioned identity (PRD §6.2):
 * immutable local configuration seeded at provisioning and checked against
 * every worker event. The outlet never re-derives its identity from requests.
 */
@Entity({ name: 'outlet_identity' })
export class OutletIdentityEntity {
  /** UUID issued by HQ at provisioning; also the JWT `outletId` claim. */
  @PrimaryColumn({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'outlet_code', type: 'text' })
  outletCode!: string;

  /** Owning company UUID (HQ-side reference; no cross-database FK). */
  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'timezone', type: 'text' })
  timezone!: string;

  @Column({ name: 'currency_code', type: 'text' })
  currencyCode!: string;
}
