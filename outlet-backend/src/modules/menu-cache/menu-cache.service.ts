import { Injectable } from '@nestjs/common';
import { ApiException } from '../../common/exceptions/api.exception.js';
// Value import (not `import type`): the class is an injection token.
import { MenuCacheRepository, type MenuItemWithStock } from './menu-cache.repository.js';
import type { OutletMenuItemResponse } from './dto/menu.dto.js';

/**
 * Assembles the POS menu read (PRD §7.3): active local catalog with effective
 * prices plus the revision/sync metadata the POS banner and offline-grace UX
 * need. Read-only — catalog content itself is owned by the menu sync
 * (Phase 3), never mutated here.
 */
@Injectable()
export class MenuCacheService {
  constructor(private readonly menuCache: MenuCacheRepository) {}

  async getMenu(): Promise<{
    items: OutletMenuItemResponse[];
    catalogRevision: string;
    lastCatalogSyncAt: string;
  }> {
    const [items, syncState] = await Promise.all([
      this.menuCache.findActiveItemsWithStock(),
      this.menuCache.getSyncState(),
    ]);
    // Without a checkpoint the outlet has never completed a menu sync: the
    // sale path blocks with SYNC_TEMPORARILY_UNAVAILABLE; the menu read
    // reports revision 0 with no sync timestamp rather than inventing one.
    return {
      items: items.map(toMenuItemResponse),
      catalogRevision: syncState?.lastAppliedRevision ?? '0',
      lastCatalogSyncAt: (syncState?.lastSyncAt ?? new Date(0)).toISOString(),
    };
  }
}

function toMenuItemResponse(row: MenuItemWithStock): OutletMenuItemResponse {
  const quantity = Number(row.availableQuantity);
  if (!Number.isSafeInteger(quantity)) {
    throw new ApiException(
      'CONFLICT',
      'Catalog stock figure is out of representable range.',
      409,
      { menuItemId: row.menuItemId },
    );
  }
  return {
    menuItemId: row.menuItemId,
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    unitPriceMinor: row.effectivePriceMinor,
    currencyCode: row.currencyCode,
    availableQuantity: quantity,
  };
}
