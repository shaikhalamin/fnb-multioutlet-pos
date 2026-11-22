import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Singleton row describing this outlet's provisioned identity (PRD §6.2):
 * immutable local configuration written once at provisioning (setup wizard
 * or dev seed) and checked against every worker event. The outlet never
 * re-derives its identity from requests. The informational columns are
 * nullable because wizard provisioning knows only the HQ-issued ID and
 * code; currency is backfilled from the first menu pull.
 */
@Entity({ name: 'outlet_identity' })
export class OutletIdentityEntity {
  /** UUID issued by HQ at provisioning; also the JWT `outletId` claim. */
  @PrimaryColumn({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'outlet_code', type: 'text' })
  outletCode!: string;

  /** Owning company UUID (HQ-side reference; no cross-database FK). */
  @Column({ name: 'company_id', type: 'uuid', nullable: true })
  companyId!: string | null;

  @Column({ name: 'timezone', type: 'text', nullable: true })
  timezone!: string | null;

  @Column({ name: 'currency_code', type: 'text', nullable: true })
  currencyCode!: string | null;
}
