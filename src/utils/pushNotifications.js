import webpush from "web-push";
import db from "../db.js";

const hasVapidKeys = Boolean(
  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
);

if (hasVapidKeys) {
  webpush.setVapidDetails(
    process.env.VAPID_MAILTO || "mailto:support@njimbong.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const isMissingTableError = (error) => error?.code === "42P01";

export const ensurePushSubscriptionsTable = async () => {
  await db.query(
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      expiration_time BIGINT,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );
};

export const upsertPushSubscription = async (
  userId,
  subscription,
  userAgent
) => {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("Invalid subscription payload");
  }

  await ensurePushSubscriptionsTable();

  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, expiration_time, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         expiration_time = EXCLUDED.expiration_time,
         user_agent = EXCLUDED.user_agent,
         updated_at = CURRENT_TIMESTAMP`,
    [
      userId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      subscription.expirationTime || null,
      userAgent || null,
    ]
  );
};

export const removePushSubscription = async (endpoint) => {
  if (!endpoint) return;
  try {
    await ensurePushSubscriptionsTable();
    await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [
      endpoint,
    ]);
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
};

export const sendPushToUser = async (userId, payload) => {
  if (!hasVapidKeys || !userId) return;

  let result;
  try {
    result = await db.query(
      `SELECT endpoint, p256dh, auth, expiration_time
       FROM push_subscriptions
       WHERE user_id = $1`,
      [userId]
    );
  } catch (error) {
    if (isMissingTableError(error)) return;
    console.warn("Push subscriptions table missing:", error.message);
    return;
  }

  if (!result.rows.length) return;

  const payloadString = JSON.stringify(payload);

  const sendResults = await Promise.allSettled(
    result.rows.map((row) =>
      webpush.sendNotification(
        {
          endpoint: row.endpoint,
          expirationTime: row.expiration_time || null,
          keys: {
            p256dh: row.p256dh,
            auth: row.auth,
          },
        },
        payloadString
      )
    )
  );

  await Promise.all(
    sendResults.map(async (res, idx) => {
      if (res.status !== "rejected") return;
      const statusCode = res.reason?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await removePushSubscription(result.rows[idx].endpoint);
      }
    })
  );
};
