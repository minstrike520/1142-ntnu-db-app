import { beforeAll } from 'bun:test';

beforeAll(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
});