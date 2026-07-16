import express from "express";
import db from "../db.js";
import { sendWelcomeEmail } from "../utils/email.js";

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
      return res
        .status(400)
        .json({
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

export default router;
