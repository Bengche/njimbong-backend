/**
 * migrate.js
 *
 * Runs all pending database migrations before the server starts.
 * Called automatically by the `start` script: node src/migrate.js && node src/server.js
 *
 * Every statement here must be idempotent (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, etc.)
 * so it is safe to run on every deploy without side effects.
 */

import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const useSsl =
  process.env.DB_SSL === "true" || process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  user: process.env.DB_USERNAME,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 20000,
});

// ---------------------------------------------------------------------------
// All migrations — always idempotent, always in order
// ---------------------------------------------------------------------------
const migrations = [
  {
    name: "001_create_orders_table",
    sql: `
      CREATE TABLE IF NOT EXISTS public.orders (
        id               SERIAL PRIMARY KEY,
        listing_id       INTEGER NOT NULL REFERENCES userlistings(id),
        buyer_id         INTEGER NOT NULL REFERENCES users(id),
        seller_id        INTEGER NOT NULL REFERENCES users(id),
        amount           NUMERIC(12, 2) NOT NULL,
        currency         VARCHAR(10)  NOT NULL DEFAULT 'XAF',
        order_reference  VARCHAR(200) NOT NULL UNIQUE,

        fonlok_invoice_id   VARCHAR(100),
        fonlok_reference    UUID,
        fonlok_payment_url  TEXT,
        fonlok_status       VARCHAR(30) NOT NULL DEFAULT 'none',

        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

        CONSTRAINT orders_fonlok_status_check CHECK (
          fonlok_status IN (
            'none',
            'pending',
            'paid_in_escrow',
            'released',
            'disputed',
            'failed',
            'cancelled',
            'initiation_failed'
          )
        )
      );

      CREATE INDEX IF NOT EXISTS orders_buyer_id_idx
        ON public.orders (buyer_id);

      CREATE INDEX IF NOT EXISTS orders_seller_id_idx
        ON public.orders (seller_id);

      CREATE INDEX IF NOT EXISTS orders_listing_id_idx
        ON public.orders (listing_id);

      CREATE INDEX IF NOT EXISTS orders_fonlok_invoice_id_idx
        ON public.orders (fonlok_invoice_id);

      CREATE INDEX IF NOT EXISTS orders_fonlok_reference_idx
        ON public.orders (fonlok_reference);
    `,
  },
  {
    name: "002_create_email_verifications_table",
    sql: `
      CREATE TABLE IF NOT EXISTS public.email_verifications (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      VARCHAR(128) NOT NULL UNIQUE,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        used_at    TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS email_verifications_token_idx
        ON public.email_verifications (token);

      CREATE INDEX IF NOT EXISTS email_verifications_user_id_idx
        ON public.email_verifications (user_id);

      -- Add email_verified column to users if it doesn't exist
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'email_verified'
        ) THEN
          ALTER TABLE public.users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
      END
      $$;
    `,
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runMigrations() {
  const client = await pool.connect();
  try {
    // Ensure the migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        name        VARCHAR(200) PRIMARY KEY,
        applied_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    for (const migration of migrations) {
      const already = await client.query(
        "SELECT 1 FROM public._migrations WHERE name = $1",
        [migration.name],
      );

      if (already.rowCount > 0) {
        console.log(`[migrate] skip  ${migration.name} (already applied)`);
        continue;
      }

      console.log(`[migrate] apply ${migration.name} ...`);
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO public._migrations (name) VALUES ($1)",
          [migration.name],
        );
        await client.query("COMMIT");
        console.log(`[migrate] done  ${migration.name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    console.log("[migrate] all migrations complete");
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error("[migrate] FAILED:", err.message);
  process.exit(1); // Non-zero exit prevents the server from starting
});
