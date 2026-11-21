import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Local role (e.g. `OUTLET_MANAGER`, `OUTLET_CASHIER`, `OUTLET_INVENTORY_CLERK`). */
@Entity({ name: 'outlet_roles' })
export class OutletRoleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'code', type: 'text' })
  code!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
