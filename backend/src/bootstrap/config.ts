import { env } from '../config/env';

/**
 * The slice of configuration the assembly stages pass between each other.
 *
 * Parsing, defaults and coercion all live in `config/env.ts`; this is the
 * narrow view — port and CORS origins — that `createHttpApp`, `createRealtime`
 * and `startServer` take as an explicit dependency instead of reaching for the
 * environment themselves.
 */
export interface AppConfig {
  port: string | number;
  corsOrigins: string[];
}

export const createConfig = (): AppConfig => {
  const { port, corsOrigins } = env();
  return { port, corsOrigins };
};
