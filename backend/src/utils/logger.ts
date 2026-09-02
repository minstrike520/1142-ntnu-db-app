import pino from 'pino';
import { env, type LogLevel } from '../config/env';

/** Max number of recent log records kept in the in-memory ring buffer. */
export const DEFAULT_RECENT_LOG_CAPACITY = 200;

/** Max character length retained per log entry in the ring buffer. */
export const DEFAULT_MAX_LOG_ENTRY_CHARS = 8 * 1024;

/** Structured log record parsed from pino NDJSON output. */
export interface RecentLogEntry {
  level: number;
  time: number;
  msg?: string;
  [key: string]: unknown;
}

/** In-memory store of recent log entries for diagnostic endpoints. */
export interface RecentLogStore {
  /** Pushes a serialized NDJSON log line into the buffer. */
  push(line: string): void;
  /** Returns the newest limit records in chronological order. */
  recent(limit?: number): RecentLogEntry[];
  readonly capacity: number;
  size(): number;
}

export interface CreateRecentLogStoreOptions {
  capacity?: number;
  maxEntryChars?: number;
}

/** Synthetic log level for dropped or unparsable records. */
const SYNTHETIC_LEVEL = 0;

/** Creates a fixed-capacity ring buffer of serialized log records. */
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
  let written = 0;

  const size = (): number => Math.min(written, capacity);

  const parse = (line: string): RecentLogEntry => {
    try {
      return JSON.parse(line) as RecentLogEntry;
    } catch {
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

/** Returns true if logs should be pretty-printed in development mode. */
export const shouldPrettyPrint = (source: NodeJS.ProcessEnv = process.env): boolean =>
  env(source).isDevelopment;

type PrettyStreamFactory = (options: Record<string, unknown>) => NodeJS.WritableStream;

/** Lazily loads pino-pretty for development stdout or falls back to raw JSON. */
const createStdoutStream = (pretty: boolean): NodeJS.WritableStream => {
  if (!pretty) return process.stdout;

  try {
    const prettyFactory = require('pino-pretty') as PrettyStreamFactory;
    return prettyFactory({ colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' });
  } catch {
    return process.stdout;
  }
};

/** Sensitive fields scrubbed from log payloads before output. */
const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'connectionString',
  'redisUrl',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

export interface CreateLoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  store?: RecentLogStore;
  /** Overrides stdout stream (used by unit tests to suppress output). */
  stdout?: NodeJS.WritableStream;
}

/** Global in-memory ring buffer of recent logs. */
export const recentLogs: RecentLogStore = createRecentLogStore();

/** Creates a pino logger instance that writes to stdout and tees to the recentLogs store. */
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
      try {
        store.push(line.endsWith('\n') ? line.slice(0, -1) : line);
      } catch {
        // Suppress buffer write errors so logging never throws into application logic.
      }
    },
  };

  return pino({ level, redact: { paths: REDACTED_PATHS, censor: '[redacted]' } }, destination);
};

export const logger: pino.Logger = createLogger();

export default logger;
