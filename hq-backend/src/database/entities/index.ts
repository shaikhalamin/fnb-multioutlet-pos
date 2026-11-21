export { CompanyEntity } from './company.entity.js';
export { OutletEntity, type OutletStatus } from './outlet.entity.js';
export { HqUserEntity, type HqUserStatus } from './hq-user.entity.js';
export { HqRoleEntity } from './hq-role.entity.js';
export { HqPermissionEntity } from './hq-permission.entity.js';
export { HqUserRoleEntity } from './hq-user-role.entity.js';
export { HqRolePermissionEntity } from './hq-role-permission.entity.js';
export {
  HqRefreshSessionEntity,
} from './hq-refresh-session.entity.js';
export { MenuCategoryEntity, type MenuCategoryStatus } from './menu-category.entity.js';
export {
  MasterMenuItemEntity,
  type MasterMenuItemStatus,
} from './master-menu-item.entity.js';
export { OutletMenuAssignmentEntity } from './outlet-menu-assignment.entity.js';
export { OutletCatalogRevisionEntity } from './outlet-catalog-revision.entity.js';
export {
  OutletCatalogChangeEntity,
  type CatalogChangeAction,
} from './outlet-catalog-change.entity.js';
export { OutletApiKeyEntity, type OutletApiKeyStatus } from './outlet-api-key.entity.js';
export { AuditLogEntity, type AuditActorType } from './audit-log.entity.js';
export { SyncInboxEventEntity } from './sync-inbox-event.entity.js';
export { HqSaleEntity } from './hq-sale.entity.js';
export { HqSaleItemEntity } from './hq-sale-item.entity.js';
export { SyncOutletCheckpointEntity } from './sync-outlet-checkpoint.entity.js';

import { CompanyEntity } from './company.entity.js';
import { OutletEntity } from './outlet.entity.js';
import { HqUserEntity } from './hq-user.entity.js';
import { HqRoleEntity } from './hq-role.entity.js';
import { HqPermissionEntity } from './hq-permission.entity.js';
import { HqUserRoleEntity } from './hq-user-role.entity.js';
import { HqRolePermissionEntity } from './hq-role-permission.entity.js';
import { HqRefreshSessionEntity } from './hq-refresh-session.entity.js';
import { MenuCategoryEntity } from './menu-category.entity.js';
import { MasterMenuItemEntity } from './master-menu-item.entity.js';
import { OutletMenuAssignmentEntity } from './outlet-menu-assignment.entity.js';
import { OutletCatalogRevisionEntity } from './outlet-catalog-revision.entity.js';
import { OutletCatalogChangeEntity } from './outlet-catalog-change.entity.js';
import { OutletApiKeyEntity } from './outlet-api-key.entity.js';
import { AuditLogEntity } from './audit-log.entity.js';
import { SyncInboxEventEntity } from './sync-inbox-event.entity.js';
import { HqSaleEntity } from './hq-sale.entity.js';
import { HqSaleItemEntity } from './hq-sale-item.entity.js';
import { SyncOutletCheckpointEntity } from './sync-outlet-checkpoint.entity.js';

/** Every HQ TypeORM entity, registered on the shared DataSource (PRD §6.1). */
export const hqEntities = [
  CompanyEntity,
  OutletEntity,
  HqUserEntity,
  HqRoleEntity,
  HqPermissionEntity,
  HqUserRoleEntity,
  HqRolePermissionEntity,
  HqRefreshSessionEntity,
  MenuCategoryEntity,
  MasterMenuItemEntity,
  OutletMenuAssignmentEntity,
  OutletCatalogRevisionEntity,
  OutletCatalogChangeEntity,
  OutletApiKeyEntity,
  AuditLogEntity,
  SyncInboxEventEntity,
  HqSaleEntity,
  HqSaleItemEntity,
  SyncOutletCheckpointEntity,
];
