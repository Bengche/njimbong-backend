import db from "./src/db.js";

const tableExists = async (tableName) => {
  const result = await db.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name = $1",
    [tableName]
  );
  return result.rowCount > 0;
};

const getListingsTable = async () => {
  if (await tableExists("userlistings")) return "userlistings";
  if (await tableExists("listings")) return "listings";
  return null;
};

const runTrustScoreSetup = async () => {
  try {
    console.log("Setting up trust score tables...");

    const listingsTable = await getListingsTable();
    if (!listingsTable) {
      console.warn(
        "No listings table found (userlistings or listings). Trust score tables will still be created, but listing references will be skipped."
      );
    }

    const adminsTableExists = await tableExists("admins");

    await db.query(
      `CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER ${
          listingsTable
            ? `REFERENCES ${listingsTable}(id) ON DELETE CASCADE`
            : ""
        },
        buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(15, 2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'XAF',
        status VARCHAR(30) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled', 'disputed')),
        buyer_confirmed BOOLEAN DEFAULT false,
        seller_confirmed BOOLEAN DEFAULT false,
        completed_at TIMESTAMP WITH TIME ZONE,
        buyer_review_left BOOLEAN DEFAULT false,
        seller_review_left BOOLEAN DEFAULT false,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`
    );
    console.log("✓ Created transactions table");

    await db.query(
      `CREATE TABLE IF NOT EXISTS user_reviews (
        id SERIAL PRIMARY KEY,
        reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reviewed_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id INTEGER ${
          listingsTable
            ? `REFERENCES ${listingsTable}(id) ON DELETE SET NULL`
            : ""
        },
        transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        title VARCHAR(100),
        review_text TEXT,
        review_sentiment VARCHAR(20)
          CHECK (review_sentiment IN ('positive', 'neutral', 'negative')),
        review_type VARCHAR(20) NOT NULL DEFAULT 'buyer_to_seller'
          CHECK (review_type IN ('buyer_to_seller', 'seller_to_buyer')),
        is_verified BOOLEAN DEFAULT false,
        is_valid BOOLEAN DEFAULT true,
        verification_method VARCHAR(50),
        reviewer_ip VARCHAR(45),
        reviewer_device_fingerprint VARCHAR(255),
        fraud_flags JSONB DEFAULT '[]'::jsonb,
        fraud_score INTEGER DEFAULT 0,
        seller_response TEXT,
        seller_response_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT no_self_review CHECK (reviewer_id != reviewed_user_id),
        CONSTRAINT unique_transaction_review UNIQUE (reviewer_id, reviewed_user_id, transaction_id),
        CONSTRAINT unique_listing_review UNIQUE (reviewer_id, reviewed_user_id, listing_id)
      )`
    );
    console.log("✓ Created user_reviews table");

    await db.query(
      "ALTER TABLE user_reviews ADD COLUMN IF NOT EXISTS review_sentiment VARCHAR(20)"
    );

    await db.query(
      `CREATE TABLE IF NOT EXISTS user_warnings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        admin_id INTEGER ${adminsTableExists ? "REFERENCES admins(id)" : ""},
        warning_type VARCHAR(50) NOT NULL
          CHECK (warning_type IN ('minor', 'moderate', 'severe', 'final')),
        reason TEXT NOT NULL,
        details JSONB DEFAULT '{}'::jsonb,
        points_deducted INTEGER NOT NULL DEFAULT 5,
        is_active BOOLEAN DEFAULT true,
        expires_at TIMESTAMP WITH TIME ZONE,
        acknowledged_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`
    );
    console.log("✓ Created user_warnings table");

    await db.query(
      `CREATE TABLE IF NOT EXISTS trust_score_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        old_score INTEGER,
        new_score INTEGER NOT NULL,
        change_amount INTEGER,
        change_reason VARCHAR(100) NOT NULL,
        change_details JSONB DEFAULT '{}'::jsonb,
        triggered_by VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`
    );
    console.log("✓ Created trust_score_history table");

    await db.query(
      `CREATE TABLE IF NOT EXISTS review_fraud_log (
        id SERIAL PRIMARY KEY,
        review_id INTEGER REFERENCES user_reviews(id) ON DELETE CASCADE,
        reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reviewed_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fraud_type VARCHAR(50) NOT NULL,
        fraud_details JSONB NOT NULL,
        severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        action_taken VARCHAR(50),
        actioned_by INTEGER ${adminsTableExists ? "REFERENCES admins(id)" : ""},
        actioned_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`
    );
    console.log("✓ Created review_fraud_log table");

    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_reviews_reviewed_user ON user_reviews(reviewed_user_id)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON user_reviews(reviewer_id)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_reviews_listing ON user_reviews(listing_id)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_reviews_rating ON user_reviews(rating)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_reviews_valid ON user_reviews(is_valid, is_verified)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_reviews_fraud_score ON user_reviews(fraud_score)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_reviews_created ON user_reviews(created_at DESC)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_transactions_buyer ON transactions(buyer_id)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_transactions_seller ON transactions(seller_id)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_transactions_listing ON transactions(listing_id)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_warnings_user ON user_warnings(user_id)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_warnings_active ON user_warnings(is_active)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_trust_history_user ON trust_score_history(user_id)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_trust_history_created ON trust_score_history(created_at DESC)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_fraud_log_reviewer ON review_fraud_log(reviewer_id)"
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_fraud_log_severity ON review_fraud_log(severity)"
    );
    console.log("✓ Created indexes");

    await db.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score INTEGER DEFAULT 0"
    );
    await db.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score_updated_at TIMESTAMP WITH TIME ZONE"
    );
    await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT");
    await db.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS can_leave_reviews BOOLEAN DEFAULT false"
    );
    await db.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS total_reviews INTEGER DEFAULT 0"
    );
    await db.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS average_rating DECIMAL(3, 2) DEFAULT 0.00"
    );
    console.log("✓ Added user columns");

    console.log("\n✅ Trust score setup completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Error setting up trust score tables:", error);
    process.exit(1);
  }
};

runTrustScoreSetup();
