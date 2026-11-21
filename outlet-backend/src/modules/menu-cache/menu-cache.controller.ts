import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { withMeta } from '../../common/interceptors/envelope.interceptor.js';
import { OutletMenuItemResponse } from './dto/menu.dto.js';
import { MenuCacheService } from './menu-cache.service.js';

/**
 * Local POS menu read (PRD §7.3): active, locally assigned items with
 * effective prices, annotated with the catalog revision and last sync time
 * in the envelope meta.
 */
@ApiTags('Menu')
@ApiSecurity('bearer-jwt')
@Controller()
export class MenuCacheController {
  constructor(private readonly menuCacheService: MenuCacheService) {}

  @Get('menu')
  @RequirePermissions('menu.read')
  @ApiOperation({ summary: 'Active local menu with effective prices and stock.' })
  @ApiOkResponse({ type: [OutletMenuItemResponse] })
  async getMenu(): Promise<OutletMenuItemResponse[]> {
    const menu = await this.menuCacheService.getMenu();
    return withMeta(menu.items, {
      catalogRevision: menu.catalogRevision,
      lastCatalogSyncAt: menu.lastCatalogSyncAt,
    });
  }
}
