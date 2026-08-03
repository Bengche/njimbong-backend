import express from "express";
import db from "../db.js";
import cloudinary from "../storage/cloudinary.js";
import multer from "multer";
import authMiddleware from "../Middleware/authMiddleware.js";
import {
  sendDisputeFiledToAdmin,
  sendDisputeConfirmation,
} from "../utils/email.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";
import { disputeFonlokPayment } from "../services/fonlok.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

// Ensure dispute_evidence table exists and orders has transcript columns
const ensureDisputeTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS dispute_evidence (
      id          SERIAL PRIMARY KEY,
      order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      filed_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      image_urls  TEXT[],
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS dispute_transcript       TEXT,
      ADD COLUMN IF NOT EXISTS dispute_transcript_sent_at TIMESTAMPTZ
  `);
};

/**
 * Fetch and format the chat transcript between buyer and seller for a listing.
 * Returns a string up to ~9,800 chars, or null if no conversation found.
 */
async function fetchChatTranscript(listingId, buyerId, sellerId) {
  try {
    const { rows: convRows } = await db.query(
      `SELECT c.id FROM conversations c
       WHERE c.listing_id = $1
         AND ((c.buyer_id = $2 AND c.seller_id = $3)
           OR (c.buyer_id = $3 AND c.seller_id = $2))
       ORDER BY c.created_at DESC LIMIT 1`,
      [listingId, buyerId, sellerId],
    );
    if (convRows.length === 0) return null;

    const { rows: messages } = await db.query(
      `SELECT m.content, m.created_at, m.sender_id,
              u.name AS sender_name,
              CASE WHEN c.buyer_id = m.sender_id THEN 'Buyer' ELSE 'Seller' END AS role
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1
         AND m.is_deleted = FALSE
         AND m.message_type = 'text'
       ORDER BY m.created_at ASC
       LIMIT 200`,
      [convRows[0].id],
    );
    if (messages.length === 0) return null;

    const lines = messages.map((m) => {
      const ts = new Date(m.created_at).toISOString().replace("T", " ").slice(0, 16);
      return `[${ts}] ${m.sender_name} (${m.role}): ${m.content}`;
    });

    const header = `=== Njimbong Chat Transcript ===\nMessages: ${messages.length}\n================================\n\n`;
    let body = lines.join("\n");
    const MAX = 9800 - header.length;
    let truncated = false;
    if (body.length > MAX) {
      body = body.slice(0, MAX);
      truncated = true;
    }
    return header + body + (truncated ? "\n\n[Transcript truncated to fit size limit]" : "");
  } catch (e) {
    console.error("[Dispute] Failed to fetch chat transcript:", e.message);
    return null;
  }
}

// ─── GET /api/orders — order history for current user (as buyer or seller) ────
router.get("/orders", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const role = req.query.role; // 'buyer' | 'seller' | omit = both

  let whereClause = "(o.buyer_id = $1 OR o.seller_id = $1)";
  if (role === "buyer") whereClause = "o.buyer_id = $1";
  if (role === "seller") whereClause = "o.seller_id = $1";

  try {
    const result = await db.query(
      `SELECT
         o.id,
         o.order_reference,
         o.amount,
         o.currency,
         o.fonlok_status,
         o.fonlok_payment_url,
         o.fonlok_invoice_id,
         o.created_at,
         o.updated_at,
         o.buyer_id,
         o.seller_id,
         l.id   AS listing_id,
         l.title AS listing_title,
         l.price AS listing_price,
         l.city  AS listing_city,
         l.country AS listing_country,
         img.imageurl AS listing_image,
         buyer.name AS buyer_name,
         seller.name AS seller_name,
         CASE WHEN o.buyer_id = $1 THEN 'buyer' ELSE 'seller' END AS my_role
       FROM orders o
       LEFT JOIN userlistings l ON l.id = o.listing_id
       LEFT JOIN imagelistings img ON img.listingid = l.id AND img.is_main = true
       LEFT JOIN users buyer ON buyer.id = o.buyer_id
       LEFT JOIN users seller ON seller.id = o.seller_id
       WHERE ${whereClause}
         AND o.fonlok_status NOT IN ('none', 'initiation_failed')
       ORDER BY o.created_at DESC`,
      [userId],
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error("[Orders] GET error:", err.message);
    res.status(500).json({ error: "Failed to fetch orders." });
  }
});

// ─── GET /api/orders/:id — single order detail ───────────────────────────────
router.get("/orders/:id", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const result = await db.query(
      `SELECT
         o.*,
         l.title AS listing_title,
         l.price AS listing_price,
         l.city  AS listing_city,
         l.country AS listing_country,
         img.imageurl AS listing_image,
         buyer.name AS buyer_name,
         buyer.email AS buyer_email,
         seller.name AS seller_name,
         CASE WHEN o.buyer_id = $2 THEN 'buyer' ELSE 'seller' END AS my_role
       FROM orders o
       LEFT JOIN userlistings l ON l.id = o.listing_id
       LEFT JOIN imagelistings img ON img.listingid = l.id AND img.is_main = true
       LEFT JOIN users buyer ON buyer.id = o.buyer_id
       LEFT JOIN users seller ON seller.id = o.seller_id
       WHERE o.id = $1 AND (o.buyer_id = $2 OR o.seller_id = $2)`,
      [id, userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found." });
    }

    // Fetch dispute evidence if any
    let evidence = [];
    try {
      await ensureDisputeTable();
      const evRes = await db.query(
        `SELECT de.*, u.name AS filed_by_name
         FROM dispute_evidence de
         JOIN users u ON u.id = de.filed_by
         WHERE de.order_id = $1
         ORDER BY de.created_at ASC`,
        [id],
      );
      evidence = evRes.rows;
    } catch (_) {}

    res.json({ order: result.rows[0], evidence });
  } catch (err) {
    console.error("[Orders] GET single error:", err.message);
    res.status(500).json({ error: "Failed to fetch order." });
  }
});

// ─── POST /api/orders/:id/dispute — file dispute with evidence ────────────────
// Both buyer AND seller can file — but only when status = 'paid_in_escrow'
router.post(
  "/orders/:id/dispute",
  authMiddleware,
  upload.array("evidence_images", 5),
  async (req, res) => {
    await ensureDisputeTable();
    const userId = req.user.id;
    const { id } = req.params;
    const { description } = req.body;

    if (!description || description.trim().length < 10) {
      return res
        .status(400)
        .json({
          error: "Please provide a description of the dispute (min 10 chars).",
        });
    }
    if (description.trim().length > 1000) {
      return res
        .status(400)
        .json({
          error: "Dispute description must not exceed 1000 characters.",
        });
    }

    try {
      // Load order + verify participant
      const orderRes = await db.query(
        `SELECT o.*, l.title, l.currency,
                u_buyer.name AS buyer_name, u_buyer.email AS buyer_email,
                u_seller.name AS seller_name, u_seller.email AS seller_email
         FROM orders o
         LEFT JOIN userlistings l ON l.id = o.listing_id
         LEFT JOIN users u_buyer ON u_buyer.id = o.buyer_id
         LEFT JOIN users u_seller ON u_seller.id = o.seller_id
         WHERE o.id = $1`,
        [id],
      );
      if (orderRes.rows.length === 0)
        return res.status(404).json({ error: "Order not found." });
      const order = orderRes.rows[0];

      if (order.buyer_id !== userId && order.seller_id !== userId) {
        return res
          .status(403)
          .json({ error: "You are not a party to this order." });
      }
      if (order.fonlok_status !== "paid_in_escrow") {
        return res
          .status(409)
          .json({
            error:
              "Disputes can only be filed for orders with funds actively held in escrow.",
          });
      }

      // Upload evidence images to Cloudinary
      const imageUrls = [];
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          try {
            const result = await new Promise((resolve, reject) => {
              const stream = cloudinary.uploader.upload_stream(
                { folder: "marketplace/disputes", resource_type: "image" },
                (err, result) => (err ? reject(err) : resolve(result)),
              );
              stream.end(file.buffer);
            });
            imageUrls.push(result.secure_url);
          } catch (uploadErr) {
            console.warn("[Dispute] Image upload failed:", uploadErr.message);
          }
        }
      }

      // Save evidence
      await db.query(
        `INSERT INTO dispute_evidence (order_id, filed_by, description, image_urls)
         VALUES ($1, $2, $3, $4)`,
        [id, userId, description.trim(), imageUrls.length ? imageUrls : null],
      );

      // Notify Fonlok BEFORE updating local DB so the fund hold is official.
      // If fonlok_invoice_id is missing or Fonlok rejects the call, abort so
      // we don't end up with a locally-disputed order that Fonlok still considers paid.
      if (!order.fonlok_invoice_id) {
        return res
          .status(502)
          .json({
            error:
              "Cannot file dispute: Fonlok invoice ID is missing for this order. Contact support.",
          });
      }

      // Fetch chat transcript to provide full context to Fonlok
      const transcript = await fetchChatTranscript(
        order.listing_id,
        order.buyer_id,
        order.seller_id,
      );

      try {
        await disputeFonlokPayment(
          order.fonlok_invoice_id,
          description.trim(),
          transcript || undefined,
        );
      } catch (fonlokErr) {
        console.error(
          "[Dispute] Fonlok dispute call failed:",
          fonlokErr.message,
        );
        return res
          .status(502)
          .json({
            error:
              "Failed to register dispute with payment provider. Please try again.",
          });
      }

      // Fonlok confirmed — now mark locally and store transcript
      await db.query(
        `UPDATE orders
         SET fonlok_status = 'disputed',
             dispute_transcript = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [id, transcript || null],
      );

      // Determine the other party
      const isFiledByBuyer = order.buyer_id === userId;
      const filerName = isFiledByBuyer ? order.buyer_name : order.seller_name;
      const filerEmail = isFiledByBuyer
        ? order.buyer_email
        : order.seller_email;
      const otherPartyId = isFiledByBuyer ? order.seller_id : order.buyer_id;

      // Notify the other party via push
      sendPushToUser(
        otherPartyId,
        buildNotificationPayload("dispute_filed", {
          title: "Dispute filed on your order",
          body: `${filerName} has filed a dispute on your order for "${order.title}". Our team will review it.`,
          url: `/orders`,
        }),
      );

      // In-app notification
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
         VALUES ($1, 'Dispute filed', $2, 'dispute', $3, 'order')`,
        [
          otherPartyId,
          `${filerName} has filed a dispute on order "${order.title}". Funds are held pending review.`,
          id,
        ],
      );

      // Email — admin + filer confirmation
      sendDisputeFiledToAdmin(
        { name: filerName, email: filerEmail },
        { title: order.title },
        order.order_reference,
        description.trim(),
      );
      sendDisputeConfirmation(
        { name: filerName, email: filerEmail },
        { title: order.title },
        order.order_reference,
      );

      res
        .status(201)
        .json({
          message:
            "Dispute filed successfully. Our team will review within 24-48 hours.",
        });
    } catch (err) {
      console.error("[Dispute] POST error:", err.message);
      res.status(500).json({ error: "Failed to file dispute." });
    }
  },
);

export default router;
