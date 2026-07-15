import express from "express";
import db from "../db.js";
import { verifyFonlokWebhook } from "../services/fonlok.js";

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
    const eventType = req.headers["x-fonlok-event"];

    if (!signatureHeader) {
      return res.status(401).json({ error: "missing_signature" });
    }

    const isValid = verifyFonlokWebhook(req.body, signatureHeader);
    if (!isValid) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    // Signature verified — safe to parse body
    const event = JSON.parse(req.body.toString());

    // Respond 200 immediately; process async so Fonlok's 8-second timeout is never hit
    res.status(200).json({ received: true });

    handleFonlokEvent(eventType, event).catch((err) =>
      console.error("[FonlokWebhook] handler error:", err),
    );
  },
);

async function handleFonlokEvent(eventType, event) {
  const { invoice_id, reference } = event;

  switch (eventType) {
    case "payment.confirmed": {
      // Idempotent: only advance forward, never overwrite a later state
      const result = await db.query(
        `UPDATE orders
         SET fonlok_status = 'paid_in_escrow', updated_at = NOW()
         WHERE fonlok_invoice_id = $1
           AND fonlok_status NOT IN ('paid_in_escrow', 'released', 'disputed', 'cancelled')
         RETURNING id, buyer_id, seller_id`,
        [invoice_id],
      );

      if (result.rows.length === 0) break; // Already updated or order not found

      const order = result.rows[0];

      // Notify seller
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
         VALUES ($1, 'New secured order', 'A buyer''s payment is secured in escrow. Prepare to ship the item.', 'payment', $2, 'order')`,
        [order.seller_id, order.id],
      );

      // Notify buyer
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
         VALUES ($1, 'Payment confirmed', 'Your payment is safely held in escrow. The seller will now prepare your item.', 'payment', $2, 'order')`,
        [order.buyer_id, order.id],
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
