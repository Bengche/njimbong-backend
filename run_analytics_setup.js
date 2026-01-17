import db from "./src/db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runAnalyticsSetup() {
  try {
    console.log("Setting up analytics tables...");

    // Create listing_analytics table
    await db.query(`
      CREATE TABLE IF NOT EXISTS listing_analytics (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER REFERENCES userlistings(id) ON DELETE CASCADE,
        views INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        last_viewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(listing_id)
      )
    `);
    console.log("✓ Created listing_analytics table");

    // Create analytics_events table
    await db.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER REFERENCES userlistings(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        event_type VARCHAR(50) NOT NULL,
        source VARCHAR(50),
        referrer TEXT,
        device_type VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✓ Created analytics_events table");

    // Create user_analytics_daily table
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_analytics_daily (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        total_views INTEGER DEFAULT 0,
        total_clicks INTEGER DEFAULT 0,
        total_impressions INTEGER DEFAULT 0,
        unique_visitors INTEGER DEFAULT 0,
        revenue DECIMAL(12, 2) DEFAULT 0,
        source_search INTEGER DEFAULT 0,
        source_browse INTEGER DEFAULT 0,
        source_direct INTEGER DEFAULT 0,
        source_external INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, date)
      )
    `);
    console.log("✓ Created user_analytics_daily table");

    // Create indexes
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_listing_analytics_listing ON listing_analytics(listing_id)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_events_listing ON analytics_events(listing_id)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_user_analytics_daily_user ON user_analytics_daily(user_id)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_user_analytics_daily_date ON user_analytics_daily(date)`
    );
    console.log("✓ Created indexes");

    // Initialize analytics for existing listings
    await db.query(`
      INSERT INTO listing_analytics (listing_id, views, clicks, created_at)
      SELECT id, 0, 0, NOW()
      FROM userlistings
      WHERE id NOT IN (SELECT listing_id FROM listing_analytics WHERE listing_id IS NOT NULL)
      ON CONFLICT DO NOTHING
    `);
    console.log("✓ Initialized analytics for existing listings");

    // Add some sample data for testing
    const listings = await db.query(
      `SELECT id, userid FROM userlistings LIMIT 10`
    );
    for (const listing of listings.rows) {
      // Add some random views and clicks
      const views = Math.floor(Math.random() * 100) + 10;
      const clicks = Math.floor(Math.random() * 20) + 1;

      await db.query(
        `
        UPDATE listing_analytics 
        SET views = $1, clicks = $2 
        WHERE listing_id = $3
      `,
        [views, clicks, listing.id]
      );

      // Add daily data for the last 7 days
      for (let i = 0; i < 7; i++) {
        const dayViews = Math.floor(Math.random() * 15) + 1;
        const dayClicks = Math.floor(Math.random() * 5);
        await db.query(
          `
          INSERT INTO user_analytics_daily (user_id, date, total_views, total_clicks, source_direct, source_search)
          VALUES ($1, CURRENT_DATE - INTERVAL '${i} days', $2, $3, $4, $5)
          ON CONFLICT (user_id, date) DO UPDATE SET
            total_views = user_analytics_daily.total_views + $2,
            total_clicks = user_analytics_daily.total_clicks + $3
        `,
          [
            listing.userid,
            dayViews,
            dayClicks,
            Math.floor(dayViews * 0.4),
            Math.floor(dayViews * 0.6),
          ]
        );
      }
    }
    console.log("✓ Added sample analytics data");

    console.log("\n✅ Analytics setup completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Error setting up analytics:", error);
    process.exit(1);
  }
}

runAnalyticsSetup();
