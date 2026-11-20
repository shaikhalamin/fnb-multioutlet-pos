import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Stable dot-case permission code (`menu.write`, `reports.read`, …) (PRD §3, §9.3). */
@Entity({ name: 'hq_permissions' })
export class HqPermissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'code', type: 'text' })
  code!: string;

  @Column({ name: 'description', type: 'text' })
  description!: string;
}
