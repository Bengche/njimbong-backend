import PDFDocument from "pdfkit";

// Brand palette
const BRAND_GREEN = "#166534"; // emerald-800 equivalent
const BRAND_LIGHT = "#f0fdf4";
const DARK = "#111827";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";
const POSITIVE = "#15803d";
const NEGATIVE = "#111827";
const STATUS_COLORS = {
  completed: "#16a34a",
  released: "#16a34a",
  refunded: "#16a34a",
  paid_in_escrow: "#1d4ed8",
  pending: "#d97706",
  processing: "#d97706",
  disputed: "#dc2626",
  failed: "#6b7280",
  cancelled: "#6b7280",
};

function statusLabel(status) {
  const map = {
    completed: "Completed",
    released: "Completed",
    refunded: "Refunded",
    paid_in_escrow: "Funds in Escrow",
    pending: "Processing",
    processing: "Processing",
    disputed: "Disputed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return map[status] ?? status;
}

function typeLabel(type) {
  const map = {
    deposit: "Wallet Deposit",
    withdrawal: "Wallet Withdrawal",
    escrow_pay: "Escrow Payment",
    purchase: "Purchase",
    sale: "Sale",
    refund: "Refund",
    dispute: "Dispute",
  };
  return map[type] ?? type;
}

function formatAmount(amount) {
  return Number(amount).toLocaleString("fr-CM") + " XAF";
}

function formatDate(d) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Douala",
  });
}

/**
 * Generates a clean PDF receipt for a single transaction.
 * @param {{ tx: object, user: { name: string, email: string } }} params
 * @returns {Promise<Buffer>}
 */
export function generateReceiptPdf({ tx, user }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A5",
      margin: 0,
      info: {
        Title: `Njimbong Receipt – ${tx.id}`,
        Author: "Njimbong",
        Subject: "Transaction Receipt",
      },
    });

    const buffers = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const W = doc.page.width; // A5 = 419.53pt
    const H = doc.page.height; // A5 = 595.28pt

    // ── Header strip ──────────────────────────────────────────────────────────
    doc.rect(0, 0, W, 52).fill(BRAND_GREEN);

    doc
      .fillColor("white")
      .font("Helvetica-Bold")
      .fontSize(13)
      .text("NJIMBONG", 24, 18);
    doc
      .fillColor("rgba(255,255,255,0.7)")
      .font("Helvetica")
      .fontSize(8)
      .text("PAYMENT RECEIPT", 24, 33);

    // Receipt label on the right
    doc
      .fillColor("rgba(255,255,255,0.85)")
      .font("Helvetica")
      .fontSize(7.5)
      .text(tx.id.toUpperCase(), W - 130, 22, { width: 110, align: "right" });

    // ── Amount section ────────────────────────────────────────────────────────
    const isIn = tx.direction === "in";
    const dirLabel = isIn
      ? "RECEIVED"
      : tx.direction === "pending"
        ? "PENDING"
        : "SENT";
    const amtColor = isIn ? POSITIVE : NEGATIVE;

    doc.rect(0, 52, W, 120).fill(BRAND_LIGHT);

    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(8)
      .text(dirLabel, 0, 72, { width: W, align: "center" });

    const displayAmt =
      (isIn ? "+ " : tx.direction === "pending" ? "" : "− ") +
      formatAmount(tx.amount);
    doc
      .fillColor(amtColor)
      .font("Helvetica-Bold")
      .fontSize(28)
      .text(displayAmt, 0, 84, { width: W, align: "center" });

    // Status badge row
    const statusColor = STATUS_COLORS[tx.status] ?? MUTED;
    const sLabel = statusLabel(tx.status);
    const badgeW = doc.widthOfString(sLabel, { fontSize: 8 }) + 20;
    const badgeX = (W - badgeW) / 2;

    doc
      .roundedRect(badgeX, 142, badgeW, 18, 9)
      .fillOpacity(0.12)
      .fill(statusColor);
    doc.fillOpacity(1);
    doc
      .fillColor(statusColor)
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .text(sLabel, badgeX, 148, { width: badgeW, align: "center" });

    // ── Divider ───────────────────────────────────────────────────────────────
    doc.rect(0, 172, W, 0.5).fill(BORDER);

    // ── Detail rows ───────────────────────────────────────────────────────────
    const rows = [
      ["Date & Time", formatDate(tx.created_at)],
      ["Transaction Type", typeLabel(tx.type)],
      tx.description ? ["Description", tx.description] : null,
      tx.counterparty ? ["Counterparty", tx.counterparty] : null,
      tx.reference ? ["Reference", tx.reference] : null,
      tx.order_reference ? ["Order Reference", tx.order_reference] : null,
      ["Account", user.name || user.email || "—"],
    ].filter(Boolean);

    let y = 185;
    const labelX = 24;
    const valueX = W / 2 + 4;
    const rowH = 32;

    rows.forEach(([label, value], i) => {
      if (i > 0) {
        doc
          .rect(labelX, y, W - labelX * 2, 0.5)
          .fillOpacity(0.5)
          .fill(BORDER)
          .fillOpacity(1);
      }

      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(8)
        .text(label, labelX, y + 8, { width: W / 2 - 30 });

      doc
        .fillColor(DARK)
        .font("Helvetica")
        .fontSize(8.5)
        .text(String(value), valueX, y + 8, {
          width: W / 2 - labelX,
          align: "right",
          lineBreak: false,
          ellipsis: true,
        });

      y += rowH;
    });

    // ── Footer ────────────────────────────────────────────────────────────────
    const footerY = H - 44;
    doc.rect(0, footerY, W, 44).fill(BRAND_GREEN);

    doc
      .fillColor("rgba(255,255,255,0.65)")
      .font("Helvetica")
      .fontSize(7)
      .text(
        "This is an automatically generated receipt. For support, contact support@njimbong.com",
        24,
        footerY + 10,
        { width: W - 48, align: "center" },
      );

    doc
      .fillColor("rgba(255,255,255,0.45)")
      .fontSize(6.5)
      .text(
        `Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`,
        24,
        footerY + 26,
        { width: W - 48, align: "center" },
      );

    doc.end();
  });
}
