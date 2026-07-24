import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;

console.log("DB INIT ENV:", process.env.NODE_ENV, "URL:", connectionString);
const pool = new Pool({
  connectionString,
});

export default pool;
