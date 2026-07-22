import express from "express";
import db from "../db.js";
import cloudinary from "../storage/cloudinary.js";
import multer from "multer";
import authMiddleware from "../Middleware/authMiddleware.js";
import optionalAuthMiddleware from "../Middleware/optionalAuthMiddleware.js";
import { blockIfSuspended } from "../Middleware/suspensionMiddleware.js";
import {
  sendListingSubmittedAdmin,
  sendPriceDropAlert,
  sendNewListingFromFollowed,
} from "../utils/email.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";

const router = express.Router();

// ─── One-time DB setup ────────────────────────────────────────────────────────
let _colsEnsured = false;
const ensureListingColumns = async () => {
  if (_colsEnsured) return;
  await db.query(
    `ALTER TABLE userlistings ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0`,
  );
  await db.query(
    `ALTER TABLE userlistings ADD COLUMN IF NOT EXISTS is_draft BOOLEAN DEFAULT FALSE`,
  );
  await db.query(
    `ALTER TABLE userlistings ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(20) DEFAULT 'pickup'`,
  );
  await db.query(
    `ALTER TABLE userlistings ADD COLUMN IF NOT EXISTS delivery_notes TEXT`,
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS search_logs (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      query      TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS seller_followers (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seller_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (follower_id, seller_id)
    )
  `);
  _colsEnsured = true;
};

const getUserSuspensionSelect = async () => {
  const result = await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'",
  );
  const columns = new Set(result.rows.map((row) => row.column_name));
  return columns.has("is_suspended")
    ? "u.is_suspended as user_is_suspended"
    : "false as user_is_suspended";
};

// Configure multer for memory storage (we'll upload to Cloudinary)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Create a new listing with multiple images
// Suspended users cannot create listings
router.post(
  "/listings",
  authMiddleware,
  blockIfSuspended,
  upload.array("images", 10),
  async (req, res) => {
    await ensureListingColumns();
    const {
      title,
      description,
      price,
      currency,
      categoryId,
      location,
      country,
      city,
      condition,
      phone,
      tags,
      status,
      seller_email,
      is_draft,
      delivery_type,
      delivery_notes,
    } = req.body;

    try {
      // Log incoming data for debugging
      console.log("Creating listing with data:", {
        userId: req.user?.id,
        title,
        description,
        price,
        currency,
        categoryId,
        location,
        country,
        city,
        condition,
        phone,
        seller_email,
        tags,
        status,
        filesCount: req.files?.length,
      });

      // Validate required fields
      if (
        !title ||
        !description ||
        !price ||
        !categoryId ||
        !country ||
        !city ||
        !phone
      ) {
        console.log("Missing required fields check failed:", {
          title: !!title,
          description: !!description,
          price: !!price,
          categoryId: !!categoryId,
          country: !!country,
          city: !!city,
          phone: !!phone,
        });
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Get user ID from auth middleware
      const userId = req.user.id;

      // Insert the listing into the database first
      // Convert tags string to array if tags column is array type
      const tagsArray = tags
        ? tags
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag)
        : [];

      const isDraft = is_draft === "true" || is_draft === true;
      const moderationStatus = isDraft ? "draft" : "pending";

      // New listings start with 'pending' moderation status
      const listingResult = await db.query(
        `INSERT INTO userlistings 
       (userid, title, description, price, currency, categoryid, location, country, city, condition, phone, seller_email, tags, status, moderation_status, is_draft, delivery_type, delivery_notes, createdat) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW()) 
       RETURNING *`,
        [
          userId,
          title,
          description,
          price,
          currency || "USD",
          categoryId,
          location || "",
          country,
          city,
          condition || "new",
          phone,
          seller_email || null,
          tagsArray,
          status || "Available",
          moderationStatus,
          isDraft,
          delivery_type || "pickup",
          delivery_notes || null,
        ],
      );

      const listingId = listingResult.rows[0].id;

      // Upload images to Cloudinary and save to imagelistings table
      const uploadedImages = [];
      if (req.files && req.files.length > 0) {
        for (let i = 0; i < req.files.length; i++) {
          const file = req.files[i];
          try {
            // Upload to Cloudinary using buffer
            const result = await new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                {
                  folder: "marketplace/listings",
                  resource_type: "image",
                },
                (error, result) => {
                  if (error) reject(error);
                  else resolve(result);
                },
              );
              uploadStream.end(file.buffer);
            });

            // Insert into imagelistings table
            const imageResult = await db.query(
              `INSERT INTO imagelistings 
             (listingid, imageurl, is_main, created_at, updated_at) 
             VALUES ($1, $2, $3, NOW(), NOW()) 
             RETURNING *`,
              [listingId, result.secure_url, i === 0], // First image is main
            );

            uploadedImages.push(imageResult.rows[0]);
          } catch (uploadError) {
            console.error("Error uploading image to Cloudinary:", uploadError);
          }
        }
      }

      // Notify admin about new listing (skip for drafts)
      const posterResult = await db.query(
        "SELECT id, name, email FROM users WHERE id = $1",
        [req.user.id],
      );
      if (posterResult.rows.length > 0 && !isDraft) {
        sendListingSubmittedAdmin(posterResult.rows[0], listingResult.rows[0]);

        // Notify followers of this seller
        try {
          const followersRes = await db.query(
            `SELECT f.follower_id, u.name AS follower_name, u.email AS follower_email
             FROM seller_followers f
             JOIN users u ON u.id = f.follower_id
             WHERE f.seller_id = $1`,
            [req.user.id],
          );
          const seller = posterResult.rows[0];
          const listing = listingResult.rows[0];
          for (const follower of followersRes.rows) {
            sendPushToUser(
              follower.follower_id,
              buildNotificationPayload("new_listing_from_followed", {
                title: `${seller.name} posted a new listing`,
                body: `"${listing.title}" — ${Number(listing.price).toLocaleString()} ${listing.currency}`,
                url: `/listing/${listing.id}`,
              }),
            );
            sendNewListingFromFollowed(
              { name: follower.follower_name, email: follower.follower_email },
              { id: seller.id, name: seller.name },
              listing,
            );
          }
        } catch (followerErr) {
          console.warn(
            "[Listings] Follower notify error:",
            followerErr.message,
          );
        }
      }

      res.status(201).json({
        message: "Listing created successfully",
        listing: listingResult.rows[0],
        uploadedImages: uploadedImages.length,
        images: uploadedImages,
      });
    } catch (error) {
      console.error("Error creating listing:", error.message);
      console.error("Error details:", error);
      console.error("PostgreSQL error code:", error.code);
      console.error("PostgreSQL error detail:", error.detail);
      console.error("PostgreSQL error constraint:", error.constraint);
      res
        .status(500)
        .json({ error: "Failed to create listing", details: error.message });
    }
  },
);

// Get current user's listings (includes all moderation statuses, including drafts)
router.get("/my-listings", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    await ensureListingColumns();

    const listingsResult = await db.query(
      `SELECT l.*, c.name as category_name
       FROM userlistings l 
       LEFT JOIN categories c ON l.categoryid = c.id 
       WHERE l.userid = $1
       ORDER BY l.createdat DESC`,
      [userId],
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

    res.status(200).json(listingsWithImages);
  } catch (error) {
    console.error("Error fetching user listings:", error);
    res.status(500).json({ error: "Failed to fetch your listings" });
  }
});

// Get all listings with images and filters
router.get("/listings", authMiddleware, async (req, res) => {
  await ensureListingColumns();
  try {
    const {
      category,
      search,
      country,
      city,
      minPrice,
      maxPrice,
      currency,
      condition,
    } = req.query;

    // Build dynamic query - include user's verification status and profile info
    // Only show approved and available (not sold) listings to the public
    // Include KYC verification status by joining with kyc_verifications table
    const userSuspensionSelect = await getUserSuspensionSelect();

    let queryText = `SELECT l.*, c.name as category_name, 
             u.id as user_id, u.name as username, u.verified as userverified, u.profilepictureurl as user_profile_picture,
             ${userSuspensionSelect},
             CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified
                     FROM userlistings l 
                     LEFT JOIN categories c ON l.categoryid = c.id 
                     LEFT JOIN users u ON l.userid = u.id
                     LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
                     WHERE l.moderation_status = 'approved' AND l.status = 'Available' AND (l.is_draft IS NULL OR l.is_draft = FALSE)`;
    const queryParams = [];
    let paramCount = 1;

    // Filter by category
    if (category) {
      queryText += ` AND l.categoryid = $${paramCount}`;
      queryParams.push(category);
      paramCount++;
    }

    // Filter by search term (title or description)
    if (search) {
      queryText += ` AND (LOWER(l.title) LIKE LOWER($${paramCount}) OR LOWER(l.description) LIKE LOWER($${paramCount}))`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    // Filter by country
    if (country) {
      queryText += ` AND LOWER(l.country) = LOWER($${paramCount})`;
      queryParams.push(country);
      paramCount++;
    }

    // Filter by city
    if (city) {
      queryText += ` AND LOWER(l.city) = LOWER($${paramCount})`;
      queryParams.push(city);
      paramCount++;
    }

    // Filter by minimum price
    if (minPrice) {
      queryText += ` AND l.price >= $${paramCount}`;
      queryParams.push(minPrice);
      paramCount++;
    }

    // Filter by maximum price
    if (maxPrice) {
      queryText += ` AND l.price <= $${paramCount}`;
      queryParams.push(maxPrice);
      paramCount++;
    }

    // Filter by currency
    if (currency) {
      queryText += ` AND l.currency = $${paramCount}`;
      queryParams.push(currency);
      paramCount++;
    }

    // Filter by condition
    if (condition) {
      queryText += ` AND l.condition = $${paramCount}`;
      queryParams.push(condition);
      paramCount++;
    }

    // Order by: Available listings first, then by creation date (newest first)
    queryText += ` ORDER BY 
      CASE WHEN l.status = 'Available' THEN 0 ELSE 1 END,
      l.createdat DESC`;

    const listingsResult = await db.query(queryText, queryParams);

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

    // Strip seller_email from all public listing responses — never expose to clients
    const safe = listingsWithImages.map(({ seller_email, ...rest }) => rest);

    // Log search term asynchronously (fire-and-forget)
    if (search && search.trim().length >= 2) {
      const userId = req.user?.id || null;
      db.query(`INSERT INTO search_logs (user_id, query) VALUES ($1, $2)`, [
        userId,
        search.trim().toLowerCase(),
      ]).catch(() => {});
    }

    res.status(200).json(safe);
  } catch (error) {
    console.error("Error fetching listings:", error.message);
    console.error("Error details:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch listings", details: error.message });
  }
});

// Trending searches — top 10 queries from the last 7 days
router.get("/listings/trending-searches", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT query, COUNT(*) AS count
       FROM search_logs
       WHERE created_at > NOW() - INTERVAL '7 days'
         AND LENGTH(query) >= 2
       GROUP BY query
       ORDER BY count DESC
       LIMIT 10`,
    );
    res.json({ trending: result.rows.map((r) => r.query) });
  } catch (err) {
    console.error("[Listings] trending-searches error:", err.message);
    res.json({ trending: [] }); // Non-fatal
  }
});

// Duplicate title check — returns user's similar active listings
router.get("/listings/check-duplicate", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { title } = req.query;
  if (!title || title.trim().length < 3) return res.json({ duplicates: [] });

  try {
    const result = await db.query(
      `SELECT id, title, status FROM userlistings
       WHERE userid = $1
         AND LOWER(title) LIKE LOWER($2)
         AND status NOT IN ('Expired', 'Sold')
         AND (is_draft IS NULL OR is_draft = FALSE)
       LIMIT 3`,
      [userId, `%${title.trim()}%`],
    );
    res.json({ duplicates: result.rows });
  } catch (err) {
    console.error("[Listings] check-duplicate error:", err.message);
    res.json({ duplicates: [] });
  }
});

// Get a single listing by ID with images
router.get("/listings/:id", optionalAuthMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const userSuspensionSelect = await getUserSuspensionSelect();

    const listingResult = await db.query(
      `SELECT l.*, c.name as categoryname, 
       u.id as user_id, u.name as username, u.verified as userverified, u.profilepictureurl as user_profile_picture,
       ${userSuspensionSelect},
       CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified
       FROM userlistings l 
       LEFT JOIN categories c ON l.categoryid = c.id 
       LEFT JOIN users u ON l.userid = u.id
       LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
       WHERE l.id = $1`,
      [id],
    );

    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    // Strip seller_email — never expose to clients
    const { seller_email, ...safeListing } = listingResult.rows[0];

    // Increment view count for non-owners (fire-and-forget)
    if (req.user?.id && req.user.id !== safeListing.userid) {
      db.query(
        `UPDATE userlistings SET view_count = COALESCE(view_count, 0) + 1 WHERE id = $1`,
        [id],
      ).catch(() => {});
    }

    // Fetch images for the listing
    const imagesResult = await db.query(
      `SELECT * FROM imagelistings 
       WHERE listingid = $1 
       ORDER BY is_main DESC`,
      [id],
    );

    res.status(200).json({
      ...safeListing,
      images: imagesResult.rows,
    });
  } catch (error) {
    console.error("Error fetching listing:", error);
    res.status(500).json({ error: "Failed to fetch listing" });
  }
});

// Get related listings based on category and tags
router.get("/listings/related/:id", optionalAuthMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    // First, get the current listing's category and tags
    const currentListing = await db.query(
      `SELECT categoryid, tags FROM userlistings WHERE id = $1`,
      [id],
    );

    if (currentListing.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const { categoryid, tags } = currentListing.rows[0];

    // Find related listings by category or similar tags
    // Only show approved listings
    let queryText = `
      SELECT l.*, c.name as categoryname, u.name as username, u.verified as userverified,
      CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified
      FROM userlistings l 
      LEFT JOIN categories c ON l.categoryid = c.id 
      LEFT JOIN users u ON l.userid = u.id
      LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
      WHERE l.id != $1 
      AND l.status = 'Available'
      AND l.moderation_status = 'approved'
    `;

    const queryParams = [id];
    let paramCount = 2;

    // Add category filter if exists
    if (categoryid) {
      queryText += ` AND l.categoryid = $${paramCount}`;
      queryParams.push(categoryid);
      paramCount++;
    }

    queryText += ` LIMIT 8`;

    const relatedResult = await db.query(queryText, queryParams);

    // Fetch images for each related listing
    const relatedWithImages = await Promise.all(
      relatedResult.rows.map(async (listing) => {
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

    res.status(200).json(relatedWithImages);
  } catch (error) {
    console.error("Error fetching related listings:", error);
    res.status(500).json({ error: "Failed to fetch related listings" });
  }
});

// Mark listing as sold (only owner can do this)
router.put("/listings/:id/mark-sold", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Check if listing exists and belongs to the user
    const listingCheck = await db.query(
      "SELECT id, userid, status, title FROM userlistings WHERE id = $1",
      [id],
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const listing = listingCheck.rows[0];

    if (listing.userid !== userId) {
      return res
        .status(403)
        .json({ error: "You can only update your own listings" });
    }

    if (listing.status === "Sold") {
      return res
        .status(400)
        .json({ error: "Listing is already marked as sold" });
    }

    // Update the listing status to Sold
    const result = await db.query(
      `UPDATE userlistings 
       SET status = 'Sold', updatedat = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [id],
    );

    res.status(200).json({
      message: "Listing marked as sold successfully",
      listing: result.rows[0],
    });
  } catch (error) {
    console.error("Error marking listing as sold:", error);
    res.status(500).json({ error: "Failed to mark listing as sold" });
  }
});

// Mark listing as available again (only owner can do this)
router.put("/listings/:id/mark-available", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Check if listing exists and belongs to the user
    const listingCheck = await db.query(
      "SELECT id, userid, status, title FROM userlistings WHERE id = $1",
      [id],
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const listing = listingCheck.rows[0];

    if (listing.userid !== userId) {
      return res
        .status(403)
        .json({ error: "You can only update your own listings" });
    }

    if (listing.status === "Available") {
      return res.status(400).json({ error: "Listing is already available" });
    }

    // Update the listing status to Available
    const result = await db.query(
      `UPDATE userlistings 
       SET status = 'Available', updatedat = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [id],
    );

    res.status(200).json({
      message: "Listing marked as available successfully",
      listing: result.rows[0],
    });
  } catch (error) {
    console.error("Error marking listing as available:", error);
    res.status(500).json({ error: "Failed to mark listing as available" });
  }
});

// Renew an expired listing (owner only) — resets createdat, re-queues for moderation
router.put(
  "/listings/:id/renew",
  authMiddleware,
  blockIfSuspended,
  async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
      const listingCheck = await db.query(
        "SELECT id, userid, status, title FROM userlistings WHERE id = $1",
        [id],
      );
      if (listingCheck.rows.length === 0) {
        return res.status(404).json({ error: "Listing not found" });
      }
      const listing = listingCheck.rows[0];
      if (listing.userid !== userId) {
        return res
          .status(403)
          .json({ error: "You can only renew your own listings" });
      }
      if (listing.status !== "Expired") {
        return res
          .status(400)
          .json({ error: "Only expired listings can be renewed" });
      }

      const result = await db.query(
        `UPDATE userlistings
       SET status = 'Available', moderation_status = 'pending', createdat = NOW(), updatedat = NOW()
       WHERE id = $1
       RETURNING *`,
        [id],
      );
      res.status(200).json({
        message: "Listing renewed and resubmitted for review",
        listing: result.rows[0],
      });
    } catch (error) {
      console.error("Error renewing listing:", error);
      res.status(500).json({ error: "Failed to renew listing" });
    }
  },
);

// Update listing price — owner only. Notifies wishlist users if price drops.
router.put("/listings/:id/update-price", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const { price } = req.body;

  const newPrice = parseFloat(price);
  if (isNaN(newPrice) || newPrice <= 0) {
    return res.status(400).json({ error: "Invalid price." });
  }

  try {
    const listingCheck = await db.query(
      "SELECT id, userid, title, price, currency, status FROM userlistings WHERE id = $1",
      [id],
    );
    if (listingCheck.rows.length === 0)
      return res.status(404).json({ error: "Listing not found" });
    const listing = listingCheck.rows[0];
    if (listing.userid !== userId)
      return res
        .status(403)
        .json({ error: "You can only update your own listings" });

    const oldPrice = parseFloat(listing.price);

    await db.query(
      `UPDATE userlistings SET price = $1, updatedat = NOW() WHERE id = $2`,
      [newPrice, id],
    );

    // Price drop: notify wishlist users
    if (newPrice < oldPrice) {
      try {
        const wishlistRes = await db.query(
          `SELECT f.userid, u.name, u.email
           FROM favorites f
           JOIN users u ON u.id = f.userid
           WHERE f.listingid = $1 AND f.userid != $2`,
          [id, userId],
        );
        for (const user of wishlistRes.rows) {
          sendPushToUser(
            user.userid,
            buildNotificationPayload("price_drop", {
              title: "Price drop on your wishlist",
              body: `"${listing.title}" dropped from ${Number(oldPrice).toLocaleString()} to ${Number(newPrice).toLocaleString()} ${listing.currency}`,
              url: `/listing/${id}`,
            }),
          );
          sendPriceDropAlert(
            user,
            { id, title: listing.title, currency: listing.currency },
            oldPrice,
            newPrice,
          );
        }
      } catch (alertErr) {
        console.warn("[Listings] Price drop alert error:", alertErr.message);
      }
    }

    res.json({ message: "Price updated.", oldPrice, newPrice });
  } catch (error) {
    console.error("Error updating price:", error);
    res.status(500).json({ error: "Failed to update price" });
  }
});

// Publish a draft listing — sends it to moderation queue
router.put(
  "/listings/:id/publish",
  authMiddleware,
  blockIfSuspended,
  async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    try {
      const listingCheck = await db.query(
        "SELECT id, userid, title, price, currency, city, country, is_draft FROM userlistings WHERE id = $1",
        [id],
      );
      if (listingCheck.rows.length === 0)
        return res.status(404).json({ error: "Listing not found" });
      const listing = listingCheck.rows[0];
      if (listing.userid !== userId)
        return res
          .status(403)
          .json({ error: "You can only publish your own listings" });
      if (!listing.is_draft)
        return res.status(400).json({ error: "Listing is not a draft." });

      const result = await db.query(
        `UPDATE userlistings
         SET is_draft = FALSE, moderation_status = 'pending', updatedat = NOW()
         WHERE id = $1 RETURNING *`,
        [id],
      );

      // Notify admin
      const posterResult = await db.query(
        "SELECT id, name, email FROM users WHERE id = $1",
        [userId],
      );
      if (posterResult.rows.length > 0) {
        sendListingSubmittedAdmin(posterResult.rows[0], result.rows[0]);

        // Notify followers
        try {
          const followersRes = await db.query(
            `SELECT f.follower_id, u.name AS follower_name, u.email AS follower_email
             FROM seller_followers f
             JOIN users u ON u.id = f.follower_id
             WHERE f.seller_id = $1`,
            [userId],
          );
          const seller = posterResult.rows[0];
          for (const follower of followersRes.rows) {
            sendPushToUser(
              follower.follower_id,
              buildNotificationPayload("new_listing_from_followed", {
                title: `${seller.name} posted a new listing`,
                body: `"${listing.title}"`,
                url: `/listing/${id}`,
              }),
            );
            sendNewListingFromFollowed(
              { name: follower.follower_name, email: follower.follower_email },
              { id: seller.id, name: seller.name },
              listing,
            );
          }
        } catch (followerErr) {
          console.warn(
            "[Listings] Publish follower notify error:",
            followerErr.message,
          );
        }
      }

      res.json({
        message: "Listing submitted for review.",
        listing: result.rows[0],
      });
    } catch (error) {
      console.error("Error publishing listing:", error);
      res.status(500).json({ error: "Failed to publish listing" });
    }
  },
);

// ─── Helper: extract Cloudinary public_id from a CDN URL ─────────────────────
function extractCloudinaryPublicId(url) {
  try {
    const parts = url.split("/upload/");
    if (parts.length < 2) return null;
    const afterUpload = parts[1].replace(/^v\d+\//, ""); // strip version
    return afterUpload.replace(/\.[^.]+$/, ""); // strip extension
  } catch {
    return null;
  }
}

// ─── PUT /api/listings/:id — full listing edit (owner only) ──────────────────
// Blocked when an escrow order is active (paid_in_escrow / released / disputed).
// Editing a live (approved) listing resets it to pending for re-moderation.
router.put(
  "/listings/:id",
  authMiddleware,
  blockIfSuspended,
  upload.array("images", 10),
  async (req, res) => {
    await ensureListingColumns();
    const { id } = req.params;
    const userId = req.user.id;

    try {
      const listingRes = await db.query(
        "SELECT id, userid, moderation_status FROM userlistings WHERE id = $1",
        [id],
      );
      if (listingRes.rows.length === 0) {
        return res.status(404).json({ error: "Listing not found." });
      }
      const listing = listingRes.rows[0];
      if (listing.userid !== userId) {
        return res
          .status(403)
          .json({ error: "You can only edit your own listings." });
      }

      // Block edit when funds are or were held in escrow
      const activeOrder = await db.query(
        `SELECT id FROM orders
         WHERE listing_id = $1
           AND fonlok_status IN ('paid_in_escrow', 'released', 'disputed')
         LIMIT 1`,
        [id],
      );
      if (activeOrder.rows.length > 0) {
        return res.status(409).json({
          error:
            "This listing has an active or completed escrow order and cannot be edited.",
        });
      }

      const {
        title,
        description,
        price,
        categoryId,
        location,
        country,
        city,
        condition,
        phone,
        seller_email,
        tags,
        delivery_type,
        delivery_notes,
        removed_image_ids,
      } = req.body;

      if (!title || !description || !price || !categoryId || !city) {
        return res
          .status(400)
          .json({
            error:
              "Title, description, price, category, and city are required.",
          });
      }

      // Delete removed existing images
      const idsToRemove = removed_image_ids
        ? Array.isArray(removed_image_ids)
          ? removed_image_ids
          : [removed_image_ids]
        : [];
      for (const imgId of idsToRemove) {
        const imgRes = await db.query(
          "SELECT imageurl FROM imagelistings WHERE id = $1 AND listingid = $2",
          [imgId, id],
        );
        if (imgRes.rows.length > 0) {
          const publicId = extractCloudinaryPublicId(imgRes.rows[0].imageurl);
          if (publicId) cloudinary.uploader.destroy(publicId).catch(() => {});
          await db.query("DELETE FROM imagelistings WHERE id = $1", [imgId]);
        }
      }

      // Upload new images
      if (req.files && req.files.length > 0) {
        const countRes = await db.query(
          "SELECT COUNT(*) FROM imagelistings WHERE listingid = $1",
          [id],
        );
        let currentCount = parseInt(countRes.rows[0].count, 10);
        for (const file of req.files) {
          try {
            const result = await new Promise((resolve, reject) => {
              const stream = cloudinary.uploader.upload_stream(
                { folder: "marketplace", resource_type: "image" },
                (err, r) => (err ? reject(err) : resolve(r)),
              );
              stream.end(file.buffer);
            });
            const isMain = currentCount === 0;
            await db.query(
              "INSERT INTO imagelistings (listingid, imageurl, is_main) VALUES ($1, $2, $3)",
              [id, result.secure_url, isMain],
            );
            currentCount++;
          } catch (uploadErr) {
            console.warn(
              "[Listings] Edit image upload failed:",
              uploadErr.message,
            );
          }
        }
      }

      // Parse tags
      const tagsArray = tags
        ? typeof tags === "string"
          ? tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : tags
        : [];

      // Editing an approved listing requires re-review
      const newModerationStatus =
        listing.moderation_status === "approved"
          ? "pending"
          : listing.moderation_status;

      const result = await db.query(
        `UPDATE userlistings
         SET title = $1, description = $2, price = $3, categoryid = $4,
             location = $5, country = $6, city = $7, condition = $8,
             phone = $9, seller_email = $10, tags = $11,
             delivery_type = $12, delivery_notes = $13,
             moderation_status = $14, updatedat = NOW()
         WHERE id = $15 AND userid = $16
         RETURNING *`,
        [
          title.trim(),
          description.trim(),
          parseFloat(price),
          parseInt(categoryId, 10),
          location || null,
          country || "Cameroon",
          city.trim(),
          condition || "used",
          phone || null,
          seller_email || null,
          tagsArray,
          delivery_type || "pickup",
          delivery_notes || null,
          newModerationStatus,
          id,
          userId,
        ],
      );

      const imagesRes = await db.query(
        "SELECT id, imageurl, is_main FROM imagelistings WHERE listingid = $1 ORDER BY is_main DESC",
        [id],
      );

      return res.json({
        message:
          listing.moderation_status === "approved"
            ? "Listing updated and resubmitted for review."
            : "Listing updated.",
        listing: { ...result.rows[0], images: imagesRes.rows },
      });
    } catch (err) {
      console.error("[Listings] Edit error:", err.message);
      return res.status(500).json({ error: "Failed to update listing." });
    }
  },
);

// ─── DELETE /api/listings/:id — delete listing (owner only) ──────────────────
// Blocked when an escrow order is active or completed.
router.delete("/listings/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const listingRes = await db.query(
      "SELECT id, userid FROM userlistings WHERE id = $1",
      [id],
    );
    if (listingRes.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found." });
    }
    if (listingRes.rows[0].userid !== userId) {
      return res
        .status(403)
        .json({ error: "You can only delete your own listings." });
    }

    const activeOrder = await db.query(
      `SELECT id FROM orders
       WHERE listing_id = $1
         AND fonlok_status IN ('paid_in_escrow', 'released', 'disputed')
       LIMIT 1`,
      [id],
    );
    if (activeOrder.rows.length > 0) {
      return res.status(409).json({
        error:
          "This listing has an active or completed escrow order and cannot be deleted.",
      });
    }

    // Fetch images before deleting so we can clean up Cloudinary
    const imagesRes = await db.query(
      "SELECT imageurl FROM imagelistings WHERE listingid = $1",
      [id],
    );

    // Delete images from DB first (avoids FK issues), then the listing
    await db.query("DELETE FROM imagelistings WHERE listingid = $1", [id]);
    await db.query("DELETE FROM userlistings WHERE id = $1", [id]);

    // Clean up Cloudinary (fire-and-forget)
    for (const img of imagesRes.rows) {
      const publicId = extractCloudinaryPublicId(img.imageurl);
      if (publicId) cloudinary.uploader.destroy(publicId).catch(() => {});
    }

    return res.json({ message: "Listing deleted." });
  } catch (err) {
    console.error("[Listings] Delete error:", err.message);
    return res.status(500).json({ error: "Failed to delete listing." });
  }
});

export default router;
