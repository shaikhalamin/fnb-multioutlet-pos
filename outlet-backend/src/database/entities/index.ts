export { OutletIdentityEntity } from './outlet-identity.entity.js';
export { HqConnectionEntity } from './hq-connection.entity.js';
export { OutletUserEntity, type OutletUserStatus } from './outlet-user.entity.js';
export { OutletRoleEntity } from './outlet-role.entity.js';
export { OutletPermissionEntity } from './outlet-permission.entity.js';
export { OutletUserRoleEntity } from './outlet-user-role.entity.js';
export { OutletRolePermissionEntity } from './outlet-role-permission.entity.js';
export { OutletRefreshSessionEntity } from './outlet-refresh-session.entity.js';
export { CatalogItemEntity } from './catalog-item.entity.js';
export { MenuSyncStateEntity } from './menu-sync-state.entity.js';
export { InventoryBalanceEntity } from './inventory-balance.entity.js';
export {
  StockMovementEntity,
  type StockMovementReason,
} from './stock-movement.entity.js';
export { ReceiptCounterEntity } from './receipt-counter.entity.js';
export { SaleEntity, type SaleStatus } from './sale.entity.js';
export { SaleItemEntity } from './sale-item.entity.js';
export { SaleIdempotencyKeyEntity } from './sale-idempotency-key.entity.js';
export { OutboxCounterEntity } from './outbox-counter.entity.js';
export { OutboxEventEntity, type OutboxStatus } from './outbox-event.entity.js';
export { SyncAttemptLogEntity } from './sync-attempt-log.entity.js';
export { OutletAuditLogEntity, type OutletAuditActorType } from './outlet-audit-log.entity.js';

import { OutletIdentityEntity } from './outlet-identity.entity.js';
import { HqConnectionEntity } from './hq-connection.entity.js';
import { OutletUserEntity } from './outlet-user.entity.js';
import { OutletRoleEntity } from './outlet-role.entity.js';
import { OutletPermissionEntity } from './outlet-permission.entity.js';
import { OutletUserRoleEntity } from './outlet-user-role.entity.js';
import { OutletRolePermissionEntity } from './outlet-role-permission.entity.js';
import { OutletRefreshSessionEntity } from './outlet-refresh-session.entity.js';
import { CatalogItemEntity } from './catalog-item.entity.js';
import { MenuSyncStateEntity } from './menu-sync-state.entity.js';
import { InventoryBalanceEntity } from './inventory-balance.entity.js';
import { StockMovementEntity } from './stock-movement.entity.js';
import { ReceiptCounterEntity } from './receipt-counter.entity.js';
import { SaleEntity } from './sale.entity.js';
import { SaleItemEntity } from './sale-item.entity.js';
import { SaleIdempotencyKeyEntity } from './sale-idempotency-key.entity.js';
import { OutboxCounterEntity } from './outbox-counter.entity.js';
import { OutboxEventEntity } from './outbox-event.entity.js';
import { SyncAttemptLogEntity } from './sync-attempt-log.entity.js';
import { OutletAuditLogEntity } from './outlet-audit-log.entity.js';

/**
 * Every outlet TypeORM entity, registered on the shared DataSource
 * (PRD §6.2).
 */
export const outletEntities = [
  OutletIdentityEntity,
  HqConnectionEntity,
  OutletUserEntity,
  OutletRoleEntity,
  OutletPermissionEntity,
  OutletUserRoleEntity,
  OutletRolePermissionEntity,
  OutletRefreshSessionEntity,
  CatalogItemEntity,
  MenuSyncStateEntity,
  InventoryBalanceEntity,
  StockMovementEntity,
  ReceiptCounterEntity,
  SaleEntity,
  SaleItemEntity,
  SaleIdempotencyKeyEntity,
  OutboxCounterEntity,
  OutboxEventEntity,
  SyncAttemptLogEntity,
  OutletAuditLogEntity,
];
