/**
 * Admin Listing Management Routes
 * ================================
 * This file handles all admin operations for listing moderation
 * including viewing, approving, and rejecting user listings.
 *
 * Routes:
 * - GET /api/admin/listings/pending - Get all pending listings
 * - GET /api/admin/listings/all - Get all listings with filters
 * - GET /api/admin/listings/stats - Get listing statistics
 * - GET /api/admin/listings/:id - Get single listing details
 * - PUT /api/admin/listings/:id/approve - Approve a listing
 * - PUT /api/admin/listings/:id/reject - Reject a listing
 */

import express from "express";
import dotenv from "dotenv";
dotenv.config();
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";

const router = express.Router();

const normalizeString = (value) =>
  value === null || value === undefined
    ? ""
    : String(value).toLowerCase().trim();

const listingMatchesSavedSearch = (listing, filters) => {
  let parsedFilters = filters;
  if (typeof filters === "string") {
    try {
      parsedFilters = JSON.parse(filters);
    } catch (error) {
      return false;
    }
  }
  if (!parsedFilters || typeof parsedFilters !== "object") return false;

  const search = normalizeString(parsedFilters.search);
  const category = normalizeString(parsedFilters.category);
  const country = normalizeString(parsedFilters.country);
  const city = normalizeString(parsedFilters.city);
  const currency = normalizeString(parsedFilters.currency);
  const condition = normalizeString(parsedFilters.condition);

  const minPrice = parsedFilters.minPrice
    ? Number(parsedFilters.minPrice)
    : null;
  const maxPrice = parsedFilters.maxPrice
    ? Number(parsedFilters.maxPrice)
    : null;

  const title = normalizeString(listing.title);
  const description = normalizeString(listing.description);
  const listingCategory = normalizeString(listing.categoryid);
  const listingCountry = normalizeString(listing.country);
  const listingCity = normalizeString(listing.city);
  const listingCurrency = normalizeString(listing.currency);
  const listingCondition = normalizeString(listing.condition);
  const listingPrice = Number(listing.price || 0);

  if (search && !title.includes(search) && !description.includes(search)) {
    return false;
  }

  if (category && listingCategory !== category) return false;
  if (country && listingCountry !== country) return false;
  if (city && listingCity !== city) return false;
  if (currency && listingCurrency !== currency) return false;
  if (condition && listingCondition !== condition) return false;

  if (minPrice !== null && listingPrice < minPrice) return false;
  if (maxPrice !== null && listingPrice > maxPrice) return false;

  return true;
};

// =====================================================
// MIDDLEWARE: Admin Authorization Check
// =====================================================
/**
 * Verifies that the authenticated user has admin privileges
 * This is an additional layer on top of authMiddleware
 */
const adminCheck = async (req, res, next) => {
  try {
    // Check if this is an env-based admin (has isAdmin flag or matching email)
    if (
      req.user.isAdmin === true ||
      req.user.email === process.env.ADMIN_EMAIL
    ) {
      return next();
    }

    // Check if user has admin role in database
    if (req.user.id) {
      const result = await db.query("SELECT role FROM users WHERE id = $1", [
        req.user.id,
      ]);

      if (result.rows.length > 0 && result.rows[0].role === "admin") {
        return next();
      }
    }

    return res.status(403).json({
      error: "Access denied. Admin privileges required.",
    });
  } catch (error) {
    console.error("Admin check error:", error);
    return res.status(500).json({ error: "Authorization check failed" });
  }
};

// =====================================================
// GET: Listing Statistics
// =====================================================
/**
 * Returns counts for each listing status
 * Useful for dashboard widgets and quick stats
 */
router.get(
  "/admin/listings/stats",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    try {
      const stats = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE moderation_status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE moderation_status = 'approved') as approved_count,
        COUNT(*) FILTER (WHERE moderation_status = 'rejected') as rejected_count,
        COUNT(*) as total_count
      FROM userlistings
    `);

      res.status(200).json({
        pending: parseInt(stats.rows[0].pending_count) || 0,
        approved: parseInt(stats.rows[0].approved_count) || 0,
        rejected: parseInt(stats.rows[0].rejected_count) || 0,
        total: parseInt(stats.rows[0].total_count) || 0,
      });
    } catch (error) {
      console.error("Error fetching listing stats:", error);
      res.status(500).json({ error: "Failed to fetch listing statistics" });
    }
  },
);

// =====================================================
// GET: All Pending Listings
// =====================================================
/**
 * Retrieves all listings waiting for admin review
 * Includes user info and images for each listing
 */
router.get(
  "/admin/listings/pending",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      // Get pending listings with user info
      const listingsResult = await db.query(
        `SELECT 
        l.*,
        c.name as category_name,
        u.name as username,
        u.email as useremail,
        u.verified as userverified,
        u.profilepictureurl as userprofilepicture,
        CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified
      FROM userlistings l
      LEFT JOIN categories c ON l.categoryid = c.id
      LEFT JOIN users u ON l.userid = u.id
      LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
      WHERE l.moderation_status = 'pending'
      ORDER BY l.createdat ASC
      LIMIT $1 OFFSET $2`,
        [parseInt(limit), offset],
      );

      // Get total count for pagination
      const countResult = await db.query(
        "SELECT COUNT(*) FROM userlistings WHERE moderation_status = 'pending'",
      );

      // Fetch images for each listing
      const listingsWithImages = await Promise.all(
        listingsResult.rows.map(async (listing) => {
          const imagesResult = await db.query(
            `SELECT * FROM imagelistings 
           WHERE listingid = $1 
           ORDER BY is_main DESC`,
            [listing.id],
          );
          return {
            ...listing,
            images: imagesResult.rows,
          };
        }),
      );

      res.status(200).json({
        listings: listingsWithImages,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].count),
          totalPages: Math.ceil(
            parseInt(countResult.rows[0].count) / parseInt(limit),
          ),
        },
      });
    } catch (error) {
      console.error("Error fetching pending listings:", error);
      res.status(500).json({ error: "Failed to fetch pending listings" });
    }
  },
);

// =====================================================
// GET: All Listings with Filters
// =====================================================
/**
 * Retrieves all listings with optional filtering
 * Supports status, category, search, and pagination
 */
router.get(
  "/admin/listings/all",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        category,
        search,
        sortBy = "createdat",
        sortOrder = "desc",
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);

      // Build dynamic query
      let queryText = `
      SELECT 
        l.*,
        c.name as category_name,
        u.name as username,
        u.email as useremail,
        u.verified as userverified,
        CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified,
        reviewer.name as reviewed_by_name
      FROM userlistings l
      LEFT JOIN categories c ON l.categoryid = c.id
      LEFT JOIN users u ON l.userid = u.id
      LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
      LEFT JOIN users reviewer ON l.reviewed_by = reviewer.id
      WHERE 1=1
    `;
      const queryParams = [];
      let paramCount = 1;

      // Filter by moderation status
      if (status && ["pending", "approved", "rejected"].includes(status)) {
        queryText += ` AND l.moderation_status = $${paramCount}`;
        queryParams.push(status);
        paramCount++;
      }

      // Filter by category
      if (category) {
        queryText += ` AND l.categoryid = $${paramCount}`;
        queryParams.push(parseInt(category));
        paramCount++;
      }

      // Search in title and description
      if (search) {
        queryText += ` AND (LOWER(l.title) LIKE LOWER($${paramCount}) OR LOWER(l.description) LIKE LOWER($${paramCount}))`;
        queryParams.push(`%${search}%`);
        paramCount++;
      }

      // Add sorting
      const validSortColumns = ["createdat", "title", "price", "reviewed_at"];
      const sortColumn = validSortColumns.includes(sortBy)
        ? sortBy
        : "createdat";
      const order = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";
      queryText += ` ORDER BY l.${sortColumn} ${order}`;

      // Add pagination
      queryText += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
      queryParams.push(parseInt(limit), offset);

      const listingsResult = await db.query(queryText, queryParams);

      // Get total count for pagination
      let countQuery = `
      SELECT COUNT(*) FROM userlistings l
      WHERE 1=1
    `;
      const countParams = [];
      let countParamNum = 1;

      if (status && ["pending", "approved", "rejected"].includes(status)) {
        countQuery += ` AND l.moderation_status = $${countParamNum}`;
        countParams.push(status);
        countParamNum++;
      }
      if (category) {
        countQuery += ` AND l.categoryid = $${countParamNum}`;
        countParams.push(parseInt(category));
        countParamNum++;
      }
      if (search) {
        countQuery += ` AND (LOWER(l.title) LIKE LOWER($${countParamNum}) OR LOWER(l.description) LIKE LOWER($${countParamNum}))`;
        countParams.push(`%${search}%`);
      }

      const countResult = await db.query(countQuery, countParams);

      // Fetch images for each listing
      const listingsWithImages = await Promise.all(
        listingsResult.rows.map(async (listing) => {
          const imagesResult = await db.query(
            `SELECT * FROM imagelistings 
           WHERE listingid = $1 
           ORDER BY is_main DESC 
           LIMIT 3`,
            [listing.id],
          );
          return {
            ...listing,
            images: imagesResult.rows,
          };
        }),
      );

      res.status(200).json({
        listings: listingsWithImages,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].count),
          totalPages: Math.ceil(
            parseInt(countResult.rows[0].count) / parseInt(limit),
          ),
        },
      });
    } catch (error) {
      console.error("Error fetching all listings:", error);
      res.status(500).json({ error: "Failed to fetch listings" });
    }
  },
);

// =====================================================
// GET: Single Listing Details
// =====================================================
/**
 * Retrieves detailed information about a specific listing
 * Includes all images and review history
 */
router.get(
  "/admin/listings/:id",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;

    try {
      // Get listing with user and category info
      const listingResult = await db.query(
        `SELECT 
        l.*,
        c.name as category_name,
        u.name as username,
        u.email as useremail,
        u.phone as userphone,
        u.verified as userverified,
        u.profilepictureurl as userprofilepicture,
        CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified,
        reviewer.name as reviewed_by_name
      FROM userlistings l
      LEFT JOIN categories c ON l.categoryid = c.id
      LEFT JOIN users u ON l.userid = u.id
      LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
      LEFT JOIN users reviewer ON l.reviewed_by = reviewer.id
      WHERE l.id = $1`,
        [id],
      );

      if (listingResult.rows.length === 0) {
        return res.status(404).json({ error: "Listing not found" });
      }

      // Get all images for the listing
      const imagesResult = await db.query(
        `SELECT * FROM imagelistings 
       WHERE listingid = $1 
       ORDER BY is_main DESC`,
        [id],
      );

      // Get review history
      const reviewsResult = await db.query(
        `SELECT 
        lr.*,
        u.name as admin_name
      FROM listing_reviews lr
      LEFT JOIN users u ON lr.admin_id = u.id
      WHERE lr.listing_id = $1
      ORDER BY lr.created_at DESC`,
        [id],
      );

      res.status(200).json({
        ...listingResult.rows[0],
        images: imagesResult.rows,
        reviewHistory: reviewsResult.rows,
      });
    } catch (error) {
      console.error("Error fetching listing details:", error);
      res.status(500).json({ error: "Failed to fetch listing details" });
    }
  },
);

// =====================================================
// PUT: Approve Listing
// =====================================================
/**
 * Approves a pending listing, making it visible in the marketplace
 * Creates an audit trail and sends notification to the user
 */
router.put(
  "/admin/listings/:id/approve",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;
    const { notes } = req.body;
    const adminId = req.user.id;

    try {
      // Check if listing exists and is pending
      const listingCheck = await db.query(
        "SELECT * FROM userlistings WHERE id = $1",
        [id],
      );

      if (listingCheck.rows.length === 0) {
        return res.status(404).json({ error: "Listing not found" });
      }

      const listing = listingCheck.rows[0];

      if (listing.moderation_status === "approved") {
        return res.status(400).json({ error: "Listing is already approved" });
      }

      // Update listing status
      const updateResult = await db.query(
        `UPDATE userlistings 
       SET moderation_status = 'approved', 
           rejection_reason = NULL,
           reviewed_by = $1, 
           reviewed_at = NOW()
       WHERE id = $2
       RETURNING *`,
        [adminId, id],
      );

      // Create audit trail entry
      await db.query(
        `INSERT INTO listing_reviews (listing_id, admin_id, action, notes, created_at)
       VALUES ($1, $2, 'approved', $3, NOW())`,
        [id, adminId, notes || null],
      );

      // Create notification for the listing owner
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          listing.userid,
          "Listing Approved! 🎉",
          `Your listing "${listing.title}" has been approved and is now visible in the marketplace.`,
          "listing_approved",
          id,
          "listing",
        ],
      );

      await sendPushToUser(
        listing.userid,
        buildNotificationPayload({
          title: "Listing Approved! 🎉",
          body: `Your listing "${listing.title}" has been approved and is now visible in the marketplace.`,
          type: "listing_approved",
          relatedId: id,
          relatedType: "listing",
        }),
      );

      // Notify all users who have favorited the listing owner
      try {
        const favoritesResult = await db.query(
          `SELECT uf.user_id, u.name as seller_name
           FROM user_favorites uf
           JOIN users u ON u.id = uf.favorite_user_id
           WHERE uf.favorite_user_id = $1 AND uf.notify_new_listings = true`,
          [listing.userid],
        );

        if (favoritesResult.rows.length > 0) {
          const sellerName = favoritesResult.rows[0].seller_name;
          const notificationPromises = favoritesResult.rows.map((fav) =>
            db.query(
              `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
               VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
              [
                fav.user_id,
                "New Listing from Favorite Seller ⭐",
                `${sellerName} just posted a new listing: "${listing.title}"`,
                "favorite_new_listing",
                id,
                "listing",
              ],
            ),
          );
          await Promise.all(notificationPromises);

          await Promise.all(
            favoritesResult.rows.map((fav) =>
              sendPushToUser(
                fav.user_id,
                buildNotificationPayload({
                  title: "New Listing from Favorite Seller ⭐",
                  body: `${sellerName} just posted a new listing: "${listing.title}"`,
                  type: "favorite_new_listing",
                  relatedId: id,
                  relatedType: "listing",
                }),
              ),
            ),
          );
          console.log(
            `Notified ${favoritesResult.rows.length} followers of new listing`,
          );
        }
      } catch (favError) {
        console.error("Error notifying favorites:", favError);
        // Don't fail the approval if notifications fail
      }

      // Notify users with saved searches
      try {
        const tableCheck = await db.query(
          "SELECT 1 FROM information_schema.tables WHERE table_name = 'saved_searches'",
        );

        if (tableCheck.rowCount > 0) {
          const savedSearches = await db.query(
            `SELECT id, user_id, name, filters
             FROM saved_searches
             WHERE notify_new_listings = TRUE`,
          );

          const notifications = savedSearches.rows
            .filter((saved) =>
              listingMatchesSavedSearch(listing, saved.filters),
            )
            .map((saved) =>
              db.query(
                `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [
                  saved.user_id,
                  "New Listing Alert 🔔",
                  `A new listing matches your saved search "${saved.name}": "${listing.title}"`,
                  "saved_search_match",
                  id,
                  "listing",
                ],
              ),
            );

          if (notifications.length > 0) {
            await Promise.all(notifications);

            await Promise.all(
              savedSearches.rows
                .filter((saved) =>
                  listingMatchesSavedSearch(listing, saved.filters),
                )
                .map((saved) =>
                  sendPushToUser(
                    saved.user_id,
                    buildNotificationPayload({
                      title: "New Listing Alert 🔔",
                      body: `A new listing matches your saved search "${saved.name}": "${listing.title}"`,
                      type: "saved_search_match",
                      relatedId: id,
                      relatedType: "listing",
                    }),
                  ),
                ),
            );
          }
        }
      } catch (searchError) {
        console.error("Error notifying saved searches:", searchError);
      }

      res.status(200).json({
        message: "Listing approved successfully",
        listing: updateResult.rows[0],
      });
    } catch (error) {
      console.error("Error approving listing:", error);
      res.status(500).json({ error: "Failed to approve listing" });
    }
  },
);

// =====================================================
// PUT: Reject Listing
// =====================================================
/**
 * Rejects a listing with a reason
 * The user can modify and resubmit after addressing the issues
 */
router.put(
  "/admin/listings/:id/reject",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;
    const { reason, notes } = req.body;
    const adminId = req.user.id;

    try {
      // Validate rejection reason
      if (!reason || reason.trim().length === 0) {
        return res.status(400).json({
          error: "Rejection reason is required",
        });
      }

      if (reason.length < 10) {
        return res.status(400).json({
          error:
            "Please provide a more detailed rejection reason (at least 10 characters)",
        });
      }

      // Check if listing exists
      const listingCheck = await db.query(
        "SELECT * FROM userlistings WHERE id = $1",
        [id],
      );

      if (listingCheck.rows.length === 0) {
        return res.status(404).json({ error: "Listing not found" });
      }

      const listing = listingCheck.rows[0];

      // Update listing status
      const updateResult = await db.query(
        `UPDATE userlistings 
       SET moderation_status = 'rejected', 
           rejection_reason = $1,
           reviewed_by = $2, 
           reviewed_at = NOW()
       WHERE id = $3
       RETURNING *`,
        [reason, adminId, id],
      );

      // Create audit trail entry
      await db.query(
        `INSERT INTO listing_reviews (listing_id, admin_id, action, reason, notes, created_at)
       VALUES ($1, $2, 'rejected', $3, $4, NOW())`,
        [id, adminId, reason, notes || null],
      );

      // Create notification for the listing owner
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          listing.userid,
          "Listing Needs Attention",
          `Your listing "${listing.title}" was not approved. Reason: ${reason}. Please update your listing and resubmit.`,
          "listing_rejected",
          id,
          "listing",
        ],
      );

      await sendPushToUser(
        listing.userid,
        buildNotificationPayload({
          title: "Listing Needs Attention",
          body: `Your listing "${listing.title}" was not approved. Reason: ${reason}. Please update your listing and resubmit.`,
          type: "listing_rejected",
          relatedId: id,
          relatedType: "listing",
        }),
      );

      res.status(200).json({
        message: "Listing rejected",
        listing: updateResult.rows[0],
      });
    } catch (error) {
      console.error("Error rejecting listing:", error);
      res.status(500).json({ error: "Failed to reject listing" });
    }
  },
);

// =====================================================
// PUT: Resubmit Listing (for users)
// =====================================================
/**
 * Allows users to resubmit a rejected listing for review
 * Resets the status to pending
 */
router.put("/admin/listings/:id/resubmit", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Check if listing exists and belongs to the user
    const listingCheck = await db.query(
      "SELECT * FROM userlistings WHERE id = $1 AND userid = $2",
      [id, userId],
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({
        error: "Listing not found or you don't have permission to modify it",
      });
    }

    const listing = listingCheck.rows[0];

    if (listing.moderation_status !== "rejected") {
      return res.status(400).json({
        error: "Only rejected listings can be resubmitted",
      });
    }

    // Update listing status to pending
    const updateResult = await db.query(
      `UPDATE userlistings 
       SET moderation_status = 'pending', 
           rejection_reason = NULL,
           reviewed_by = NULL, 
           reviewed_at = NULL
       WHERE id = $1
       RETURNING *`,
      [id],
    );

    res.status(200).json({
      message: "Listing resubmitted for review",
      listing: updateResult.rows[0],
    });
  } catch (error) {
    console.error("Error resubmitting listing:", error);
    res.status(500).json({ error: "Failed to resubmit listing" });
  }
});

export default router;
