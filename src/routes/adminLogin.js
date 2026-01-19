import express from "express";
import bcrypt from "bcrypt";
import db from "../db.js";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import authMiddleware from "../Middleware/authMiddleware.js";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();
const saltRounds = 10;

router.post("/login", async (req, res) => {
  const { adminEmail, adminPassword } = req.body;

  try {
    // Validate against environment variables
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
      console.error("Admin credentials not configured in environment");
      return res.status(500).json({ message: "Server configuration error" });
    }

    // Check email
    if (adminEmail !== process.env.ADMIN_EMAIL) {
      return res
        .status(401)
        .json({ message: "Invalid admin email or password" });
    }

    // Check password
    if (adminPassword !== process.env.ADMIN_PASSWORD) {
      return res
        .status(401)
        .json({ message: "Invalid admin email or password" });
    }

    const isProd = process.env.NODE_ENV === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      path: "/",
      ...(process.env.COOKIE_DOMAIN
        ? { domain: process.env.COOKIE_DOMAIN }
        : {}),
    };

    // Admin authenticated, generate JWT token
    const token = jwt.sign(
      { email: process.env.ADMIN_EMAIL, isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: "6h" }
    );

    // Set cookie (for requests that use cookies)
    res.cookie("adminAuthToken", token, {
      ...cookieOptions,
      maxAge: 6 * 60 * 60 * 1000, // 6 hours
    });

    res.status(200).json({ message: "Admin login successful" });
  } catch (error) {
    console.error("Error during admin login:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
