import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type HqUserStatus = 'ACTIVE' | 'DISABLED';

/**
 * HQ staff account. Email is unique case-insensitively per company
 * (`uq_hq_users_email` on `(company_id, lower(email))`); only the bcrypt
 * hash is ever stored (PRD §6.1, §9.1).
 */
@Entity({ name: 'hq_users' })
export class HqUserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'email', type: 'text' })
  email!: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ name: 'status', type: 'text' })
  status!: HqUserStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
