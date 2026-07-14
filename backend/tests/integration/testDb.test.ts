import { afterAll, describe, expect, it } from 'bun:test';
import { testPool } from '../helpers/testPool';

describe('test DB connection', () => {
  afterAll(async () => {
    await testPool.end();
  });

  it('reaches the test database', async () => {
    const result = await testPool.query('SELECT 1 AS one');
    expect(result.rows[0].one).toBe(1);
  });
});
