/**
 * Reject with a labelled error after `ms`. The input promise gets a no-op
 * catch attached so a late rejection after a lost race cannot surface as an
 * unhandled rejection.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  void promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
