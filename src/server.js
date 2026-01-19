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
import db from "./db.js";
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
  })
);

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

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
  })
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

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

const ensureKycTriggers = async () => {
  try {
    const result = await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'kyc_status'"
    );

    if (result.rowCount === 0) {
      await db.query("DROP TRIGGER IF EXISTS trust_score_kyc_trigger ON users");
      await db.query(
        "DROP TRIGGER IF EXISTS trigger_update_review_eligibility ON users"
      );
      console.warn(
        "KYC triggers disabled: users.kyc_status column is missing."
      );
    }
  } catch (error) {
    console.warn("KYC trigger check failed:", error);
  }
};

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
  ensureKycTriggers();
});
