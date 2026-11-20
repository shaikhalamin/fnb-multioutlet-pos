import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { HealthController } from './health.controller.js';
import type { HealthReport, HealthService } from './health.service.js';

function makeService(report: HealthReport): HealthService {
  return {
    check: async () => report,
  } as unknown as HealthService;
}

describe('HealthController', () => {
  it('returns the report when all checks pass', async () => {
    const report: HealthReport = {
      status: 'ok',
      service: 'outlet-backend',
      version: '0.1.0',
      uptimeSeconds: 1,
      timestamp: new Date().toISOString(),
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    };
    const controller = new HealthController(makeService(report), {} as DataSource, {} as Redis);
    await expect(controller.getHealth()).resolves.toEqual(report);
  });

  it('throws a 503 SERVICE_UNAVAILABLE ApiException when a check is down', async () => {
    const report: HealthReport = {
      status: 'down',
      service: 'outlet-backend',
      version: '0.1.0',
      uptimeSeconds: 1,
      timestamp: new Date().toISOString(),
      checks: { database: { status: 'up' }, redis: { status: 'down', reason: 'refused' } },
    };
    const controller = new HealthController(makeService(report), {} as DataSource, {} as Redis);
    try {
      await controller.getHealth();
      expect.unreachable('should have thrown');
    } catch (error) {
      const apiError = error as ApiException;
      expect(apiError).toBeInstanceOf(ApiException);
      expect(apiError.getStatus()).toBe(503);
      expect(apiError.code).toBe('SERVICE_UNAVAILABLE');
      expect(apiError.details).toEqual({ checks: report.checks });
    }
  });
});
