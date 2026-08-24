import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_LATENCY_SAMPLE_CAPACITY,
  createProcessMetricsSampler,
  createRequestMetricsStore,
  type RequestMetricsStore,
} from '../../../src/utils/performanceMetrics';

const recordDurations = (store: RequestMetricsStore, durations: number[], status = 200): void => {
  for (const durationMs of durations) {
    store.record({ method: 'GET', path: '/api/v1/health', status, durationMs });
  }
};

describe('createRequestMetricsStore', () => {
  it('rejects a capacity that could not bound anything', () => {
    for (const sampleCapacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createRequestMetricsStore({ sampleCapacity })).toThrow(RangeError);
    }
  });

  it('reports zeroed latency before anything is recorded', () => {
    const snapshot = createRequestMetricsStore({ sampleCapacity: 4 }).snapshot();

    expect(snapshot.totalRequests).toBe(0);
    expect(snapshot.sampleSize).toBe(0);
    expect(snapshot.sampleCapacity).toBe(4);
    expect(snapshot.latency).toEqual({ count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
  });

  it('defaults to the documented sample capacity', () => {
    expect(createRequestMetricsStore().sampleCapacity).toBe(DEFAULT_LATENCY_SAMPLE_CAPACITY);
  });

  it('summarises latency over the recorded requests', () => {
    const store = createRequestMetricsStore({ sampleCapacity: 100 });
    recordDurations(
      store,
      Array.from({ length: 100 }, (_, index) => index + 1),
    );

    const { latency, totalRequests } = store.snapshot();
    expect(totalRequests).toBe(100);
    expect(latency.count).toBe(100);
    expect(latency.avgMs).toBe(50.5);
    expect(latency.p50Ms).toBe(50);
    expect(latency.p95Ms).toBe(95);
    expect(latency.p99Ms).toBe(99);
    expect(latency.maxMs).toBe(100);
  });

  it('counts every request but summarises only the most recent window', () => {
    const store = createRequestMetricsStore({ sampleCapacity: 3 });
    recordDurations(store, [1000, 1000, 5, 6, 7]);

    const snapshot = store.snapshot();
    expect(snapshot.totalRequests).toBe(5);
    expect(snapshot.sampleSize).toBe(3);
    expect(snapshot.latency.maxMs).toBe(7);
    expect(snapshot.latency.avgMs).toBe(6);
  });

  it('classifies statuses and keeps unknown ones out of the real classes', () => {
    const store = createRequestMetricsStore({ sampleCapacity: 10 });
    for (const status of [200, 201, 304, 404, 429, 500, 503, 0, 999]) {
      store.record({ method: 'GET', path: '/x', status, durationMs: 1 });
    }

    expect(store.snapshot().statusClasses).toEqual({
      '1xx': 0,
      '2xx': 2,
      '3xx': 1,
      '4xx': 2,
      '5xx': 2,
      other: 2,
    });
  });

  it('counts a non-finite duration without letting it poison the percentiles', () => {
    const store = createRequestMetricsStore({ sampleCapacity: 5 });
    recordDurations(store, [10, 20]);
    store.record({ method: 'GET', path: '/x', status: 200, durationMs: Number.NaN });

    const snapshot = store.snapshot();
    expect(snapshot.totalRequests).toBe(3);
    expect(snapshot.sampleSize).toBe(2);
    expect(snapshot.latency.avgMs).toBe(15);
    expect(snapshot.latency.maxMs).toBe(20);
  });

  it('clamps a negative duration rather than recording time running backwards', () => {
    const store = createRequestMetricsStore({ sampleCapacity: 5 });
    recordDurations(store, [-3]);

    expect(store.snapshot().latency.maxMs).toBe(0);
  });

  it('hands out a copy of the status counts, not the live object', () => {
    const store = createRequestMetricsStore({ sampleCapacity: 5 });
    recordDurations(store, [1]);

    const first = store.snapshot();
    first.statusClasses['2xx'] = 999;

    expect(store.snapshot().statusClasses['2xx']).toBe(1);
  });

  it('clears counters and the latency window on reset', () => {
    const store = createRequestMetricsStore({ sampleCapacity: 5 });
    recordDurations(store, [10, 20], 500);
    store.reset();

    const snapshot = store.snapshot();
    expect(snapshot.totalRequests).toBe(0);
    expect(snapshot.sampleSize).toBe(0);
    expect(snapshot.statusClasses['5xx']).toBe(0);
    expect(snapshot.latency.maxMs).toBe(0);
  });
});

describe('createProcessMetricsSampler', () => {
  const fixedMemory = (): NodeJS.MemoryUsage => ({
    rss: 100,
    heapTotal: 80,
    heapUsed: 60,
    external: 40,
    arrayBuffers: 20,
  });

  it('reports process usage and no CPU percentage on the first sample', () => {
    const sampler = createProcessMetricsSampler({
      cpuUsage: () => ({ user: 2_000, system: 1_000 }),
      memoryUsage: fixedMemory,
      uptime: () => 12.5,
      now: () => 0,
    });

    const snapshot = sampler.sample();
    expect(snapshot.uptimeSeconds).toBe(12.5);
    expect(snapshot.cpu).toEqual({ userMs: 2, systemMs: 1, percent: null });
    expect(snapshot.memory).toEqual({
      rssBytes: 100,
      heapUsedBytes: 60,
      heapTotalBytes: 80,
      externalBytes: 40,
    });
  });

  it('derives CPU percentage from the delta since the previous sample', () => {
    let cpu: NodeJS.CpuUsage = { user: 0, system: 0 };
    let clock = 0;
    const sampler = createProcessMetricsSampler({
      cpuUsage: () => cpu,
      memoryUsage: fixedMemory,
      uptime: () => 1,
      now: () => clock,
    });

    sampler.sample();
    // 50 ms of CPU (30 ms user + 20 ms system) over 100 ms of wall clock.
    cpu = { user: 30_000, system: 20_000 };
    clock = 100;

    expect(sampler.sample().cpu.percent).toBe(50);
  });

  it('leaves the percentage unknown when no wall-clock time has passed', () => {
    const sampler = createProcessMetricsSampler({
      cpuUsage: () => ({ user: 1_000, system: 0 }),
      memoryUsage: fixedMemory,
      uptime: () => 1,
      now: () => 42,
    });

    sampler.sample();
    expect(sampler.sample().cpu.percent).toBeNull();
  });
});
