import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import { generateReceiptPdf } from "../utils/generateReceiptPdf.js";
import { generateStatementPdf } from "../utils/generateStatementPdf.js";

const router = express.Router();

// ─── Unified transaction query ────────────────────────────────────────────────
async function fetchTransactions(userId) {
  const { rows } = await db.query(
    `
    /* ── Wallet: deposits & withdrawals ── */
    SELECT
      'wt_' || wt.id      AS id,
      'wallet'            AS source,
      wt.type             AS type,
      CASE wt.type WHEN 'deposit' THEN 'in' ELSE 'out' END AS direction,
      wt.amount,
      'XAF'               AS currency,
      wt.status,
      wt.description,
      NULL::TEXT          AS counterparty,
      NULL::TEXT          AS listing_title,
      wt.reference,
      NULL::TEXT          AS order_reference,
      NULL::INTEGER       AS order_id,
      wt.created_at,
      wt.updated_at
    FROM wallet_transactions wt
    WHERE wt.user_id = $1

    UNION ALL

    /* ── Orders: buyer perspective ── */
    SELECT
      'buy_' || o.id      AS id,
      'order'             AS source,
      CASE
        WHEN o.fonlok_status = 'refunded' THEN 'refund'
        WHEN o.fonlok_status = 'disputed' THEN 'dispute'
        ELSE 'purchase'
      END                 AS type,
      CASE WHEN o.fonlok_status = 'refunded' THEN 'in' ELSE 'out' END AS direction,
      o.amount,
      o.currency,
      o.fonlok_status     AS status,
      COALESCE(l.title, 'Order') AS description,
      s.name              AS counterparty,
      l.title             AS listing_title,
      NULL::TEXT          AS reference,
      o.order_reference,
      o.id                AS order_id,
      o.created_at,
      o.updated_at
    FROM orders o
    LEFT JOIN userlistings l ON l.id = o.listing_id
    LEFT JOIN users s ON s.id = o.seller_id
    WHERE o.buyer_id = $1
      AND o.fonlok_status NOT IN ('none', 'initiation_failed')

    UNION ALL

    /* ── Orders: seller perspective (pending + paid + released + disputed) ── */
    SELECT
      'sell_' || o.id     AS id,
      'order'             AS source,
      CASE
        WHEN o.fonlok_status = 'disputed' THEN 'dispute'
        ELSE 'sale'
      END                 AS type,
      CASE WHEN o.fonlok_status = 'released' THEN 'in' ELSE 'pending' END AS direction,
      o.amount,
      o.currency,
      o.fonlok_status     AS status,
      COALESCE(l.title, 'Order') AS description,
      b.name              AS counterparty,
      l.title             AS listing_title,
      NULL::TEXT          AS reference,
      o.order_reference,
      o.id                AS order_id,
      o.created_at,
      o.updated_at
    FROM orders o
    LEFT JOIN userlistings l ON l.id = o.listing_id
    LEFT JOIN users b ON b.id = o.buyer_id
    WHERE o.seller_id = $1
      AND o.fonlok_status NOT IN ('none', 'initiation_failed')

    ORDER BY created_at DESC
    `,
    [userId],
  );
  return rows;
}

// ─── GET /api/transactions ────────────────────────────────────────────────────
router.get("/transactions", authMiddleware, async (req, res) => {
  try {
    const rows = await fetchTransactions(req.user.id);
    res.json({ transactions: rows });
  } catch (err) {
    console.error("[Transactions] fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch transactions." });
  }
});

// ─── GET /api/transactions/export ────────────────────────────────────────────
// Returns a CSV file of all transactions.
router.get("/transactions/export", authMiddleware, async (req, res) => {
  try {
    const rows = await fetchTransactions(req.user.id);

    const headers = [
      "Date",
      "Type",
      "Direction",
      "Description",
      "Counterparty",
      "Amount (XAF)",
      "Currency",
      "Status",
      "Reference",
      "Order Reference",
    ];

    const escape = (v) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s}"`
        : s;
    };

    const lines = [
      headers.join(","),
      ...rows.map((r) =>
        [
          new Date(r.created_at).toISOString().slice(0, 19).replace("T", " "),
          escape(r.type),
          r.direction === "in"
            ? "Received"
            : r.direction === "pending"
              ? "Pending"
              : "Sent",
          escape(r.description),
          escape(r.counterparty),
          r.amount,
          r.currency,
          escape(r.status),
          escape(r.reference),
          escape(r.order_reference),
        ].join(","),
      ),
    ];

    const csv = lines.join("\n");
    const filename = `njimbong-transactions-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csv); // UTF-8 BOM for Excel compatibility
  } catch (err) {
    console.error("[Transactions] export error:", err.message);
    res.status(500).json({ error: "Failed to export transactions." });
  }
});

// ─── GET /api/transactions/export/pdf ────────────────────────────────────────
// Returns a professional A4 PDF account statement, optionally filtered by date.
router.get("/transactions/export/pdf", authMiddleware, async (req, res) => {
  const { from, to } = req.query;
  try {
    let rows = await fetchTransactions(req.user.id);

    if (from) {
      const fromDate = new Date(from);
      rows = rows.filter((r) => new Date(r.created_at) >= fromDate);
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      rows = rows.filter((r) => new Date(r.created_at) <= toDate);
    }

    const { rows: userRows } = await db.query(
      `SELECT name, email FROM users WHERE id = $1`,
      [req.user.id],
    );
    const user = userRows[0] ?? { name: "Account holder", email: "" };

    const pdfBuffer = await generateStatementPdf({
      transactions: rows,
      user,
      from: from || null,
      to: to || null,
    });

    const date = new Date().toISOString().slice(0, 10);
    const filename = `njimbong-statement-${date}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("[Transactions] PDF export error:", err.message);
    res.status(500).json({ error: "Failed to generate statement." });
  }
});

// ─── GET /api/transactions/:id/receipt ───────────────────────────────────────
// Generates and streams an individual PDF receipt.
router.get("/transactions/:id/receipt", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Find the transaction in the unified set
    const rows = await fetchTransactions(userId);
    const tx = rows.find((r) => r.id === id);

    if (!tx) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const { rows: userRows } = await db.query(
      `SELECT name, email FROM users WHERE id = $1`,
      [userId],
    );
    const user = userRows[0] ?? { name: "Account holder", email: "" };

    const pdfBuffer = await generateReceiptPdf({ tx, user });
    const filename = `njimbong-receipt-${id}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("[Transactions] receipt error:", err.message);
    res.status(500).json({ error: "Failed to generate receipt." });
  }
});

export default router;
