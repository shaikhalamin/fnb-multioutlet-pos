import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type OutletStatus = 'ACTIVE' | 'SUSPENDED';

/** Physical outlet site; UNIQUE(company_id, code), status tombstones (PRD §6.1). */
@Entity({ name: 'outlets' })
export class OutletEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'code', type: 'text' })
  code!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  /** IANA zone, e.g. `Asia/Dhaka`; kept for business-day reporting (PRD §1.3). */
  @Column({ name: 'timezone', type: 'text' })
  timezone!: string;

  @Column({ name: 'status', type: 'text' })
  status!: OutletStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
