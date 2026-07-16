import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import { blockIfSuspended } from "../Middleware/suspensionMiddleware.js";
import {
  createFonlokInvoice,
  initiateFonlokPayment,
  getFonlokPaymentStatus,
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
    const { listing_id, phone_number } = req.body;
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

    try {
      // Fetch the listing and both users in one query
      const listingResult = await db.query(
        `SELECT l.id, l.title, l.description, l.price, l.currency, l.userid AS seller_id,
              l.phone AS seller_phone,
              b.email AS buyer_email,
              s.email AS seller_email
       FROM userlistings l
       JOIN users b ON b.id = $2
       JOIN users s ON s.id = l.userid
       WHERE l.id = $1
         AND l.status = 'active'
         AND l.moderation_status = 'approved'`,
        [listing_id, buyer_id],
      );

      if (listingResult.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "Listing not found or not available for purchase." });
      }

      const listing = listingResult.rows[0];

      if (listing.seller_id === buyer_id) {
        return res
          .status(400)
          .json({ error: "You cannot purchase your own listing." });
      }

      if (listing.currency !== "XAF") {
        return res.status(400).json({
          error:
            "Fonlok escrow is only supported for XAF-priced listings at this time.",
        });
      }

      if (Number(listing.price) < 500) {
        return res.status(400).json({
          error: "Listing price is below the minimum escrow amount (500 XAF).",
        });
      }

      // Prevent duplicate in-flight orders for the same listing by this buyer
      const existingOrder = await db.query(
        `SELECT id FROM orders
       WHERE listing_id = $1
         AND buyer_id = $2
         AND fonlok_status IN ('pending', 'paid_in_escrow')`,
        [listing_id, buyer_id],
      );

      if (existingOrder.rows.length > 0) {
        return res.status(409).json({
          error: "You already have an active order for this listing.",
        });
      }

      const orderId = `${listing_id}-${buyer_id}-${Date.now()}`;
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(); // 7 days

      // Step 1 — Create Fonlok escrow invoice
      const invoice = await withRetry(() =>
        createFonlokInvoice({
          title: listing.title,
          amount: Math.round(Number(listing.price)),
          buyerEmail: listing.buyer_email,
          sellerEmail: listing.seller_email,
          sellerPhone: listing.seller_phone,
          description: `Marketplace purchase: ${listing.title}`,
          orderId,
          expiresAt,
        }),
      );

      // Step 2 — Persist order immediately with invoice data (before initiating payment
      //           so we can always recover state even if the next step fails)
      const orderResult = await db.query(
        `INSERT INTO orders
         (listing_id, buyer_id, seller_id, amount, currency,
          fonlok_invoice_id, fonlok_payment_url, fonlok_status, order_reference)
       VALUES ($1, $2, $3, $4, 'XAF', $5, $6, 'pending', $7)
       RETURNING id`,
        [
          listing_id,
          buyer_id,
          listing.seller_id,
          Math.round(Number(listing.price)),
          invoice.id,
          invoice.payment_url,
          orderId,
        ],
      );
      const dbOrderId = orderResult.rows[0].id;

      // Step 3 — Trigger MoMo payment prompt
      let payment;
      try {
        payment = await withRetry(() =>
          initiateFonlokPayment({
            invoiceId: invoice.id,
            phoneNumber: normalisedPhone,
            buyerEmail: listing.buyer_email,
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

export default router;
