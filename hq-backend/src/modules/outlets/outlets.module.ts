import { Module } from '@nestjs/common';
import { OutletsController } from './outlets.controller.js';
import { OutletsRepository } from './outlets.repository.js';
import { OutletsService } from './outlets.service.js';

@Module({
  controllers: [OutletsController],
  providers: [OutletsRepository, OutletsService],
  exports: [OutletsRepository],
})
export class OutletsModule {}
