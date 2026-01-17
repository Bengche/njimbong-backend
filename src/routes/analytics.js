import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";

const router = express.Router();

// Track a view event
router.post("/track/view", authMiddleware, async (req, res) => {
  const { listingId, source } = req.body;
  const viewerId = req.user?.id;

  try {
    // Don't track if user views their own listing
    const listingCheck = await db.query(
      "SELECT userid FROM userlistings WHERE id = $1",
      [listingId]
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const ownerId = listingCheck.rows[0].userid;

    // Still track the view even if it's their own listing (for testing), but mark it
    const isOwnView = ownerId === viewerId;

    // Update listing_analytics
    await db.query(
      `
      INSERT INTO listing_analytics (listing_id, views, last_viewed_at)
      VALUES ($1, 1, NOW())
      ON CONFLICT (listing_id) 
      DO UPDATE SET 
        views = listing_analytics.views + 1,
        last_viewed_at = NOW(),
        updated_at = NOW()
    `,
      [listingId]
    );

    // Record detailed event
    await db.query(
      `
      INSERT INTO analytics_events (listing_id, user_id, event_type, source, created_at)
      VALUES ($1, $2, 'view', $3, NOW())
    `,
      [listingId, isOwnView ? null : viewerId, source || "direct"]
    );

    // Update daily aggregates for the listing owner
    await db.query(
      `
      INSERT INTO user_analytics_daily (user_id, date, total_views, source_${
        source || "direct"
      })
      VALUES ($1, CURRENT_DATE, 1, 1)
      ON CONFLICT (user_id, date) 
      DO UPDATE SET 
        total_views = user_analytics_daily.total_views + 1,
        source_${source || "direct"} = user_analytics_daily.source_${
        source || "direct"
      } + 1
    `
        .replace(/source_direct/g, "source_direct")
        .replace(/source_search/g, "source_search")
        .replace(/source_browse/g, "source_browse")
        .replace(/source_external/g, "source_external"),
      [ownerId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error tracking view:", error);
    // Don't fail the request, just log the error
    res.json({ success: true, tracked: false });
  }
});

// Track a click event (contact, favorite, etc.)
router.post("/track/click", authMiddleware, async (req, res) => {
  const { listingId, clickType, source } = req.body;
  const clickerId = req.user?.id;

  try {
    const listingCheck = await db.query(
      "SELECT userid FROM userlistings WHERE id = $1",
      [listingId]
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const ownerId = listingCheck.rows[0].userid;

    // Update listing_analytics
    await db.query(
      `
      INSERT INTO listing_analytics (listing_id, clicks)
      VALUES ($1, 1)
      ON CONFLICT (listing_id) 
      DO UPDATE SET 
        clicks = listing_analytics.clicks + 1,
        updated_at = NOW()
    `,
      [listingId]
    );

    // Record detailed event
    await db.query(
      `
      INSERT INTO analytics_events (listing_id, user_id, event_type, source, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `,
      [listingId, clickerId, clickType || "click", source || "direct"]
    );

    // Update daily aggregates
    await db.query(
      `
      INSERT INTO user_analytics_daily (user_id, date, total_clicks)
      VALUES ($1, CURRENT_DATE, 1)
      ON CONFLICT (user_id, date) 
      DO UPDATE SET 
        total_clicks = user_analytics_daily.total_clicks + 1
    `,
      [ownerId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error tracking click:", error);
    res.json({ success: true, tracked: false });
  }
});

// Get user's analytics dashboard data
router.get("/dashboard", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    // Get total stats from all user's listings
    const totalStats = await db.query(
      `
      SELECT 
        COALESCE(SUM(la.views), 0) as total_views,
        COALESCE(SUM(la.clicks), 0) as total_clicks,
        COUNT(DISTINCT ul.id) as total_listings
      FROM userlistings ul
      LEFT JOIN listing_analytics la ON ul.id = la.listing_id
      WHERE ul.userid = $1
    `,
      [userId]
    );

    // Get revenue from sold items
    const revenueResult = await db.query(
      `
      SELECT COALESCE(SUM(price), 0) as total_revenue, currency
      FROM userlistings 
      WHERE userid = $1 AND status = 'Sold'
      GROUP BY currency
    `,
      [userId]
    );

    // Calculate total revenue (simplified - just sum all currencies)
    let totalRevenue = 0;
    revenueResult.rows.forEach((row) => {
      totalRevenue += parseFloat(row.total_revenue) || 0;
    });

    // Get 7-day performance data
    const last7Days = await db.query(
      `
      SELECT 
        date,
        total_views,
        total_clicks,
        source_search,
        source_browse,
        source_direct,
        source_external
      FROM user_analytics_daily
      WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY date ASC
    `,
      [userId]
    );

    // Fill in missing days with zeros
    const performanceData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];

      const dayData = last7Days.rows.find(
        (d) => new Date(d.date).toISOString().split("T")[0] === dateStr
      );

      performanceData.push({
        date: dateStr,
        day: date.toLocaleDateString("en-US", { weekday: "short" }),
        views: dayData?.total_views || 0,
        clicks: dayData?.total_clicks || 0,
      });
    }

    // Get traffic sources (last 30 days)
    const trafficSources = await db.query(
      `
      SELECT 
        COALESCE(SUM(source_search), 0) as search,
        COALESCE(SUM(source_browse), 0) as browse,
        COALESCE(SUM(source_direct), 0) as direct,
        COALESCE(SUM(source_external), 0) as external
      FROM user_analytics_daily
      WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '30 days'
    `,
      [userId]
    );

    // Get week-over-week trends
    const thisWeek = await db.query(
      `
      SELECT 
        COALESCE(SUM(total_views), 0) as views,
        COALESCE(SUM(total_clicks), 0) as clicks
      FROM user_analytics_daily
      WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '7 days'
    `,
      [userId]
    );

    const lastWeek = await db.query(
      `
      SELECT 
        COALESCE(SUM(total_views), 0) as views,
        COALESCE(SUM(total_clicks), 0) as clicks
      FROM user_analytics_daily
      WHERE user_id = $1 
        AND date >= CURRENT_DATE - INTERVAL '14 days'
        AND date < CURRENT_DATE - INTERVAL '7 days'
    `,
      [userId]
    );

    const thisWeekViews = parseInt(thisWeek.rows[0]?.views) || 0;
    const lastWeekViews = parseInt(lastWeek.rows[0]?.views) || 0;
    const thisWeekClicks = parseInt(thisWeek.rows[0]?.clicks) || 0;
    const lastWeekClicks = parseInt(lastWeek.rows[0]?.clicks) || 0;

    const viewsTrend =
      lastWeekViews > 0
        ? Math.round(((thisWeekViews - lastWeekViews) / lastWeekViews) * 100)
        : thisWeekViews > 0
        ? 100
        : 0;

    const clicksTrend =
      lastWeekClicks > 0
        ? Math.round(((thisWeekClicks - lastWeekClicks) / lastWeekClicks) * 100)
        : thisWeekClicks > 0
        ? 100
        : 0;

    // Get top performing listings
    const topListings = await db.query(
      `
      SELECT 
        ul.id,
        ul.title,
        ul.price,
        ul.currency,
        ul.status,
        COALESCE(la.views, 0) as views,
        COALESCE(la.clicks, 0) as clicks,
        CASE WHEN la.views > 0 THEN ROUND((la.clicks::numeric / la.views) * 100, 1) ELSE 0 END as ctr,
        (SELECT imageurl FROM imagelistings WHERE listingid = ul.id ORDER BY is_main DESC LIMIT 1) as image
      FROM userlistings ul
      LEFT JOIN listing_analytics la ON ul.id = la.listing_id
      WHERE ul.userid = $1
      ORDER BY COALESCE(la.views, 0) DESC
      LIMIT 5
    `,
      [userId]
    );

    // Get active listings count
    const activeListings = await db.query(
      `
      SELECT COUNT(*) as count FROM userlistings 
      WHERE userid = $1 AND status = 'Available' AND moderation_status = 'approved'
    `,
      [userId]
    );

    // Calculate CTR
    const totalViews = parseInt(totalStats.rows[0]?.total_views) || 0;
    const totalClicks = parseInt(totalStats.rows[0]?.total_clicks) || 0;
    const ctr =
      totalViews > 0 ? ((totalClicks / totalViews) * 100).toFixed(1) : 0;

    res.json({
      overview: {
        totalViews: totalViews,
        totalClicks: totalClicks,
        ctr: parseFloat(ctr),
        totalListings: parseInt(totalStats.rows[0]?.total_listings) || 0,
        activeListings: parseInt(activeListings.rows[0]?.count) || 0,
        totalRevenue: totalRevenue,
      },
      trends: {
        views: viewsTrend,
        clicks: clicksTrend,
      },
      performanceData: performanceData,
      trafficSources: {
        search: parseInt(trafficSources.rows[0]?.search) || 0,
        browse: parseInt(trafficSources.rows[0]?.browse) || 0,
        direct: parseInt(trafficSources.rows[0]?.direct) || 0,
        external: parseInt(trafficSources.rows[0]?.external) || 0,
      },
      topListings: topListings.rows,
    });
  } catch (error) {
    console.error("Error fetching analytics dashboard:", error);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// Initialize analytics for existing listings (run once)
router.post("/initialize", authMiddleware, async (req, res) => {
  try {
    // Create analytics entries for all listings that don't have one
    await db.query(`
      INSERT INTO listing_analytics (listing_id, views, clicks, created_at)
      SELECT id, 0, 0, NOW()
      FROM userlistings
      WHERE id NOT IN (SELECT listing_id FROM listing_analytics WHERE listing_id IS NOT NULL)
    `);

    res.json({ success: true, message: "Analytics initialized" });
  } catch (error) {
    console.error("Error initializing analytics:", error);
    res.status(500).json({ error: "Failed to initialize analytics" });
  }
});

// =====================================================
// GET: Top selling items by category
// Shows what's popular/selling well in each category
// =====================================================
router.get("/top-sellers", async (req, res) => {
  try {
    const { limit = 4 } = req.query;

    // Get all categories with their top performing listings
    const categoriesResult = await db.query(`
      SELECT id, name FROM categories ORDER BY name ASC
    `);

    const topSellersByCategory = [];

    for (const category of categoriesResult.rows) {
      // Get top listings in this category based on views, clicks, and sales
      const topListings = await db.query(
        `
        SELECT 
          l.id,
          l.title,
          l.price,
          l.currency,
          l.status,
          l.createdat,
          c.name as category_name,
          u.name as seller_name,
          u.profilepictureurl as seller_picture,
          CASE WHEN kyc.status = 'approved' THEN true ELSE false END as seller_verified,
          COALESCE(la.views, 0) as views,
          COALESCE(la.clicks, 0) as clicks,
          (SELECT imageurl FROM imagelistings WHERE listingid = l.id AND is_main = true LIMIT 1) as image,
          -- Calculate a "hotness" score based on views, clicks, recency, and if sold
          (
            COALESCE(la.views, 0) * 1 + 
            COALESCE(la.clicks, 0) * 3 + 
            CASE WHEN l.status = 'Sold' THEN 50 ELSE 0 END +
            CASE WHEN l.createdat > NOW() - INTERVAL '7 days' THEN 20 ELSE 0 END +
            CASE WHEN l.createdat > NOW() - INTERVAL '1 day' THEN 10 ELSE 0 END
          ) as hotness_score
        FROM userlistings l
        LEFT JOIN categories c ON l.categoryid = c.id
        LEFT JOIN users u ON l.userid = u.id
        LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
        LEFT JOIN listing_analytics la ON l.id = la.listing_id
        WHERE l.categoryid = $1
        AND l.moderation_status = 'approved'
        ORDER BY hotness_score DESC, l.createdat DESC
        LIMIT $2
      `,
        [category.id, parseInt(limit)]
      );

      if (topListings.rows.length > 0) {
        topSellersByCategory.push({
          category: {
            id: category.id,
            name: category.name,
          },
          listings: topListings.rows.map((listing) => ({
            id: listing.id,
            title: listing.title,
            price: listing.price,
            currency: listing.currency,
            status: listing.status,
            image: listing.image,
            views: parseInt(listing.views) || 0,
            clicks: parseInt(listing.clicks) || 0,
            seller: {
              name: listing.seller_name,
              picture: listing.seller_picture,
              verified: listing.seller_verified,
            },
            isSold: listing.status === "Sold",
            isHot: parseInt(listing.hotness_score) > 30,
          })),
        });
      }
    }

    res.json({
      topSellers: topSellersByCategory,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching top sellers:", error);
    res.status(500).json({ error: "Failed to fetch top sellers" });
  }
});

// =====================================================
// GET: Trending items across all categories
// =====================================================
router.get("/trending", async (req, res) => {
  try {
    const { limit = 12 } = req.query;

    const trendingListings = await db.query(
      `
      SELECT 
        l.id,
        l.title,
        l.price,
        l.currency,
        l.status,
        l.createdat,
        c.id as category_id,
        c.name as category_name,
        u.name as seller_name,
        u.profilepictureurl as seller_picture,
        CASE WHEN kyc.status = 'approved' THEN true ELSE false END as seller_verified,
        COALESCE(la.views, 0) as views,
        COALESCE(la.clicks, 0) as clicks,
        (SELECT imageurl FROM imagelistings WHERE listingid = l.id AND is_main = true LIMIT 1) as image,
        -- Calculate trending score with emphasis on recent activity
        (
          COALESCE(la.views, 0) * 1 + 
          COALESCE(la.clicks, 0) * 5 + 
          CASE WHEN l.status = 'Sold' THEN 100 ELSE 0 END +
          CASE WHEN l.createdat > NOW() - INTERVAL '24 hours' THEN 50 ELSE 0 END +
          CASE WHEN l.createdat > NOW() - INTERVAL '3 days' THEN 30 ELSE 0 END +
          CASE WHEN l.createdat > NOW() - INTERVAL '7 days' THEN 10 ELSE 0 END
        ) as trending_score
      FROM userlistings l
      LEFT JOIN categories c ON l.categoryid = c.id
      LEFT JOIN users u ON l.userid = u.id
      LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
      LEFT JOIN listing_analytics la ON l.id = la.listing_id
      WHERE l.moderation_status = 'approved'
      AND l.status = 'Available'
      ORDER BY trending_score DESC, l.createdat DESC
      LIMIT $1
    `,
      [parseInt(limit)]
    );

    res.json({
      trending: trendingListings.rows.map((listing) => ({
        id: listing.id,
        title: listing.title,
        price: listing.price,
        currency: listing.currency,
        image: listing.image,
        category: {
          id: listing.category_id,
          name: listing.category_name,
        },
        views: parseInt(listing.views) || 0,
        clicks: parseInt(listing.clicks) || 0,
        seller: {
          name: listing.seller_name,
          picture: listing.seller_picture,
          verified: listing.seller_verified,
        },
        trendingScore: parseInt(listing.trending_score) || 0,
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching trending items:", error);
    res.status(500).json({ error: "Failed to fetch trending items" });
  }
});

export default router;
