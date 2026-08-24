/**
 * In-process aggregation of request timings and process resource usage.
 *
 * This is the data source the admin `GET /api/v1/admin/metrics` endpoint will
 * read from, which is why both halves are exposed as small interfaces rather
 * than as loose module state: the endpoint only needs `snapshot()` / `sample()`,
 * so either can later be swapped for a cross-process store without touching the
 * route. Everything here is per-process and resets on restart — a deliberate
 * trade-off matching the recent-log buffer in `logger.ts`.
 */

/** One completed request, as the timing middleware observed it. */
export interface RequestSample {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other';

/**
 * Latency over the retained window, not over all time.
 *
 * Percentiles need the individual observations, and keeping every one of them
 * for the life of the process is precisely the unbounded growth this module has
 * to avoid — so the summary describes the most recent `sampleCapacity`
 * requests. `totalRequests` on the snapshot remains a lifetime counter.
 */
export interface LatencySummary {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface RequestMetricsSnapshot {
  /** Lifetime count, unaffected by the sampling window. */
  totalRequests: number;
  /** Lifetime counts per status class. */
  statusClasses: Record<StatusClass, number>;
  latency: LatencySummary;
  sampleSize: number;
  sampleCapacity: number;
}

export interface RequestMetricsStore {
  record(sample: RequestSample): void;
  snapshot(): RequestMetricsSnapshot;
  reset(): void;
  readonly sampleCapacity: number;
}

/**
 * How many recent durations are retained for percentile maths.
 *
 * 1000 doubles is ~8 KB, and `snapshot()` sorts a copy of them — negligible for
 * an endpoint an operator polls every few seconds, while giving p99 enough
 * observations to mean something.
 */
export const DEFAULT_LATENCY_SAMPLE_CAPACITY = 1000;

const EMPTY_LATENCY: LatencySummary = {
  count: 0,
  avgMs: 0,
  p50Ms: 0,
  p95Ms: 0,
  p99Ms: 0,
  maxMs: 0,
};

const statusClassOf = (status: number): StatusClass => {
  if (!Number.isFinite(status) || status < 100 || status >= 600) return 'other';
  return (`${Math.floor(status / 100)}xx`) as StatusClass;
};

/** Nearest-rank percentile over an ascending array; `sorted` must be non-empty. */
const percentile = (sorted: number[], fraction: number): number => {
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index];
};

/** Keeps float noise (0.30000000000000004) out of a JSON response. */
const round = (value: number, decimals = 3): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export interface CreateRequestMetricsStoreOptions {
  sampleCapacity?: number;
}

/**
 * Counters plus a fixed-size ring of recent durations.
 *
 * `record()` stays O(1) — it only bumps counters and overwrites one slot — so
 * the timing middleware adds nothing measurable to the request path. The
 * sorting cost is paid in `snapshot()`, which only an admin poll triggers.
 */
export const createRequestMetricsStore = (
  options: CreateRequestMetricsStoreOptions = {},
): RequestMetricsStore => {
  const { sampleCapacity = DEFAULT_LATENCY_SAMPLE_CAPACITY } = options;

  if (!Number.isInteger(sampleCapacity) || sampleCapacity <= 0) {
    throw new RangeError(
      `RequestMetricsStore sampleCapacity must be a positive integer, received ${String(sampleCapacity)}`,
    );
  }

  const durations = new Float64Array(sampleCapacity);
  let written = 0;
  let totalRequests = 0;
  let statusClasses: Record<StatusClass, number>;

  const emptyStatusClasses = (): Record<StatusClass, number> => ({
    '1xx': 0,
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
    other: 0,
  });

  statusClasses = emptyStatusClasses();

  return {
    sampleCapacity,

    record({ status, durationMs }: RequestSample): void {
      totalRequests += 1;
      statusClasses[statusClassOf(status)] += 1;

      // A non-finite duration would poison every percentile from here on, so it
      // is counted as a request but never enters the latency window.
      if (!Number.isFinite(durationMs)) return;
      durations[written % sampleCapacity] = Math.max(durationMs, 0);
      written += 1;
    },

    snapshot(): RequestMetricsSnapshot {
      const sampleSize = Math.min(written, sampleCapacity);
      if (sampleSize === 0) {
        return {
          totalRequests,
          statusClasses: { ...statusClasses },
          latency: { ...EMPTY_LATENCY },
          sampleSize,
          sampleCapacity,
        };
      }

      const sorted = Array.from(durations.subarray(0, sampleSize)).sort((a, b) => a - b);
      const sum = sorted.reduce((total, value) => total + value, 0);

      return {
        totalRequests,
        statusClasses: { ...statusClasses },
        latency: {
          count: sampleSize,
          avgMs: round(sum / sampleSize),
          p50Ms: round(percentile(sorted, 0.5)),
          p95Ms: round(percentile(sorted, 0.95)),
          p99Ms: round(percentile(sorted, 0.99)),
          maxMs: round(sorted[sampleSize - 1]),
        },
        sampleSize,
        sampleCapacity,
      };
    },

    reset(): void {
      durations.fill(0);
      written = 0;
      totalRequests = 0;
      statusClasses = emptyStatusClasses();
    },
  };
};

export interface ProcessMetricsSnapshot {
  uptimeSeconds: number;
  cpu: {
    userMs: number;
    systemMs: number;
    /**
     * CPU time consumed since the previous `sample()` call, as a percentage of
     * one core's wall-clock time. `null` on the first sample, which has no
     * earlier point to difference against. Values above 100 are expected and
     * correct on a multi-core host: Bun's runtime is multi-threaded.
     */
    percent: number | null;
  };
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
}

export interface ProcessMetricsSampler {
  sample(): ProcessMetricsSnapshot;
}

export interface CreateProcessMetricsSamplerOptions {
  cpuUsage?: () => NodeJS.CpuUsage;
  memoryUsage?: () => NodeJS.MemoryUsage;
  uptime?: () => number;
  /** Monotonic wall clock in milliseconds; only differences of it are used. */
  now?: () => number;
}

/**
 * Samples the process's own resource usage on demand.
 *
 * Nothing is collected on a timer: an operator polling `/metrics` is the only
 * consumer, so sampling at read time avoids a background interval that would
 * keep the process busy — and keep it alive — for data nobody is looking at.
 */
export const createProcessMetricsSampler = (
  options: CreateProcessMetricsSamplerOptions = {},
): ProcessMetricsSampler => {
  const {
    cpuUsage = () => process.cpuUsage(),
    memoryUsage = () => process.memoryUsage(),
    uptime = () => process.uptime(),
    now = () => performance.now(),
  } = options;

  let previous: { cpu: NodeJS.CpuUsage; at: number } | null = null;

  return {
    sample(): ProcessMetricsSnapshot {
      const cpu = cpuUsage();
      const memory = memoryUsage();
      const at = now();

      let percent: number | null = null;
      if (previous) {
        const elapsedMs = at - previous.at;
        if (elapsedMs > 0) {
          const usedMs = (cpu.user - previous.cpu.user + (cpu.system - previous.cpu.system)) / 1000;
          percent = round(Math.max((usedMs / elapsedMs) * 100, 0), 2);
        }
      }
      previous = { cpu, at };

      return {
        uptimeSeconds: round(uptime(), 3),
        cpu: { userMs: round(cpu.user / 1000), systemMs: round(cpu.system / 1000), percent },
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
        },
      };
    },
  };
};

/** The process-wide aggregates the timing middleware feeds and `/metrics` reads. */
export const requestMetrics: RequestMetricsStore = createRequestMetricsStore();
export const processMetrics: ProcessMetricsSampler = createProcessMetricsSampler();
