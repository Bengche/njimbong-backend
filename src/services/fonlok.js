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
  sellerName,
  sellerEmail,
  sellerPhone,
  buyerEmail,
  buyerPhone,
  description,
  orderId,
  expiresAt,
}) {
  const payload = {
    title,
    amount,
    currency: "XAF",
    seller_name: sellerName,
    seller_email: sellerEmail,
    seller_phone: sellerPhone,
    buyer_email: buyerEmail,
    buyer_phone: buyerPhone,
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

/** Release held funds to the seller after buyer confirms receipt. */
export async function releaseFonlokPayment(invoiceId) {
  const { data } = await client.post("/v1/payments/release", {
    invoice_id: invoiceId,
  });
  return data; // { seller_receives, platform_fee, released_at, ... }
}

/** Flag a paid invoice as disputed. */
export async function disputeFonlokPayment(invoiceId, reason) {
  const { data } = await client.post("/v1/payments/dispute", {
    invoice_id: invoiceId,
    reason,
  });
  return data;
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
 * Register a webhook endpoint with Fonlok.
 * Call once during setup; store the returned `secret` as FONLOK_WEBHOOK_SECRET.
 * @param {string} url - Publicly accessible HTTPS URL (e.g. https://njimbong-backend-production.up.railway.app/webhooks/fonlok)
 * @returns {{ id, url, secret, active, created_at }}
 */
export async function registerFonlokWebhook(url) {
  console.log("[Fonlok] Registering webhook:", url);
  const { data } = await client.post("/v1/webhooks/register", { url });
  console.log("[Fonlok] Webhook registered:", JSON.stringify(data));
  return data; // { id, url, secret, active, created_at }
}

/** List all registered webhook endpoints. */
export async function listFonlokWebhooks() {
  const { data } = await client.get("/v1/webhooks");
  return data;
}

// ─── Wallet API ───────────────────────────────────────────────────────────────

/**
 * Initiate a wallet deposit via MoMo.
 * The user is charged `amount + 1.5%`; their wallet is credited `amount` on success.
 * @returns {{ transaction_id, reference, amount_requested, amount_charged, fee, status }}
 */
export async function initiateWalletDeposit({
  amount,
  phone,
  userRef,
  description = "Wallet top-up",
}) {
  const { data } = await client.post("/v1/wallet/deposit/initiate", {
    amount,
    phone,
    user_ref: userRef,
    description,
  });
  return data;
}

/**
 * Poll wallet deposit status. Idempotent — safe to call multiple times.
 * @returns {{ reference, status, amount_credited, transaction_id, user_ref }}
 */
export async function getWalletDepositStatus(reference) {
  const { data } = await client.get(
    `/v1/wallet/deposit/${reference}/status`,
  );
  return data;
}

/**
 * Get wallet balance for a user. Returns 0 balance if no wallet exists yet.
 * @returns {{ user_ref, balance, currency }}
 */
export async function getWalletBalance(userRef) {
  const { data } = await client.get("/v1/wallet/balance", {
    params: { user_ref: userRef },
  });
  return data;
}

/**
 * Withdraw funds from wallet directly to the user's MoMo account.
 * No fee charged to user — Fonlok covers Campay's 1% disbursement fee.
 * Synchronous — funds dispatched before response is returned.
 * @returns {{ transaction_id, reference, amount_withdrawn, new_balance, status }}
 */
export async function withdrawFromWallet({
  amount,
  phone,
  userRef,
  description = "Withdrawal",
}) {
  const { data } = await client.post("/v1/wallet/withdraw", {
    amount,
    phone,
    user_ref: userRef,
    description,
  });
  return data;
}

/**
 * Fund an escrow invoice directly from the user's wallet balance.
 * Invoice must be in `pending` status. Buyer receives a release link by email.
 * @returns {{ invoice_id, amount_paid, new_balance, currency, status, release_code }}
 */
export async function payEscrowFromWallet({ invoiceId, userRef }) {
  const { data } = await client.post("/v1/wallet/pay", {
    invoice_id: invoiceId,
    user_ref: userRef,
  });
  return data;
}

/**
 * Delete a registered webhook by its Fonlok webhook ID.
 * @param {string} webhookId
 */
export async function deleteFonlokWebhook(webhookId) {
  const { data } = await client.delete(`/v1/webhooks/${webhookId}`);
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

  if (!secret) {
    // Secret not yet configured — allow through so emails and order updates work.
    // Set FONLOK_WEBHOOK_SECRET in Railway once Fonlok provides it to enforce
    // HMAC-SHA256 verification and prevent spoofed events.
    console.warn(
      "[Fonlok] FONLOK_WEBHOOK_SECRET is not set. " +
        "Webhook signature verification is DISABLED. " +
        "Set this variable in Railway to enable security.",
    );
    return true;
  }

  if (!signatureHeader) return false;
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
