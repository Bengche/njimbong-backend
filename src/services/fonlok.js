import axios from "axios";
import crypto from "crypto";

const BASE = "https://fonlok-backend-production.up.railway.app";

if (!process.env.FONLOK_API_KEY) {
  console.warn("[Fonlok] FONLOK_API_KEY environment variable is not set.");
}

const client = axios.create({
  baseURL: BASE,
  headers: {
    Authorization: `Bearer ${process.env.FONLOK_API_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

/** Create an escrow invoice for a marketplace listing. */
export async function createFonlokInvoice({
  title,
  amount,
  buyerEmail,
  sellerEmail,
  sellerPhone,
  description,
  orderId,
  expiresAt,
}) {
  const payload = {
    title,
    amount,
    currency: "XAF",
    buyer_email: buyerEmail,
    seller_email: sellerEmail,
    seller_phone: sellerPhone,
    description,
    reference: `njimbong-${orderId}`,
    expires_at: expiresAt,
  };
  console.log("[Fonlok] createInvoice payload:", JSON.stringify(payload));
  try {
    const { data } = await client.post("/v1/invoices", payload);
    console.log("[Fonlok] createInvoice response:", JSON.stringify(data));
    return data; // { id, payment_url, status, ... }
  } catch (err) {
    console.error(
      "[Fonlok] createInvoice error status:",
      err.response?.status,
      "body:",
      JSON.stringify(err.response?.data),
    );
    throw err;
  }
}

/** Trigger a MoMo prompt on the buyer's phone. */
export async function initiateFonlokPayment({
  invoiceId,
  phoneNumber,
  buyerEmail,
}) {
  const { data } = await client.post("/v1/payments/initiate", {
    invoice_id: invoiceId,
    phone_number: phoneNumber,
    buyer_email: buyerEmail,
  });
  return data; // { reference, status, provider, ... }
}

/** Poll a payment's current status. */
export async function getFonlokPaymentStatus(reference) {
  const { data } = await client.get(`/v1/payments/${reference}/status`);
  return data; // { status, invoice_status, amount, ... }
}

/** Get a full invoice by ID. */
export async function getFonlokInvoice(invoiceId) {
  const { data } = await client.get(`/v1/invoices/${invoiceId}`);
  return data;
}

/**
 * Verify an incoming webhook signature.
 * Must be called before trusting any event payload.
 * @param {Buffer} rawBody - The raw request body bytes (not parsed JSON).
 * @param {string} signatureHeader - The full value of X-Fonlok-Signature.
 */
export function verifyFonlokWebhook(rawBody, signatureHeader) {
  const secret = process.env.FONLOK_WEBHOOK_SECRET;
  if (!secret) return false;
  const [algo, received] = signatureHeader.split("=");
  if (algo !== "sha256" || !received) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  try {
    // Constant-time comparison prevents timing oracle attacks
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(received, "hex"),
    );
  } catch {
    return false; // buffers of different lengths
  }
}
