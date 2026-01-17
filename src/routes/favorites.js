/**
 * Favorites Routes
 * ================
 * Handles user favorites functionality - adding/removing favorite users,
 * getting favorite users list, and listings from favorite users.
 */

import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";

const router = express.Router();

// =====================================================
// GET: Check if user is favorited
// =====================================================
router.get("/favorites/:userId/check", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const currentUserId = req.user.id;

  try {
    const result = await db.query(
      "SELECT id FROM user_favorites WHERE user_id = $1 AND favorite_user_id = $2",
      [currentUserId, userId]
    );

    res.status(200).json({
      isFavorited: result.rows.length > 0,
    });
  } catch (error) {
    console.error("Error checking favorite status:", error);
    res.status(500).json({ error: "Failed to check favorite status" });
  }
});

// =====================================================
// POST: Add user to favorites
// =====================================================
router.post("/favorites/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const currentUserId = req.user.id;

  try {
    // Can't favorite yourself
    if (parseInt(userId) === currentUserId) {
      return res.status(400).json({ error: "You cannot favorite yourself" });
    }

    // Check if user exists
    const userCheck = await db.query(
      "SELECT id, name FROM users WHERE id = $1",
      [userId]
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if already favorited
    const existingFavorite = await db.query(
      "SELECT id FROM user_favorites WHERE user_id = $1 AND favorite_user_id = $2",
      [currentUserId, userId]
    );

    if (existingFavorite.rows.length > 0) {
      return res
        .status(400)
        .json({ error: "User is already in your favorites" });
    }

    // Add to favorites
    await db.query(
      "INSERT INTO user_favorites (user_id, favorite_user_id, created_at) VALUES ($1, $2, NOW())",
      [currentUserId, userId]
    );

    res.status(201).json({
      message: "User added to favorites",
      favoriteUserId: parseInt(userId),
    });
  } catch (error) {
    console.error("Error adding favorite:", error);
    res.status(500).json({ error: "Failed to add user to favorites" });
  }
});

// =====================================================
// DELETE: Remove user from favorites
// =====================================================
router.delete("/favorites/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const currentUserId = req.user.id;

  try {
    const result = await db.query(
      "DELETE FROM user_favorites WHERE user_id = $1 AND favorite_user_id = $2 RETURNING id",
      [currentUserId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User was not in your favorites" });
    }

    res.status(200).json({
      message: "User removed from favorites",
    });
  } catch (error) {
    console.error("Error removing favorite:", error);
    res.status(500).json({ error: "Failed to remove user from favorites" });
  }
});

// =====================================================
// GET: Get all favorite users
// =====================================================
router.get("/favorites", authMiddleware, async (req, res) => {
  const currentUserId = req.user.id;
  const { limit = 50, offset = 0 } = req.query;

  try {
    const columnsResult = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
    );
    const columns = new Set(columnsResult.rows.map((row) => row.column_name));
    const suspensionSelect = columns.has("is_suspended")
      ? "u.is_suspended as user_is_suspended"
      : "false as user_is_suspended";

    const result = await db.query(
      `SELECT 
        uf.id as favorite_id,
        uf.created_at as favorited_at,
        u.id,
        u.name,
        u.email,
        u.profilepictureurl,
        u.verified,
        ${suspensionSelect},
        u.country,
        CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified,
        (SELECT COUNT(*) FROM userlistings WHERE userid = u.id AND moderation_status = 'approved' AND status = 'Available') as active_listings
       FROM user_favorites uf
       JOIN users u ON uf.favorite_user_id = u.id
       LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
       WHERE uf.user_id = $1
       ORDER BY uf.created_at DESC
       LIMIT $2 OFFSET $3`,
      [currentUserId, limit, offset]
    );

    // Get total count
    const countResult = await db.query(
      "SELECT COUNT(*) FROM user_favorites WHERE user_id = $1",
      [currentUserId]
    );

    res.status(200).json({
      favorites: result.rows,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error("Error fetching favorites:", error);
    res.status(500).json({ error: "Failed to fetch favorites" });
  }
});

// =====================================================
// GET: Get listings from favorite users
// =====================================================
router.get("/favorites/listings", authMiddleware, async (req, res) => {
  const currentUserId = req.user.id;
  const { limit = 20, offset = 0 } = req.query;

  try {
    const columnsResult = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
    );
    const columns = new Set(columnsResult.rows.map((row) => row.column_name));
    const suspensionSelect = columns.has("is_suspended")
      ? "u.is_suspended as user_is_suspended"
      : "false as user_is_suspended";

    // Get listings from favorite users, prioritized by newest first
    const result = await db.query(
      `SELECT 
        l.*,
        c.name as category_name,
        u.id as user_id,
        u.name as username,
        u.verified as userverified,
        u.profilepictureurl as user_profile_picture,
        ${suspensionSelect},
        CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified,
        uf.created_at as favorited_at
       FROM userlistings l
       JOIN user_favorites uf ON l.userid = uf.favorite_user_id
       JOIN users u ON l.userid = u.id
       LEFT JOIN categories c ON l.categoryid = c.id
       LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
       WHERE uf.user_id = $1
         AND l.moderation_status = 'approved'
         AND l.status = 'Available'
       ORDER BY l.createdat DESC
       LIMIT $2 OFFSET $3`,
      [currentUserId, limit, offset]
    );

    // Fetch images for each listing
    const listingsWithImages = await Promise.all(
      result.rows.map(async (listing) => {
        const imagesResult = await db.query(
          `SELECT * FROM imagelistings 
           WHERE listingid = $1 
           ORDER BY is_main DESC`,
          [listing.id]
        );
        return {
          ...listing,
          images: imagesResult.rows,
        };
      })
    );

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) FROM userlistings l
       JOIN user_favorites uf ON l.userid = uf.favorite_user_id
       WHERE uf.user_id = $1 AND l.moderation_status = 'approved' AND l.status = 'Available'`,
      [currentUserId]
    );

    res.status(200).json({
      listings: listingsWithImages,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error("Error fetching favorite user listings:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch listings from favorite users" });
  }
});

// =====================================================
// GET: Get favorite users count
// =====================================================
router.get("/favorites/count", authMiddleware, async (req, res) => {
  const currentUserId = req.user.id;

  try {
    const result = await db.query(
      "SELECT COUNT(*) FROM user_favorites WHERE user_id = $1",
      [currentUserId]
    );

    res.status(200).json({
      count: parseInt(result.rows[0].count),
    });
  } catch (error) {
    console.error("Error fetching favorites count:", error);
    res.status(500).json({ error: "Failed to fetch favorites count" });
  }
});

// =====================================================
// Helper: Notify followers when user creates listing
// This will be called from listings.js when a listing is approved
// =====================================================
export const notifyFollowers = async (userId, listingId, listingTitle) => {
  try {
    // Get all users who have this user as a favorite
    const followers = await db.query(
      `SELECT uf.user_id, u.name as follower_name
       FROM user_favorites uf
       JOIN users u ON uf.user_id = u.id
       WHERE uf.favorite_user_id = $1`,
      [userId]
    );

    // Get the seller's name
    const sellerResult = await db.query(
      "SELECT name FROM users WHERE id = $1",
      [userId]
    );
    const sellerName = sellerResult.rows[0]?.name || "A seller you follow";

    // Create notifications for each follower
    for (const follower of followers.rows) {
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          follower.user_id,
          "⭐ New Listing from Favorite Seller",
          `${sellerName} just posted a new listing: "${listingTitle}"`,
          "favorite_listing",
          listingId,
          "listing",
        ]
      );
    }

    return followers.rows.length;
  } catch (error) {
    console.error("Error notifying followers:", error);
    return 0;
  }
};

export default router;
