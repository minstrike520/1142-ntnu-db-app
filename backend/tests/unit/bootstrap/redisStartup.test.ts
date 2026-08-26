import { describe, it, expect } from 'bun:test';
import path from 'path';

const backendRoot = path.resolve(__dirname, '../../..');

/**
 * What a Redis outage does to the *process*, which no in-process test can show.
 *
 * The manager's own unit tests prove that `connect()` resolves and that every
 * operation degrades instead of throwing. Neither proves the thing a deployment
 * actually depends on: that `src/index.ts` still reaches the listening state
 * with Redis unreachable, and still terminates on SIGTERM afterwards. Both are
 * properties of a real process — an unhandled rejection or a retained
 * event-loop handle is invisible to an assertion inside the same process — so,
 * as in `models/dbBootstrap.test.ts` and `config/startupExit.test.ts`, this runs
 * a subprocess.
 *
 * The second half is not hypothetical. Closing a Bun Redis connection that is
 * still in subscriber mode leaves a handle behind and the process then never
 * exits on its own; `utils/redis.ts` unsubscribes before closing precisely so
 * that a container shuts down instead of waiting to be SIGKILLed.
 */

/** Parsable, and refused instantly — loopback port 1, so no DNS and no waiting. */
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';

/** Bun's SQL client connects lazily, so an unreachable host opens no socket. */
const UNREACHABLE_DB = 'postgresql://app@database-not-reachable-in-test:5432/appdb';

const spawnServer = (extra: Record<string, string | undefined>) => {
  const childEnv: Record<string, string> = {};
  const base = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: UNREACHABLE_DB,
    DATABASE_URL_TEST: undefined,
    JWT_SECRET: 'startup-test-secret',
    // A port of its own, so a developer's running stack does not collide.
    PORT: '4599',
    LOG_LEVEL: 'info',
    ...extra,
  };
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) childEnv[key] = value;
  }

  return Bun.spawn(['bun', 'src/index.ts'], {
    cwd: backendRoot,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
};

/** Collect output until `marker` shows up, or give up after `timeoutMs`. */
const waitForOutput = async (
  stream: ReadableStream<Uint8Array>,
  marker: string,
  timeoutMs: number,
): Promise<{ found: boolean; output: string }> => {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => 'timeout' as const),
      ]);
      if (next === 'timeout') break;
      if (next.done) break;
      output += decoder.decode(next.value, { stream: true });
      if (output.includes(marker)) return { found: true, output };
    }
  } finally {
    reader.releaseLock();
  }
  return { found: false, output };
};

describe('startup with Redis unreachable', () => {
  it('still listens, and still shuts down cleanly on SIGTERM', async () => {
    const server = spawnServer({ REDIS_URL: UNREACHABLE_REDIS });

    try {
      const { found, output } = await waitForOutput(server.stdout, 'successfully listening', 15_000);

      // Redis holds derived state only. A process that refused to serve any REST
      // route because a presence store is down would be strictly worse than one
      // running with realtime degraded — and the compose healthcheck gates on
      // this line's endpoint answering, so the container would never go healthy.
      expect(found).toBe(true);
      expect(output).not.toInclude('ECONNREFUSED\n    at');
      expect(server.killed).toBe(false);

      server.kill('SIGTERM');
      const exitCode = await Promise.race([
        server.exited,
        Bun.sleep(15_000).then(() => 'still-running' as const),
      ]);

      // Not merely "exits": exits without needing SIGKILL. A Redis teardown that
      // hangs would hold a deployment open until the orchestrator gives up.
      expect(exitCode).toBe(0);
    } finally {
      server.kill('SIGKILL');
    }
  }, 40_000);

  it('starts with no REDIS_URL at all', async () => {
    const server = spawnServer({ REDIS_URL: undefined });

    try {
      const { found, output } = await waitForOutput(server.stdout, 'successfully listening', 15_000);

      expect(found).toBe(true);
      // Not configured is a supported deployment, not a misconfiguration, so it
      // is reported once and never treated as an error.
      expect(output).toInclude('REDIS_URL is not configured');

      server.kill('SIGTERM');
      expect(
        await Promise.race([
          server.exited,
          Bun.sleep(15_000).then(() => 'still-running' as const),
        ]),
      ).toBe(0);
    } finally {
      server.kill('SIGKILL');
    }
  }, 40_000);
});
