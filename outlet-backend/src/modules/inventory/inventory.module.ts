import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';
import { InventoryRepository } from './inventory.repository.js';
import { InventoryService } from './inventory.service.js';

/** Local inventory balances + audited adjustments (PRD §7.3). */
@Module({
  controllers: [InventoryController],
  providers: [InventoryRepository, InventoryService],
  exports: [InventoryRepository],
})
export class InventoryModule {}
