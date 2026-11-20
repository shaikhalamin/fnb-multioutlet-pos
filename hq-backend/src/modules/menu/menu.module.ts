import { Module } from '@nestjs/common';
import { CatalogChangesService } from './catalog-changes.service.js';
import { MenuController } from './menu.controller.js';
import { MenuRepository } from './menu.repository.js';
import { MenuService } from './menu.service.js';

/**
 * Master menu governance. Exports the change-log writer and the catalog read
 * repository shared with the assignments module (§8.2).
 */
@Module({
  controllers: [MenuController],
  providers: [MenuRepository, MenuService, CatalogChangesService],
  exports: [CatalogChangesService, MenuRepository],
})
export class MenuModule {}
