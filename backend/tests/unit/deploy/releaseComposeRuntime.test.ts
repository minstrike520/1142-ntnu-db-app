import { describe, it, expect } from 'bun:test';
import path from 'path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Guards the contract between `docker-compose.release.yml` and the image that
 * `backend/Dockerfile.prod` actually produces.
 *
 * These two files drifted apart silently (issue #558): the compose bundle
 * overrode the backend commands with `pnpm run migrate:up` and
 * `node dist/backend/src/index.js`, while the runner stage had become a
 * bun-only image with no `node`, no `pnpm` and no `dist/`. Nothing failed until
 * a deployment actually ran, because the release workflow only ever *copies*
 * the compose file into the bundle — it never starts it.
 *
 * So the check has to be static: read the runner stage, work out which
 * interpreters and which paths it really contains, and hold every command the
 * compose files aim at that image to it.
 */

const backendRoot = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(backendRoot, '..');

const dockerfile = readFileSync(path.join(backendRoot, 'Dockerfile.prod'), 'utf8');
const backendPackageJson = JSON.parse(
  readFileSync(path.join(backendRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

/**
 * Everything after the final `FROM ... AS runner`. Only that stage ships; the
 * builder stage deliberately grafts in node and pnpm, so including it would
 * make the whole check vacuous.
 */
function runnerStage(): { baseImage: string; lines: string[] } {
  const lines = dockerfile.split('\n');
  // Scanned backwards rather than with findLastIndex, which tsconfig's lib
  // target does not provide.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^FROM\s+\S+\s+AS\s+runner\s*$/i.test(lines[i]!)) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    throw new Error('Dockerfile.prod has no `FROM ... AS runner` stage');
  }
  const baseImage = /^FROM\s+(\S+)\s+AS\s+runner/i.exec(lines[start]!)![1]!;
  return { baseImage, lines: lines.slice(start + 1) };
}

/**
 * Maps each path the runner stage creates, relative to its WORKDIR, back to the
 * repository path it was copied from. `COPY --from=builder` entries are
 * build-stage artifacts with no repo-side source, so they map to null: present
 * in the image, but not something a test can resolve on disk.
 */
function runnerPaths(): Map<string, string | null> {
  const { lines } = runnerStage();
  const paths = new Map<string, string | null>();
  let workdir = '/';

  for (const line of lines) {
    const workdirMatch = /^WORKDIR\s+(\S+)/i.exec(line);
    if (workdirMatch) {
      workdir = workdirMatch[1]!;
      continue;
    }

    const copyMatch = /^COPY\s+(.*)$/i.exec(line);
    if (!copyMatch) continue;

    const args = copyMatch[1]!.trim().split(/\s+/);
    const fromBuilder = args.some((arg) => /^--from=/.test(arg));
    const operands = args.filter((arg) => !arg.startsWith('--'));
    if (operands.length < 2) continue;

    const destination = operands.at(-1)!;
    const sources = operands.slice(0, -1);
    // `COPY a b ./` copies the *contents* under the destination directory, so
    // the image path is the destination joined with each source's basename.
    // `COPY a ./src` renames, so the destination is itself the image path.
    const destIsDir = destination.endsWith('/') || destination === '.';
    const absolute = (p: string) => (p.startsWith('/') ? p : path.posix.join(workdir, p));

    for (const source of sources) {
      const imagePath = destIsDir
        ? path.posix.join(absolute(destination), path.posix.basename(source))
        : absolute(destination);
      paths.set(imagePath, fromBuilder ? null : path.join(repoRoot, source));
    }
  }

  return paths;
}

function composeServices(file: string): Record<string, { image?: string; command?: unknown }> {
  const parsed = Bun.YAML.parse(readFileSync(path.join(repoRoot, file), 'utf8')) as {
    services?: Record<string, { image?: string; command?: unknown }>;
  };
  return parsed.services ?? {};
}

/** Services that run the backend production image, keyed by `<file>:<service>`. */
function backendImageCommands(): Array<{ id: string; command: string[] }> {
  const found: Array<{ id: string; command: string[] }> = [];

  for (const file of ['docker-compose.release.yml', 'docker-compose.prod.yml']) {
    for (const [name, service] of Object.entries(composeServices(file))) {
      // prod builds the image inline and has no `image:`; release injects it as
      // ${BACKEND_IMAGE}. Either way only the backend/migrate services run it.
      const usesBackendImage = service.image?.includes('BACKEND_IMAGE') ?? ['backend', 'migrate'].includes(name);
      if (!usesBackendImage) continue;
      // No `command:` means the image's own CMD runs, which is by construction
      // in sync with the Dockerfile and needs no guarding here.
      if (!Array.isArray(service.command)) continue;
      found.push({ id: `${file}:${name}`, command: service.command as string[] });
    }
  }

  return found;
}

describe('backend production runner stage', () => {
  it('is a bun-only image, so no compose command may reach for node or pnpm', () => {
    const { baseImage, lines } = runnerStage();
    expect(baseImage).toMatch(/^oven\/bun:/);

    // The builder stage installs node and pnpm via `COPY --from=node:` and
    // `corepack`. If either ever appears in the runner stage, the bun-only
    // premise of the assertions below no longer holds and they must be revisited.
    const grafted = lines.filter((line) => /--from=node:|corepack|apt-get install[^\n]*\bnodejs\b/.test(line));
    expect(grafted).toEqual([]);
  });

  it('ships no build output for a compose command to point at', () => {
    expect([...runnerPaths().keys()]).not.toContain('/app/dist');
  });
});

describe('compose commands against the backend production image', () => {
  it('finds the services to check, so a rename cannot silently empty this suite', () => {
    expect(backendImageCommands().map((entry) => entry.id)).toEqual([
      'docker-compose.release.yml:migrate',
      'docker-compose.release.yml:backend',
    ]);
  });

  for (const { id, command } of backendImageCommands()) {
    describe(id, () => {
      it('invokes bun, the only interpreter in the runner stage', () => {
        expect(command[0]).toBe('bun');
      });

      it('resolves to a package script or a file the runner stage contains', () => {
        const paths = runnerPaths();

        if (command[1] === 'run') {
          const script = command[2]!;
          expect(Object.keys(backendPackageJson.scripts)).toContain(script);
          // The script itself must also be bun-only: `bun run migrate:up` is no
          // better than `pnpm run migrate:up` if migrate:up shells out to node.
          expect(backendPackageJson.scripts[script]).toMatch(/^bun\s/);
          return;
        }

        // Otherwise bun is handed a path, which must live under a directory the
        // runner stage actually copied in. `dist/backend/src/index.js` failed
        // exactly here: nothing in the runner stage creates /app/dist.
        const target = command[1]!;
        const workdirPath = path.posix.join('/app', target);
        const root = `/app/${target.split('/')[0]}`;
        expect(paths.has(root)).toBe(true);

        const repoPath = paths.get(root);
        expect(repoPath).not.toBeNull();
        expect(existsSync(path.join(repoPath!, path.posix.relative(root, workdirPath)))).toBe(true);
      });
    });
  }
});
