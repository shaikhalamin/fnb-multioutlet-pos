import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Outlet permission catalog (dot-case codes, PRD §3, §9.3). */
@Entity({ name: 'outlet_permissions' })
export class OutletPermissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'code', type: 'text' })
  code!: string;

  @Column({ name: 'description', type: 'text' })
  description!: string;
}
