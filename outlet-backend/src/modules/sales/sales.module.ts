import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { ReceiptsModule } from '../receipts/receipts.module.js';
import { SalesController } from './sales.controller.js';
import { SalesRepository } from './sales.repository.js';
import { SalesService } from './sales.service.js';

/** Atomic idempotent local sales (PRD §7.3, §8.6). */
@Module({
  imports: [ReceiptsModule, OutboxModule],
  controllers: [SalesController],
  providers: [SalesRepository, SalesService],
})
export class SalesModule {}
