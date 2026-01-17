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

    // Admin authenticated, generate JWT token
    const token = jwt.sign(
      { email: process.env.ADMIN_EMAIL, isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // Set cookie (for requests that use cookies)
    res.cookie("adminAuthToken", token, {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 1000, // 1 hour
    });

    // Also return token in response body for frontend to store
    res.status(200).json({
      message: "Admin login successful",
      token: token,
    });
  } catch (error) {
    console.error("Error during admin login:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
