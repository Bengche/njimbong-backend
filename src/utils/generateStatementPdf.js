import PDFDocument from "pdfkit";

const BRAND_GREEN = "#166534";
const BRAND_GREEN2 = "#14532d";
const BRAND_LIGHT = "#f0fdf4";
const DARK = "#111827";
const MUTED = "#6b7280";
const MUTED_LIGHT = "#9ca3af";
const BORDER = "#e5e7eb";
const ROW_ALT = "#f9fafb";
const POSITIVE = "#15803d";
const NEGATIVE = "#dc2626"; // red for outgoing

// Safe number formatter — no locale dependency, always comma thousands
function fmtNum(amount) {
  return Math.round(Math.abs(Number(amount)))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmt(amount) {
  return fmtNum(amount) + " XAF";
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtDateFull(iso) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
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
  return map[type] || type;
}

function statusLabel(status) {
  const map = {
    completed: "Completed",
    released: "Completed",
    refunded: "Refunded",
    paid_in_escrow: "In Escrow",
    pending: "Processing",
    disputed: "Disputed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return map[status] || status;
}

// Truncate text to fit maxWidth, appending "..." if cut
function truncate(doc, text, maxWidth) {
  if (doc.widthOfString(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(t + "...") > maxWidth)
    t = t.slice(0, -1);
  return t + "...";
}

// Status pill colours
function statusStyle(status) {
  if (["completed", "released"].includes(status))
    return { bg: "#f0fdf4", text: "#15803d" };
  if (["refunded"].includes(status)) return { bg: "#eff6ff", text: "#1d4ed8" };
  if (["paid_in_escrow"].includes(status))
    return { bg: "#fefce8", text: "#a16207" };
  if (["disputed"].includes(status)) return { bg: "#fef2f2", text: "#b91c1c" };
  if (["failed", "cancelled"].includes(status))
    return { bg: "#f3f4f6", text: "#4b5563" };
  return { bg: "#f3f4f6", text: "#6b7280" };
}

export function generateStatementPdf({ transactions, user, from, to }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      info: {
        Title: "Njimbong Transaction Statement",
        Author: "Njimbong",
        Subject: "Account Statement",
      },
    });

    const buffers = [];
    doc.on("data", (c) => buffers.push(c));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const W = doc.page.width; // 595.28pt
    const ML = 44;
    const MR = 44;
    const CW = W - ML - MR;

    // Column layout
    const COL = {
      date: { x: ML, w: 68 },
      desc: { x: ML + 68, w: 178 },
      ref: { x: ML + 246, w: 100 },
      amt: { x: ML + 346, w: 96 },
      stat: { x: ML + 442, w: CW - 442 },
    };

    // Totals
    let totalIn = 0,
      totalOut = 0;
    for (const tx of transactions) {
      if (tx.direction === "in") totalIn += Number(tx.amount);
      else if (tx.direction === "out") totalOut += Number(tx.amount);
    }
    const net = totalIn - totalOut;

    const periodLabel = (() => {
      if (from && to) return `${fmtDateFull(from)} - ${fmtDateFull(to)}`;
      if (from) return `From ${fmtDateFull(from)}`;
      if (transactions.length === 0) return "All transactions";
      const oldest = transactions[transactions.length - 1].created_at;
      const newest = transactions[0].created_at;
      return `${fmtDateFull(oldest)} - ${fmtDateFull(newest)}`;
    })();

    let pageNum = 0;

    function drawPageHeader() {
      pageNum++;

      // Green header band
      doc.rect(0, 0, W, 58).fill(BRAND_GREEN);

      // Logo / brand
      doc
        .fillColor("white")
        .font("Helvetica-Bold")
        .fontSize(14)
        .text("NJIMBONG", ML, 18);
      doc
        .fillColor("rgba(255,255,255,0.65)")
        .font("Helvetica")
        .fontSize(7.5)
        .text("TRANSACTION STATEMENT", ML, 36);

      // Page number right-aligned
      doc
        .fillColor("rgba(255,255,255,0.55)")
        .font("Helvetica")
        .fontSize(7)
        .text(`Page ${pageNum}`, 0, 24, { width: W - ML, align: "right" });

      // Thin accent line below header
      doc.rect(0, 58, W, 2).fill(BRAND_GREEN2);
    }

    // ── PAGE 1 ───────────────────────────────────────────────────────────────
    drawPageHeader();

    let y = 76;

    // Account info
    doc
      .fillColor(DARK)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(user.name || "Account Holder", ML, y);
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(8)
      .text(user.email || "", ML, y + 13);
    doc
      .fillColor(MUTED_LIGHT)
      .font("Helvetica")
      .fontSize(7.5)
      .text(`Period: ${periodLabel}`, ML, y + 27);
    doc
      .fillColor(MUTED_LIGHT)
      .font("Helvetica")
      .fontSize(7.5)
      .text(
        `Generated: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`,
        0,
        y + 27,
        { width: W - ML, align: "right" },
      );

    y += 50;

    // ── Summary card ─────────────────────────────────────────────────────────
    const BOX_H = 66;
    doc.roundedRect(ML, y, CW, BOX_H, 6).fillAndStroke(BRAND_LIGHT, "#bbf7d0");

    const colW = CW / 4;
    const summaryItems = [
      { label: "Total Received", value: "+" + fmt(totalIn), color: POSITIVE },
      { label: "Total Sent", value: "-" + fmt(totalOut), color: NEGATIVE },
      {
        label: "Net",
        value: (net >= 0 ? "+" : "-") + fmt(Math.abs(net)),
        color: net >= 0 ? POSITIVE : NEGATIVE,
      },
      {
        label: "Transactions",
        value: String(transactions.length),
        color: DARK,
      },
    ];

    summaryItems.forEach((item, i) => {
      const cx = ML + colW * i;
      if (i < summaryItems.length - 1) {
        doc
          .moveTo(cx + colW, y + 12)
          .lineTo(cx + colW, y + BOX_H - 12)
          .strokeColor(BORDER)
          .lineWidth(0.5)
          .stroke();
      }
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(6.5)
        .text(item.label.toUpperCase(), cx, y + 13, {
          width: colW,
          align: "center",
        });
      doc
        .fillColor(item.color)
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(item.value, cx, y + 28, { width: colW, align: "center" });
    });

    y += BOX_H + 18;

    // ── Table ─────────────────────────────────────────────────────────────────
    const ROW_H = 24;
    const PILL_H = 12;

    function drawTableHeader() {
      doc.rect(ML, y, CW, ROW_H - 2).fill("#f3f4f6");
      // Bottom border of header
      doc
        .moveTo(ML, y + ROW_H - 2)
        .lineTo(ML + CW, y + ROW_H - 2)
        .strokeColor("#d1d5db")
        .lineWidth(0.6)
        .stroke();

      const headers = [
        { col: COL.date, label: "DATE", align: "left" },
        { col: COL.desc, label: "DESCRIPTION", align: "left" },
        { col: COL.ref, label: "REFERENCE", align: "left" },
        { col: COL.amt, label: "AMOUNT", align: "right" },
        { col: COL.stat, label: "STATUS", align: "left" },
      ];

      doc.fillColor("#374151").font("Helvetica-Bold").fontSize(6.5);
      headers.forEach(({ col, label, align }) => {
        doc.text(label, col.x + 5, y + 8, { width: col.w - 10, align });
      });
      y += ROW_H;
    }

    drawTableHeader();

    const PAGE_BOTTOM = doc.page.height - 44;

    transactions.forEach((tx, i) => {
      if (y + ROW_H > PAGE_BOTTOM) {
        doc.addPage({ size: "A4", margin: 0 });
        drawPageHeader();
        y = 80;
        drawTableHeader();
      }

      const isIn = tx.direction === "in";
      const isPend = tx.direction === "pending";
      const rowBg = i % 2 === 0 ? "white" : ROW_ALT;

      doc.rect(ML, y, CW, ROW_H).fill(rowBg);

      // Row separator
      doc
        .moveTo(ML, y + ROW_H)
        .lineTo(ML + CW, y + ROW_H)
        .strokeColor(BORDER)
        .lineWidth(0.25)
        .stroke();

      const ty = y + (ROW_H - 8) / 2; // vertical centre

      // Date
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(7)
        .text(fmtDate(tx.created_at), COL.date.x + 5, ty, {
          width: COL.date.w - 10,
          lineBreak: false,
        });

      // Description (title line + sub) — manually truncated to prevent overflow
      const desc = tx.listing_title || typeLabel(tx.type);
      const sub = tx.counterparty || "";
      const descAvailW = COL.desc.w - 10;
      const descY = sub ? ty - 3 : ty;

      doc.font("Helvetica").fontSize(7.5);
      const descText = truncate(doc, desc, descAvailW);
      doc
        .fillColor(DARK)
        .text(descText, COL.desc.x + 5, descY, { lineBreak: false });

      if (sub) {
        doc.font("Helvetica").fontSize(6);
        const subText = truncate(doc, sub, descAvailW);
        doc
          .fillColor(MUTED_LIGHT)
          .text(subText, COL.desc.x + 5, descY + 10, { lineBreak: false });
      }

      // Reference
      const ref = tx.order_reference || tx.reference || "";
      doc
        .fillColor(MUTED_LIGHT)
        .font("Helvetica")
        .fontSize(6.5)
        .text(ref || "-", COL.ref.x + 5, ty, {
          width: COL.ref.w - 10,
          lineBreak: false,
          ellipsis: true,
        });

      // Amount — sign uses plain ASCII +/-
      const sign = isIn ? "+" : isPend ? "" : "-";
      const amtStr = sign + fmt(tx.amount);
      const amtCol = isIn ? POSITIVE : isPend ? MUTED : NEGATIVE;

      doc
        .fillColor(amtCol)
        .font("Helvetica-Bold")
        .fontSize(8)
        .text(amtStr, COL.amt.x, ty, {
          width: COL.amt.w - 6,
          align: "right",
          lineBreak: false,
        });

      // Status pill
      const st = statusStyle(tx.status);
      const lab = statusLabel(tx.status);
      // Measure label width for pill
      doc.font("Helvetica").fontSize(6.5);
      const labW = Math.min(doc.widthOfString(lab) + 10, COL.stat.w - 10);
      const pillX = COL.stat.x + 5;
      const pillY = y + (ROW_H - PILL_H) / 2;
      doc.roundedRect(pillX, pillY, labW, PILL_H, 3).fill(st.bg);
      doc
        .fillColor(st.text)
        .font("Helvetica")
        .fontSize(6.5)
        .text(lab, pillX, pillY + 2.5, {
          width: labW,
          align: "center",
          lineBreak: false,
        });

      y += ROW_H;
    });

    // ── Footer on every page ──────────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let p = 0; p < range.count; p++) {
      doc.switchToPage(range.start + p);
      const H = doc.page.height;
      doc.rect(0, H - 28, W, 28).fill(BRAND_GREEN);
      doc
        .fillColor("rgba(255,255,255,0.55)")
        .font("Helvetica")
        .fontSize(6.5)
        .text(
          `Njimbong  |  Automatically generated statement  |  support@njimbong.com`,
          ML,
          H - 18,
          { width: CW, align: "center" },
        );
    }

    doc.end();
  });
}
