import { Module } from '@nestjs/common';
import { OutletsModule } from '../outlets/outlets.module.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysRepository } from './api-keys.repository.js';
import { ApiKeysService } from './api-keys.service.js';

@Module({
  imports: [OutletsModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysRepository, ApiKeysService],
})
export class ApiKeysModule {}
