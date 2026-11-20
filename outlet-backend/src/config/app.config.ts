import { parseApiEnv, type ApiEnv } from './env.schema.js';

export const SERVICE_NAME = 'outlet-backend' as const;
export const SERVICE_VERSION = '0.1.0' as const;
export const API_PREFIX = 'api/v1' as const;

export type AppConfig = {
  serviceName: typeof SERVICE_NAME;
  version: typeof SERVICE_VERSION;
  nodeEnv: ApiEnv['NODE_ENV'];
  isProduction: boolean;
  port: number;
  apiPrefix: string;
  logLevel: ApiEnv['LOG_LEVEL'];
  corsOrigins: string[];
  swaggerEnabled: boolean;
  openApiExport: boolean;
  outletId: string;
  outletCode: string;
  offlineGraceHours: number;
  syncMaxBodyBytes: number;
};

export function loadAppConfig(env: ApiEnv = parseApiEnv()): AppConfig {
  return {
    serviceName: SERVICE_NAME,
    version: SERVICE_VERSION,
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    apiPrefix: API_PREFIX,
    logLevel: env.LOG_LEVEL,
    corsOrigins: env.CORS_ORIGINS,
    swaggerEnabled: env.SWAGGER_ENABLED,
    openApiExport: env.OPENAPI_EXPORT,
    outletId: env.OUTLET_ID,
    outletCode: env.OUTLET_CODE,
    offlineGraceHours: env.OFFLINE_GRACE_HOURS,
    syncMaxBodyBytes: env.SYNC_MAX_BODY_BYTES,
  };
}
