import { Entity, PrimaryColumn } from 'typeorm';

/** Role → permission grant for local outlet roles (PRD §6.2). */
@Entity({ name: 'outlet_role_permissions' })
export class OutletRolePermissionEntity {
  @PrimaryColumn({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @PrimaryColumn({ name: 'permission_id', type: 'uuid' })
  permissionId!: string;
}
