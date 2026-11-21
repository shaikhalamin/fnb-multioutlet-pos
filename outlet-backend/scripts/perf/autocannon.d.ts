/**
 * Minimal ambient typings for autocannon@8 (it ships no .d.ts). Covers only
 * the surface `sale-load.ts` uses.
 */
declare module 'autocannon' {
  export interface AutocannonRequestSpec {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
    setupRequest?: (
      request: AutocannonRequestSpec,
      context: Record<string, unknown>,
    ) => AutocannonRequestSpec;
    /** autocannon@8 emits `(client, statusCode, resBytes, responseTime)`. */
    onResponse?: (
      client: unknown,
      statusCode: number,
      resBytes: number,
      responseTime: number,
    ) => void;
  }

  export interface AutocannonOptions {
    url: string;
    connections?: number;
    duration?: number;
    overallRate?: number;
    timeout?: number;
    method?: string;
    headers?: Record<string, string>;
    requests?: AutocannonRequestSpec[];
    ignoreCoordinatedOmission?: boolean;
  }

  export interface AutocannonResult {
    duration: number;
    latency: { average: number; mean: number; min: number; max: number; stddev: number } & Record<
      string,
      number
    >;
    requests: { average: number; mean: number; total: number; rate: number; sent: number };
    errors: number;
    timeouts: number;
    non2xx: number;
    statusCodes: Record<string, number>;
  }

  interface AutocannonInstance extends NodeJS.EventEmitter {
    stop(): void;
  }

  function autocannon(options: AutocannonOptions): AutocannonInstance & Promise<AutocannonResult>;

  export = autocannon;
}
