import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function runSetup() {
  try {
    console.log("Running preferences_setup.sql...");

    const sql = readFileSync(join(__dirname, "preferences_setup.sql"), "utf8");

    // Split by semicolons but keep function definitions intact
    const statements = sql.split(/;(?=\s*(?:CREATE|DROP|INSERT|ALTER|DO|$))/);

    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed && trimmed.length > 5) {
        try {
          await pool.query(trimmed);
          // Extract first line for logging
          const firstLine = trimmed.split("\n")[0].substring(0, 50);
          console.log("✓", firstLine + "...");
        } catch (err) {
          // Ignore some expected errors
          if (
            !err.message.includes("already exists") &&
            !err.message.includes("does not exist")
          ) {
            console.error("Error:", err.message);
          }
        }
      }
    }

    console.log("\n✅ Preferences setup complete!\n");

    // Verify tables were created
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name LIKE 'user_%'
      ORDER BY table_name
    `);

    console.log("User-related tables in database:");
    tables.rows.forEach((t) => console.log("  -", t.table_name));

    process.exit(0);
  } catch (err) {
    console.error("Setup failed:", err);
    process.exit(1);
  }
}

runSetup();
