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
const PORT = process.env.PORT || 5000;

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
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(apiLimiter);
app.use("/auth", authLimiter);
app.use("/admin", authLimiter);

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});
app.use("/register", registerUSER);
app.use("/uploads", express.static("uploads"));
app.use("/auth", userLogin);
app.use("/admin", AdminLogin);
app.use("/api", categories);
app.use("/api", listings);
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

ensureKycTriggers().finally(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
});
