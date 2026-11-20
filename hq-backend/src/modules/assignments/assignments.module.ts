import { Module } from '@nestjs/common';
import { MenuModule } from '../menu/menu.module.js';
import { OutletsModule } from '../outlets/outlets.module.js';
import { AssignmentsController } from './assignments.controller.js';
import { AssignmentsRepository } from './assignments.repository.js';
import { AssignmentsService } from './assignments.service.js';

/** Assignment governance; reuses the menu module's change-log writer (§8.2). */
@Module({
  imports: [MenuModule, OutletsModule],
  controllers: [AssignmentsController],
  providers: [AssignmentsRepository, AssignmentsService],
})
export class AssignmentsModule {}
