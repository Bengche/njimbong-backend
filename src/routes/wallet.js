import express from "express";
import rateLimit from "express-rate-limit";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import { blockIfSuspended } from "../Middleware/suspensionMiddleware.js";
import {
  getWalletBalance,
  initiateWalletDeposit,
  getWalletDepositStatus,
  withdrawFromWallet,
} from "../services/fonlok.js";

const router = express.Router();

/** Canonical user reference for Fonlok wallet scoping. */
const toUserRef = (userId) => `njimbong_${userId}`;

/** Normalise a Cameroonian phone number to 237XXXXXXXXX format. */
const normalisePhone = (raw) => {
  const digits = String(raw).replace(/\D/g, "");
  return digits.startsWith("237") ? digits : "237" + digits;
};

const PHONE_RE = /^237[62]\d{8}$/;
const MIN_AMOUNT = 100;
const MAX_AMOUNT = 500_000;

// ─── One-time DB migration ────────────────────────────────────────────────────
(async () => {
  try {
    await db.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS momo_phone VARCHAR(30)`,
    );
    await db.query(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type         VARCHAR(20) NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'escrow_pay')),
        amount       INTEGER NOT NULL,
        reference    VARCHAR(255),
        status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'completed', 'failed')),
        fonlok_tx_id INTEGER,
        description  TEXT,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id)`,
    );
  } catch (err) {
    console.error("[Wallet] migration error:", err.message);
  }
})();

// ─── Rate limiters ────────────────────────────────────────────────────────────
// These are IP-based as a first defence layer; auth checks further restrict.
const depositLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many deposit requests. Please wait a moment before trying again." },
});

const withdrawLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many withdrawal requests. Please wait before trying again." },
});

// ─── GET /api/wallet/balance ─────────────────────────────────────────────────
router.get("/wallet/balance", authMiddleware, async (req, res) => {
  try {
    const data = await getWalletBalance(toUserRef(req.user.id));
    return res.json({ balance: data.balance, currency: data.currency ?? "XAF" });
  } catch (err) {
    // 404 = no wallet yet — return zero balance
    if (err.response?.status === 404) {
      return res.json({ balance: 0, currency: "XAF" });
    }
    console.error("[Wallet] balance error:", err.message);
    return res.status(502).json({ error: "Unable to fetch wallet balance. Please try again." });
  }
});

// ─── GET /api/wallet/momo-phone ──────────────────────────────────────────────
// Returns the user's saved MoMo phone number for pre-filling forms.
router.get("/wallet/momo-phone", authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT momo_phone FROM users WHERE id = $1`,
      [req.user.id],
    );
    return res.json({ momo_phone: rows[0]?.momo_phone ?? null });
  } catch {
    return res.json({ momo_phone: null });
  }
});

// ─── POST /api/wallet/deposit/initiate ──────────────────────────────────────
router.post(
  "/wallet/deposit/initiate",
  authMiddleware,
  blockIfSuspended,
  depositLimiter,
  async (req, res) => {
    const { amount, phone } = req.body;
    const userId = req.user.id;

    if (!amount || !phone) {
      return res.status(400).json({ error: "amount and phone are required." });
    }

    const parsedAmount = parseInt(amount, 10);
    if (isNaN(parsedAmount) || parsedAmount < MIN_AMOUNT) {
      return res
        .status(400)
        .json({ error: `Minimum deposit amount is ${MIN_AMOUNT.toLocaleString()} XAF.` });
    }
    if (parsedAmount > MAX_AMOUNT) {
      return res
        .status(400)
        .json({ error: `Maximum deposit amount is ${MAX_AMOUNT.toLocaleString()} XAF per transaction.` });
    }

    const normPhone = normalisePhone(phone);
    if (!PHONE_RE.test(normPhone)) {
      return res.status(400).json({
        error:
          "Invalid MoMo number. Use a Cameroonian MTN (67x/65x) or Orange (69x) number without the country code.",
      });
    }

    try {
      // Persist the MoMo number for future convenience
      await db.query(`UPDATE users SET momo_phone = $1 WHERE id = $2`, [
        normPhone,
        userId,
      ]);

      const result = await initiateWalletDeposit({
        amount: parsedAmount,
        phone: normPhone,
        userRef: toUserRef(userId),
        description: "Njimbong wallet top-up",
      });

      // Record pending deposit for audit
      await db.query(
        `INSERT INTO wallet_transactions
           (user_id, type, amount, reference, status, fonlok_tx_id, description)
         VALUES ($1, 'deposit', $2, $3, 'pending', $4, 'Wallet top-up via MoMo')`,
        [userId, parsedAmount, result.reference, result.transaction_id ?? null],
      );

      return res.status(202).json({
        reference: result.reference,
        amount_requested: result.amount_requested,
        amount_charged: result.amount_charged,
        fee: result.fee,
        currency: result.currency ?? "XAF",
        status: result.status,
        message: result.message,
      });
    } catch (err) {
      console.error("[Wallet] deposit initiate error:", err.message);
      const msg =
        err.response?.data?.error ||
        "Failed to initiate deposit. Please check your MoMo number and try again.";
      return res
        .status(err.response?.status ?? 502)
        .json({ error: msg });
    }
  },
);

// ─── GET /api/wallet/deposit/:reference/status ──────────────────────────────
// Idempotent — polls Fonlok and syncs the local audit record.
router.get(
  "/wallet/deposit/:reference/status",
  authMiddleware,
  async (req, res) => {
    const { reference } = req.params;
    const userId = req.user.id;

    // Validate the reference belongs to this user
    const { rowCount } = await db.query(
      `SELECT 1 FROM wallet_transactions
       WHERE reference = $1 AND user_id = $2 AND type = 'deposit'`,
      [reference, userId],
    );
    if (rowCount === 0) {
      // Either the row doesn't exist yet (race) or it's not theirs — return 404
      // rather than leaking existence of other users' transactions.
      return res.status(404).json({ error: "Transaction not found." });
    }

    try {
      const result = await getWalletDepositStatus(reference);

      // Mirror terminal states to our audit table
      if (result.status === "completed" || result.status === "failed") {
        await db.query(
          `UPDATE wallet_transactions
             SET status = $1, updated_at = NOW()
           WHERE reference = $2 AND user_id = $3`,
          [result.status, reference, userId],
        );
      }

      return res.json({
        status: result.status,
        amount_credited: result.amount_credited ?? null,
      });
    } catch (err) {
      if (err.response?.status === 404) {
        return res.status(404).json({ error: "Transaction not found." });
      }
      console.error("[Wallet] deposit status error:", err.message);
      return res.status(502).json({ error: "Failed to check deposit status. Please try again." });
    }
  },
);

// ─── POST /api/wallet/withdraw ───────────────────────────────────────────────
router.post(
  "/wallet/withdraw",
  authMiddleware,
  blockIfSuspended,
  withdrawLimiter,
  async (req, res) => {
    const { amount, phone } = req.body;
    const userId = req.user.id;

    if (!amount || !phone) {
      return res.status(400).json({ error: "amount and phone are required." });
    }

    const parsedAmount = parseInt(amount, 10);
    if (isNaN(parsedAmount) || parsedAmount < MIN_AMOUNT) {
      return res
        .status(400)
        .json({ error: `Minimum withdrawal is ${MIN_AMOUNT.toLocaleString()} XAF.` });
    }
    if (parsedAmount > MAX_AMOUNT) {
      return res
        .status(400)
        .json({ error: `Maximum withdrawal is ${MAX_AMOUNT.toLocaleString()} XAF per transaction.` });
    }

    const normPhone = normalisePhone(phone);
    if (!PHONE_RE.test(normPhone)) {
      return res.status(400).json({
        error:
          "Invalid MoMo number. Use a Cameroonian MTN or Orange number without the country code.",
      });
    }

    // Verify sufficient balance before calling Fonlok (fail fast with a clear message)
    let currentBalance = 0;
    try {
      const bal = await getWalletBalance(toUserRef(userId));
      currentBalance = bal.balance;
    } catch {
      return res
        .status(502)
        .json({ error: "Unable to verify wallet balance. Please try again shortly." });
    }

    if (currentBalance < parsedAmount) {
      return res.status(409).json({
        error: `Insufficient balance. Your current balance is ${currentBalance.toLocaleString()} XAF.`,
        balance: currentBalance,
      });
    }

    try {
      // Persist phone for future convenience
      await db.query(`UPDATE users SET momo_phone = $1 WHERE id = $2`, [
        normPhone,
        userId,
      ]);

      const result = await withdrawFromWallet({
        amount: parsedAmount,
        phone: normPhone,
        userRef: toUserRef(userId),
        description: "Njimbong wallet withdrawal",
      });

      // Record completed withdrawal
      await db.query(
        `INSERT INTO wallet_transactions
           (user_id, type, amount, reference, status, fonlok_tx_id, description)
         VALUES ($1, 'withdrawal', $2, $3, 'completed', $4, 'Withdrawal to MoMo')`,
        [
          userId,
          parsedAmount,
          result.reference ?? null,
          result.transaction_id ?? null,
        ],
      );

      return res.json({
        amount_withdrawn: result.amount_withdrawn,
        new_balance: result.new_balance,
        status: result.status,
        message: "Funds dispatched to your MoMo account successfully.",
      });
    } catch (err) {
      console.error("[Wallet] withdraw error:", err.message);
      const msg =
        err.response?.data?.error ||
        "Withdrawal failed. Please try again.";
      return res
        .status(err.response?.status ?? 502)
        .json({ error: msg });
    }
  },
);

export default router;
