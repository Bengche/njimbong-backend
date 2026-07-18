import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import registerUSER from "./routes/UserRegisteration.js";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import userLogin from "./routes/userLogin.js";
import AdminLogin from "./routes/adminLogin.js";
import categories from "./routes/categories.js";
import listings from "./routes/listings.js";
import users from "./routes/users.js";
import kyc from "./routes/kyc.js";
import notifications from "./routes/notifications.js";
import adminListings from "./routes/adminListings.js";
import reports from "./routes/reports.js";
import adminModeration from "./routes/adminModeration.js";
import chat from "./routes/chat.js";
import trustScore from "./routes/trustScore.js";
import preferences from "./routes/preferences.js";
import favorites from "./routes/favorites.js";
import wishlist from "./routes/wishlist.js";
import analytics from "./routes/analytics.js";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import logout from "./routes/userLogout.js";
import homeListings from "./routes/homeListings.js";
import payments from "./routes/payments.js";
import fonlokWebhook from "./routes/fonlokWebhook.js";
import emailVerification from "./routes/emailVerification.js";
import offers from "./routes/offers.js";
import orders from "./routes/orders.js";
import db from "./db.js";
import {
  sendListingExpiryWarning,
  sendListingExpired,
  sendSavedSearchAlert,
} from "./utils/email.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "./utils/pushNotifications.js";
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Fonlok webhook must be mounted BEFORE express.json() — it needs the raw body bytes to verify HMAC signatures.
app.use(fonlokWebhook);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000000000000000000000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path === "/health" ||
    req.path === "/" ||
    req.path === "/favicon.ico" ||
    req.path === "/api/user/me" ||
    req.path === "/api/users/me",
});

const readOnlyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path === "/health" ||
    req.path === "/" ||
    req.path === "/favicon.ico" ||
    req.path === "/api/user/me" ||
    req.path === "/api/users/me",
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path === "/health" ||
    req.path === "/" ||
    req.path === "/favicon.ico" ||
    req.path === "/api/user/me" ||
    req.path === "/api/users/me",
});

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use((req, res, next) => {
  if (req.method === "GET") {
    return readOnlyLimiter(req, res, next);
  }
  return writeLimiter(req, res, next);
});

app.use("/auth", authLimiter);
app.use("/admin", authLimiter);
app.use("/admin", AdminLogin);
app.use("/auth", userLogin);
app.use("/auth", registerUSER);
app.use("/auth", emailVerification);
app.use("/register", registerUSER);
app.use("/api", listings);
app.use("/api", categories);
app.use("/api", users);
app.use("/api", kyc);
app.use("/api", notifications);
app.use("/api", adminListings);
app.use("/api", reports);
app.use("/api", adminModeration);
app.use("/api", chat);
app.use("/api", trustScore);
app.use("/api", preferences);
app.use("/api", favorites);
app.use("/api", wishlist);
app.use("/api/analytics", analytics);
app.use("/auth", logout);
app.use("/home", homeListings);
app.use("/api", payments);
app.use("/api", offers);
app.use("/api", orders);

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

const ensureKycTriggers = async () => {
  try {
    const result = await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'kyc_status'",
    );

    if (result.rowCount === 0) {
      await db.query("DROP TRIGGER IF EXISTS trust_score_kyc_trigger ON users");
      await db.query(
        "DROP TRIGGER IF EXISTS trigger_update_review_eligibility ON users",
      );
      console.warn(
        "KYC triggers disabled: users.kyc_status column is missing.",
      );
    }
  } catch (error) {
    console.warn("KYC trigger check failed:", error);
  }
};

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
  ensureKycTriggers();

  // Ensure seller_email column exists on userlistings (added for Fonlok v2)
  db.query(
    `ALTER TABLE userlistings ADD COLUMN IF NOT EXISTS seller_email text`,
  ).catch((err) =>
    console.warn("seller_email migration skipped:", err.message),
  );

  // ─── Listing expiry cron (runs daily at 03:00) ────────────────────────────
  const runListingExpiry = async () => {
    try {
      // 1. Send 7-day warning for listings that will expire in exactly 7 days
      const warnResult = await db.query(
        `SELECT l.id, l.title, l.price, l.currency,
                u.name, u.email, u.id AS user_id
         FROM userlistings l
         JOIN users u ON u.id = l.userid
         WHERE l.status = 'Available'
           AND l.moderation_status = 'approved'
           AND l.createdat::date = (NOW() - INTERVAL '53 days')::date
           AND NOT EXISTS (
             SELECT 1 FROM orders WHERE listing_id = l.id
             AND fonlok_status IN ('pending','paid_in_escrow','released')
           )`,
      );
      for (const row of warnResult.rows) {
        sendListingExpiryWarning(
          { name: row.name, email: row.email },
          row,
        ).catch(() => {});
        sendPushToUser(
          row.user_id,
          buildNotificationPayload("listing_expiry_warning", {
            title: "Listing expiring soon",
            body: `Your listing "${row.title}" will expire in 7 days. Renew it now.`,
            url: "/dashboard",
          }),
        );
      }

      // 2. Expire listings older than 60 days
      const expiredResult = await db.query(
        `UPDATE userlistings
         SET status = 'Expired', updatedat = NOW()
         WHERE status = 'Available'
           AND moderation_status = 'approved'
           AND createdat < NOW() - INTERVAL '60 days'
           AND NOT EXISTS (
             SELECT 1 FROM orders WHERE listing_id = userlistings.id
             AND fonlok_status IN ('pending','paid_in_escrow')
           )
         RETURNING id, title, price, currency, userid`,
      );
      for (const row of expiredResult.rows) {
        const userRes = await db.query(
          `SELECT name, email FROM users WHERE id=$1`,
          [row.userid],
        );
        if (userRes.rows.length) {
          const user = userRes.rows[0];
          sendListingExpired(user, row).catch(() => {});
          sendPushToUser(
            row.userid,
            buildNotificationPayload("listing_expired", {
              title: "Listing expired",
              body: `Your listing "${row.title}" has expired. Renew it to relist.`,
              url: "/dashboard",
            }),
          );
        }
      }
      if (expiredResult.rowCount > 0) {
        console.log(`[Expiry] Expired ${expiredResult.rowCount} listings.`);
      }
    } catch (err) {
      console.error("[Expiry] Cron error:", err.message);
    }
  };

  // ─── Saved search alert cron (runs every 2 hours) ─────────────────────────
  const runSavedSearchAlerts = async () => {
    try {
      // Get all saved searches with notifications enabled
      const searchesRes = await db
        .query(
          `SELECT ss.id, ss.user_id, ss.name, ss.filters,
                u.email, u.name AS user_name
         FROM saved_searches ss
         JOIN users u ON u.id = ss.user_id
         WHERE ss.notify_new_listings = true`,
        )
        .catch(() => ({ rows: [] }));

      for (const search of searchesRes.rows) {
        const f = search.filters;
        const params = [];
        let where = `l.moderation_status = 'approved' AND l.status = 'Available'
                     AND l.createdat > NOW() - INTERVAL '2 hours'`;
        let idx = 1;
        if (f.search && f.search.trim()) {
          where += ` AND (LOWER(l.title) LIKE LOWER($${idx}) OR LOWER(l.description) LIKE LOWER($${idx}))`;
          params.push(`%${f.search.trim()}%`);
          idx++;
        }
        if (f.category && f.category.trim()) {
          where += ` AND l.categoryid = $${idx}`;
          params.push(f.category);
          idx++;
        }
        if (f.country && f.country.trim()) {
          where += ` AND LOWER(l.country) = LOWER($${idx})`;
          params.push(f.country);
          idx++;
        }
        if (f.city && f.city.trim()) {
          where += ` AND LOWER(l.city) = LOWER($${idx})`;
          params.push(f.city);
          idx++;
        }
        if (f.minPrice && f.minPrice.trim()) {
          where += ` AND l.price >= $${idx}`;
          params.push(parseFloat(f.minPrice));
          idx++;
        }
        if (f.maxPrice && f.maxPrice.trim()) {
          where += ` AND l.price <= $${idx}`;
          params.push(parseFloat(f.maxPrice));
          idx++;
        }
        if (f.condition && f.condition.trim()) {
          where += ` AND l.condition = $${idx}`;
          params.push(f.condition);
          idx++;
        }

        const matches = await db
          .query(
            `SELECT l.id, l.title, l.price, l.currency, l.city, l.country
           FROM userlistings l
           WHERE ${where}
           ORDER BY l.createdat DESC
           LIMIT 10`,
            params,
          )
          .then((r) => r.rows)
          .catch(() => []);

        if (matches.length > 0) {
          sendSavedSearchAlert(
            { name: search.user_name, email: search.email },
            search.name,
            matches,
          ).catch(() => {});
          sendPushToUser(
            search.user_id,
            buildNotificationPayload("saved_search_alert", {
              title: `${matches.length} new listing${matches.length > 1 ? "s" : ""} for "${search.name}"`,
              body: `New matches found for your saved search.`,
              url: "/market",
            }),
          );
        }
      }
    } catch (err) {
      console.error("[SavedSearchAlerts] Cron error:", err.message);
    }
  };

  // Schedule: expiry at 03:00 daily, saved search alerts every 2 hours
  const scheduleDaily = (fn, targetHour) => {
    const now = new Date();
    const next = new Date();
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      fn();
      setInterval(fn, 24 * 60 * 60 * 1000);
    }, next.getTime() - now.getTime());
  };
  scheduleDaily(runListingExpiry, 3);
  setInterval(runSavedSearchAlerts, 2 * 60 * 60 * 1000);
  // Run once at startup after 30s (to avoid blocking boot)
  setTimeout(runSavedSearchAlerts, 30 * 1000);

  // ─── Stale pending order cleanup (runs every 5 minutes) ───────────────────
  // MoMo USSD prompts time out in < 2 minutes. Any order stuck in
  // 'pending' or 'none' for > 5 minutes is definitively abandoned.
  // Marking them 'failed' unblocks other buyers from purchasing the listing.
  const runStaleOrderCleanup = async () => {
    try {
      const stale = await db.query(
        `UPDATE orders
         SET fonlok_status = 'failed', updated_at = NOW()
         WHERE fonlok_status IN ('pending', 'none')
           AND created_at < NOW() - INTERVAL '5 minutes'
         RETURNING id`,
      );
      if (stale.rowCount > 0) {
        console.log(`[StaleOrders] Cleaned up ${stale.rowCount} stale order(s).`);
      }
    } catch (err) {
      console.error("[StaleOrders] Cron error:", err.message);
    }
  };
  setInterval(runStaleOrderCleanup, 5 * 60 * 1000);
  setTimeout(runStaleOrderCleanup, 60 * 1000); // also run 60s after startup
});
