import path from 'path';
import type pino from 'pino';
import type { AppConfig } from './config';
import type { BunRuntimeServer } from './realtime';
import { logger as defaultLogger } from '../utils/logger';

/**
 * The running version, for the startup log line only.
 *
 * The workspace root manifest is the source of truth; the backend's own is the
 * fallback for when the process runs with the package as its working directory.
 */
const resolveVersion = async (): Promise<string> => {
  try {
    return (await Bun.file(path.join(process.cwd(), '../package.json')).json()).version;
  } catch {
    try {
      return (await Bun.file(path.join(process.cwd(), 'package.json')).json()).version;
    } catch {
      return '1.0.0';
    }
  }
};

export interface StartServerDeps {
  server: BunRuntimeServer;
  config: AppConfig;
  /** Injectable so the startup line is assertable; defaults to the shared logger. */
  logger?: pino.Logger;
}

export const startServer = async ({
  server,
  config,
  logger = defaultLogger,
}: StartServerDeps): Promise<void> => {
  const version = await resolveVersion();

  server.listen(config.port, '0.0.0.0', () =>
    // The message text is unchanged from the `console.log` this replaced, so
    // anything tailing container logs for it keeps matching; the structured
    // fields are additive.
    logger.info(
      { version, port: config.port, address: '0.0.0.0' },
      `Backend server (v${version}) successfully listening on port ${config.port} (0.0.0.0)`,
    ),
  );
};
