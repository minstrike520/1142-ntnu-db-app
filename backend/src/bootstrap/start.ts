import path from 'path';
import type { AppConfig } from './config';
import type { BunRuntimeServer } from './realtime';

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
}

export const startServer = async ({ server, config }: StartServerDeps): Promise<void> => {
  const version = await resolveVersion();

  server.listen(config.port, '0.0.0.0', () =>
    console.log(
      `Backend server (v${version}) successfully listening on port ${config.port} (0.0.0.0)`,
    ),
  );
};
