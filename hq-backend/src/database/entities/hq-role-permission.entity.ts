import { Entity, PrimaryColumn } from 'typeorm';

/** Role ↔ permission mapping; composite PK keeps duplicates impossible (PRD §6.1). */
@Entity({ name: 'hq_role_permissions' })
export class HqRolePermissionEntity {
  @PrimaryColumn({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @PrimaryColumn({ name: 'permission_id', type: 'uuid' })
  permissionId!: string;
}
