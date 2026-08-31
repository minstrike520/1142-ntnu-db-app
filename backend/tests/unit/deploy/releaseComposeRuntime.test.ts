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

/**
 * The runner stage's own `CMD`, as an argv array.
 *
 * A compose service with no `command:` runs this instead, so it is just as much
 * a startup command as the ones spelled out in the compose files — and until
 * issue #586 it was the one nothing checked.
 */
function runnerCmd(): string[] {
  const { lines } = runnerStage();
  let last: string | undefined;
  for (const line of lines) {
    const match = /^CMD\s+(.+)$/i.exec(line.trim());
    if (match) last = match[1]!;
  }
  if (last === undefined) throw new Error('Dockerfile.prod runner stage has no CMD');
  // Only the exec form is parseable, and it is the only form that reaches the
  // kernel without a shell of Docker's own choosing in the way.
  if (!last.startsWith('[')) throw new Error(`Dockerfile.prod CMD is not in exec form: ${last}`);
  return JSON.parse(last) as string[];
}

/**
 * `["sh", "-c", "a && b"]` -> `[["a"], ["b"]]`, or null when argv is not a shell
 * wrapper. Each segment is the argv of one command the container really runs.
 */
function shellSegments(argv: string[]): string[][] | null {
  const isShell = argv[0] === 'sh' || argv[0] === '/bin/sh';
  if (!isShell || argv[1] !== '-c' || typeof argv[2] !== 'string') return null;
  return argv[2]
    .split('&&')
    .map((segment) => segment.trim().split(/\s+/))
    .filter((segment) => segment.length > 0 && segment[0] !== '');
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
      // A service with no `command:` runs the image's own CMD. This used to be
      // skipped as "in sync with the Dockerfile by construction" — that
      // assumption is exactly what let issue #586 through, because the CMD
      // itself was the broken part and docker-compose.prod.yml's backend is the
      // one service that inherits it. Check the CMD in its place instead.
      const command = service.command ?? runnerCmd();
      found.push({ id: service.command === undefined ? `${file}:${name} (image CMD)` : `${file}:${name}`, command });
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
      'docker-compose.prod.yml:backend (image CMD)',
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
      const segments = shellSegments(argv);
      // A shell wrapper is tolerable only if it hands the container off before
      // the long-running command; each `&&` segment is then checked as its own
      // argv. Without one, `argv` is already the single command.
      const commands = segments ?? [argv];

      if (segments) {
        it('execs its last command, so the application ends up as PID 1', () => {
          // The container's process tree decides whether SIGTERM is ever seen.
          // `/bin/sh` here is dash, which does not forward signals, and the
          // kernel discards default-disposition signals aimed at PID 1 — so a
          // shell left at PID 1 makes `docker stop` a no-op: SIGTERM is ignored,
          // the grace period expires and the container dies on SIGKILL with
          // src/index.ts's drain never entered (issue #586).
          expect(segments.at(-1)![0]).toBe('exec');

          // Only the last one: an earlier `exec` would replace the shell before
          // the commands after it could run at all.
          for (const segment of segments.slice(0, -1)) {
            expect(segment[0]).not.toBe('exec');
          }
        });
      }

      for (const [index, segment] of commands.entries()) {
        // `exec bun src/index.ts` is checked as `bun src/index.ts`; the exec
        // itself is asserted above.
        const words = segment[0] === 'exec' ? segment.slice(1) : segment;
        const label = commands.length > 1 ? `part ${index + 1}: ${segment.join(' ')}` : segment.join(' ');

        describe(label, () => {
          it('invokes bun, the only interpreter in the runner stage', () => {
            expect(words[0]).toBe('bun');
          });

          it('resolves to a package script or a file the runner stage contains', () => {
            if (words[1] === 'run') {
              const script = words[2]!;
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
            expect(resolveInRunner(words[1]!)).toEqual({ inImage: true, onDisk: true });
          });
        });
      }
    });
  }
});

/**
 * The stop budget the drain in src/index.ts depends on. Docker's default grace
 * period is 10s; the drain's own worst case is ~14s (10s to force the HTTP
 * drain, 2s for presence leases, 2s for Redis), so at the default a slow drain
 * is SIGKILLed part-way through handing presence leases back (issue #586).
 */
describe('backend stop grace period', () => {
  for (const file of ['docker-compose.release.yml', 'docker-compose.prod.yml']) {
    it(`${file} gives the backend longer than its own drain`, () => {
      const services = composeServices(file) as Record<string, { stop_grace_period?: string }>;
      const grace = services.backend?.stop_grace_period;
      expect(grace).toBeDefined();

      const seconds = /^(\d+)s$/.exec(grace!);
      expect(seconds).not.toBeNull();
      // Above the 20s deadline src/index.ts arms, which is itself above the
      // ~14s step-wise worst case, so the process always exits before Docker
      // reaches for SIGKILL.
      expect(Number(seconds![1])).toBeGreaterThan(20);
    });
  }
});

/**
 * Source-level properties of the release bundle, checked against the raw YAML
 * rather than a rendered model.
 *
 * These deliberately need no Docker. `scripts/check-compose-invariants.mjs`
 * holds the *rendered* models to `compose-invariants.json` (issue #631) and
 * needs the Compose CLI to do it; keeping that dependency out of the unit tier
 * means these still run on any machine, and a missing Docker in some future
 * runner degrades the checker rather than silently emptying this suite too.
 *
 * They are also the layer where escaping is still visible: by the time Compose
 * has rendered a model, `${VAR:?}` and `$${VAR}` have either been resolved or
 * preserved depending on flags, so the file's own text is the honest source for
 * "was this written to fail fast" and "was this escaped for the container".
 */
describe('release bundle source properties', () => {
  const releaseText = readFileSync(path.join(repoRoot, 'docker-compose.release.yml'), 'utf8');
  const releaseServices = composeServices('docker-compose.release.yml') as Record<
    string,
    { image?: string; build?: unknown }
  >;

  it('finds the services to check, so a rename cannot silently empty this suite', () => {
    expect(Object.keys(releaseServices).sort()).toEqual(['backend', 'db', 'frontend', 'migrate']);
  });

  it('pins its own project name, which decides the volume names on an upgrade', () => {
    // Asserted here rather than in compose-invariants.json because the checker
    // renders with `-p near-chat` -- which overrides this key, so a rendered row
    // would still pass with it deleted. Without it the project name comes from
    // the directory the bundle happens to be unpacked into, so an upgrade
    // extracted somewhere else starts an empty pgdata instead of the existing
    // database (issue #631).
    const parsed = Bun.YAML.parse(readFileSync(path.join(repoRoot, 'docker-compose.release.yml'), 'utf8')) as {
      name?: string;
    };
    expect(parsed.name).toBe('near-chat');
  });

  it('ships no build stanza, because the bundle carries no source to build from', () => {
    // A `build:` here would make a deployment rebuild from whatever happened to
    // be in the extraction directory instead of running the published image.
    for (const [name, service] of Object.entries(releaseServices)) {
      expect([name, service.build]).toEqual([name, undefined]);
    }
  });

  it('pins every image it does not take from the release workflow to a digest', () => {
    for (const [name, service] of Object.entries(releaseServices)) {
      const image = service.image;
      expect([name, typeof image]).toEqual([name, 'string']);
      // The application images arrive as ${BACKEND_IMAGE} / ${FRONTEND_IMAGE},
      // which release-stack.yml resolves to digests it just published. Anything
      // else in this file is a third-party image and has to be pinned here, or
      // two deployments of one release can run different builds.
      if (image!.startsWith('${')) continue;
      expect([name, image]).toEqual([name, expect.stringMatching(/@sha256:[0-9a-f]{64}$/)]);
    }
  });

  it('takes both application images from a required variable, not a default', () => {
    // `:-` would boot something unintended when the variable is missing; the
    // bundle has no source to fall back on, so it must fail at render instead.
    for (const [name, variable] of [
      ['backend', 'BACKEND_IMAGE'],
      ['migrate', 'BACKEND_IMAGE'],
      ['frontend', 'FRONTEND_IMAGE'],
    ] as const) {
      expect([name, releaseServices[name]?.image]).toEqual([name, `\${${variable}:?${variable} is required}`]);
    }
  });

  it('escapes the healthcheck credentials so the container expands them', () => {
    // `$${VAR}` reaches the container as `${VAR}` for its own shell. Written
    // with a single `$`, Compose would substitute host-side and bake the
    // credentials into the rendered config — and on a host that does not export
    // them, into an empty string that never passes the healthcheck.
    const test = (releaseServices as Record<string, { healthcheck?: { test?: string[] } }>).db?.healthcheck?.test;
    expect(test).toEqual(['CMD-SHELL', 'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}']);
  });

  it('fails fast on every secret it cannot invent a default for', () => {
    // Each of these either has no safe default (credentials, image references)
    // or would be actively unsafe defaulted (CORS_ORIGINS defaulted open).
    for (const variable of [
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'POSTGRES_DB',
      'DATABASE_URL',
      'JWT_SECRET',
      'CORS_ORIGINS',
      'BACKEND_IMAGE',
      'FRONTEND_IMAGE',
    ]) {
      expect([variable, releaseText.includes(`\${${variable}:?`)]).toEqual([variable, true]);
      // And none of them may also appear with a default somewhere else in the
      // file, which would quietly re-supply the value the `:?` exists to demand.
      expect([variable, new RegExp(`\\$\\{${variable}:?-`).test(releaseText)]).toEqual([variable, false]);
    }
  });
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
