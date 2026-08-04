/**
 * generateDisputePdf.js
 * Produces a professional A4 evidence PDF for Fonlok dispute resolution.
 * Includes order details, buyer/seller identities, and the full chat transcript
 * (or a clear notice if no chat was recorded).
 */
import PDFDocument from "pdfkit";

// ─── Brand / colour palette ───────────────────────────────────────────────────
const C = {
  brand:      "#065f46",
  brandAccent:"#059669",
  white:      "#ffffff",
  dark:       "#111827",
  muted:      "#6b7280",
  mutedLight: "#9ca3af",
  rule:       "#e5e7eb",
  bgGray:     "#f9fafb",
  bgBlue:     "#eff6ff",
  accentBlue: "#3b82f6",
  labelBlue:  "#1d4ed8",
  bgGreen:    "#f0fdf4",
  accentGreen:"#10b981",
  labelGreen: "#15803d",
  bgAmber:    "#fffbeb",
  accentAmber:"#f59e0b",
  labelAmber: "#78350f",
  headerSub:  "#a7f3d0",
  headerMeta: "#6ee7b7",
};

// ─── Page geometry ────────────────────────────────────────────────────────────
const ML  = 52;   // margin left
const MR  = 52;   // margin right
const PW  = 595.28; // A4 width
const PH  = 841.89; // A4 height
const CW  = PW - ML - MR; // content width  ≈ 491
const BOTTOM_SAFE = PH - 58; // lowest safe y before footer zone

// ─── Helper: draw a horizontal rule ─────────────────────────────────────────
function rule(doc, y, color = C.rule, width = 0.5) {
  doc.save()
    .lineWidth(width).strokeColor(color)
    .moveTo(ML, y).lineTo(ML + CW, y).stroke()
    .restore();
}

// ─── Helper: label over value (returns y after the pair) ────────────────────
function labelValue(doc, label, value, x, y, colWidth, opts = {}) {
  doc
    .fillColor(C.muted).font("Helvetica").fontSize(7)
    .text(label.toUpperCase(), x, y, { width: colWidth, lineBreak: false, characterSpacing: 0.4 });
  doc
    .fillColor(C.dark).font("Helvetica-Bold").fontSize(opts.valueSize ?? 10)
    .text(value ?? "N/A", x, y + 11, { width: colWidth, lineBreak: false });
}

// ─── Helper: wrapped label over value (returns estimated height) ─────────────
function labelValueWrapped(doc, label, value, x, y, colWidth) {
  doc
    .fillColor(C.muted).font("Helvetica").fontSize(7)
    .text(label.toUpperCase(), x, y, { width: colWidth, lineBreak: false, characterSpacing: 0.4 });
  doc
    .fillColor(C.dark).font("Helvetica").fontSize(10)
    .text(value ?? "N/A", x, y + 11, { width: colWidth, lineGap: 2 });
  doc.font("Helvetica").fontSize(10);
  const h = doc.heightOfString(value ?? "N/A", { width: colWidth, lineGap: 2 });
  return 11 + h + 4;
}

// ─── Main export ──────────────────────────────────────────────────────────────
export function generateDisputePdf({ order, buyer, seller, listing, reason, messages }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 0, bottom: 0, left: ML, right: MR },
      bufferPages: true,
      info: {
        Title:   `Dispute Evidence Report — Order #${order.reference}`,
        Author:  "Njimbong Platform",
        Subject: "Dispute Evidence",
        Creator: "Njimbong",
      },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const generatedAt = new Date().toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
      timeZone: "Africa/Douala",
    }) + " WAT";

    const msgCount = messages?.length ?? 0;
    const HALF = (CW - 14) / 2; // half-column width with 14pt gutter
    const COL2X = ML + HALF + 14;

    // ── 1. HEADER BAR ────────────────────────────────────────────────────────
    doc.rect(0, 0, PW, 68).fill(C.brand);
    doc.rect(0, 65, PW, 3).fill(C.brandAccent); // bottom accent stripe

    // Wordmark
    doc.fillColor(C.white).font("Helvetica-Bold").fontSize(21)
      .text("NJIMBONG", ML, 16, { lineBreak: false });

    // Vertical separator
    doc.save().lineWidth(0.7).strokeColor("#34d399")
      .moveTo(ML + 132, 20).lineTo(ML + 132, 50).stroke().restore();

    // Report type label
    doc.fillColor(C.white).font("Helvetica-Bold").fontSize(10)
      .text("DISPUTE EVIDENCE REPORT", ML + 144, 18, { lineBreak: false });

    doc.fillColor(C.headerSub).font("Helvetica").fontSize(8.5)
      .text("Confidential — for Fonlok dispute resolution only", ML + 144, 33, { lineBreak: false });

    // Generated timestamp top-right
    doc.fillColor(C.headerMeta).font("Helvetica").fontSize(7.5)
      .text(generatedAt, ML, 50, { width: CW, align: "right", lineBreak: false });

    // ── 2. REFERENCE SECTION ─────────────────────────────────────────────────
    let y = 82;

    // Row 1: Order ref | Invoice ID
    labelValue(doc, "Njimbong Order", `#${order.reference}`, ML, y, HALF);
    labelValue(doc, "Fonlok Invoice", order.fonlokInvoiceId ?? "N/A", COL2X, y, HALF, { valueSize: 9 });
    y += 30;

    // Row 2: Listing | Amount
    const listingDisplay = listing.title.length > 48
      ? listing.title.slice(0, 45) + "…"
      : listing.title;
    const amountDisplay = order.amount
      ? `${Number(order.amount).toLocaleString("fr-CM")} ${order.currency ?? "XAF"}`
      : "N/A";
    labelValue(doc, "Listing", listingDisplay, ML, y, HALF);
    labelValue(doc, "Amount in Escrow", amountDisplay, COL2X, y, HALF);
    y += 30;

    // Row 3: Dispute reason (full width, may wrap)
    const reasonH = labelValueWrapped(
      doc, "Dispute Reason", reason || "No reason provided", ML, y, CW,
    );
    y += reasonH + 10;

    // Thin rule after reference section
    rule(doc, y);
    y += 14;

    // ── 3. PARTY CARDS ───────────────────────────────────────────────────────
    const CARD_H = 60;

    // Buyer card
    doc.lineWidth(0.5)
      .rect(ML, y, HALF, CARD_H)
      .fillAndStroke(C.bgBlue, "#bfdbfe");
    doc.rect(ML, y, 4, CARD_H).fill(C.accentBlue);
    doc.fillColor(C.labelBlue).font("Helvetica-Bold").fontSize(7.5)
      .text("BUYER", ML + 12, y + 9, { lineBreak: false, characterSpacing: 0.5 });
    doc.fillColor(C.dark).font("Helvetica-Bold").fontSize(11)
      .text(buyer.name, ML + 12, y + 22);
    doc.fillColor(C.muted).font("Helvetica").fontSize(8.5)
      .text(buyer.email, ML + 12, y + 38, { width: HALF - 24, lineBreak: false });

    // Seller card
    doc.lineWidth(0.5)
      .rect(COL2X, y, HALF, CARD_H)
      .fillAndStroke(C.bgGreen, "#bbf7d0");
    doc.rect(COL2X, y, 4, CARD_H).fill(C.accentGreen);
    doc.fillColor(C.labelGreen).font("Helvetica-Bold").fontSize(7.5)
      .text("SELLER", COL2X + 12, y + 9, { lineBreak: false, characterSpacing: 0.5 });
    doc.fillColor(C.dark).font("Helvetica-Bold").fontSize(11)
      .text(seller.name, COL2X + 12, y + 22);
    doc.fillColor(C.muted).font("Helvetica").fontSize(8.5)
      .text(seller.email, COL2X + 12, y + 38, { width: HALF - 24, lineBreak: false });

    y += CARD_H + 20;

    // ── 4. TRANSCRIPT HEADER ─────────────────────────────────────────────────
    rule(doc, y);
    y += 14;

    doc.fillColor(C.brand).font("Helvetica-Bold").fontSize(13)
      .text("Chat Transcript", ML, y, { lineBreak: false });
    y += 19;

    const subLine = msgCount > 0
      ? `${msgCount} message${msgCount !== 1 ? "s" : ""} — between ${buyer.name} and ${seller.name}`
      : `No prior communication recorded between ${buyer.name} and ${seller.name}`;

    doc.fillColor(C.muted).font("Helvetica").fontSize(9)
      .text(subLine, ML, y, { lineBreak: false });
    y += 20;

    // ── 5a. NO-CHAT NOTICE ───────────────────────────────────────────────────
    if (msgCount === 0) {
      const noticeText =
        `There is no prior in-app communication on record between ${buyer.name} (buyer) ` +
        `and ${seller.name} (seller) concerning this listing on the Njimbong platform. ` +
        `This order was placed without any preceding chat exchange. The dispute was ` +
        `opened without an existing conversation thread to reference.`;

      doc.font("Helvetica").fontSize(9.5);
      const ntH = doc.heightOfString(noticeText, { width: CW - 32, lineGap: 3 });
      const noticeBoxH = ntH + 36;

      if (y + noticeBoxH > BOTTOM_SAFE) { doc.addPage(); y = 60; }

      doc.rect(ML, y, CW, noticeBoxH).fill(C.bgAmber);
      doc.rect(ML, y, 4, noticeBoxH).fill(C.accentAmber);

      doc.fillColor(C.labelAmber).font("Helvetica-Bold").fontSize(10)
        .text("No prior chat recorded on this listing", ML + 14, y + 11, { lineBreak: false });
      doc.fillColor(C.labelAmber).font("Helvetica").fontSize(9.5)
        .text(noticeText, ML + 14, y + 27, { width: CW - 32, lineGap: 3 });

      y += noticeBoxH + 12;

    // ── 5b. MESSAGES ─────────────────────────────────────────────────────────
    } else {
      for (let i = 0; i < messages.length; i++) {
        const msg     = messages[i];
        const isBuyer = msg.role === "Buyer";
        const bgClr   = isBuyer ? C.bgBlue  : C.bgGreen;
        const acclClr = isBuyer ? C.accentBlue  : C.accentGreen;
        const lblClr  = isBuyer ? C.labelBlue   : C.labelGreen;

        const ts = new Date(msg.created_at).toLocaleString("en-GB", {
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit", hour12: false,
          timeZone: "Africa/Douala",
        });

        doc.font("Helvetica").fontSize(10);
        const contentH = doc.heightOfString(msg.content, { width: CW - 36, lineGap: 2.5 });
        const boxH = Math.max(48, contentH + 32);

        if (y + boxH > BOTTOM_SAFE) { doc.addPage(); y = 60; }

        // Background
        doc.rect(ML, y, CW, boxH).fill(bgClr);
        // Left accent stripe
        doc.rect(ML, y, 4, boxH).fill(acclClr);

        // Row separator for consecutive messages (skip first)
        if (i > 0) {
          doc.save().lineWidth(0.3).strokeColor(C.rule)
            .moveTo(ML + 4, y).lineTo(ML + CW, y).stroke().restore();
        }

        // Role + name
        doc.fillColor(lblClr).font("Helvetica-Bold").fontSize(8)
          .text(
            `${msg.role.toUpperCase()}  ·  ${msg.sender_name}`,
            ML + 14, y + 10, { lineBreak: false },
          );

        // Timestamp — right-aligned
        doc.fillColor(C.mutedLight).font("Helvetica").fontSize(7.5)
          .text(ts, ML, y + 10, { width: CW - 8, align: "right", lineBreak: false });

        // Message body
        doc.fillColor(C.dark).font("Helvetica").fontSize(10)
          .text(msg.content, ML + 14, y + 24, { width: CW - 36, lineGap: 2.5 });

        y += boxH;
      }
    }

    // ── 6. FOOTERS (all pages) ───────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let p = 0; p < range.count; p++) {
      doc.switchToPage(range.start + p);
      const fy = PH - 36;
      rule(doc, fy - 7, C.rule, 0.4);

      doc.fillColor(C.muted).font("Helvetica").fontSize(7)
        .text(
          `Generated by Njimbong Platform  ·  ${generatedAt}  ·  Confidential`,
          ML, fy, { width: CW - 70, lineBreak: false },
        );
      doc.fillColor(C.muted).font("Helvetica").fontSize(7)
        .text(
          `Page ${p + 1} of ${range.count}`,
          ML, fy, { width: CW, align: "right", lineBreak: false },
        );
    }

    doc.end();
  });
}
