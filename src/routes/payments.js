import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import { blockIfSuspended } from "../Middleware/suspensionMiddleware.js";
import {
  createFonlokInvoice,
  initiateFonlokPayment,
  getFonlokPaymentStatus,
  releaseFonlokPayment,
  disputeFonlokPayment,
} from "../services/fonlok.js";

const router = express.Router();

/** Retry helper — never retries 4xx client errors, retries 5xx with exponential backoff. */
async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (status && status < 500) throw err;
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * POST /payments/initiate
 * Creates a Fonlok escrow invoice, persists the order, then triggers a MoMo prompt.
 */
router.post(
  "/payments/initiate",
  authMiddleware,
  blockIfSuspended,
  async (req, res) => {
    const { listing_id, phone_number, buyer_email } = req.body;
    const buyer_id = req.user.id;

    if (!listing_id || !phone_number) {
      return res
        .status(400)
        .json({ error: "listing_id and phone_number are required." });
    }

    // Normalise phone_number: strip non-digits, ensure 237 prefix
    const rawDigits = phone_number.replace(/\D/g, "");
    const normalisedPhone = rawDigits.startsWith("237")
      ? rawDigits
      : "237" + rawDigits;

    if (!/^237[62]\d{8}$/.test(normalisedPhone)) {
      return res.status(400).json({
        error:
          "Invalid phone number. Must be a Cameroonian MTN or Orange MoMo number.",
      });
    }

    // ── Phase 1: Concurrency-safe reservation ────────────────────────────────
    // Use a short DB transaction with SELECT … FOR UPDATE to lock the listing
    // row.  Any other concurrent initiation for the same listing will block
    // until this transaction commits, then fail the active-order check below.
    // ─────────────────────────────────────────────────────────────────────────
    let listing, dbOrderId, orderId, agreedAmount;
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Lock this listing row for the duration of the transaction
      const listingResult = await client.query(
        `SELECT l.id, l.title, l.description, l.price, l.currency,
                l.userid AS seller_id,
                l.phone  AS listing_phone,
                COALESCE(l.seller_email, s.email) AS seller_email,
                s.name  AS seller_name,
                s.phone AS seller_account_phone
         FROM userlistings l
         JOIN users s ON s.id = l.userid
         WHERE l.id = $1
           AND l.status = 'Available'
           AND l.moderation_status = 'approved'
         FOR UPDATE OF l`,
        [listing_id],
      );

      if (listingResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ error: "Listing not found or not available for purchase." });
      }

      listing = listingResult.rows[0];

      if (listing.seller_id === buyer_id) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "You cannot purchase your own listing." });
      }

      if (listing.currency !== "XAF") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            "Fonlok escrow is only supported for XAF-priced listings at this time.",
        });
      }

      if (Number(listing.price) < 500) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Listing price is below the minimum escrow amount (500 XAF).",
        });
      }

      // Block if ANY buyer already has an active order for this listing
      const existingOrder = await client.query(
        `SELECT id FROM orders
         WHERE listing_id = $1
           AND fonlok_status IN ('none', 'pending', 'paid_in_escrow')
         LIMIT 1`,
        [listing_id],
      );

      if (existingOrder.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            "This item already has a payment in progress. Please try again shortly.",
        });
      }

      // Check for an accepted offer from this buyer — use that price if available.
      // This ensures buyers who negotiated a price pay what was agreed, not the list price.
      const offerRes = await client.query(
        `SELECT amount FROM offers
         WHERE listing_id = $1 AND buyer_id = $2 AND status = 'accepted'
         ORDER BY updated_at DESC LIMIT 1`,
        [listing_id, buyer_id],
      );
      agreedAmount =
        offerRes.rows.length > 0
          ? Math.round(Number(offerRes.rows[0].amount))
          : Math.round(Number(listing.price));

      // Insert a placeholder order ('none') to claim this slot before releasing
      // the lock.  If the Fonlok call fails, we mark it 'initiation_failed' so
      // the next buyer can try.
      orderId = `${listing_id}-${buyer_id}-${Date.now()}`;
      const orderResult = await client.query(
        `INSERT INTO orders
           (listing_id, buyer_id, seller_id, amount, currency,
            fonlok_status, order_reference)
         VALUES ($1, $2, $3, $4, 'XAF', 'none', $5)
         RETURNING id`,
        [listing_id, buyer_id, listing.seller_id, agreedAmount, orderId],
      );
      dbOrderId = orderResult.rows[0].id;

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Payments] reservation transaction error:", txErr.message);
      return res
        .status(500)
        .json({ error: "Payment initiation failed. Please try again." });
    } finally {
      client.release();
    }

    // ── Phase 2: External Fonlok calls (outside the transaction) ────────────
    try {
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const rawSellerDigits = (
        listing.listing_phone ||
        listing.seller_account_phone ||
        ""
      ).replace(/\D/g, "");
      const normalisedSellerPhone = rawSellerDigits
        ? rawSellerDigits.startsWith("237")
          ? rawSellerDigits
          : "237" + rawSellerDigits
        : undefined;

      if (!normalisedSellerPhone) {
        console.warn(
          `[Payments] Listing ${listing_id} seller has no phone number — Fonlok may reject the invoice.`,
        );
      }

      // Step 1 — Create Fonlok escrow invoice
      const invoice = await withRetry(() =>
        createFonlokInvoice({
          title: listing.title,
          amount: agreedAmount,
          sellerName: listing.seller_name,
          sellerEmail: listing.seller_email,
          sellerPhone: normalisedSellerPhone,
          buyerEmail: buyer_email || undefined,
          buyerPhone: normalisedPhone,
          description: listing.description,
          orderId,
          expiresAt,
        }),
      );

      // Step 2 — Update order with invoice data
      await db.query(
        `UPDATE orders
         SET fonlok_invoice_id  = $1,
             fonlok_payment_url = $2,
             fonlok_status      = 'pending',
             updated_at         = NOW()
         WHERE id = $3`,
        [invoice.id, invoice.payment_url, dbOrderId],
      );

      // Step 3 — Trigger MoMo payment prompt
      let payment;
      try {
        payment = await withRetry(() =>
          initiateFonlokPayment({
            invoiceId: invoice.id,
            phoneNumber: normalisedPhone,
            buyerEmail: buyer_email || undefined,
          }),
        );
      } catch (paymentErr) {
        await db.query(
          `UPDATE orders SET fonlok_status = 'initiation_failed', updated_at = NOW() WHERE id = $1`,
          [dbOrderId],
        );
        const fonlokError = paymentErr.response?.data?.error;
        if (fonlokError === "no_payout_number") {
          return res.status(403).json({
            error:
              "The seller has not set up their Fonlok payout account. Contact them directly.",
          });
        }
        const msg =
          paymentErr.response?.data?.message ||
          "MoMo payment initiation failed. Please try again.";
        return res.status(502).json({ error: msg });
      }

      // Step 4 — Store the payment reference for polling and webhook matching
      await db.query(
        `UPDATE orders SET fonlok_reference = $1, updated_at = NOW() WHERE id = $2`,
        [payment.reference, dbOrderId],
      );

      return res.status(201).json({
        order_id: dbOrderId,
        fonlok_reference: payment.reference,
        fonlok_invoice_id: invoice.id,
        payment_url: invoice.payment_url,
        provider: payment.provider,
        message: payment.message,
        status: "pending",
      });
    } catch (err) {
      // Release the placeholder so another buyer can attempt
      await db
        .query(
          `UPDATE orders SET fonlok_status = 'initiation_failed', updated_at = NOW() WHERE id = $1`,
          [dbOrderId],
        )
        .catch(() => {});

      console.error(
        "[Payments] initiate error:",
        err.response?.data || err.message,
      );
      const fonlokError = err.response?.data?.error;
      const httpStatus = err.response?.status;

      if (fonlokError === "amount_too_low") {
        return res.status(400).json({
          error: "Listing price is below the minimum payment amount (500 XAF).",
        });
      }
      if (fonlokError === "duplicate_reference") {
        return res.status(409).json({
          error: "An order for this listing is already being processed.",
        });
      }
      if (httpStatus === 429) {
        return res.status(429).json({
          error:
            "Payment service is temporarily rate-limited. Please try again in a minute.",
        });
      }
      return res
        .status(500)
        .json({ error: "Payment initiation failed. Please try again." });
    }
  },
);

/**
 * GET /payments/:reference/status
 * Poll a payment's status — fallback for when a webhook was missed.
 */
router.get("/payments/:reference/status", authMiddleware, async (req, res) => {
  const { reference } = req.params;

  // Basic UUID format check
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      reference,
    )
  ) {
    return res.status(400).json({ error: "Invalid payment reference format." });
  }

  try {
    // Verify the order belongs to this buyer
    const orderResult = await db.query(
      `SELECT id, fonlok_status FROM orders
       WHERE fonlok_reference = $1 AND buyer_id = $2`,
      [reference, req.user.id],
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: "Order not found." });
    }

    const order = orderResult.rows[0];

    // If already at a terminal state, return locally without calling Fonlok
    if (
      [
        "paid_in_escrow",
        "released",
        "disputed",
        "cancelled",
        "failed",
      ].includes(order.fonlok_status)
    ) {
      return res.json({ status: order.fonlok_status, order_id: order.id });
    }

    // Poll Fonlok for live status
    const fonlokStatus = await getFonlokPaymentStatus(reference);

    // Sync local status if Fonlok confirms payment
    if (
      fonlokStatus.status === "paid" &&
      order.fonlok_status !== "paid_in_escrow"
    ) {
      await db.query(
        `UPDATE orders SET fonlok_status = 'paid_in_escrow', updated_at = NOW() WHERE id = $1`,
        [order.id],
      );
      return res.json({ status: "paid_in_escrow", order_id: order.id });
    }

    if (fonlokStatus.status === "failed") {
      await db.query(
        `UPDATE orders SET fonlok_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [order.id],
      );
    }

    return res.json({
      status: fonlokStatus.status,
      invoice_status: fonlokStatus.invoice_status,
      order_id: order.id,
    });
  } catch (err) {
    console.error(
      "[Payments] status poll error:",
      err.response?.data || err.message,
    );
    return res
      .status(500)
      .json({ error: "Failed to retrieve payment status." });
  }
});

/**
 * POST /payments/release
 * Buyer confirms receipt — releases escrow funds to seller via Fonlok.
 */
router.post("/payments/release", authMiddleware, async (req, res) => {
  const { order_id } = req.body;
  if (!order_id)
    return res.status(400).json({ error: "order_id is required." });

  try {
    const orderResult = await db.query(
      `SELECT id, fonlok_invoice_id, fonlok_status, buyer_id, seller_id
       FROM orders WHERE id = $1`,
      [order_id],
    );

    if (orderResult.rows.length === 0)
      return res.status(404).json({ error: "Order not found." });

    const order = orderResult.rows[0];

    if (order.buyer_id !== req.user.id)
      return res
        .status(403)
        .json({ error: "Only the buyer can release funds." });

    if (order.fonlok_status !== "paid_in_escrow")
      return res.status(409).json({
        error:
          "Funds can only be released after payment is confirmed in escrow.",
      });

    const release = await releaseFonlokPayment(order.fonlok_invoice_id);

    await db.query(
      `UPDATE orders SET fonlok_status = 'released', updated_at = NOW() WHERE id = $1`,
      [order_id],
    );

    // Notify seller
    await db.query(
      `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
       VALUES ($1, 'Payment released', 'The buyer has confirmed receipt. Funds have been sent to your MoMo number.', 'payment', $2, 'order')`,
      [order.seller_id, order_id],
    );

    return res.json({
      status: "released",
      seller_receives: release.seller_receives,
      platform_fee: release.platform_fee,
      message: release.message,
    });
  } catch (err) {
    console.error(
      "[Payments] release error:",
      err.response?.data || err.message,
    );
    return res.status(500).json({ error: "Failed to release payment." });
  }
});

/**
 * POST /payments/dispute
 * Buyer raises a dispute before releasing funds.
 */
router.post("/payments/dispute", authMiddleware, async (req, res) => {
  const { order_id, reason } = req.body;
  if (!order_id || !reason)
    return res.status(400).json({ error: "order_id and reason are required." });

  try {
    const orderResult = await db.query(
      `SELECT id, fonlok_invoice_id, fonlok_status, buyer_id, seller_id
       FROM orders WHERE id = $1`,
      [order_id],
    );

    if (orderResult.rows.length === 0)
      return res.status(404).json({ error: "Order not found." });

    const order = orderResult.rows[0];

    if (order.buyer_id !== req.user.id)
      return res
        .status(403)
        .json({ error: "Only the buyer can raise a dispute." });

    if (order.fonlok_status !== "paid_in_escrow")
      return res.status(409).json({
        error: "Disputes can only be raised on orders with funds in escrow.",
      });

    await disputeFonlokPayment(order.fonlok_invoice_id, reason);

    await db.query(
      `UPDATE orders SET fonlok_status = 'disputed', updated_at = NOW() WHERE id = $1`,
      [order_id],
    );

    // Notify seller
    await db.query(
      `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
       VALUES ($1, 'Dispute raised', 'A buyer has raised a dispute on your order. Funds are held pending resolution.', 'payment', $2, 'order')`,
      [order.seller_id, order_id],
    );

    return res.json({
      status: "disputed",
      message: "Dispute raised. Fonlok support will contact both parties.",
    });
  } catch (err) {
    console.error(
      "[Payments] dispute error:",
      err.response?.data || err.message,
    );
    return res.status(500).json({ error: "Failed to raise dispute." });
  }
});

export default router;
