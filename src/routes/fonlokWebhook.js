import express from "express";
import db from "../db.js";
import { verifyFonlokWebhook } from "../services/fonlok.js";
import {
  sendPaymentConfirmedBuyer,
  sendPaymentConfirmedSeller,
  sendPaymentReleasedSeller,
  sendPaymentReleasedBuyer,
} from "../utils/email.js";

// Startup migration: add 'In Escrow' to the allowed values if the check
// constraint exists. On Railway we can't easily alter constraints, so
// we log a reminder instead — the DB constraint was defined with open-ended
// VARCHAR so 'In Escrow' will be accepted as long as the constraint below is
// not present.  If it is, a DBA must add the value manually.

const router = express.Router();

/**
 * POST /webhooks/fonlok
 *
 * Receives signed event notifications from Fonlok.
 *
 * CRITICAL: This route uses express.raw() — NOT express.json() — so the raw
 * body bytes are preserved for HMAC-SHA256 signature verification.
 * It MUST be mounted in server.js BEFORE app.use(express.json(...)) to ensure
 * the global JSON parser has not already consumed the body stream.
 */
router.post(
  "/webhooks/fonlok",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signatureHeader = req.headers["x-fonlok-signature"];

    // If the secret is configured, the signature header is required.
    // If the secret is not yet configured, we skip signature checks entirely
    // (verifyFonlokWebhook will return true and log a warning).
    const secretConfigured = !!process.env.FONLOK_WEBHOOK_SECRET;
    if (secretConfigured && !signatureHeader) {
      return res.status(401).json({ error: "missing_signature" });
    }

    const isValid = verifyFonlokWebhook(req.body, signatureHeader || "");
    if (!isValid) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    // Signature verified — safe to parse body
    const event = JSON.parse(req.body.toString());

    // Respond 200 immediately; process async so Fonlok's 8-second timeout is never hit
    res.status(200).json({ received: true });

    handleFonlokEvent(event).catch((err) =>
      console.error("[FonlokWebhook] handler error:", err),
    );
  },
);

async function handleFonlokEvent(event) {
  // payment.confirmed uses `invoice_number`; all other events use `invoice_id`
  const eventType = event.type;
  const invoice_id = event.invoice_id || event.invoice_number;
  const { reference } = event;

  switch (eventType) {
    case "payment.confirmed": {
      // Idempotent: only advance forward, never overwrite a later state
      const result = await db.query(
        `UPDATE orders
         SET fonlok_status = 'paid_in_escrow', updated_at = NOW()
         WHERE fonlok_invoice_id = $1
           AND fonlok_status NOT IN ('paid_in_escrow', 'released', 'disputed', 'cancelled')
         RETURNING id, buyer_id, seller_id, listing_id`,
        [invoice_id],
      );

      if (result.rows.length === 0) break; // Already updated or order not found

      const order = result.rows[0];

      // Mark the listing as reserved — prevents any new buyer from paying
      await db.query(
        `UPDATE userlistings SET status = 'In Escrow' WHERE id = $1`,
        [order.listing_id],
      );

      // Fetch all details needed for notifications and emails in one query
      try {
        const detailsRes = await db.query(
          `SELECT
             ul.title,
             o.amount,
             o.currency,
             buyer.name  AS buyer_name,
             buyer.email AS buyer_email,
             seller.name AS seller_name,
             COALESCE(ul.seller_email, seller.email) AS seller_contact_email
           FROM orders o
           JOIN userlistings ul  ON ul.id  = o.listing_id
           JOIN users buyer     ON buyer.id  = o.buyer_id
           JOIN users seller    ON seller.id = o.seller_id
           WHERE o.id = $1`,
          [order.id],
        );

        if (detailsRes.rows.length > 0) {
          const d = detailsRes.rows[0];

          sendPaymentConfirmedSeller(
            { name: d.seller_name, email: d.seller_contact_email },
            { title: d.title },
            order.id,
            d.amount,
            d.currency,
          );

          sendPaymentConfirmedBuyer(
            { name: d.buyer_name, email: d.buyer_email },
            { title: d.title, amount: d.amount, currency: d.currency },
            order.id,
          );
        }
      } catch (emailErr) {
        console.error("[FonlokWebhook] email notification error:", emailErr);
      }

      // In-app: notify seller
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
         VALUES ($1, 'New secured order', 'A buyer''s payment is secured in escrow. Prepare to deliver the item.', 'payment', $2, 'order')`,
        [order.seller_id, order.id],
      );

      // In-app: notify buyer
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
         VALUES ($1, 'Payment confirmed', 'Your payment is safely held in escrow. The seller will now prepare your item.', 'payment', $2, 'order')`,
        [order.buyer_id, order.id],
      );

      break;
    }

    case "payment.released": {
      const releaseUpdate = await db.query(
        `UPDATE orders
         SET fonlok_status = 'released', updated_at = NOW()
         WHERE fonlok_invoice_id = $1
           AND fonlok_status NOT IN ('released', 'cancelled')
         RETURNING id, buyer_id, seller_id, listing_id`,
        [invoice_id],
      );

      if (releaseUpdate.rows.length === 0) break;
      const o = releaseUpdate.rows[0];

      // Mark the listing as Sold — permanently unavailable for new orders
      await db.query(`UPDATE userlistings SET status = 'Sold' WHERE id = $1`, [
        o.listing_id,
      ]);

      // Send payout emails with review links
      try {
        const detailsRes = await db.query(
          `SELECT
             ul.title,
             o.amount,
             o.currency,
             buyer.id    AS buyer_id,
             buyer.name  AS buyer_name,
             buyer.email AS buyer_email,
             seller.id   AS seller_id,
             seller.name AS seller_name,
             COALESCE(ul.seller_email, seller.email) AS seller_contact_email
           FROM orders o
           JOIN userlistings ul ON ul.id  = o.listing_id
           JOIN users buyer    ON buyer.id  = o.buyer_id
           JOIN users seller   ON seller.id = o.seller_id
           WHERE o.id = $1`,
          [o.id],
        );

        if (detailsRes.rows.length > 0) {
          const d = detailsRes.rows[0];

          // Keep email payout display consistent with Njimbong's 3% fee policy.
          const grossAmount = Number(event.gross_amount ?? d.amount);
          const platformFee = Math.round(grossAmount * 0.03);
          const netAmount = grossAmount - platformFee;
          const currency = event.currency ?? d.currency;

          // Buyer reviews the seller; seller reviews the buyer
          const buyerReviewLink = `${process.env.FRONTEND_URL?.split(",")[0].trim() || "https://njimbong.com"}/profile/${d.seller_id}`;
          const sellerReviewLink = `${process.env.FRONTEND_URL?.split(",")[0].trim() || "https://njimbong.com"}/profile/${d.buyer_id}`;

          sendPaymentReleasedSeller(
            { name: d.seller_name, email: d.seller_contact_email },
            { title: d.title },
            o.id,
            grossAmount,
            netAmount,
            platformFee,
            currency,
            sellerReviewLink,
          );

          sendPaymentReleasedBuyer(
            { name: d.buyer_name, email: d.buyer_email },
            { title: d.title },
            o.id,
            grossAmount,
            currency,
            buyerReviewLink,
          );
        }
      } catch (emailErr) {
        console.error("[FonlokWebhook] release email error:", emailErr);
      }

      // In-app notifications
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
         VALUES ($1, 'Payment received', 'Funds have been sent to your MoMo number. Order complete.', 'payment', $2, 'order')`,
        [o.seller_id, o.id],
      );
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
         VALUES ($1, 'Order complete', 'Funds have been released to the seller. Thank you for using Njimbong!', 'payment', $2, 'order')`,
        [o.buyer_id, o.id],
      );

      break;
    }

    case "payment.disputed": {
      await db.query(
        `UPDATE orders
         SET fonlok_status = 'disputed', updated_at = NOW()
         WHERE fonlok_invoice_id = $1
           AND fonlok_status NOT IN ('disputed', 'released', 'cancelled')`,
        [invoice_id],
      );
      break;
    }

    case "payment.initiated": {
      // Update to pending if the order somehow didn't get its reference set
      if (reference) {
        await db.query(
          `UPDATE orders SET fonlok_status = 'pending', updated_at = NOW()
           WHERE fonlok_reference = $1 AND fonlok_status = 'none'`,
          [reference],
        );
      }
      break;
    }

    default:
      console.log(`[FonlokWebhook] Unhandled event type: ${eventType}`);
  }
}

export default router;
