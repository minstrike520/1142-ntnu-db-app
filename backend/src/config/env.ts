import { DEFAULT_ACCESS_TOKEN_TTL_SECONDS, parseDurationSeconds } from '../utils/accessTokenTtl';
import { parsePositiveInt } from '../utils/parsePositiveInt';

/**
 * The single place this process interprets its environment.
 *
 * Before this module the same variable was read, coerced and defaulted at
 * whichever call site happened to need it, so `TRUST_PROXY`'s meaning lived in
 * `clientIp.ts`, the rate-limit windows in `securityMiddleware.ts`, the cookie
 * lifetime in two files that had to agree, and nothing anywhere listed what the
 * backend actually reads. Everything now lands here: one declaration per
 * variable, one place to change a default, and one typed shape (`Env`) for the
 * rest of the code to consume.
 *
 * Two deliberate properties:
 *
 * - **`env()` re-reads `process.env` on every call.** The values are not cached.
 *   That keeps the lazy semantics every existing caller (and its tests) was
 *   written against, and the parse is a handful of string operations — far
 *   below the cost of the request that triggers it.
 * - **`env()` never throws.** An unusable value falls back to its default,
 *   exactly as the scattered parsers did. Surfacing those is the job of
 *   `assertStartupEnv()`, which the server entrypoint calls once so a
 *   misconfigured deployment is reported at boot instead of at the first
 *   request that happens to touch the setting.
 *
 * Parsing is hand-written rather than Zod-based: these are flat strings whose
 * accepted forms are inherited (`Number()`-style ints, `15m` durations, the
 * legacy `TRUST_PROXY` boolean), so a schema would only wrap the same bespoke
 * functions. Zod stays where it validates real request shapes.
 */

/** Re-exported so every default is reachable from one place. */
export { DEFAULT_ACCESS_TOKEN_TTL_SECONDS };

export const DEFAULT_PORT = 4000;

export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3005',
  'http://localhost:5173',
] as const;

/** Stand-in secret for non-production runs, so a fresh checkout boots. */
export const DEV_JWT_SECRET = 'default-dev-secret';

export const DEFAULT_REFRESH_TTL_DAYS = 14;

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_MAX = 1000;
export const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;

export const DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
  'application/zip',
  'text/plain',
] as const;

export const DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.pdf',
  '.zip',
  '.txt',
] as const;

export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export interface Env {
  /** Raw `NODE_ENV`; `undefined` when unset, which is not the same as development. */
  nodeEnv: string | undefined;
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;

  /**
   * Handed to `server.listen` unchanged.
   *
   * Left as `string | number` because that is what `PORT || 4000` has always
   * produced: a non-numeric `PORT` reaches `listen` as a string, which Node
   * treats as a pipe path. Coercing it here would change how such a value
   * behaves, so it is only reported by `assertStartupEnv()`.
   */
  port: string | number;
  corsOrigins: string[];

  /**
   * The database this process should connect to, or `undefined` when none is
   * configured. `DATABASE_URL_TEST` wins only under the test runner — the
   * regular compose stack also defines it, pointing at a host that only
   * `docker-compose.test.yml` starts.
   */
  databaseUrl: string | undefined;

  /** Raw `JWT_SECRET`, empty treated as unset. The production rule lives in `assertStartupEnv`/`utils/jwt`. */
  jwtSecret: string | undefined;
  accessTokenTtlSeconds: number;
  refreshTokenTtlMs: number;
  refreshCookieMaxAgeMs: number;
  /** Cookies go out `Secure` everywhere except local development and tests. */
  secureCookies: boolean;

  /**
   * How many proxies we operate sit between the client and this process, which
   * is what decides how far from the right of `X-Forwarded-For` a trustworthy
   * address can be read. See `utils/clientIp`.
   */
  trustedProxyHops: number;

  rateLimit: {
    disabled: boolean;
    global: { windowMs: number; limit: number };
    auth: { windowMs: number; limit: number };
  };

  attachments: {
    restrictionEnabled: boolean;
    allowedMimeTypes: string[];
    allowedExtensions: string[];
    maxBytes: number;
  };
}

/** A variable that is missing when required, or set to something unusable. */
export interface EnvProblem {
  name: string;
  message: string;
  /** The offending value, present only for settings that cannot hold a secret. */
  value?: string;
  /** Fatal problems stop startup; the rest fall back to a default and are reported. */
  fatal: boolean;
}

export class EnvConfigError extends Error {
  constructor(readonly problems: EnvProblem[]) {
    super(`Invalid environment configuration:\n${problems.map(formatProblem).join('\n')}`);
    this.name = 'EnvConfigError';
  }
}

// --- value parsers -----------------------------------------------------------
//
// Each returns `undefined` for "unusable", which the readers below turn into
// either a fallback (in `env()`) or a reported problem (in `envProblems()`).

/** `Number()`-based, matching what `parsePositiveInt` accepted before. */
const asPositiveInt = (raw: string): number | undefined => {
  const parsed = parsePositiveInt(raw, Number.NaN);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const asNonNegativeInt = (raw: string): number | undefined => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const asDurationSeconds = (raw: string): number | undefined => {
  // A sentinel no real duration can produce, so "fell back" is distinguishable
  // from "parsed to the same number as the default".
  const parsed = parseDurationSeconds(raw, -1);
  return parsed === -1 ? undefined : parsed;
};

const asBoolean = (raw: string): boolean | undefined => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
};

const asList = (raw: string): string[] =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** A list that must have at least one entry to count as configured. */
const asNonEmptyList = (raw: string): string[] | undefined => {
  const items = asList(raw);
  return items.length > 0 ? items : undefined;
};

// --- readers -----------------------------------------------------------------

type Parser<T> = (raw: string) => T | undefined;

/**
 * Read one variable, falling back when it is unset or unusable.
 *
 * `problems` is optional so the same table drives both `env()` (which ignores
 * bad values) and `envProblems()` (which collects them).
 */
const read = <T>(
  source: NodeJS.ProcessEnv,
  name: string,
  parse: Parser<T>,
  fallback: T,
  problems?: EnvProblem[],
): T => {
  const raw = source[name];
  // Blank counts as unset, not as unusable. Compose passes a variable that is
  // absent from `.env` through as an empty string, and warning about every one
  // of those would bury the values that really were mistyped.
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = parse(raw);
  if (parsed !== undefined) return parsed;

  problems?.push({
    name,
    message: `is not usable, falling back to the default (${String(fallback)})`,
    value: raw,
    fatal: false,
  });
  return fallback;
};

/**
 * Resolve the trusted hop count from the current and legacy settings.
 *
 * `TRUST_PROXY_HOPS` wins whenever it is set to anything at all — including a
 * malformed value, which resolves to zero rather than quietly falling through
 * to `TRUST_PROXY`. A misconfiguration must never end up granting more trust
 * than the operator asked for.
 */
const readTrustedProxyHops = (source: NodeJS.ProcessEnv, problems?: EnvProblem[]): number => {
  const configured = (source.TRUST_PROXY_HOPS ?? '').trim();

  if (configured) {
    const hops = asNonNegativeInt(configured);
    if (hops !== undefined) return hops;

    problems?.push({
      name: 'TRUST_PROXY_HOPS',
      message: 'is not a non-negative integer, so no proxy is trusted',
      value: configured,
      fatal: false,
    });
    return 0;
  }

  return (source.TRUST_PROXY ?? '').trim().toLowerCase() === 'true' ? 1 : 0;
};

const readAll = (source: NodeJS.ProcessEnv, problems?: EnvProblem[]): Env => {
  const nodeEnv = source.NODE_ENV;
  const isTest = nodeEnv === 'test';

  const refreshTokenTtlMs =
    read(source, 'JWT_REFRESH_EXPIRES_IN_DAYS', asPositiveInt, DEFAULT_REFRESH_TTL_DAYS, problems) *
    24 * 60 * 60 * 1000;

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isDevelopment: nodeEnv === 'development',
    isTest,

    port: source.PORT || DEFAULT_PORT,
    // Not read through `read`: here a blank value is not "unset" but "allow no
    // origin at all", which is what an operator gets today by leaving
    // CORS_ORIGINS out of `.env` (Compose passes it through as an empty
    // string). Falling back to the localhost defaults would quietly widen it.
    corsOrigins:
      source.CORS_ORIGINS === undefined ? [...DEFAULT_CORS_ORIGINS] : asList(source.CORS_ORIGINS),

    databaseUrl: (isTest ? source.DATABASE_URL_TEST : undefined) || source.DATABASE_URL || undefined,

    jwtSecret: source.JWT_SECRET || undefined,
    accessTokenTtlSeconds: read(
      source,
      'JWT_EXPIRES_IN',
      asDurationSeconds,
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      problems,
    ),
    refreshTokenTtlMs,
    refreshCookieMaxAgeMs: read(
      source,
      'REFRESH_COOKIE_MAX_AGE_MS',
      asPositiveInt,
      refreshTokenTtlMs,
      problems,
    ),
    secureCookies: nodeEnv !== 'development' && nodeEnv !== 'test',

    trustedProxyHops: readTrustedProxyHops(source, problems),

    rateLimit: {
      // Exact match, unlike the other booleans: this is the historical spelling
      // and widening it would silently disable limiting for values (`TRUE`,
      // `yes`) that do nothing today.
      disabled: isTest || source.RATE_LIMIT_DISABLED === 'true',
      global: {
        windowMs: read(
          source,
          'RATE_LIMIT_WINDOW_MS',
          asPositiveInt,
          DEFAULT_RATE_LIMIT_WINDOW_MS,
          problems,
        ),
        limit: read(source, 'RATE_LIMIT_MAX', asPositiveInt, DEFAULT_RATE_LIMIT_MAX, problems),
      },
      auth: {
        windowMs: read(
          source,
          'AUTH_RATE_LIMIT_WINDOW_MS',
          asPositiveInt,
          DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
          problems,
        ),
        limit: read(
          source,
          'AUTH_RATE_LIMIT_MAX',
          asPositiveInt,
          DEFAULT_AUTH_RATE_LIMIT_MAX,
          problems,
        ),
      },
    },

    attachments: {
      restrictionEnabled: read(
        source,
        'ATTACHMENT_TYPE_RESTRICTION_ENABLED',
        asBoolean,
        false,
        problems,
      ),
      allowedMimeTypes: read(
        source,
        'ATTACHMENT_ALLOWED_MIME_TYPES',
        asNonEmptyList,
        [...DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES],
        problems,
      ).map((mimeType) => mimeType.toLowerCase()),
      allowedExtensions: read(
        source,
        'ATTACHMENT_ALLOWED_EXTENSIONS',
        asNonEmptyList,
        [...DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS],
        problems,
      ).map((extension) => extension.toLowerCase()),
      maxBytes: read(
        source,
        'ATTACHMENT_MAX_BYTES',
        asPositiveInt,
        DEFAULT_ATTACHMENT_MAX_BYTES,
        problems,
      ),
    },
  };
};

/**
 * The current environment, typed.
 *
 * Re-derived per call, so a caller always sees the live `process.env`. Pass an
 * explicit source to interpret an environment other than this process's.
 */
export const env = (source: NodeJS.ProcessEnv = process.env): Env => readAll(source);

/**
 * Everything wrong with an environment: values that will be ignored, and
 * required settings that are missing for the environment they run in.
 */
export const envProblems = (source: NodeJS.ProcessEnv = process.env): EnvProblem[] => {
  const problems: EnvProblem[] = [];
  const config = readAll(source, problems);

  // Advisory rather than coerced, for the reason on `Env['port']`.
  if (source.PORT?.trim() && asPositiveInt(source.PORT) === undefined) {
    problems.push({
      name: 'PORT',
      message: 'is not a positive integer, so it will be treated as a pipe or socket path',
      value: source.PORT,
      fatal: false,
    });
  }

  // A test run deliberately has no database: the unit-test CI job runs without
  // one, and suites that need it set DATABASE_URL_TEST.
  if (!config.databaseUrl && !config.isTest) {
    problems.push({
      name: 'DATABASE_URL',
      message: 'is required (or DATABASE_URL_TEST when NODE_ENV=test)',
      fatal: true,
    });
  }

  if (!config.jwtSecret && config.isProduction) {
    problems.push({
      name: 'JWT_SECRET',
      message: 'is required in production; tokens would otherwise be signed with a public dev key',
      fatal: true,
    });
  }

  return problems;
};

const formatProblem = (problem: EnvProblem): string =>
  problem.value === undefined
    ? `  - ${problem.name} ${problem.message}`
    : `  - ${problem.name}=${JSON.stringify(problem.value)} ${problem.message}`;

/**
 * Fail fast on a misconfigured process.
 *
 * Called once by the server entrypoint. Non-fatal problems are warned about so
 * an ignored value is visible in the startup log rather than discovered when a
 * limit or lifetime turns out to be the default; a fatal one throws, because
 * the alternatives are signing tokens with a published key or serving requests
 * that all fail at the first query.
 */
export const assertStartupEnv = (source: NodeJS.ProcessEnv = process.env): void => {
  const problems = envProblems(source);
  if (problems.length === 0) return;

  const fatal = problems.filter((problem) => problem.fatal);
  const ignored = problems.filter((problem) => !problem.fatal);

  if (ignored.length > 0) {
    console.warn(`Ignoring unusable environment values:\n${ignored.map(formatProblem).join('\n')}`);
  }

  if (fatal.length > 0) {
    throw new EnvConfigError(fatal);
  }
};
