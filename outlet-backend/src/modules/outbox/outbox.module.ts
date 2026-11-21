import { Module } from '@nestjs/common';
import { OutboxRepository } from './outbox.repository.js';

/**
 * Transactional outbox (PRD §8.4–§8.6). Phase 2 owns the write path inside
 * the sale transaction and the read side for sync status; the dispatcher
 * worker lands in Phase 3.
 */
@Module({
  providers: [OutboxRepository],
  exports: [OutboxRepository],
})
export class OutboxModule {}
