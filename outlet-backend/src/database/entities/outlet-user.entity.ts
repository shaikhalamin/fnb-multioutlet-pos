import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type OutletUserStatus = 'ACTIVE' | 'DISABLED';

/**
 * Local outlet staff account (PRD §6.2): outlet-only identity, never an HQ
 * token. Email is unique case-insensitively (`uq_outlet_users_email` on
 * `lower(email)`); only the bcrypt hash is ever stored (PRD §9.1).
 */
@Entity({ name: 'outlet_users' })
export class OutletUserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'email', type: 'text' })
  email!: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ name: 'status', type: 'text' })
  status!: OutletUserStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
