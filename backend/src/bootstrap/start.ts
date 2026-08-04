import path from 'path';
import type { Server as HttpServer } from 'node:http';
import type { AppConfig } from './config';

/**
 * The running version, for the startup log line only.
 *
 * The workspace root manifest is the source of truth; the backend's own is the
 * fallback for when the process runs with the package as its working directory.
 * Both lookups stay best-effort — a missing or unreadable manifest must not stop
 * the server from booting.
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
  httpServer: HttpServer;
  config: AppConfig;
}

export const startServer = async ({ httpServer, config }: StartServerDeps): Promise<void> => {
  const version = await resolveVersion();

  httpServer.listen(config.port as number, '0.0.0.0', () =>
    console.log(
      `Backend server (v${version}) successfully listening on port ${config.port} (0.0.0.0)`,
    ),
  );
};
