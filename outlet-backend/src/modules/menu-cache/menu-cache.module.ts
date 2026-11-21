import { Module } from '@nestjs/common';
import { MenuCacheController } from './menu-cache.controller.js';
import { MenuCacheRepository } from './menu-cache.repository.js';
import { MenuCacheService } from './menu-cache.service.js';

/** Read-only local catalog cache for the POS (PRD §7.3 `GET /menu`). */
@Module({
  controllers: [MenuCacheController],
  providers: [MenuCacheRepository, MenuCacheService],
  exports: [MenuCacheRepository],
})
export class MenuCacheModule {}
