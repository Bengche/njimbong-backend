// Script to run favorites setup SQL
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
    console.log("Setting up favorites table...");

    // Create user_favorites table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_favorites (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        favorite_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(user_id, favorite_user_id)
      )
    `);
    console.log("✓ user_favorites table created");

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_favorites_user_id ON user_favorites(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_favorites_favorite_user_id ON user_favorites(favorite_user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_favorites_created_at ON user_favorites(created_at DESC)
    `);
    console.log("✓ Indexes created");

    console.log("\n✅ Favorites system setup complete!");
  } catch (error) {
    console.error("Error setting up favorites system:", error);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
