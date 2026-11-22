import { Injectable } from '@nestjs/common';
import { JsonLogger } from '../../../common/logging/logger.service.js';
import { HqSyncError } from '../clients/hq-sync.client.js';
// Value import (not `import type`): the class is an injection token.
import { MenuPullService } from '../services/menu-pull.service.js';

/**
 * Menu pull tick (PRD §13: ~30s while online): runs the pull+apply service.
 * Failures are logged and surfaced via `/sync/status` — never retried with
 * a stale checkpoint (AT-13: HTTP failure leaves the checkpoint untouched).
 * Before the terminal is paired with HQ the tick idles at info level
 * (`awaiting_provisioning`) instead of warning every interval.
 */
@Injectable()
export class MenuPullProcessor {
  private readonly logger = new JsonLogger('MenuPullWorker');

  constructor(private readonly menuPull: MenuPullService) {}

  async pull(): Promise<void> {
    try {
      const result = await this.menuPull.pullAndApply();
      if (result.applied > 0 || result.snapshotApplied) {
        this.logger.log('menu_pull_applied', { ...result });
      }
    } catch (error) {
      if (error instanceof HqSyncError && error.code === 'HQ_NOT_PROVISIONED') {
        this.logger.log('awaiting_provisioning', { hint: 'Pair this terminal via the setup wizard' });
      } else if (error instanceof HqSyncError) {
        this.logger.warn('menu_pull_failed', { code: error.code, status: error.status });
      } else {
        this.logger.warn('menu_pull_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
