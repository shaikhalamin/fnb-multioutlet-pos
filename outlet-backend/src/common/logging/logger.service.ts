import { type LogLevel } from '@nestjs/common';
import { SERVICE_NAME, SERVICE_VERSION } from '../../config/app.config.js';
import { getRequestId } from './request-context.js';

type JsonRecord = Record<string, unknown>;

type LoggerLevel = Exclude<LogLevel, never>;

const LEVEL_WEIGHT: Record<LoggerLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  log: 30,
  debug: 20,
  verbose: 10,
};

const LEVEL_LABEL: Record<LoggerLevel, string> = {
  fatal: 'fatal',
  error: 'error',
  warn: 'warn',
  log: 'info',
  debug: 'debug',
  verbose: 'trace',
};

/**
 * Structured JSON logger (PRD §13): one JSON object per line with `time`,
 * `level`, `service`, `context` and — inside a request — `requestId`.
 * Development keeps a compact human-readable line instead.
 */
export class JsonLogger {
  private minWeight: number = LEVEL_WEIGHT.log;
  private readonly base: JsonRecord;

  constructor(
    private readonly defaultContext: string = SERVICE_NAME,
    base: JsonRecord = {},
    private readonly pretty: boolean = process.env.NODE_ENV !== 'production',
  ) {
    this.base = { service: SERVICE_NAME, version: SERVICE_VERSION, ...base };
  }

  setMinLevel(level: LoggerLevel): void {
    this.minWeight = LEVEL_WEIGHT[level];
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.write('log', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('verbose', message, rest);
  }

  private write(level: LoggerLevel, message: unknown, rest: unknown[]): void {
    if (LEVEL_WEIGHT[level] < this.minWeight) return;

    let context: string | undefined;
    let stack: string | undefined;
    const meta: JsonRecord = {};

    for (const param of rest) {
      if (typeof param === 'string') {
        // NestJS passes (message, stack?, context?) for errors and
        // (message, context) otherwise.
        if (level === 'error' && stack === undefined && param.includes('\n')) {
          stack = param;
        } else {
          context ??= param;
        }
      } else if (param !== null && param !== undefined) {
        Object.assign(meta, param);
      }
    }

    const record: JsonRecord = {
      time: new Date().toISOString(),
      level: LEVEL_LABEL[level],
      ...this.base,
      context: context ?? this.defaultContext,
      requestId: getRequestId(),
      msg: typeof message === 'string' ? message : String(message),
      ...(stack ? { stack } : {}),
      ...meta,
    };
    if (record.requestId === undefined) delete record.requestId;

    const line = this.pretty
      ? `${String(record.level).padEnd(5)} [${String(record.context)}] ${String(record.msg)}${
          Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
        }`
      : JSON.stringify(record);

    if (level === 'error' || level === 'fatal') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}
