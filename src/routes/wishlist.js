import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";

const router = express.Router();

const ensureWishlistTables = async () => {
  await db.query(
    `CREATE TABLE IF NOT EXISTS wishlist_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      listing_id INTEGER NOT NULL,
      notify_price_drop BOOLEAN DEFAULT TRUE,
      last_seen_price NUMERIC,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, listing_id)
    )`,
  );
};

const getListing = async (listingId) => {
  const result = await db.query(
    `SELECT id, title, price, currency, status, moderation_status, userid
     FROM userlistings
     WHERE id = $1`,
    [listingId],
  );
  return result.rows[0] || null;
};

// =====================================================
// GET: Wishlist listing IDs (quick lookup)
// =====================================================
router.get("/wishlist/ids", authMiddleware, async (req, res) => {
  try {
    await ensureWishlistTables();
    const userId = req.user.id;
    const result = await db.query(
      `SELECT listing_id FROM wishlist_items WHERE user_id = $1`,
      [userId],
    );
    res.status(200).json({
      listingIds: result.rows.map((row) => row.listing_id),
    });
  } catch (error) {
    console.error("Error fetching wishlist ids:", error);
    res.status(500).json({ error: "Failed to fetch wishlist ids" });
  }
});

// =====================================================
// GET: Check if listing is wishlisted
// =====================================================
router.get("/wishlist/:listingId/check", authMiddleware, async (req, res) => {
  try {
    await ensureWishlistTables();
    const userId = req.user.id;
    const { listingId } = req.params;

    const result = await db.query(
      `SELECT id, notify_price_drop FROM wishlist_items WHERE user_id = $1 AND listing_id = $2`,
      [userId, listingId],
    );

    res.status(200).json({
      isWishlisted: result.rows.length > 0,
      notify_price_drop: result.rows[0]?.notify_price_drop ?? false,
    });
  } catch (error) {
    console.error("Error checking wishlist:", error);
    res.status(500).json({ error: "Failed to check wishlist" });
  }
});

// =====================================================
// POST: Add listing to wishlist
// =====================================================
router.post("/wishlist/:listingId", authMiddleware, async (req, res) => {
  try {
    await ensureWishlistTables();
    const userId = req.user.id;
    const { listingId } = req.params;

    const listing = await getListing(listingId);
    if (!listing) {
      return res.status(404).json({ error: "Listing not found" });
    }

    if (listing.moderation_status !== "approved") {
      return res.status(400).json({ error: "Listing is not approved" });
    }

    await db.query(
      `INSERT INTO wishlist_items (user_id, listing_id, last_seen_price)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, listing_id) DO NOTHING`,
      [userId, listingId, listing.price],
    );

    res.status(201).json({ message: "Listing added to wishlist" });
  } catch (error) {
    console.error("Error adding wishlist item:", error);
    res.status(500).json({ error: "Failed to add wishlist item" });
  }
});

// =====================================================
// DELETE: Remove listing from wishlist
// =====================================================
router.delete("/wishlist/:listingId", authMiddleware, async (req, res) => {
  try {
    await ensureWishlistTables();
    const userId = req.user.id;
    const { listingId } = req.params;

    const result = await db.query(
      `DELETE FROM wishlist_items WHERE user_id = $1 AND listing_id = $2 RETURNING id`,
      [userId, listingId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Wishlist item not found" });
    }

    res.status(200).json({ message: "Listing removed from wishlist" });
  } catch (error) {
    console.error("Error removing wishlist item:", error);
    res.status(500).json({ error: "Failed to remove wishlist item" });
  }
});

// =====================================================
// PUT: Toggle price drop alerts
// =====================================================
router.put(
  "/wishlist/:listingId/price-alert",
  authMiddleware,
  async (req, res) => {
    try {
      await ensureWishlistTables();
      const userId = req.user.id;
      const { listingId } = req.params;
      const { notify } = req.body;

      const result = await db.query(
        `UPDATE wishlist_items
         SET notify_price_drop = $1, updated_at = NOW()
         WHERE user_id = $2 AND listing_id = $3
         RETURNING *`,
        [Boolean(notify), userId, listingId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Wishlist item not found" });
      }

      res.status(200).json({
        message: "Price drop alert updated",
        notify_price_drop: result.rows[0].notify_price_drop,
      });
    } catch (error) {
      console.error("Error updating price alert:", error);
      res.status(500).json({ error: "Failed to update price alert" });
    }
  },
);

// =====================================================
// GET: Wishlist listings
// =====================================================
router.get("/wishlist", authMiddleware, async (req, res) => {
  try {
    await ensureWishlistTables();
    const userId = req.user.id;
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT wi.id as wishlist_id,
              wi.notify_price_drop,
              wi.last_seen_price,
              wi.created_at as wishlisted_at,
              l.*, c.name as category_name,
              u.name as seller_name,
              u.id as seller_id,
              u.profilepictureurl as seller_picture
       FROM wishlist_items wi
       JOIN userlistings l ON wi.listing_id = l.id
       LEFT JOIN categories c ON l.categoryid = c.id
       LEFT JOIN users u ON l.userid = u.id
       WHERE wi.user_id = $1
       ORDER BY wi.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    const listingsWithImages = await Promise.all(
      result.rows.map(async (listing) => {
        const imagesResult = await db.query(
          `SELECT * FROM imagelistings
           WHERE listingid = $1
           ORDER BY is_main DESC`,
          [listing.id],
        );

        const priceDropped =
          listing.last_seen_price !== null &&
          Number(listing.price) < Number(listing.last_seen_price);

        return {
          ...listing,
          images: imagesResult.rows,
          price_dropped: priceDropped,
        };
      }),
    );

    // Check for price drops and notify
    const priceDropNotifications = [];
    const priceDropPushes = [];
    for (const listing of listingsWithImages) {
      if (listing.notify_price_drop && listing.price_dropped) {
        priceDropNotifications.push(
          db.query(
            `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
              userId,
              "Price Dropped 🔻",
              `The price for "${listing.title}" dropped from ${listing.last_seen_price} to ${listing.price}.`,
              "price_drop",
              listing.id,
              "listing",
            ],
          ),
        );

        priceDropPushes.push(
          sendPushToUser(
            userId,
            buildNotificationPayload({
              title: "Price Dropped 🔻",
              body: `The price for "${listing.title}" dropped from ${listing.last_seen_price} to ${listing.price}.`,
              type: "price_drop",
              relatedId: listing.id,
              relatedType: "listing",
            }),
          ),
        );

        await db.query(
          `UPDATE wishlist_items
           SET last_seen_price = $1, updated_at = NOW()
           WHERE user_id = $2 AND listing_id = $3`,
          [listing.price, userId, listing.id],
        );
      }
    }

    if (priceDropNotifications.length > 0) {
      await Promise.all(priceDropNotifications);
      await Promise.all(priceDropPushes);
    }

    res.status(200).json({
      listings: listingsWithImages,
    });
  } catch (error) {
    console.error("Error fetching wishlist:", error);
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
});

export default router;
