import { Module } from '@nestjs/common';
import { ReceiptCounterRepository } from './receipt-counter.repository.js';

/** Receipt counter allocation shared by the sale transaction (PRD §6.2). */
@Module({
  providers: [ReceiptCounterRepository],
  exports: [ReceiptCounterRepository],
})
export class ReceiptsModule {}
