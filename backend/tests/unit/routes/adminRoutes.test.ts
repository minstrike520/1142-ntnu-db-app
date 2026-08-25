import { describe, it, expect } from 'bun:test';
import { limitQuerySchema } from '../../../src/routes/adminRoutes';

/**
 * The admin handlers themselves are exercised end to end in
 * `tests/e2e/routes/admin.e2e.test.ts`, because they sit behind `authMiddleware`
 * — which reaches for the shared SQL client with no injection seam, so a unit
 * test could only get past it with `mock.module()`, which this repo bans
 * (tests/CLAUDE.md, issue #467). Exporting an unguarded monitoring sub-app to
 * make it unit-testable would trade a real safety property for test
 * convenience.
 *
 * What is worth isolating is the `?limit=` boundary, which is pure and has more
 * edge cases than an E2E pass would sensibly enumerate.
 */
describe('admin limit query', () => {
  const parse = (capacity: number, query: Record<string, unknown>) =>
    limitQuerySchema(capacity).safeParse(query);

  it('defaults to the buffer capacity when no limit is given', () => {
    const result = parse(200, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ limit: 200 });
  });

  it('treats a blank value as absent', () => {
    // A panel that always appends `?limit=${value}` sends this before the
    // operator has picked one.
    expect(parse(100, { limit: '' }).data).toEqual({ limit: 100 });
  });

  it('accepts a numeric string, which is all a query string can carry', () => {
    expect(parse(200, { limit: '50' }).data).toEqual({ limit: 50 });
  });

  it('caps the request at what the buffer can actually hold', () => {
    // Rejected rather than clamped: silently returning 200 records for a request
    // that asked for 5000 would look like the buffer holds 5000.
    expect(parse(200, { limit: '5000' }).success).toBe(false);
  });

  it('rejects values that cannot mean a number of records', () => {
    expect(parse(200, { limit: '0' }).success).toBe(false);
    expect(parse(200, { limit: '-1' }).success).toBe(false);
    expect(parse(200, { limit: '1.5' }).success).toBe(false);
    expect(parse(200, { limit: 'all' }).success).toBe(false);
  });

  it('uses each buffer\'s own capacity, not one shared ceiling', () => {
    // Logs retain 200 and slow queries 100, so the same request is valid
    // against one endpoint and not the other.
    expect(parse(200, { limit: '150' }).success).toBe(true);
    expect(parse(100, { limit: '150' }).success).toBe(false);
  });
});
