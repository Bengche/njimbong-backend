import express from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import db from "../db.js";
import { sendWelcomeEmail, sendPasswordResetEmail } from "../utils/email.js";

const router = express.Router();

// GET /auth/verify-email?token=...
router.get("/verify-email", async (req, res) => {
  const { token } = req.query;

  if (!token || typeof token !== "string" || token.length > 200) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid or missing token." });
  }

  try {
    // Look up valid, unused, unexpired token
    const result = await db.query(
      `SELECT ev.id, ev.user_id, ev.used_at, ev.expires_at,
              u.name, u.email, u.email_verified
       FROM email_verifications ev
       JOIN users u ON u.id = ev.user_id
       WHERE ev.token = $1`,
      [token],
    );

    if (result.rows.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Verification link is invalid." });
    }

    const row = result.rows[0];

    if (row.used_at) {
      return res
        .status(400)
        .json({ success: false, message: "This link has already been used." });
    }

    if (new Date(row.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        message: "This verification link has expired.",
      });
    }

    // Mark token as used and user as verified in a single transaction
    await db.query("BEGIN");
    await db.query(
      "UPDATE email_verifications SET used_at = NOW() WHERE id = $1",
      [row.id],
    );
    await db.query("UPDATE users SET email_verified = TRUE WHERE id = $1", [
      row.user_id,
    ]);
    await db.query("COMMIT");

    // Send welcome email only on first verification
    if (!row.email_verified) {
      sendWelcomeEmail({ name: row.name, email: row.email });
    }

    return res.json({
      success: true,
      message: "Email verified successfully. Welcome to Njimbong!",
    });
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("Email verification error:", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Server error. Please try again." });
  }
});

// POST /auth/forgot-password
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== "string" || email.length > 255) {
    return res
      .status(400)
      .json({ error: "A valid email address is required." });
  }
  // Always return the same generic response to prevent email enumeration
  const ok = {
    message: "If that email is registered, a reset link has been sent.",
  };

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      VARCHAR(64) NOT NULL UNIQUE,
        used_at    TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const userRes = await db.query(
      "SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1)",
      [email.trim()],
    );
    if (userRes.rows.length === 0) return res.json(ok);

    const user = userRes.rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, token, expiresAt],
    );

    sendPasswordResetEmail(user, token).catch((err) =>
      console.error("[Auth] Password reset email error:", err.message),
    );
    return res.json(ok);
  } catch (err) {
    console.error("[Auth] forgot-password error:", err.message);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
});

// POST /auth/reset-password
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || typeof token !== "string" || token.length !== 64) {
    return res.status(400).json({ error: "Invalid reset token." });
  }
  if (!newPassword || typeof newPassword !== "string") {
    return res.status(400).json({ error: "New password is required." });
  }
  if (newPassword.length < 8) {
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters." });
  }
  if (newPassword.length > 128) {
    return res.status(400).json({ error: "Password is too long." });
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      VARCHAR(64) NOT NULL UNIQUE,
        used_at    TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const result = await db.query(
      `SELECT prt.id, prt.user_id, prt.used_at, prt.expires_at
       FROM password_reset_tokens prt
       WHERE prt.token = $1`,
      [token],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired reset link." });
    }
    const row = result.rows[0];
    if (row.used_at) {
      return res
        .status(400)
        .json({ error: "This link has already been used." });
    }
    if (new Date(row.expires_at) < new Date()) {
      return res
        .status(400)
        .json({
          error: "This reset link has expired. Please request a new one.",
        });
    }

    const hash = await bcrypt.hash(newPassword, 12);

    await db.query("BEGIN");
    await db.query(
      "UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1",
      [row.id],
    );
    await db.query(
      "UPDATE users SET passwordhash = $1, updatedat = NOW() WHERE id = $2",
      [hash, row.user_id],
    );
    await db.query("COMMIT");

    return res.json({
      message:
        "Password reset successfully. You can now log in with your new password.",
    });
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("[Auth] reset-password error:", err.message);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
});

export default router;
