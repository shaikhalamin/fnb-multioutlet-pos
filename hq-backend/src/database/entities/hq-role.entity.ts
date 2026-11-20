import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Named role bundle (e.g. HQ_SUPER_ADMIN); UNIQUE(company_id, code) (PRD §6.1). */
@Entity({ name: 'hq_roles' })
export class HqRoleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'code', type: 'text' })
  code!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
