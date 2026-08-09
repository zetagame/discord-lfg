export interface ActionAfterOptions {
  timeoutMs?: number;
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 750;
const DEFAULT_RETRIES = 2;

/**
 * Runs a side effect immediately after a successful write. Each attempt gets
 * its own abort signal and a short deadline; callers should pass the signal to
 * any network request so timed-out attempts cannot keep running in parallel.
 */
export async function actionAfter<T>(
  label: string,
  action: (signal: AbortSignal, attempt: number) => Promise<T>,
  options: ActionAfterOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([action(controller.signal, attempt), deadline]);
    } catch (error) {
      lastError = error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`${label} failed after ${retries + 1} attempts: ${detail}`);
}
