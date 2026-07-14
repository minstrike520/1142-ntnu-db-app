/**
 * The single non-native polling helper sanctioned by issue #316.
 *
 * Replaces `vi.waitFor`. Polls `check` on a fixed interval until it stops
 * throwing (assertion passes) or the timeout elapses, at which point the last
 * assertion error is re-thrown. Used by the E2E socket suites where an event
 * has to propagate across the socket boundary before an assertion can hold.
 */
export interface WaitForOptions {
  /** Total time to keep retrying before giving up. Default 1000ms. */
  timeout?: number;
  /** Delay between attempts. Default 10ms. */
  interval?: number;
}

export async function waitFor(
  check: () => void | Promise<void>,
  { timeout = 1000, interval = 10 }: WaitForOptions = {},
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeout) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  throw lastError ?? new Error(`waitFor: condition not met within ${timeout}ms`);
}
