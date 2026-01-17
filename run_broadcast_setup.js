// Script to run broadcast setup SQL
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "marketplace",
  password: process.env.DB_PASSWORD || "Boyalinco$10",
  port: parseInt(process.env.DB_PORT) || 1998,
});

async function setup() {
  const client = await pool.connect();
  try {
    console.log("Setting up admin broadcasts table...");

    // Create admin_broadcasts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_broadcasts (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        title VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(50) DEFAULT 'announcement',
        priority VARCHAR(20) DEFAULT 'normal',
        recipients_count INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
    console.log("✓ admin_broadcasts table created");

    // Create index
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_broadcasts_created_at 
      ON admin_broadcasts(created_at DESC)
    `);
    console.log("✓ Index created");

    console.log("\n✅ Admin broadcast system setup complete!");
  } catch (error) {
    console.error("Error setting up broadcast system:", error);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
