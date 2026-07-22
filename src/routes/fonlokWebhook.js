import express from "express";
import db from "../db.js";
import { verifyFonlokWebhook } from "../services/fonlok.js";
import {
  sendPaymentConfirmedBuyer,
  sendPaymentConfirmedSeller,
  sendPaymentReleasedSeller,
  sendPaymentReleasedBuyer,
} from "../utils/email.js";

const router = express.Router();

// ─── Idempotency table ────────────────────────────────────────────────────────
// Ensures each (invoice_id, canonical_event) pair is processed exactly once,
// even when Fonlok retries or fires both `payout.completed` and
// `payment.released` for the same invoice.
const _tablesReady = (async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        id           SERIAL PRIMARY KEY,
        invoice_id   VARCHAR(200) NOT NULL,
        event_key    VARCHAR(100) NOT NULL,
        received_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE (invoice_id, event_key)
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_pwh_invoice
      ON processed_webhooks (invoice_id)
    `);
  } catch (err) {
    // Non-fatal — worst case a retry event is double-processed once
    console.error(
      "[FonlokWebhook] Could not create processed_webhooks table:",
      err.message,
    );
  }
})();

/**
 * Insert (invoice_id, eventKey) into processed_webhooks.
 * Returns true  → this is the first time we see this event (process it).
 * Returns false → duplicate detected (skip silently).
 */
async function claimEvent(invoiceId, eventKey) {
  try {
    await _tablesReady;
    const { rowCount } = await db.query(
      `INSERT INTO processed_webhooks (invoice_id, event_key)
       VALUES ($1, $2)
       ON CONFLICT (invoice_id, event_key) DO NOTHING`,
      [invoiceId, eventKey],
    );
    return rowCount > 0;
  } catch (err) {
    // Fail open: let the event proceed rather than silently dropping it
    console.error("[FonlokWebhook] claimEvent error:", err.message);
    return true;
  }
}

// ─── Webhook endpoint ─────────────────────────────────────────────────────────
/**
 * POST /webhooks/fonlok
 *
 * CRITICAL: Uses express.raw() — NOT express.json() — so raw body bytes are
 * preserved for HMAC-SHA256 signature verification.
 * Must be mounted in server.js BEFORE app.use(express.json()).
 */
router.post(
  "/webhooks/fonlok",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signatureHeader = req.headers["x-fonlok-signature"];
    const headerEventType = req.headers["x-fonlok-event"];

    if (process.env.FONLOK_WEBHOOK_SECRET && !signatureHeader) {
      console.warn("[FonlokWebhook] Request missing X-Fonlok-Signature header");
      return res.status(401).json({ error: "missing_signature" });
    }

    if (!verifyFonlokWebhook(req.body, signatureHeader || "")) {
      console.warn(
        "[FonlokWebhook] Signature verification failed — event:",
        headerEventType,
      );
      return res.status(401).json({ error: "invalid_signature" });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "invalid_json" });
    }

    // Resolve event type from body first, fall back to header
    const eventType = event.type || headerEventType;
    // payment.confirmed uses `invoice_number`; release events use `invoice_id`
    const invoiceId = event.invoice_id || event.invoice_number;

    console.log(
      `[FonlokWebhook] Received: type=${eventType} invoice=${invoiceId}`,
    );

    // ── Respond 200 immediately — Fonlok has an 8-second delivery timeout ──
    res.status(200).json({ received: true });

    // Process asynchronously — failure here is logged but doesn't affect the 200
    handleFonlokEvent(event, eventType, invoiceId).catch((err) =>
      console.error("[FonlokWebhook] Unhandled error in event processor:", err),
    );
  },
);

// ─── Event dispatcher ─────────────────────────────────────────────────────────
async function handleFonlokEvent(event, eventType, invoiceId) {
  if (!invoiceId) {
    console.warn(
      "[FonlokWebhook] Event has no invoice_id — skipping:",
      eventType,
    );
    return;
  }

  switch (eventType) {
    case "payment.confirmed":
      await handlePaymentConfirmed(event, invoiceId);
      break;

    // payout.completed — buyer releases funds from the Fonlok payment page.
    // payment.released — platform calls POST /v1/payments/release programmatically.
    // Both have identical payloads and require identical processing.
    case "payout.completed":
    case "payment.released":
      await handlePayoutReleased(event, invoiceId, eventType);
      break;

    case "payment.disputed":
      await handlePaymentDisputed(invoiceId);
      break;

    case "payment.initiated":
      await handlePaymentInitiated(event);
      break;

    default:
      console.log(`[FonlokWebhook] Unhandled event type: ${eventType}`);
  }
}

// ─── payment.confirmed ────────────────────────────────────────────────────────
// Fires when a buyer's payment has been received and locked in escrow.
async function handlePaymentConfirmed(event, invoiceId) {
  const claimed = await claimEvent(invoiceId, "payment.confirmed");
  if (!claimed) {
    console.log(
      `[FonlokWebhook] payment.confirmed duplicate — skipping invoice ${invoiceId}`,
    );
    return;
  }

  const { rows, rowCount } = await db.query(
    `UPDATE orders
     SET fonlok_status = 'paid_in_escrow', updated_at = NOW()
     WHERE fonlok_invoice_id = $1
       AND fonlok_status NOT IN ('paid_in_escrow', 'released', 'disputed', 'cancelled')
     RETURNING id, buyer_id, seller_id, listing_id`,
    [invoiceId],
  );

  if (rowCount === 0) {
    console.log(
      `[FonlokWebhook] payment.confirmed: no updatable order for invoice ${invoiceId}`,
    );
    return;
  }

  const order = rows[0];
  console.log(`[FonlokWebhook] Order ${order.id} → paid_in_escrow`);

  // Reserve listing — prevents a second buyer from initiating a concurrent order
  await db.query(`UPDATE userlistings SET status = 'In Escrow' WHERE id = $1`, [
    order.listing_id,
  ]);

  // Fetch details for emails
  try {
    const { rows: details } = await db.query(
      `SELECT ul.title, o.amount, o.currency,
              buyer.name  AS buyer_name,
              COALESCE(o.buyer_checkout_email, buyer.email) AS buyer_email,
              seller.name AS seller_name,
              COALESCE(ul.seller_email, seller.email) AS seller_email
       FROM orders o
       JOIN userlistings ul ON ul.id     = o.listing_id
       JOIN users buyer     ON buyer.id  = o.buyer_id
       JOIN users seller    ON seller.id = o.seller_id
       WHERE o.id = $1`,
      [order.id],
    );

    if (details.length > 0) {
      const d = details[0];
      sendPaymentConfirmedSeller(
        { name: d.seller_name, email: d.seller_email },
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
  } catch (err) {
    console.error(
      "[FonlokWebhook] payment.confirmed email error:",
      err.message,
    );
  }

  // In-app notifications (run in parallel; individual failures are absorbed)
  await Promise.allSettled([
    db.query(
      `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
       VALUES ($1, 'New secured order',
               'A buyer''s payment is secured in escrow. Prepare to deliver the item.',
               'payment', $2, 'order')`,
      [order.seller_id, order.id],
    ),
    db.query(
      `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
       VALUES ($1, 'Payment confirmed',
               'Your payment is safely held in escrow. The seller will now prepare your item.',
               'payment', $2, 'order')`,
      [order.buyer_id, order.id],
    ),
  ]);
}

// ─── payout.completed / payment.released ──────────────────────────────────────
// Fires when escrow funds are released to the seller.
// Both event types share a single dedup key so exactly one processing occurs
// regardless of which (or both) arrive.
async function handlePayoutReleased(event, invoiceId, eventType) {
  // Canonical dedup key shared between both event variants
  const claimed = await claimEvent(invoiceId, "payout.released");
  if (!claimed) {
    console.log(
      `[FonlokWebhook] ${eventType} duplicate — skipping invoice ${invoiceId}`,
    );
    return;
  }

  const { rows, rowCount } = await db.query(
    `UPDATE orders
     SET fonlok_status = 'released', updated_at = NOW()
     WHERE fonlok_invoice_id = $1
       AND fonlok_status NOT IN ('released', 'cancelled')
     RETURNING id, buyer_id, seller_id, listing_id, amount, currency`,
    [invoiceId],
  );

  if (rowCount === 0) {
    console.log(
      `[FonlokWebhook] ${eventType}: no updatable order for invoice ${invoiceId}`,
    );
    return;
  }

  const order = rows[0];
  console.log(
    `[FonlokWebhook] Order ${order.id} → released (via ${eventType})`,
  );

  // Permanently mark listing as sold — it should no longer appear as available
  await db.query(`UPDATE userlistings SET status = 'Sold' WHERE id = $1`, [
    order.listing_id,
  ]);

  // Prefer Fonlok's exact payout figures from the payload; compute from order as fallback
  const grossAmount = Number(event.gross_amount ?? order.amount);
  const platformFee = Number(
    event.platform_fee ?? Math.round(grossAmount * 0.03),
  );
  const netAmount = Number(event.seller_receives ?? grossAmount - platformFee);
  const currency = event.currency ?? order.currency;
  const frontendUrl =
    process.env.FRONTEND_URL?.split(",")[0].trim() || "https://njimbong.com";

  // Fetch user and listing details for emails
  try {
    const { rows: details } = await db.query(
      `SELECT ul.title,
              buyer.id   AS buyer_id,
              buyer.name AS buyer_name,
              COALESCE(o.buyer_checkout_email, buyer.email) AS buyer_email,
              seller.id  AS seller_id,
              seller.name AS seller_name,
              COALESCE(ul.seller_email, seller.email) AS seller_email
       FROM orders o
       JOIN userlistings ul ON ul.id     = o.listing_id
       JOIN users buyer     ON buyer.id  = o.buyer_id
       JOIN users seller    ON seller.id = o.seller_id
       WHERE o.id = $1`,
      [order.id],
    );

    if (details.length > 0) {
      const d = details[0];
      // Seller reviews the buyer; buyer reviews the seller
      const sellerReviewLink = `${frontendUrl}/profile/${d.buyer_id}`;
      const buyerReviewLink = `${frontendUrl}/profile/${d.seller_id}`;

      sendPaymentReleasedSeller(
        { name: d.seller_name, email: d.seller_email },
        { title: d.title },
        order.id,
        grossAmount,
        netAmount,
        platformFee,
        currency,
        sellerReviewLink,
      );
      sendPaymentReleasedBuyer(
        { name: d.buyer_name, email: d.buyer_email },
        { title: d.title },
        order.id,
        grossAmount,
        currency,
        buyerReviewLink,
      );
    }
  } catch (err) {
    console.error(`[FonlokWebhook] ${eventType} email error:`, err.message);
  }

  // In-app notifications
  await Promise.allSettled([
    db.query(
      `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
       VALUES ($1, 'Payment received',
               'Funds have been sent to your MoMo number. Order complete.',
               'payment', $2, 'order')`,
      [order.seller_id, order.id],
    ),
    db.query(
      `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
       VALUES ($1, 'Order complete',
               'Funds have been released to the seller. Thank you for using Njimbong!',
               'payment', $2, 'order')`,
      [order.buyer_id, order.id],
    ),
  ]);
}

// ─── payment.disputed ─────────────────────────────────────────────────────────
async function handlePaymentDisputed(invoiceId) {
  const claimed = await claimEvent(invoiceId, "payment.disputed");
  if (!claimed) return;

  await db.query(
    `UPDATE orders
     SET fonlok_status = 'disputed', updated_at = NOW()
     WHERE fonlok_invoice_id = $1
       AND fonlok_status NOT IN ('disputed', 'released', 'cancelled')`,
    [invoiceId],
  );
  console.log(`[FonlokWebhook] Order disputed for invoice ${invoiceId}`);
}

// ─── payment.initiated ────────────────────────────────────────────────────────
async function handlePaymentInitiated(event) {
  const { reference } = event;
  if (!reference) return;

  await db.query(
    `UPDATE orders SET fonlok_status = 'pending', updated_at = NOW()
     WHERE fonlok_reference = $1 AND fonlok_status = 'none'`,
    [reference],
  );
}

export default router;
