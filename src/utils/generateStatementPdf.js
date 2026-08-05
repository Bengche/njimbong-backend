import PDFDocument from "pdfkit";

const BRAND_GREEN = "#166534";
const BRAND_GREEN_LIGHT = "#f0fdf4";
const DARK = "#111827";
const MUTED = "#6b7280";
const MUTED_LIGHT = "#9ca3af";
const BORDER = "#e5e7eb";
const ROW_ALT = "#f9fafb";
const POSITIVE = "#15803d";
const NEGATIVE = "#111827";

function fmt(amount) {
  return Number(amount).toLocaleString("fr-CM") + " XAF";
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

/**
 * Generates a multi-page A4 PDF transaction statement.
 * @param {{ transactions: object[], user: { name: string, email: string }, from?: string, to?: string }} params
 * @returns {Promise<Buffer>}
 */
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
    const ML = 44; // left margin
    const MR = 44; // right margin
    const CW = W - ML - MR; // content width = 507.28pt

    // ── Column layout ────────────────────────────────────────────────────────
    const COL = {
      date: { x: ML, w: 72 },
      desc: { x: ML + 72, w: 180 },
      ref: { x: ML + 252, w: 100 },
      amt: { x: ML + 352, w: 90 },
      stat: { x: ML + 442, w: CW - 442 },
    };

    // ── Summary ──────────────────────────────────────────────────────────────
    let totalIn = 0,
      totalOut = 0;
    for (const tx of transactions) {
      if (tx.direction === "in") totalIn += Number(tx.amount);
      else if (tx.direction === "out") totalOut += Number(tx.amount);
    }
    const net = totalIn - totalOut;

    const periodLabel = (() => {
      if (from && to) return `${fmtDateFull(from)} – ${fmtDateFull(to)}`;
      if (from) return `From ${fmtDateFull(from)}`;
      if (transactions.length === 0) return "All transactions";
      const oldest = transactions[transactions.length - 1].created_at;
      const newest = transactions[0].created_at;
      return `${fmtDateFull(oldest)} – ${fmtDateFull(newest)}`;
    })();

    // ─────────────────────────────────────────────────────────────────────────
    // HEADER (drawn once per page via a helper)
    // ─────────────────────────────────────────────────────────────────────────
    let pageNum = 0;
    const totalPages = () => doc.bufferedPageRange().count;

    function drawPageHeader() {
      pageNum++;
      // Green top bar
      doc.rect(0, 0, W, 64).fill(BRAND_GREEN);

      doc
        .fillColor("white")
        .font("Helvetica-Bold")
        .fontSize(15)
        .text("NJIMBONG", ML, 22);

      doc
        .fillColor("rgba(255,255,255,0.75)")
        .font("Helvetica")
        .fontSize(8.5)
        .text("ACCOUNT STATEMENT", ML, 40);

      doc
        .fillColor("rgba(255,255,255,0.6)")
        .font("Helvetica")
        .fontSize(7.5)
        .text(`Page ${pageNum}`, 0, 27, { width: W - ML, align: "right" });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAGE 1 HEADER BLOCK
    // ─────────────────────────────────────────────────────────────────────────
    drawPageHeader();

    let y = 84;

    // Account info block
    doc
      .fillColor(DARK)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(user.name || "Account holder", ML, y);
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(8.5)
      .text(user.email || "", ML, y + 13);
    doc
      .fillColor(MUTED_LIGHT)
      .font("Helvetica")
      .fontSize(7.5)
      .text(`Period: ${periodLabel}`, ML, y + 28);
    doc
      .fillColor(MUTED_LIGHT)
      .font("Helvetica")
      .fontSize(7.5)
      .text(
        `Generated: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`,
        0,
        y + 28,
        { width: W - ML, align: "right" },
      );

    y += 52;

    // ── Summary box ──────────────────────────────────────────────────────────
    const BOX_H = 62;
    doc
      .roundedRect(ML, y, CW, BOX_H, 6)
      .fillAndStroke(BRAND_GREEN_LIGHT, BORDER);

    const colW = CW / 4;
    const summaryItems = [
      { label: "Total Received", value: fmt(totalIn), color: POSITIVE },
      { label: "Total Sent", value: fmt(totalOut), color: NEGATIVE },
      {
        label: "Net Balance",
        value: (net >= 0 ? "+" : "−") + fmt(Math.abs(net)),
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
      const isLast = i === summaryItems.length - 1;

      if (!isLast) {
        doc
          .moveTo(cx + colW, y + 10)
          .lineTo(cx + colW, y + BOX_H - 10)
          .strokeColor(BORDER)
          .lineWidth(0.5)
          .stroke();
      }

      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(7)
        .text(item.label.toUpperCase(), cx, y + 12, {
          width: colW,
          align: "center",
        });

      doc
        .fillColor(item.color)
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .text(item.value, cx, y + 25, { width: colW, align: "center" });
    });

    y += BOX_H + 20;

    // ── Table header row ─────────────────────────────────────────────────────
    const ROW_H = 22;

    function drawTableHeader() {
      doc.rect(ML, y, CW, ROW_H).fill("#f3f4f6");

      const headers = [
        { col: COL.date, label: "DATE" },
        { col: COL.desc, label: "DESCRIPTION" },
        { col: COL.ref, label: "REFERENCE" },
        { col: COL.amt, label: "AMOUNT" },
        { col: COL.stat, label: "STATUS" },
      ];

      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.5);
      headers.forEach(({ col, label }) => {
        const align = col === COL.amt ? "right" : "left";
        doc.text(label, col.x + 4, y + 7, { width: col.w - 8, align });
      });

      y += ROW_H;
    }

    drawTableHeader();

    // ── Table rows ───────────────────────────────────────────────────────────
    const PAGE_BOTTOM = doc.page.height - 44; // leave footer space

    transactions.forEach((tx, i) => {
      // New page if needed
      if (y + ROW_H > PAGE_BOTTOM) {
        doc.addPage({ size: "A4", margin: 0 });
        drawPageHeader();
        y = 84;
        drawTableHeader();
      }

      const isIn = tx.direction === "in";
      const rowBg = i % 2 === 0 ? "white" : ROW_ALT;
      doc.rect(ML, y, CW, ROW_H).fill(rowBg);

      // Bottom border
      doc
        .moveTo(ML, y + ROW_H)
        .lineTo(ML + CW, y + ROW_H)
        .strokeColor(BORDER)
        .lineWidth(0.3)
        .stroke();

      const ty = y + 7; // text baseline

      // Date
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(7.5)
        .text(fmtDate(tx.created_at), COL.date.x + 4, ty, {
          width: COL.date.w - 8,
          lineBreak: false,
        });

      // Description
      const desc = tx.listing_title || typeLabel(tx.type);
      const sub = tx.counterparty ? tx.counterparty : "";
      doc
        .fillColor(DARK)
        .font("Helvetica")
        .fontSize(7.5)
        .text(desc, COL.desc.x + 4, ty, {
          width: COL.desc.w - 8,
          lineBreak: false,
          ellipsis: true,
        });
      if (sub) {
        doc
          .fillColor(MUTED_LIGHT)
          .font("Helvetica")
          .fontSize(6.5)
          .text(sub, COL.desc.x + 4, ty + 9, {
            width: COL.desc.w - 8,
            lineBreak: false,
            ellipsis: true,
          });
      }

      // Reference
      const ref = tx.order_reference || tx.reference || "—";
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(7)
        .text(ref, COL.ref.x + 4, ty, {
          width: COL.ref.w - 8,
          lineBreak: false,
          ellipsis: true,
        });

      // Amount
      const sign = isIn ? "+" : tx.direction === "pending" ? "" : "−";
      doc
        .fillColor(isIn ? POSITIVE : NEGATIVE)
        .font("Helvetica-Bold")
        .fontSize(7.5)
        .text(sign + fmt(tx.amount), COL.amt.x, ty, {
          width: COL.amt.w - 4,
          align: "right",
          lineBreak: false,
        });

      // Status
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(7)
        .text(statusLabel(tx.status), COL.stat.x + 4, ty, {
          width: COL.stat.w - 8,
          lineBreak: false,
        });

      y += ROW_H;
    });

    // ── Footer on every page ─────────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const H = doc.page.height;
      doc.rect(0, H - 32, W, 32).fill(BRAND_GREEN);
      doc
        .fillColor("rgba(255,255,255,0.6)")
        .font("Helvetica")
        .fontSize(7)
        .text(
          `Njimbong · This is an automatically generated statement · support@njimbong.com`,
          ML,
          H - 20,
          { width: CW, align: "center" },
        );
    }

    doc.end();
  });
}
