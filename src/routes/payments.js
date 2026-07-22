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
  payEscrowFromWallet,
  getWalletBalance,
} from "../services/fonlok.js";
import {
  sendPaymentReleasedSeller,
  sendPaymentReleasedBuyer,
} from "../utils/email.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";

const router = express.Router();

/** Normalise a raw phone string to a 12-digit Cameroonian MoMo number
 *  (237 + 9 digits) or undefined if the result is not valid. */
function normalisePhone(raw) {
  if (!raw) return undefined;
  const digits = String(raw).replace(/\D/g, "");
  const withPrefix = digits.startsWith("237") ? digits : "237" + digits;
  return /^237\d{9}$/.test(withPrefix) ? withPrefix : undefined;
}

// ── Startup migration: add buyer_checkout_email if not yet present ─────────────
// This column stores the email the buyer explicitly entered at checkout,
// which may differ from their account email. It is the authoritative address
// for all payment notification emails to the buyer.
(async () => {
  try {
    await db.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS buyer_checkout_email VARCHAR(255)
    `);
  } catch (err) {
    console.error(
      "[Payments] migration error (buyer_checkout_email):",
      err.message,
    );
  }
})();

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
            fonlok_status, order_reference, buyer_checkout_email)
         VALUES ($1, $2, $3, $4, 'XAF', 'none', $5, $6)
         RETURNING id`,
        [
          listing_id,
          buyer_id,
          listing.seller_id,
          agreedAmount,
          orderId,
          buyer_email?.trim() || null,
        ],
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

      const normalisedSellerPhone = normalisePhone(
        listing.listing_phone || listing.seller_account_phone,
      );

      if (!normalisedSellerPhone) {
        console.warn(
          `[Payments] Listing ${listing_id} seller phone is missing or invalid — Fonlok may reject the invoice.`,
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
    // ── 1. Fetch full order + listing + user details ─────────────────────────
    const orderResult = await db.query(
      `SELECT
         o.id,
         o.order_reference,
         o.fonlok_invoice_id,
         o.fonlok_status,
         o.amount,
         o.currency,
         o.buyer_id,
         o.seller_id,
         o.listing_id,
         l.title       AS listing_title,
         l.city        AS listing_city,
         l.country     AS listing_country,
         b.name        AS buyer_name,
         b.email       AS buyer_email,
         s.name        AS seller_name,
         s.email       AS seller_email
       FROM orders o
       LEFT JOIN userlistings l  ON l.id  = o.listing_id
       LEFT JOIN users        b  ON b.id  = o.buyer_id
       LEFT JOIN users        s  ON s.id  = o.seller_id
       WHERE o.id = $1`,
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

    // ── 2. Call Fonlok to release funds ──────────────────────────────────────
    const release = await releaseFonlokPayment(order.fonlok_invoice_id);

    const grossAmount = Number(order.amount);
    const platformFee = release.platform_fee ?? Math.round(grossAmount * 0.03);
    const sellerReceives = release.seller_receives ?? grossAmount - platformFee;

    // ── 3. Update order status ────────────────────────────────────────────────
    await db.query(
      `UPDATE orders SET fonlok_status = 'released', updated_at = NOW() WHERE id = $1`,
      [order_id],
    );

    // ── 4. Mark listing as Sold ───────────────────────────────────────────────
    await db.query(
      `UPDATE userlistings SET status = 'Sold', updatedat = NOW() WHERE id = $1`,
      [order.listing_id],
    );

    // ── 5. Record analytics event + upsert daily revenue for seller ──────────
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    await Promise.all([
      db.query(
        `INSERT INTO analytics_events
           (listing_id, user_id, event_type, source)
         VALUES ($1, $2, 'sale', 'escrow')`,
        [order.listing_id, order.seller_id],
      ),
      db.query(
        `INSERT INTO user_analytics_daily
           (user_id, date, revenue)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, date)
         DO UPDATE SET revenue = user_analytics_daily.revenue + EXCLUDED.revenue`,
        [order.seller_id, today, sellerReceives],
      ),
    ]);

    // ── 6. In-app notifications ───────────────────────────────────────────────
    const APP_URL = process.env.APP_URL || "https://njimbong.com";
    const reviewLink = `${APP_URL}/profile/${order.buyer_id}`;

    await db.query(
      `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype)
       VALUES
         ($1, 'Payment released', 'The buyer has confirmed receipt. Your payout has been dispatched to your MoMo number.', 'payment', $2, 'order'),
         ($3, 'Purchase complete', 'You released funds for "${order.listing_title}". The transaction is now complete.', 'payment', $2, 'order')`,
      [order.seller_id, order_id, order.buyer_id],
    );

    // Emails are sent by the Fonlok `payment.released` webhook which fires
    // automatically after releaseFonlokPayment() succeeds. Sending here too
    // would duplicate every email. The webhook has idempotency protection.

    return res.json({
      status: "released",
      seller_receives: sellerReceives,
      platform_fee: platformFee,
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

/**
 * POST /payments/initiate-wallet
 * Buyer funds a listing purchase directly from their Njimbong wallet balance.
 * Creates a Fonlok invoice, then immediately pays it from the wallet so funds
 * are held in escrow. No MoMo prompt is sent — balance is deducted instantly.
 */
router.post(
  "/payments/initiate-wallet",
  authMiddleware,
  blockIfSuspended,
  async (req, res) => {
    const { listing_id } = req.body;
    const buyer_id = req.user.id;
    const userRef = `njimbong_${buyer_id}`;

    if (!listing_id) {
      return res.status(400).json({ error: "listing_id is required." });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Lock the listing row to prevent concurrent purchases
      const listingResult = await client.query(
        `SELECT l.id, l.title, l.description, l.price, l.currency,
                l.userid AS seller_id,
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

      if (!listingResult.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Listing not found or no longer available for purchase.",
        });
      }

      const listing = listingResult.rows[0];

      if (listing.seller_id === buyer_id) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "You cannot buy your own listing." });
      }

      // Reject if there is already an active order for this listing
      const existing = await client.query(
        `SELECT id FROM orders
         WHERE listing_id = $1
           AND fonlok_status IN ('pending', 'paid_in_escrow')
         LIMIT 1`,
        [listing_id],
      );
      if (existing.rowCount > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "There is already an active order for this listing.",
        });
      }

      const agreedAmount = Math.round(Number(listing.price));

      // Verify the buyer has sufficient wallet balance before creating the invoice
      let walletBalance = 0;
      try {
        const bal = await getWalletBalance(userRef);
        walletBalance = bal.balance;
      } catch {
        await client.query("ROLLBACK");
        return res.status(502).json({
          error: "Unable to verify wallet balance. Please try again.",
        });
      }

      if (walletBalance < agreedAmount) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Insufficient wallet balance. You have ${walletBalance.toLocaleString()} XAF but this listing costs ${agreedAmount.toLocaleString()} XAF.`,
          balance: walletBalance,
          required: agreedAmount,
        });
      }

      // Fetch buyer details including saved MoMo phone for refund routing
      const buyerResult = await client.query(
        `SELECT name, email, momo_phone FROM users WHERE id = $1`,
        [buyer_id],
      );
      const buyer = buyerResult.rows[0];

      // Create a Fonlok escrow invoice
      // Normalise seller phone the same way as the regular payment flow
      const normalisedSellerPhone = normalisePhone(listing.seller_account_phone);

      let fonlokInvoice;
      try {
        fonlokInvoice = await createFonlokInvoice({
          title: listing.title,
          amount: agreedAmount,
          sellerName: listing.seller_name,
          sellerEmail: listing.seller_email,
          sellerPhone: normalisedSellerPhone,
          buyerEmail: buyer.email,
          // Pass saved MoMo number so Fonlok can route refunds in disputes.
          // Falls back to empty string if buyer has never topped up their wallet.
          buyerPhone: buyer.momo_phone || "",
          description: `Wallet purchase: ${listing.title}`,
          orderId: `wallet-${Date.now()}`,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        });
      } catch (fonlokErr) {
        await client.query("ROLLBACK");
        console.error("[WalletPay] createInvoice error:", fonlokErr.message);
        return res.status(502).json({
          error: "Failed to create payment invoice. Please try again.",
        });
      }

      // Create the local order record
      const orderRef = `NJM-W${Date.now()}`;
      const orderResult = await client.query(
        `INSERT INTO orders
           (buyer_id, seller_id, listing_id, amount, currency,
            fonlok_invoice_id, fonlok_status, order_reference)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
         RETURNING id`,
        [
          buyer_id,
          listing.seller_id,
          listing_id,
          agreedAmount,
          listing.currency || "XAF",
          fonlokInvoice.id,
          orderRef,
        ],
      );
      const orderId = orderResult.rows[0].id;

      // Fund the invoice from the buyer's wallet
      let walletPay;
      try {
        walletPay = await payEscrowFromWallet({
          invoiceId: fonlokInvoice.id,
          userRef,
        });
      } catch (walletErr) {
        await client.query("ROLLBACK");
        console.error("[WalletPay] pay error:", walletErr.message);
        const errMsg = walletErr.response?.data?.error || "";
        if (
          walletErr.response?.status === 409 ||
          errMsg.includes("insufficient")
        ) {
          return res
            .status(409)
            .json({ error: "Insufficient wallet balance for this purchase." });
        }
        return res
          .status(502)
          .json({ error: "Wallet payment failed. Please try again." });
      }

      // Mark order as paid_in_escrow and listing as In Escrow
      await client.query(
        `UPDATE orders
           SET fonlok_status = 'paid_in_escrow', updated_at = NOW()
         WHERE id = $1`,
        [orderId],
      );
      await client.query(
        `UPDATE userlistings SET status = 'In Escrow' WHERE id = $1`,
        [listing_id],
      );

      // Wallet audit record
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, type, amount, status, description)
         VALUES ($1, 'escrow_pay', $2, 'completed', $3)`,
        [buyer_id, agreedAmount, `Purchase: ${listing.title}`],
      );

      await client.query("COMMIT");

      // Async notifications — non-critical
      Promise.allSettled([
        sendPushToUser(
          listing.seller_id,
          buildNotificationPayload("new_order", {
            title: "New wallet order received",
            body: `${buyer.name} purchased "${listing.title}" using their Njimbong wallet. Funds are secured in escrow.`,
            url: "/orders",
          }),
        ),
        db.query(
          `INSERT INTO notifications
             (userid, title, message, type, relatedid, relatedtype)
           VALUES ($1, 'New order', $2, 'payment', $3, 'order')`,
          [
            listing.seller_id,
            `${buyer.name} purchased "${listing.title}" from their wallet. Payment is held in escrow.`,
            orderId,
          ],
        ),
      ]).catch(() => {});

      return res.json({
        order_id: orderId,
        order_reference: orderRef,
        amount_paid: walletPay.amount_paid,
        new_balance: walletPay.new_balance,
        currency: walletPay.currency ?? "XAF",
        release_code: walletPay.release_code,
        status: "paid_in_escrow",
        message:
          "Payment successful. Funds are held in escrow until you confirm delivery.",
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[WalletPay] unexpected error:", err.message);
      return res
        .status(500)
        .json({ error: "An unexpected error occurred. Please try again." });
    } finally {
      client.release();
    }
  },
);

export default router;
