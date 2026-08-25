import pino from 'pino';
import { env, type LogLevel } from '../config/env';

/**
 * How many records the in-memory buffer keeps before it starts overwriting the
 * oldest. Small enough to stay negligible next to the process's own footprint,
 * large enough to cover a burst around an incident.
 */
export const DEFAULT_RECENT_LOG_CAPACITY = 200;

/**
 * Per-record ceiling for the buffer, in `String.length` units.
 *
 * The entry count alone does not bound memory: one `logger.info(hugeObject)`
 * would park a multi-megabyte string in the ring until 200 more records push it
 * out. Anything larger is replaced by a stand-in, so the buffer's footprint is
 * bounded by size and not merely by record count.
 *
 * Measured in UTF-16 code units rather than encoded bytes: that is what a
 * retained JS string actually costs in memory, and it avoids re-encoding every
 * record on the logging hot path just to measure it.
 */
export const DEFAULT_MAX_LOG_ENTRY_CHARS = 8 * 1024;

/**
 * One structured record, as pino serialized it.
 *
 * `level` is pino's numeric severity (30 = info, 50 = error) and `time` an
 * epoch-millisecond stamp. The index signature keeps whatever context the call
 * site merged in — `logger.info({ roomId }, '...')` — without this type having
 * to enumerate it.
 */
export interface RecentLogEntry {
  level: number;
  time: number;
  msg?: string;
  [key: string]: unknown;
}

/**
 * A bounded window over the most recent log records.
 *
 * This is the data source the admin `GET /api/v1/admin/logs` endpoint will read
 * from, which is why it is an interface rather than a bare array: the endpoint
 * only needs `recent()`, so the buffer can later be swapped for a Redis-backed,
 * cross-process store without touching the route.
 */
export interface RecentLogStore {
  /** Accepts one serialized NDJSON record, exactly as pino emits it. */
  push(line: string): void;
  /** The newest `limit` records, oldest first. Defaults to everything held. */
  recent(limit?: number): RecentLogEntry[];
  readonly capacity: number;
  size(): number;
}

export interface CreateRecentLogStoreOptions {
  capacity?: number;
  maxEntryChars?: number;
}

/** Level 0 sits below pino's own `trace` (10), marking a record this layer synthesized. */
const SYNTHETIC_LEVEL = 0;

/**
 * A fixed-size ring buffer of serialized log records.
 *
 * A write overwrites the oldest slot rather than appending, so a process that
 * logs for a week still holds at most `capacity` records and this can never be
 * the reason the backend runs out of memory. A plain array with `shift()` bounds
 * the length too, but re-indexes the whole array on every log line.
 *
 * Records are kept as strings and parsed in `recent()` rather than on the way
 * in. That keeps `JSON.parse` off the logging hot path, and — more importantly —
 * means the buffer never retains a reference to whatever object the caller
 * logged, which would otherwise keep that whole object graph alive for the next
 * 200 records.
 */
export const createRecentLogStore = (
  options: CreateRecentLogStoreOptions = {},
): RecentLogStore => {
  const { capacity = DEFAULT_RECENT_LOG_CAPACITY, maxEntryChars = DEFAULT_MAX_LOG_ENTRY_CHARS } =
    options;

  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(
      `RecentLogStore capacity must be a positive integer, received ${String(capacity)}`,
    );
  }
  if (!Number.isInteger(maxEntryChars) || maxEntryChars <= 0) {
    throw new RangeError(
      `RecentLogStore maxEntryChars must be a positive integer, received ${String(maxEntryChars)}`,
    );
  }

  const slots: string[] = [];
  // Counts every push ever made, not the number retained. The read path needs it
  // to locate the oldest surviving record after wraparound.
  let written = 0;

  const size = (): number => Math.min(written, capacity);

  const parse = (line: string): RecentLogEntry => {
    try {
      return JSON.parse(line) as RecentLogEntry;
    } catch {
      // Surfaced rather than dropped: a record this layer cannot parse is
      // exactly what an operator reading /logs needs to see. `time: 0` is an
      // honest "unknown" — the real stamp lived inside the unparsable payload.
      return { level: SYNTHETIC_LEVEL, time: 0, msg: line };
    }
  };

  return {
    capacity,
    size,

    push(line: string): void {
      const record =
        line.length > maxEntryChars
          ? JSON.stringify({
              level: SYNTHETIC_LEVEL,
              time: Date.now(),
              msg: 'log record dropped from the recent-log buffer: too large to retain',
              droppedChars: line.length,
              maxEntryChars,
            })
          : line;

      slots[written % capacity] = record;
      written += 1;
    },

    recent(limit: number = capacity): RecentLogEntry[] {
      const available = size();
      const requested = Number.isFinite(limit) ? Math.max(Math.trunc(limit), 0) : available;
      const wanted = Math.min(requested, available);

      // Walk forward from the oldest retained record, so the caller gets a
      // chronological feed and never a reference to the backing array.
      const entries: RecentLogEntry[] = [];
      for (let cursor = written - wanted; cursor < written; cursor += 1) {
        entries.push(parse(slots[cursor % capacity]));
      }
      return entries;
    },
  };
};

/**
 * `LOG_LEVEL` wins when it names a real level, falling back otherwise: pino
 * throws on an unknown level and this module builds a logger eagerly, so a typo
 * in a deployment's environment would be a boot crash. Tests default to
 * `silent` so `bun test` output stays readable; the logger's own tests pass an
 * explicit level rather than relying on this.
 *
 * Both the level list and that fallback live in `config/env`, which is where
 * every backend variable is declared. This stays a named function because it is
 * the seam the logger's tests inject a literal environment through.
 */
export const resolveLogLevel = (source: NodeJS.ProcessEnv = process.env): LogLevel =>
  env(source).logLevel;

/**
 * Pretty output is opt-in by exact environment name, never "anything that is not
 * production".
 *
 * docker-compose.prod.yml passes `NODE_ENV=${NODE_ENV}`, and Compose turns an
 * unset variable into the empty string — which *overrides* the image's
 * `ENV NODE_ENV=production`. A `!== 'production'` test would then select the
 * pretty path in production, where `pino-pretty` is not installed. Same class of
 * Compose interpolation trap as the `TRUST_PROXY_HOPS` note in .env.example.
 * `Env.isDevelopment` is that exact-match test.
 */
export const shouldPrettyPrint = (source: NodeJS.ProcessEnv = process.env): boolean =>
  env(source).isDevelopment;

type PrettyStreamFactory = (options: Record<string, unknown>) => NodeJS.WritableStream;

/**
 * The human-facing half of the output.
 *
 * `pino-pretty` is a devDependency and the production image installs with
 * `--prod` (backend/Dockerfile.prod), so it is required lazily and its absence
 * falls back to raw JSON — which is what production wants anyway. A static
 * import would turn that missing devDependency into a boot crash.
 */
const createStdoutStream = (pretty: boolean): NodeJS.WritableStream => {
  if (!pretty) return process.stdout;

  try {
    const prettyFactory = require('pino-pretty') as PrettyStreamFactory;
    return prettyFactory({ colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' });
  } catch {
    return process.stdout;
  }
};

/**
 * Fields scrubbed before a record is written anywhere.
 *
 * The recent-log buffer is about to be served over HTTP by the admin `/logs`
 * endpoint, so a credential that reaches a log line becomes a credential an
 * endpoint hands out. `describeDatabaseTarget.ts` exists for the same reason on
 * the connection-string path; this is the general case.
 */
const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'connectionString',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

export interface CreateLoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  store?: RecentLogStore;
  /** Overrides the human-facing destination. Tests use it to stay quiet. */
  stdout?: NodeJS.WritableStream;
}

/**
 * The process-wide buffer of recent records.
 *
 * Exported separately so the future admin route can read the window without
 * importing the logger that feeds it.
 */
export const recentLogs: RecentLogStore = createRecentLogStore();

/**
 * Build a logger that writes every record to stdout and to a recent-log buffer.
 *
 * The destination is a plain tee rather than `pino.multistream`, for two
 * reasons. Multistream applies a *second*, per-stream level filter that
 * defaults to `info`, so a logger built at `debug` silently drops every debug
 * record at both destinations unless each entry re-declares the level — a trap
 * with no upside here, since both destinations always want the same records.
 * And the buffer has to live in this process for the admin route to read it,
 * which rules out the other option, a `pino.transport` worker thread.
 *
 * pino calls `write()` once per record with one complete newline-terminated
 * line, so no reassembly is needed; only the trailing newline is trimmed.
 */
export const createLogger = (options: CreateLoggerOptions = {}): pino.Logger => {
  const {
    level = resolveLogLevel(),
    pretty = shouldPrettyPrint(),
    store = recentLogs,
    stdout,
  } = options;

  const humanReadable = stdout ?? createStdoutStream(pretty);

  const destination = {
    write(line: string): void {
      humanReadable.write(line);
      // pino invokes this synchronously from inside logger.info(); a throw here
      // would turn a log statement into an application error, so the buffer must
      // never be able to fail the caller.
      try {
        store.push(line.endsWith('\n') ? line.slice(0, -1) : line);
      } catch {
        // Losing a buffered record is strictly better than losing the request.
      }
    },
  };

  return pino({ level, redact: { paths: REDACTED_PATHS, censor: '[redacted]' } }, destination);
};

export const logger: pino.Logger = createLogger();

export default logger;
