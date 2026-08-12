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
 * The runner stage's final WORKDIR plus every path it creates, mapped back to
 * the repository path it was copied from. `COPY --from=builder` entries are
 * build-stage artifacts with no repo-side source, so they map to null: present
 * in the image, but not something a test can resolve on disk.
 */
function runnerLayout(): { workdir: string; paths: Map<string, string | null> } {
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
    const absolute = (p: string) => (path.posix.isAbsolute(p) ? p : path.posix.join(workdir, p));

    for (const source of sources) {
      const imagePath = destIsDir
        ? path.posix.join(absolute(destination), path.posix.basename(source))
        : absolute(destination);
      paths.set(imagePath, fromBuilder ? null : path.join(repoRoot, source));
    }
  }

  return { workdir, paths };
}

/**
 * Resolve a path as the container would see it, relative to the runner's own
 * WORKDIR rather than a hardcoded /app, and report whether the runner stage
 * really contains it. Matching the longest known prefix means a file deep
 * inside a copied directory resolves through that directory's mapping.
 */
function resolveInRunner(target: string): { inImage: boolean; onDisk: boolean } {
  const { workdir, paths } = runnerLayout();
  const imagePath = path.posix.isAbsolute(target) ? target : path.posix.join(workdir, target);

  let matched: string | null = null;
  for (const key of paths.keys()) {
    const covers = imagePath === key || imagePath.startsWith(`${key}/`);
    if (covers && (matched === null || key.length > matched.length)) matched = key;
  }
  if (matched === null) return { inImage: false, onDisk: false };

  const source = paths.get(matched)!;
  // Copied from the builder stage: it exists in the image, but there is no
  // repository file to stat.
  if (source === null) return { inImage: true, onDisk: true };

  return {
    inImage: true,
    onDisk: existsSync(path.join(source, path.posix.relative(matched, imagePath))),
  };
}

function composeServices(file: string): Record<string, { image?: string; command?: unknown }> {
  const parsed = Bun.YAML.parse(readFileSync(path.join(repoRoot, file), 'utf8')) as {
    services?: Record<string, { image?: string; command?: unknown }>;
  };
  return parsed.services ?? {};
}

/** Services that run the backend production image, keyed by `<file>:<service>`. */
function backendImageCommands(): Array<{ id: string; command: unknown }> {
  const found: Array<{ id: string; command: unknown }> = [];

  for (const file of ['docker-compose.release.yml', 'docker-compose.prod.yml']) {
    for (const [name, service] of Object.entries(composeServices(file))) {
      // prod builds the image inline and has no `image:`; release injects it as
      // ${BACKEND_IMAGE}. Either way only the backend/migrate services run it.
      const usesBackendImage = service.image?.includes('BACKEND_IMAGE') ?? ['backend', 'migrate'].includes(name);
      if (!usesBackendImage) continue;
      // No `command:` at all means the image's own CMD runs, which is by
      // construction in sync with the Dockerfile and needs no guarding here.
      if (service.command === undefined) continue;
      found.push({ id: `${file}:${name}`, command: service.command });
    }
  }

  return found;
}

/** `bun run migrate:up` -> the path inside `migrate:up`, so scripts are checked too. */
function scriptPathArgument(scriptBody: string): string | undefined {
  return scriptBody
    .trim()
    .split(/\s+/)
    .slice(1)
    .find((token) => !token.startsWith('-') && token.includes('/'));
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
    expect(resolveInRunner('dist').inImage).toBe(false);
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
      // Compose also accepts `command: node dist/...` as a bare string, which
      // would slip past an array-only check. Reject it outright rather than
      // skipping it, so the failure names the real problem.
      it('uses the exec form, which is the only form this suite can check', () => {
        expect(Array.isArray(command)).toBe(true);
      });

      const argv = (Array.isArray(command) ? command : []) as string[];

      it('invokes bun, the only interpreter in the runner stage', () => {
        expect(argv[0]).toBe('bun');
      });

      it('resolves to a package script or a file the runner stage contains', () => {
        if (argv[1] === 'run') {
          const script = argv[2]!;
          expect(Object.keys(backendPackageJson.scripts)).toContain(script);

          // The script itself must also be bun-only: `bun run migrate:up` is no
          // better than `pnpm run migrate:up` if migrate:up shells out to node.
          const body = backendPackageJson.scripts[script]!;
          expect(body).toMatch(/^bun\s/);

          // And the path *inside* the script has to ship too, or moving
          // src/models/migrate.ts would break the container while this test
          // stayed green.
          const scriptTarget = scriptPathArgument(body);
          expect(scriptTarget).toBeDefined();
          expect(resolveInRunner(scriptTarget!)).toEqual({ inImage: true, onDisk: true });
          return;
        }

        // Otherwise bun is handed a path directly, which must live under a
        // directory the runner stage actually copied in. `dist/backend/src/index.js`
        // failed exactly here: nothing in the runner stage creates a dist/.
        expect(resolveInRunner(argv[1]!)).toEqual({ inImage: true, onDisk: true });
      });
    });
  }
});

/**
 * The ordering guarantee the commands depend on. Without it the backend can
 * boot against a schema the migrate service has not finished applying.
 */
describe('release compose migrate ordering', () => {
  const services = composeServices('docker-compose.release.yml') as Record<
    string,
    { restart?: string; depends_on?: Record<string, { condition?: string }> }
  >;

  it('runs migrate once rather than restarting it', () => {
    expect(services.migrate?.restart).toBe('no');
  });

  it('holds the backend until migrate has completed successfully', () => {
    expect(services.backend?.depends_on?.migrate?.condition).toBe('service_completed_successfully');
  });
});
