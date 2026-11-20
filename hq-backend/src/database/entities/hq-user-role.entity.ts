import { Entity, PrimaryColumn } from 'typeorm';

/** User ↔ role mapping; composite PK keeps duplicates impossible (PRD §6.1). */
@Entity({ name: 'hq_user_roles' })
export class HqUserRoleEntity {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ name: 'role_id', type: 'uuid' })
  roleId!: string;
}
