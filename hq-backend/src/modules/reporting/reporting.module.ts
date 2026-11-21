import { Module } from '@nestjs/common';
import { ReportingController } from './reporting.controller.js';
import { ReportingRepository } from './reporting.repository.js';
import { ReportingService } from './reporting.service.js';

@Module({
  controllers: [ReportingController],
  providers: [ReportingRepository, ReportingService],
})
export class ReportingModule {}
