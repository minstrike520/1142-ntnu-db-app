import { describe, it, expect, afterAll } from 'bun:test';
import { testPool } from '../helpers/testPool';

describe('test DB connection', () => {

  it('reaches the test database', async () => {
    const result = await testPool.unsafe('SELECT 1 AS one');
    expect(result[0].one).toBe(1);
  });
});
