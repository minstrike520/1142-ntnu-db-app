import { SQL } from "bun";

if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST is not set — copy .env.test.example to .env.test');
}

export const testPool = new SQL(process.env.DATABASE_URL_TEST);
