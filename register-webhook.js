/**
 * One-time script: register Njimbong's webhook URL with Fonlok.
 *
 * Usage (run from the backend directory):
 *   node register-webhook.js
 *
 * Required env vars (set in Railway or .env):
 *   FONLOK_API_KEY   — your Fonlok API key
 *
 * After running, copy the returned `secret` into Railway as:
 *   FONLOK_WEBHOOK_SECRET=<value>
 *
 * The webhook URL to register is:
 *   https://njimbong-backend-production.up.railway.app/webhooks/fonlok
 */

import "dotenv/config";
import { registerFonlokWebhook, listFonlokWebhooks } from "./src/services/fonlok.js";

const WEBHOOK_URL =
  process.env.FONLOK_WEBHOOK_URL ||
  "https://njimbong-backend-production.up.railway.app/webhooks/fonlok";

(async () => {
  console.log("Current registered webhooks:");
  try {
    const existing = await listFonlokWebhooks();
    console.log(JSON.stringify(existing, null, 2));
  } catch (err) {
    console.warn("Could not list existing webhooks:", err.message);
  }

  console.log(`\nRegistering webhook: ${WEBHOOK_URL}`);
  const result = await registerFonlokWebhook(WEBHOOK_URL);

  console.log("\n✓ Webhook registered successfully:");
  console.log(JSON.stringify(result, null, 2));

  if (result.secret) {
    console.log(`
─────────────────────────────────────────────────
IMPORTANT: Set this in Railway (njimbong-backend):
  FONLOK_WEBHOOK_SECRET=${result.secret}
─────────────────────────────────────────────────
`);
  }
})().catch((err) => {
  console.error("Failed to register webhook:", err.response?.data || err.message);
  process.exit(1);
});
