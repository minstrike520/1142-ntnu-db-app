import { randomUUID } from 'crypto';
import { env } from '../config/env';

/**
 * The slice of configuration the assembly stages pass between each other.
 *
 * Parsing, defaults and coercion all live in `config/env.ts`; this is the
 * narrow view — port, CORS origins and this process's identity — that
 * `createHttpApp`, `createRealtime`, `createPresence` and `startServer` take as
 * an explicit dependency instead of reaching for the environment themselves.
 */
export interface AppConfig {
  port: string | number;
  corsOrigins: string[];
  /**
   * What this process is called in state it shares with other instances.
   *
   * Resolved here rather than in `config/env.ts` because it has to be resolved
   * exactly once: `env()` re-reads `process.env` on every call, so a generated
   * default would come back different each time it was asked for, and a
   * presence lease keyed on it would never be released by the process that took
   * it out.
   */
  instanceId: string;
}

export const createConfig = (): AppConfig => {
  const { port, corsOrigins, instanceId } = env();
  return { port, corsOrigins, instanceId: instanceId ?? randomUUID() };
};
