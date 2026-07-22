/**
 * Buyer Requests — Forum-style "wanted ads" where buyers post what they need
 * and sellers fulfill by auto-creating a listing.
 *
 * Tables (created inline on first request):
 *   buyer_requests         — the request posts
 *   request_fulfillments   — one row per seller who fulfills a request
 */

import express from "express";
import multer from "multer";
import db from "../db.js";
import cloudinary from "../storage/cloudinary.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import { blockIfSuspended } from "../Middleware/suspensionMiddleware.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";

const router = express.Router();

// ── Multer (memory storage → Cloudinary) ─────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    file.mimetype.startsWith("image/")
      ? cb(null, true)
      : cb(new Error("Only image files are allowed"));
  },
});

// ── One-time table setup ──────────────────────────────────────────────────────
let _tablesReady = false;
async function ensureTables() {
  if (_tablesReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS buyer_requests (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title             VARCHAR(255) NOT NULL,
      description       TEXT NOT NULL,
      category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      tags              TEXT[],
      image_url         TEXT,
      cloudinary_id     TEXT,
      budget_min        DECIMAL(12,2),
      budget_max        DECIMAL(12,2),
      currency          VARCHAR(10)  NOT NULL DEFAULT 'XAF',
      country           VARCHAR(100),
      city              VARCHAR(100),
      status            VARCHAR(30)  NOT NULL DEFAULT 'open',
      view_count        INTEGER      NOT NULL DEFAULT 0,
      fulfillment_count INTEGER      NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS request_fulfillments (
      id              SERIAL PRIMARY KEY,
      request_id      INTEGER NOT NULL REFERENCES buyer_requests(id) ON DELETE CASCADE,
      seller_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id      INTEGER REFERENCES userlistings(id) ON DELETE SET NULL,
      price           DECIMAL(12,2) NOT NULL,
      currency        VARCHAR(10)   NOT NULL,
      condition       VARCHAR(50),
      city            VARCHAR(100),
      country         VARCHAR(100),
      seller_email    VARCHAR(255),
      seller_phone    VARCHAR(50),
      delivery_type   VARCHAR(50)   DEFAULT 'pickup',
      delivery_notes  TEXT,
      message         TEXT,
      status          VARCHAR(30)   NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE (request_id, seller_id)
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_buyer_requests_status   ON buyer_requests(status)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_buyer_requests_created  ON buyer_requests(created_at DESC)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_buyer_requests_user     ON buyer_requests(user_id)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_rf_request              ON request_fulfillments(request_id)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_rf_seller               ON request_fulfillments(seller_id)`,
  );
  _tablesReady = true;
}

// Helper — upload a file buffer to Cloudinary
async function uploadToCloudinary(buffer, folder = "marketplace/requests") {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(buffer);
  });
}

// Helper — notify a user in-app + push
async function notifyUser(
  userId,
  { title, message, type, relatedId, relatedType, url },
) {
  try {
    await db.query(
      `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, title, message, type, relatedId || null, relatedType || null],
    );
  } catch (e) {
    console.error("[Requests] notification insert:", e.message);
  }
  sendPushToUser(
    userId,
    buildNotificationPayload({
      title,
      body: message,
      type,
      relatedId,
      relatedType,
      url,
    }),
  );
}

// ── GET /api/requests — public list ──────────────────────────────────────────
router.get("/requests", async (req, res) => {
  try {
    await ensureTables();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(40, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const category = req.query.category ? parseInt(req.query.category) : null;
    const search = req.query.search?.trim() || null;
    const country = req.query.country?.trim() || null;
    const city = req.query.city?.trim() || null;

    const conditions = ["r.status = 'open'", "r.expires_at > NOW()"];
    const params = [];

    if (category) {
      params.push(category);
      conditions.push(`r.category_id = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      conditions.push(`(r.title ILIKE $${p} OR r.description ILIKE $${p})`);
    }
    if (country) {
      params.push(`%${country}%`);
      conditions.push(`r.country ILIKE $${params.length}`);
    }
    if (city) {
      params.push(`%${city}%`);
      conditions.push(`r.city ILIKE $${params.length}`);
    }

    const where = conditions.join(" AND ");

    const countRes = await db.query(
      `SELECT COUNT(*) FROM buyer_requests r WHERE ${where}`,
      params,
    );
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const dataRes = await db.query(
      `SELECT
         r.id, r.title, r.description, r.category_id, c.name AS category_name,
         r.tags, r.image_url, r.budget_min, r.budget_max, r.currency,
         r.country, r.city, r.status, r.view_count, r.fulfillment_count,
         r.created_at, r.expires_at,
         u.id AS user_id, u.name AS username, u.profile_picture AS user_avatar,
         u.kyc_status AS user_kyc_status
       FROM buyer_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN categories c ON c.id = r.category_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    res.json({
      requests: dataRes.rows,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[Requests] GET /requests:", err.message);
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

// ── GET /api/requests/mine — current user's requests ─────────────────────────
router.get("/requests/mine", authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const result = await db.query(
      `SELECT
         r.id, r.title, r.description, r.category_id, c.name AS category_name,
         r.tags, r.image_url, r.budget_min, r.budget_max, r.currency,
         r.country, r.city, r.status, r.view_count, r.fulfillment_count,
         r.created_at, r.expires_at
       FROM buyer_requests r
       LEFT JOIN categories c ON c.id = r.category_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id],
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error("[Requests] GET /requests/mine:", err.message);
    res.status(500).json({ error: "Failed to fetch your requests" });
  }
});

// ── GET /api/requests/:id — single request with fulfillments ─────────────────
router.get("/requests/:id", async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    // Increment view count
    await db.query(
      `UPDATE buyer_requests SET view_count = view_count + 1 WHERE id = $1`,
      [id],
    );

    const reqRes = await db.query(
      `SELECT
         r.id, r.title, r.description, r.category_id, c.name AS category_name,
         r.tags, r.image_url, r.budget_min, r.budget_max, r.currency,
         r.country, r.city, r.status, r.view_count, r.fulfillment_count,
         r.created_at, r.expires_at, r.user_id,
         u.name AS username, u.profile_picture AS user_avatar,
         u.kyc_status AS user_kyc_status
       FROM buyer_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN categories c ON c.id = r.category_id
       WHERE r.id = $1`,
      [id],
    );
    if (!reqRes.rows.length)
      return res.status(404).json({ error: "Request not found" });

    // Fulfillments (visible to the request owner; public view shows count only)
    const fulRes = await db.query(
      `SELECT
         f.id, f.seller_id, f.listing_id, f.price, f.currency,
         f.condition, f.city, f.country, f.message, f.status, f.created_at,
         u.name AS seller_name, u.profile_picture AS seller_avatar,
         u.kyc_status AS seller_kyc_status,
         l.moderation_status AS listing_mod_status
       FROM request_fulfillments f
       JOIN users u ON u.id = f.seller_id
       LEFT JOIN userlistings l ON l.id = f.listing_id
       WHERE f.request_id = $1
       ORDER BY f.created_at DESC`,
      [id],
    );

    res.json({ request: reqRes.rows[0], fulfillments: fulRes.rows });
  } catch (err) {
    console.error("[Requests] GET /requests/:id:", err.message);
    res.status(500).json({ error: "Failed to fetch request" });
  }
});

// ── POST /api/requests — create a request ────────────────────────────────────
router.post(
  "/requests",
  authMiddleware,
  blockIfSuspended,
  upload.single("image"),
  async (req, res) => {
    try {
      await ensureTables();
      const {
        title,
        description,
        category_id,
        tags,
        budget_min,
        budget_max,
        currency,
        country,
        city,
      } = req.body;

      if (!title?.trim() || !description?.trim()) {
        return res
          .status(400)
          .json({ error: "Title and description are required" });
      }
      if (!country?.trim() || !city?.trim()) {
        return res.status(400).json({ error: "Country and city are required" });
      }

      const tagsArray = tags
        ? tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];

      let image_url = null;
      let cloudinary_id = null;
      if (req.file) {
        const result = await uploadToCloudinary(req.file.buffer);
        image_url = result.secure_url;
        cloudinary_id = result.public_id;
      }

      const result = await db.query(
        `INSERT INTO buyer_requests
           (user_id, title, description, category_id, tags, image_url, cloudinary_id,
            budget_min, budget_max, currency, country, city)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          req.user.id,
          title.trim(),
          description.trim(),
          category_id ? parseInt(category_id) : null,
          tagsArray,
          image_url,
          cloudinary_id,
          budget_min ? parseFloat(budget_min) : null,
          budget_max ? parseFloat(budget_max) : null,
          currency || "XAF",
          country.trim(),
          city.trim(),
        ],
      );

      res.status(201).json({ request: result.rows[0] });
    } catch (err) {
      console.error("[Requests] POST /requests:", err.message);
      res.status(500).json({ error: "Failed to create request" });
    }
  },
);

// ── DELETE /api/requests/:id — close / delete own request ────────────────────
router.delete("/requests/:id", authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const existing = await db.query(
      `SELECT id, user_id, cloudinary_id FROM buyer_requests WHERE id = $1`,
      [id],
    );
    if (!existing.rows.length)
      return res.status(404).json({ error: "Request not found" });
    if (existing.rows[0].user_id !== req.user.id) {
      return res
        .status(403)
        .json({ error: "You can only delete your own requests" });
    }

    // Delete Cloudinary image if present
    if (existing.rows[0].cloudinary_id) {
      cloudinary.uploader
        .destroy(existing.rows[0].cloudinary_id)
        .catch(() => {});
    }

    await db.query(`DELETE FROM buyer_requests WHERE id = $1`, [id]);
    res.json({ message: "Request deleted" });
  } catch (err) {
    console.error("[Requests] DELETE /requests/:id:", err.message);
    res.status(500).json({ error: "Failed to delete request" });
  }
});

// ── POST /api/requests/:id/fulfill — seller fulfills a request ────────────────
//
// Creates a listing using the request's title/description/category/image,
// plus the seller's price/condition/contact details.
// The listing is auto-approved so the buyer can purchase immediately.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/requests/:id/fulfill",
  authMiddleware,
  blockIfSuspended,
  async (req, res) => {
    try {
      await ensureTables();
      const requestId = parseInt(req.params.id);
      if (isNaN(requestId))
        return res.status(400).json({ error: "Invalid request ID" });

      // Load the request
      const reqRes = await db.query(
        `SELECT r.*, u.name AS buyer_name, u.email AS buyer_email
         FROM buyer_requests r
         JOIN users u ON u.id = r.user_id
         WHERE r.id = $1`,
        [requestId],
      );
      if (!reqRes.rows.length)
        return res.status(404).json({ error: "Request not found" });

      const buyerRequest = reqRes.rows[0];

      if (buyerRequest.user_id === req.user.id) {
        return res
          .status(403)
          .json({ error: "You cannot fulfill your own request" });
      }
      if (buyerRequest.status !== "open") {
        return res
          .status(409)
          .json({ error: "This request is no longer open" });
      }

      // Validate required seller fields
      const {
        price,
        currency,
        condition,
        city,
        country,
        seller_email,
        seller_phone,
        delivery_type,
        delivery_notes,
        message,
      } = req.body;

      if (!price || isNaN(parseFloat(price))) {
        return res.status(400).json({ error: "A valid price is required" });
      }
      if (!seller_phone?.trim()) {
        return res
          .status(400)
          .json({ error: "A contact phone number is required" });
      }
      if (!city?.trim() || !country?.trim()) {
        return res.status(400).json({ error: "City and country are required" });
      }
      if (!condition?.trim()) {
        return res.status(400).json({ error: "Item condition is required" });
      }

      // Check for existing fulfillment from this seller
      const existing = await db.query(
        `SELECT id FROM request_fulfillments WHERE request_id = $1 AND seller_id = $2`,
        [requestId, req.user.id],
      );
      if (existing.rows.length) {
        return res.status(409).json({
          error: "You have already submitted a listing for this request",
        });
      }

      // ── 1. Create the listing ─────────────────────────────────────────────
      const listingResult = await db.query(
        `INSERT INTO userlistings
           (userid, title, description, price, currency, categoryid,
            location, country, city, condition, phone, seller_email, tags,
            status, moderation_status, is_draft, delivery_type, delivery_notes, createdat)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Available','approved',false,$14,$15,NOW())
         RETURNING *`,
        [
          req.user.id,
          buyerRequest.title,
          buyerRequest.description,
          parseFloat(price),
          currency || buyerRequest.currency || "XAF",
          buyerRequest.category_id || null,
          "",
          country.trim(),
          city.trim(),
          condition.trim(),
          seller_phone.trim(),
          seller_email?.trim() || null,
          buyerRequest.tags || [],
          delivery_type || "pickup",
          delivery_notes?.trim() || null,
        ],
      );
      const listing = listingResult.rows[0];

      // ── 2. Copy the request image to listing images ───────────────────────
      if (buyerRequest.image_url) {
        await db.query(
          `INSERT INTO imagelistings (listingid, imageurl, is_main, created_at, updated_at)
           VALUES ($1, $2, true, NOW(), NOW())`,
          [listing.id, buyerRequest.image_url],
        );
      }

      // ── 3. Record the fulfillment ─────────────────────────────────────────
      const fulfillResult = await db.query(
        `INSERT INTO request_fulfillments
           (request_id, seller_id, listing_id, price, currency,
            condition, city, country, seller_email, seller_phone,
            delivery_type, delivery_notes, message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          requestId,
          req.user.id,
          listing.id,
          parseFloat(price),
          currency || buyerRequest.currency || "XAF",
          condition.trim(),
          city.trim(),
          country.trim(),
          seller_email?.trim() || null,
          seller_phone.trim(),
          delivery_type || "pickup",
          delivery_notes?.trim() || null,
          message?.trim() || null,
        ],
      );

      // ── 4. Increment fulfillment counter ──────────────────────────────────
      await db.query(
        `UPDATE buyer_requests SET fulfillment_count = fulfillment_count + 1 WHERE id = $1`,
        [requestId],
      );

      // ── 5. Notify the buyer ───────────────────────────────────────────────
      const sellerRes = await db.query(`SELECT name FROM users WHERE id = $1`, [
        req.user.id,
      ]);
      const sellerName = sellerRes.rows[0]?.name || "A seller";

      await notifyUser(buyerRequest.user_id, {
        title: "A seller has your item!",
        message: `${sellerName} accepted your request for "${buyerRequest.title}" and created a listing. You can now view and purchase it.`,
        type: "request_fulfilled",
        relatedId: listing.id,
        relatedType: "listing",
        url: `/listing/${listing.id}`,
      });

      res.status(201).json({
        message: "Listing created successfully. The buyer has been notified.",
        fulfillment: fulfillResult.rows[0],
        listing_id: listing.id,
      });
    } catch (err) {
      if (err.code === "23505") {
        // UNIQUE constraint on (request_id, seller_id)
        return res.status(409).json({
          error: "You have already submitted a listing for this request",
        });
      }
      console.error("[Requests] POST /requests/:id/fulfill:", err.message);
      res.status(500).json({ error: "Failed to fulfill request" });
    }
  },
);

// ── DELETE /api/requests/fulfillments/:id — seller withdraws fulfillment ─────
router.delete(
  "/requests/fulfillments/:id",
  authMiddleware,
  async (req, res) => {
    try {
      await ensureTables();
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const existing = await db.query(
        `SELECT id, seller_id, request_id FROM request_fulfillments WHERE id = $1`,
        [id],
      );
      if (!existing.rows.length)
        return res.status(404).json({ error: "Fulfillment not found" });
      if (existing.rows[0].seller_id !== req.user.id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      await db.query(`DELETE FROM request_fulfillments WHERE id = $1`, [id]);
      await db.query(
        `UPDATE buyer_requests
         SET fulfillment_count = GREATEST(0, fulfillment_count - 1)
         WHERE id = $1`,
        [existing.rows[0].request_id],
      );

      res.json({ message: "Fulfillment withdrawn" });
    } catch (err) {
      console.error("[Requests] DELETE fulfillments/:id:", err.message);
      res.status(500).json({ error: "Failed to withdraw fulfillment" });
    }
  },
);

export default router;
