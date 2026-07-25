import { SQL } from "bun";

const connectionString = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;

console.log("DB INIT ENV:", process.env.NODE_ENV, "URL:", connectionString);

const sql = new SQL(connectionString!);

export default sql;
