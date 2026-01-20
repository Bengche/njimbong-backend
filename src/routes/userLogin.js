import express from "express";
import bcrypt from "bcrypt";
import db from "../db.js";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import authMiddleware from "../Middleware/authMiddleware.js";
dotenv.config();
const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password required" });
  }

  try {
    // Use await directly, no callback
    const result = await db.query(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR username = $2",
      [email, email],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.passwordhash);

    if (!passwordMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Check onboarding status
    let onboardingComplete = false;
    try {
      const prefsResult = await db.query(
        "SELECT onboarding_complete FROM user_preferences WHERE user_id = $1",
        [user.id],
      );
      if (prefsResult.rows.length > 0) {
        onboardingComplete = prefsResult.rows[0].onboarding_complete;
      } else {
        // Create preferences record for new user
        await db.query(
          "INSERT INTO user_preferences (user_id, onboarding_complete) VALUES ($1, FALSE) ON CONFLICT (user_id) DO NOTHING",
          [user.id],
        );
      }
    } catch (prefError) {
      console.log("Preferences table may not exist yet:", prefError.message);
    }

    // Generate JWT token

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

    jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "6h" },
      (err, token) => {
        if (err) {
          console.error("Error generating JWT:", err);
          return res.status(500).json({ message: "Server error" });
        }

        // Clear any existing auth cookies first
        res.clearCookie("authToken", cookieOptions);

        // Set new cookie with fresh token
        res.cookie("authToken", token, {
          ...cookieOptions,
          maxAge: 6 * 60 * 60 * 1000, // 6 hours
        });

        console.log(`User logged in: ID=${user.id}, Email=${user.email}`);

        res.status(200).json({
          message: "Login successful",
          token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            username: user.username,
            profilePictureUrl: user.profilepictureurl,
            onboardingComplete: onboardingComplete,
          },
        });
      },
    );
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
