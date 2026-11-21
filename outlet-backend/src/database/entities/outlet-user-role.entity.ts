import { Entity, PrimaryColumn } from 'typeorm';

/** User ↔ role membership for local outlet identities (PRD §6.2). */
@Entity({ name: 'outlet_user_roles' })
export class OutletUserRoleEntity {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ name: 'role_id', type: 'uuid' })
  roleId!: string;
}
