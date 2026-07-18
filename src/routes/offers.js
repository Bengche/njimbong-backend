import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import { blockIfSuspended } from "../Middleware/suspensionMiddleware.js";
import {
  sendOfferReceived,
  sendOfferAccepted,
  sendOfferCountered,
} from "../utils/email.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";

const router = express.Router();

// Ensure offers table exists
const ensureOffersTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS offers (
      id            SERIAL PRIMARY KEY,
      listing_id    INTEGER NOT NULL REFERENCES userlistings(id) ON DELETE CASCADE,
      buyer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seller_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount        NUMERIC(12,2) NOT NULL,
      currency      TEXT NOT NULL DEFAULT 'XAF',
      message       TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
        -- pending | accepted | declined | countered | expired | withdrawn
      counter_amount NUMERIC(12,2),
      counter_message TEXT,
      expires_at    TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);
};

// ─── POST /api/offers — buyer makes an offer ──────────────────────────────────
router.post("/offers", authMiddleware, blockIfSuspended, async (req, res) => {
  await ensureOffersTable();
  const buyerId = req.user.id;
  const { listing_id, amount, message } = req.body;

  if (!listing_id || !amount) {
    return res
      .status(400)
      .json({ error: "listing_id and amount are required." });
  }
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "Invalid offer amount." });
  }

  try {
    // Get listing details
    const listingRes = await db.query(
      `SELECT l.*, u.name AS seller_name, u.email AS seller_email
         FROM userlistings l
         JOIN users u ON u.id = l.userid
         WHERE l.id = $1 AND l.status = 'Available' AND l.moderation_status = 'approved'`,
      [listing_id],
    );
    if (listingRes.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Listing not found or not available." });
    }
    const listing = listingRes.rows[0];

    if (listing.userid === buyerId) {
      return res
        .status(400)
        .json({ error: "You cannot make an offer on your own listing." });
    }

    // Only one active offer per buyer per listing
    const existing = await db.query(
      `SELECT id FROM offers WHERE listing_id=$1 AND buyer_id=$2 AND status='pending' LIMIT 1`,
      [listing_id, buyerId],
    );
    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "You already have a pending offer on this listing." });
    }

    const offerRes = await db.query(
      `INSERT INTO offers (listing_id, buyer_id, seller_id, amount, currency, message)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
      [
        listing_id,
        buyerId,
        listing.userid,
        parsedAmount,
        listing.currency,
        message || null,
      ],
    );
    const offer = offerRes.rows[0];

    // Notify seller via push
    sendPushToUser(
      listing.userid,
      buildNotificationPayload("new_offer", {
        title: "New offer received",
        body: `${parsedAmount.toLocaleString()} ${listing.currency} offer on "${listing.title}"`,
        url: `/listing/${listing_id}`,
      }),
    );
    // Notify seller via email
    sendOfferReceived(
      { name: listing.seller_name, email: listing.seller_email },
      {
        id: listing.id,
        title: listing.title,
        price: listing.price,
        currency: listing.currency,
      },
      { amount: parsedAmount, message: message || null },
    );

    res.status(201).json({ offer });
  } catch (err) {
    console.error("[Offers] POST error:", err.message);
    res.status(500).json({ error: "Failed to submit offer." });
  }
});

// ─── GET /api/offers/listing/:id — seller or buyer views offers on a listing ──
router.get("/offers/listing/:id", authMiddleware, async (req, res) => {
  await ensureOffersTable();
  const userId = req.user.id;
  const { id: listingId } = req.params;

  try {
    // Verify the listing belongs to the user, OR user is the buyer
    const offersRes = await db.query(
      `SELECT o.*, 
              b.name AS buyer_name, b.profilepictureurl AS buyer_pic
       FROM offers o
       JOIN users b ON b.id = o.buyer_id
       WHERE o.listing_id = $1
         AND (o.seller_id = $2 OR o.buyer_id = $2)
         AND o.status NOT IN ('expired')
       ORDER BY o.created_at DESC`,
      [listingId, userId],
    );
    res.json({ offers: offersRes.rows });
  } catch (err) {
    console.error("[Offers] GET listing offers error:", err.message);
    res.status(500).json({ error: "Failed to fetch offers." });
  }
});

// ─── GET /api/offers/mine — buyer sees all their own offers ──────────────────
router.get("/offers/mine", authMiddleware, async (req, res) => {
  await ensureOffersTable();
  const buyerId = req.user.id;
  try {
    const result = await db.query(
      `SELECT o.*, l.title AS listing_title, l.price AS listing_price,
              img.imageurl AS listing_image
       FROM offers o
       JOIN userlistings l ON l.id = o.listing_id
       LEFT JOIN imagelistings img ON img.listingid = l.id AND img.is_main = true
       WHERE o.buyer_id = $1
       ORDER BY o.created_at DESC`,
      [buyerId],
    );
    res.json({ offers: result.rows });
  } catch (err) {
    console.error("[Offers] GET mine error:", err.message);
    res.status(500).json({ error: "Failed to fetch your offers." });
  }
});

// ─── PUT /api/offers/:id — seller accepts / counters / declines ───────────────
// Also handles buyer accepting / declining a counter-offer
router.put("/offers/:id", authMiddleware, async (req, res) => {
  await ensureOffersTable();
  const userId = req.user.id;
  const { id } = req.params;
  const { action, counter_amount, counter_message } = req.body;
  // Seller actions: 'accept' | 'decline' | 'counter'
  // Buyer actions:  'accept_counter' | 'decline_counter'

  if (
    ![
      "accept",
      "decline",
      "counter",
      "accept_counter",
      "decline_counter",
    ].includes(action)
  ) {
    return res.status(400).json({ error: "Invalid action." });
  }

  try {
    const offerRes = await db.query(
      `SELECT o.*, l.title, l.currency, l.id AS listing_db_id,
              b.name AS buyer_name, b.email AS buyer_email,
              s.name AS seller_name, s.email AS seller_email
       FROM offers o
       JOIN userlistings l ON l.id = o.listing_id
       JOIN users b ON b.id = o.buyer_id
       JOIN users s ON s.id = o.seller_id
       WHERE o.id = $1`,
      [id],
    );
    if (offerRes.rows.length === 0)
      return res.status(404).json({ error: "Offer not found." });
    const offer = offerRes.rows[0];

    // ── Buyer responding to counter ──────────────────────────────────────────
    if (action === "accept_counter" || action === "decline_counter") {
      if (offer.buyer_id !== userId) {
        return res
          .status(403)
          .json({ error: "Only the buyer can respond to a counter-offer." });
      }
      if (offer.status !== "countered") {
        return res
          .status(409)
          .json({ error: "Offer is not in a countered state." });
      }

      const newStatus = action === "accept_counter" ? "accepted" : "declined";
      // When accepting a counter, the accepted amount becomes the counter_amount
      const acceptedAmount =
        action === "accept_counter" ? offer.counter_amount : offer.amount;

      await db.query(
        `UPDATE offers SET status=$1, amount=$2, updated_at=NOW() WHERE id=$3`,
        [newStatus, acceptedAmount, id],
      );

      if (action === "accept_counter") {
        sendPushToUser(
          offer.seller_id,
          buildNotificationPayload("counter_accepted", {
            title: "Counter-offer accepted!",
            body: `The buyer accepted your counter-offer on "${offer.title}" for ${Number(acceptedAmount).toLocaleString()} ${offer.currency}.`,
            url: `/listing/${offer.listing_id}`,
          }),
        );
        // In-app notification for seller
        await db.query(
          `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
           VALUES ($1, 'Counter-offer accepted', $2, 'offer', $3, 'listing')`,
          [
            offer.seller_id,
            `Buyer accepted your counter-offer on "${offer.title}" for ${Number(acceptedAmount).toLocaleString()} ${offer.currency}.`,
            offer.listing_id,
          ],
        );
      }

      return res.json({ message: `Counter-offer ${newStatus}.` });
    }

    // ── Seller responding ─────────────────────────────────────────────────────
    if (offer.seller_id !== userId) {
      return res
        .status(403)
        .json({ error: "Only the seller can respond to an offer." });
    }

    if (offer.status !== "pending") {
      return res
        .status(409)
        .json({ error: `Offer is already ${offer.status}.` });
    }

    let newStatus =
      action === "accept"
        ? "accepted"
        : action === "decline"
          ? "declined"
          : "countered";
    let counterAmountVal = null;

    if (action === "counter") {
      counterAmountVal = parseFloat(counter_amount);
      if (isNaN(counterAmountVal) || counterAmountVal <= 0) {
        return res.status(400).json({ error: "Invalid counter amount." });
      }
    }

    await db.query(
      `UPDATE offers
       SET status=$1, counter_amount=$2, counter_message=$3, updated_at=NOW()
       WHERE id=$4`,
      [newStatus, counterAmountVal, counter_message || null, id],
    );

    // Notify buyer
    if (action === "accept") {
      sendPushToUser(
        offer.buyer_id,
        buildNotificationPayload("offer_accepted", {
          title: "Your offer was accepted!",
          body: `Your offer on "${offer.title}" was accepted. Complete your purchase now.`,
          url: `/listing/${offer.listing_id}`,
        }),
      );
      sendOfferAccepted(
        { name: offer.buyer_name, email: offer.buyer_email },
        { id: offer.listing_id, title: offer.title, currency: offer.currency },
        { amount: offer.amount },
      );
    } else if (action === "counter") {
      sendPushToUser(
        offer.buyer_id,
        buildNotificationPayload("offer_countered", {
          title: "Counter-offer received",
          body: `The seller countered your offer on "${offer.title}" with ${counterAmountVal.toLocaleString()} ${offer.currency}.`,
          url: `/listing/${offer.listing_id}`,
        }),
      );
      sendOfferCountered(
        { name: offer.buyer_name, email: offer.buyer_email },
        { title: offer.title },
        offer.amount,
        counterAmountVal,
        offer.currency,
      );
    }

    res.json({ message: `Offer ${newStatus}.` });
  } catch (err) {
    console.error("[Offers] PUT error:", err.message);
    res.status(500).json({ error: "Failed to update offer." });
  }
});

// ─── DELETE /api/offers/:id — buyer withdraws an offer ───────────────────────
router.delete("/offers/:id", authMiddleware, async (req, res) => {
  await ensureOffersTable();
  const buyerId = req.user.id;
  const { id } = req.params;
  try {
    const result = await db.query(
      `UPDATE offers SET status='withdrawn', updated_at=NOW()
       WHERE id=$1 AND buyer_id=$2 AND status='pending'
       RETURNING id`,
      [id, buyerId],
    );
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Offer not found or already resolved." });
    }
    res.json({ message: "Offer withdrawn." });
  } catch (err) {
    console.error("[Offers] DELETE error:", err.message);
    res.status(500).json({ error: "Failed to withdraw offer." });
  }
});

export default router;
