export interface ActionAfterOptions {
  timeoutMs?: number;
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRIES = 2;

export class PermanentActionError extends Error {}

export class RetryableActionError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) {
    super(message);
  }
}

/**
 * Runs a side effect immediately after a successful write. Each attempt gets
 * its own abort signal and deadline; callers should pass the signal to network
 * requests so timed-out attempts cannot keep running beside their retries.
 */
export async function actionAfter<T>(
  label: string,
  action: (signal: AbortSignal, attempt: number) => Promise<T>,
  options: ActionAfterOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  let lastError: unknown;
  let attempts = 0;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    attempts = attempt;
    const controller = new AbortController();
    const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError);
      }, timeoutMs);
    });

    try {
      return await Promise.race([action(controller.signal, attempt), deadline]);
    } catch (error) {
      lastError = timedOut ? timeoutError : error;
      if (error instanceof PermanentActionError) break;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (attempt <= retries && lastError instanceof RetryableActionError && lastError.retryAfterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, lastError.retryAfterMs));
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`${label} failed after ${attempts} attempts: ${detail}`);
}
