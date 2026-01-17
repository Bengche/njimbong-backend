import dotenv from "dotenv";
import { Pool } from "pg";
dotenv.config();

const useSsl =
  process.env.DB_SSL === "true" || process.env.NODE_ENV === "production";

const db = new Pool({
  user: process.env.DB_USERNAME,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.DB_POOL_SIZE || "10", 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
});

export default db;
