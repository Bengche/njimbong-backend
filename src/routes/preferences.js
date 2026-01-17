import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";

const router = express.Router();

const ensureSavedSearchesTable = async () => {
  await db.query(
    `CREATE TABLE IF NOT EXISTS saved_searches (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      filters JSONB NOT NULL,
      notify_new_listings BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`
  );
};

const normalizeSearchFilters = (filters) => {
  const safeString = (value) =>
    typeof value === "string" ? value.trim() : value?.toString?.().trim() || "";

  return {
    category: safeString(filters?.category),
    search: safeString(filters?.search),
    country: safeString(filters?.country),
    city: safeString(filters?.city),
    minPrice: safeString(filters?.minPrice),
    maxPrice: safeString(filters?.maxPrice),
    currency: safeString(filters?.currency),
    condition: safeString(filters?.condition),
  };
};

const hasActiveFilters = (filters) =>
  Object.values(filters || {}).some(
    (value) => String(value || "").trim() !== ""
  );

// =====================================================
// GET USER PREFERENCES
// =====================================================
router.get("/preferences", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user preferences
    const prefsResult = await db.query(
      `SELECT * FROM user_preferences WHERE user_id = $1`,
      [userId]
    );

    // Get selected categories
    const categoriesResult = await db.query(
      `SELECT ucp.category_id, ucp.priority, c.name, c.icon, c.slug
       FROM user_category_preferences ucp
       JOIN categories c ON ucp.category_id = c.id
       WHERE ucp.user_id = $1
       ORDER BY ucp.priority DESC`,
      [userId]
    );

    // Get category affinity (learned preferences)
    const affinityResult = await db.query(
      `SELECT uca.category_id, uca.affinity_score, c.name, c.icon, c.slug
       FROM user_category_affinity uca
       JOIN categories c ON uca.category_id = c.id
       WHERE uca.user_id = $1
       ORDER BY uca.affinity_score DESC
       LIMIT 10`,
      [userId]
    );

    const preferences = prefsResult.rows[0] || { onboarding_complete: false };

    res.status(200).json({
      onboarding_complete: preferences.onboarding_complete,
      selected_categories: categoriesResult.rows,
      learned_preferences: affinityResult.rows,
    });
  } catch (error) {
    console.error("Error fetching preferences:", error);
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

// =====================================================
// CHECK ONBOARDING STATUS
// =====================================================
router.get(
  "/preferences/onboarding-status",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;

      const result = await db.query(
        `SELECT onboarding_complete FROM user_preferences WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        // Create preference record if doesn't exist
        await db.query(
          `INSERT INTO user_preferences (user_id, onboarding_complete) VALUES ($1, FALSE)`,
          [userId]
        );
        return res.status(200).json({ onboarding_complete: false });
      }

      res.status(200).json({
        onboarding_complete: result.rows[0].onboarding_complete,
      });
    } catch (error) {
      console.error("Error checking onboarding status:", error);
      res.status(500).json({ error: "Failed to check onboarding status" });
    }
  }
);

// =====================================================
// SAVE USER CATEGORY PREFERENCES (ONBOARDING)
// =====================================================
router.post("/preferences/categories", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { categoryIds } = req.body;

    if (!categoryIds || !Array.isArray(categoryIds) || categoryIds.length < 5) {
      return res.status(400).json({
        error: "Please select at least 5 categories",
      });
    }

    // Start transaction
    await db.query("BEGIN");

    try {
      // Clear existing preferences
      await db.query(
        `DELETE FROM user_category_preferences WHERE user_id = $1`,
        [userId]
      );

      // Insert new preferences with priority
      for (let i = 0; i < categoryIds.length; i++) {
        await db.query(
          `INSERT INTO user_category_preferences (user_id, category_id, priority)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, category_id) DO UPDATE SET priority = $3`,
          [userId, categoryIds[i], categoryIds.length - i] // Higher priority for earlier selections
        );
      }

      // Mark onboarding as complete
      await db.query(
        `INSERT INTO user_preferences (user_id, onboarding_complete, updated_at)
         VALUES ($1, TRUE, NOW())
         ON CONFLICT (user_id) DO UPDATE SET 
           onboarding_complete = TRUE,
           updated_at = NOW()`,
        [userId]
      );

      await db.query("COMMIT");

      res.status(200).json({
        message: "Preferences saved successfully",
        categories_saved: categoryIds.length,
      });
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error("Error saving preferences:", error);
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

// =====================================================
// UPDATE CATEGORY PREFERENCES (SETTINGS)
// =====================================================
router.put("/preferences/categories", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { categoryIds } = req.body;

    if (!categoryIds || !Array.isArray(categoryIds)) {
      return res.status(400).json({
        error: "Invalid category list",
      });
    }

    await db.query("BEGIN");

    try {
      // Clear existing preferences
      await db.query(
        `DELETE FROM user_category_preferences WHERE user_id = $1`,
        [userId]
      );

      // Insert new preferences
      for (let i = 0; i < categoryIds.length; i++) {
        await db.query(
          `INSERT INTO user_category_preferences (user_id, category_id, priority)
           VALUES ($1, $2, $3)`,
          [userId, categoryIds[i], categoryIds.length - i]
        );
      }

      await db.query("COMMIT");

      res.status(200).json({
        message: "Preferences updated successfully",
      });
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error("Error updating preferences:", error);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

// =====================================================
// RECORD SEARCH HISTORY
// =====================================================
router.post("/preferences/search", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { searchTerm, categoryId } = req.body;

    if (!searchTerm || searchTerm.trim().length < 2) {
      return res.status(400).json({ error: "Invalid search term" });
    }

    const normalizedTerm = searchTerm.trim().toLowerCase();

    await db.query(
      `INSERT INTO user_search_history (user_id, search_term, category_id, search_count, last_searched_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (user_id, search_term) DO UPDATE SET
         search_count = user_search_history.search_count + 1,
         category_id = COALESCE($3, user_search_history.category_id),
         last_searched_at = NOW()`,
      [userId, normalizedTerm, categoryId || null]
    );

    res.status(200).json({ message: "Search recorded" });
  } catch (error) {
    console.error("Error recording search:", error);
    res.status(500).json({ error: "Failed to record search" });
  }
});

// =====================================================
// GET SEARCH HISTORY
// =====================================================
router.get("/preferences/search-history", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;

    const result = await db.query(
      `SELECT search_term, category_id, search_count, last_searched_at
       FROM user_search_history
       WHERE user_id = $1
       ORDER BY last_searched_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching search history:", error);
    res.status(500).json({ error: "Failed to fetch search history" });
  }
});

// =====================================================
// RECORD LISTING VIEW
// =====================================================
router.post("/preferences/view", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId } = req.body;

    if (!listingId) {
      return res.status(400).json({ error: "Listing ID required" });
    }

    await db.query(
      `INSERT INTO user_listing_views (user_id, listing_id, view_count, last_viewed_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (user_id, listing_id) DO UPDATE SET
         view_count = user_listing_views.view_count + 1,
         last_viewed_at = NOW()`,
      [userId, listingId]
    );

    res.status(200).json({ message: "View recorded" });
  } catch (error) {
    console.error("Error recording view:", error);
    res.status(500).json({ error: "Failed to record view" });
  }
});

// =====================================================
// GET PERSONALIZED LISTINGS
// =====================================================
router.get("/personalized-listings", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let hasPreferences = false;

    // Check if user has preferences (handle case when table doesn't exist)
    try {
      const prefsCheck = await db.query(
        `SELECT onboarding_complete FROM user_preferences WHERE user_id = $1`,
        [userId]
      );
      hasPreferences =
        prefsCheck.rows.length > 0 && prefsCheck.rows[0].onboarding_complete;
    } catch (prefError) {
      // Table might not exist, continue without personalization
      console.log("User preferences table not available:", prefError.message);
      hasPreferences = false;
    }

    let listings = [];
    let hasPersonalizedResults = false;

    if (hasPreferences) {
      try {
        // Get user's preferred categories (explicit + learned)
        const preferredCategories = await db.query(
          `SELECT DISTINCT category_id, 
                  CASE WHEN priority IS NOT NULL THEN priority + 100 ELSE affinity_score END as score
           FROM (
             SELECT category_id, priority, NULL as affinity_score 
             FROM user_category_preferences 
             WHERE user_id = $1
             UNION ALL
             SELECT category_id, NULL as priority, affinity_score 
             FROM user_category_affinity 
             WHERE user_id = $1
           ) combined
           ORDER BY score DESC
           LIMIT 15`,
          [userId]
        );

        const categoryIds = preferredCategories.rows.map((r) => r.category_id);

        if (categoryIds.length > 0) {
          // Get listings from preferred categories
          const personalizedResult = await db.query(
            `SELECT l.*, c.name as category_name,
                    u.id as user_id, u.name as username, u.verified as userverified, 
                    u.profilepictureurl as user_profile_picture,
                    CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified,
                    CASE 
                      WHEN l.categoryid = ANY($1::int[]) THEN 1 
                      ELSE 0 
                    END as is_preferred
             FROM userlistings l
             LEFT JOIN categories c ON l.categoryid = c.id
             LEFT JOIN users u ON l.userid = u.id
             LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
             WHERE l.moderation_status = 'approved'
             AND l.status = 'Available'
             ORDER BY 
               CASE WHEN l.categoryid = ANY($1::int[]) THEN 0 ELSE 1 END,
               l.createdat DESC
             LIMIT $2 OFFSET $3`,
            [categoryIds, limit, offset]
          );

          if (personalizedResult.rows.length > 0) {
            listings = personalizedResult.rows;
            hasPersonalizedResults = listings.some((l) => l.is_preferred === 1);
          }
        }
      } catch (prefQueryError) {
        console.log(
          "Error fetching personalized listings:",
          prefQueryError.message
        );
        hasPreferences = false;
      }
    }

    // If no personalized results, get regular listings
    if (listings.length === 0) {
      const regularResult = await db.query(
        `SELECT l.*, c.name as category_name,
                u.id as user_id, u.name as username, u.verified as userverified,
                u.profilepictureurl as user_profile_picture,
                CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified,
                0 as is_preferred
         FROM userlistings l
         LEFT JOIN categories c ON l.categoryid = c.id
         LEFT JOIN users u ON l.userid = u.id
         LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
         WHERE l.moderation_status = 'approved'
         AND l.status = 'Available'
         ORDER BY l.createdat DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      listings = regularResult.rows;
    }

    // Fetch images for each listing
    const listingsWithImages = await Promise.all(
      listings.map(async (listing) => {
        const imagesResult = await db.query(
          `SELECT * FROM imagelistings WHERE listingid = $1 ORDER BY is_main DESC`,
          [listing.id]
        );
        return {
          ...listing,
          images: imagesResult.rows,
        };
      })
    );

    res.status(200).json({
      listings: listingsWithImages,
      personalized: hasPersonalizedResults,
      page,
      limit,
    });
  } catch (error) {
    console.error("Error fetching personalized listings:", error);
    res.status(500).json({ error: "Failed to fetch personalized listings" });
  }
});

// =====================================================
// GET RECOMMENDED LISTINGS BASED ON SEARCH HISTORY
// =====================================================
router.get("/recommended-listings", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;

    // Get recent search terms
    const searchHistory = await db.query(
      `SELECT search_term, category_id
       FROM user_search_history
       WHERE user_id = $1
       ORDER BY last_searched_at DESC
       LIMIT 5`,
      [userId]
    );

    if (searchHistory.rows.length === 0) {
      return res.status(200).json({ listings: [], based_on: "none" });
    }

    // Build search pattern from recent searches
    const searchTerms = searchHistory.rows.map((r) => r.search_term);
    const categoryIds = searchHistory.rows
      .filter((r) => r.category_id)
      .map((r) => r.category_id);

    // Create search pattern
    const searchPattern = searchTerms.join("|");

    let queryText = `
      SELECT l.*, c.name as category_name,
             u.id as user_id, u.name as username, u.verified as userverified,
             u.profilepictureurl as user_profile_picture,
             CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified
      FROM userlistings l
      LEFT JOIN categories c ON l.categoryid = c.id
      LEFT JOIN users u ON l.userid = u.id
      LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
      WHERE l.moderation_status = 'approved'
      AND l.status = 'Available'
      AND (
        l.title ~* $1 
        OR l.description ~* $1
        OR l.tags::text ~* $1
    `;

    const queryParams = [searchPattern];
    let paramCount = 2;

    if (categoryIds.length > 0) {
      queryText += ` OR l.categoryid = ANY($${paramCount}::int[])`;
      queryParams.push(categoryIds);
      paramCount++;
    }

    queryText += `)
      ORDER BY l.createdat DESC
      LIMIT $${paramCount}`;
    queryParams.push(limit);

    const result = await db.query(queryText, queryParams);

    // Fetch images
    const listingsWithImages = await Promise.all(
      result.rows.map(async (listing) => {
        const imagesResult = await db.query(
          `SELECT * FROM imagelistings WHERE listingid = $1 ORDER BY is_main DESC`,
          [listing.id]
        );
        return {
          ...listing,
          images: imagesResult.rows,
        };
      })
    );

    res.status(200).json({
      listings: listingsWithImages,
      based_on: searchTerms,
    });
  } catch (error) {
    console.error("Error fetching recommended listings:", error);
    res.status(500).json({ error: "Failed to fetch recommendations" });
  }
});

// =====================================================
// SAVED SEARCHES (ALERTS)
// =====================================================
router.get("/preferences/saved-searches", authMiddleware, async (req, res) => {
  try {
    await ensureSavedSearchesTable();
    const userId = req.user.id;

    const result = await db.query(
      `SELECT id, name, filters, notify_new_listings, created_at
       FROM saved_searches
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    res.status(200).json({ savedSearches: result.rows });
  } catch (error) {
    console.error("Error fetching saved searches:", error);
    res.status(500).json({ error: "Failed to fetch saved searches" });
  }
});

router.post("/preferences/saved-searches", authMiddleware, async (req, res) => {
  try {
    await ensureSavedSearchesTable();
    const userId = req.user.id;
    const { name, filters, notifyNewListings = true } = req.body;

    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ error: "Search name is required" });
    }

    const normalized = normalizeSearchFilters(filters);
    if (!hasActiveFilters(normalized)) {
      return res.status(400).json({
        error: "Please add at least one filter before saving",
      });
    }

    const result = await db.query(
      `INSERT INTO saved_searches (user_id, name, filters, notify_new_listings)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, filters, notify_new_listings, created_at`,
      [userId, String(name).trim(), normalized, Boolean(notifyNewListings)]
    );

    res.status(201).json({ savedSearch: result.rows[0] });
  } catch (error) {
    console.error("Error saving search:", error);
    res.status(500).json({ error: "Failed to save search" });
  }
});

router.put(
  "/preferences/saved-searches/:id",
  authMiddleware,
  async (req, res) => {
    try {
      await ensureSavedSearchesTable();
      const userId = req.user.id;
      const { id } = req.params;
      const { name, filters, notifyNewListings } = req.body;

      const updates = [];
      const values = [];
      let idx = 1;

      if (name !== undefined) {
        updates.push(`name = $${idx++}`);
        values.push(String(name).trim());
      }

      if (filters !== undefined) {
        const normalized = normalizeSearchFilters(filters);
        updates.push(`filters = $${idx++}`);
        values.push(normalized);
      }

      if (notifyNewListings !== undefined) {
        updates.push(`notify_new_listings = $${idx++}`);
        values.push(Boolean(notifyNewListings));
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: "No updates provided" });
      }

      updates.push(`updated_at = NOW()`);
      values.push(userId, id);

      const result = await db.query(
        `UPDATE saved_searches
         SET ${updates.join(", ")}
         WHERE user_id = $${idx++} AND id = $${idx}
         RETURNING id, name, filters, notify_new_listings, created_at`,
        values
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Saved search not found" });
      }

      res.status(200).json({ savedSearch: result.rows[0] });
    } catch (error) {
      console.error("Error updating saved search:", error);
      res.status(500).json({ error: "Failed to update saved search" });
    }
  }
);

router.delete(
  "/preferences/saved-searches/:id",
  authMiddleware,
  async (req, res) => {
    try {
      await ensureSavedSearchesTable();
      const userId = req.user.id;
      const { id } = req.params;

      const result = await db.query(
        `DELETE FROM saved_searches WHERE user_id = $1 AND id = $2 RETURNING id`,
        [userId, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Saved search not found" });
      }

      res.status(200).json({ message: "Saved search deleted" });
    } catch (error) {
      console.error("Error deleting saved search:", error);
      res.status(500).json({ error: "Failed to delete saved search" });
    }
  }
);

// =====================================================
// SKIP ONBOARDING (for users who don't want to select)
// =====================================================
router.post(
  "/preferences/skip-onboarding",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;

      await db.query(
        `INSERT INTO user_preferences (user_id, onboarding_complete, updated_at)
       VALUES ($1, TRUE, NOW())
       ON CONFLICT (user_id) DO UPDATE SET 
         onboarding_complete = TRUE,
         updated_at = NOW()`,
        [userId]
      );

      res.status(200).json({ message: "Onboarding skipped" });
    } catch (error) {
      console.error("Error skipping onboarding:", error);
      res.status(500).json({ error: "Failed to skip onboarding" });
    }
  }
);

export default router;
