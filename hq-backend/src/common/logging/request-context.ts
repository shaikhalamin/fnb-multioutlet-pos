import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context propagated through async continuations so every log
 * line inside a request can carry its `requestId` (PRD §13).
 */
export interface RequestContext {
  requestId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
