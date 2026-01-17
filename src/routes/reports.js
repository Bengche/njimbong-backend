/**
 * Reporting & Moderation Routes
 * ==============================
 * Handles all report submissions, viewing reports, and user-facing moderation features.
 *
 * Routes:
 * - GET /api/reports/reasons - Get available report reasons
 * - POST /api/reports/listing/:id - Report a listing
 * - POST /api/reports/user/:id - Report a user
 * - GET /api/reports/my-reports - Get user's submitted reports
 * - GET /api/user/:id/public-profile - Get public profile of a user
 * - GET /api/account/status - Check if current user is suspended
 * - POST /api/appeals/submit - Submit an appeal
 * - GET /api/appeals/my-appeals - Get user's submitted appeals
 * - GET /api/warnings/my-warnings - Get user's warnings
 */

import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import {
  blockIfSuspended,
  getUserSuspensionStatus,
} from "../Middleware/suspensionMiddleware.js";

const router = express.Router();

// =====================================================
// GET: Report Reasons
// =====================================================
/**
 * Get available report reasons for listings or users
 */
router.get("/reports/reasons", authMiddleware, async (req, res) => {
  try {
    const { type } = req.query; // 'listing', 'user', or undefined for all

    let query = "SELECT * FROM report_reasons WHERE is_active = true";
    const params = [];

    if (type === "listing") {
      query += " AND (category = 'listing' OR category = 'both')";
    } else if (type === "user") {
      query += " AND (category = 'user' OR category = 'both')";
    }

    query += " ORDER BY severity DESC, reason ASC";

    const result = await db.query(query, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching report reasons:", error);
    res.status(500).json({ error: "Failed to fetch report reasons" });
  }
});

// =====================================================
// POST: Report a Listing
// Suspended users cannot submit reports
// =====================================================
router.post(
  "/reports/listing/:id",
  authMiddleware,
  blockIfSuspended,
  async (req, res) => {
    const { id } = req.params;
    const { reasonId, customReason, evidenceUrls } = req.body;
    const reporterId = req.user.id;

    try {
      // Validate listing exists
      const listingCheck = await db.query(
        "SELECT id, userid FROM userlistings WHERE id = $1",
        [id]
      );

      if (listingCheck.rows.length === 0) {
        return res.status(404).json({ error: "Listing not found" });
      }

      // Prevent self-reporting
      if (listingCheck.rows[0].userid === reporterId) {
        return res
          .status(400)
          .json({ error: "You cannot report your own listing" });
      }

      // Check for duplicate report
      const duplicateCheck = await db.query(
        `SELECT id FROM reports 
       WHERE reporter_id = $1 AND reported_listing_id = $2 AND status = 'pending'`,
        [reporterId, id]
      );

      if (duplicateCheck.rows.length > 0) {
        return res.status(400).json({
          error:
            "You have already reported this listing. Please wait for review.",
        });
      }

      // Validate reason
      if (!reasonId) {
        return res
          .status(400)
          .json({ error: "Please select a reason for reporting" });
      }

      const reasonCheck = await db.query(
        "SELECT severity FROM report_reasons WHERE id = $1 AND is_active = true",
        [reasonId]
      );

      if (reasonCheck.rows.length === 0) {
        return res.status(400).json({ error: "Invalid report reason" });
      }

      // Determine priority based on reason severity
      const priority = reasonCheck.rows[0].severity;

      // Create report
      const result = await db.query(
        `INSERT INTO reports 
       (reporter_id, report_type, reported_listing_id, reported_user_id, reason_id, custom_reason, evidence_urls, priority, created_at)
       VALUES ($1, 'listing', $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
        [
          reporterId,
          id,
          listingCheck.rows[0].userid, // Also track the listing owner
          reasonId,
          customReason || null,
          evidenceUrls || null,
          priority,
        ]
      );

      // Increment report count for the listing owner (non-blocking)
      try {
        await db.query(
          "UPDATE users SET report_count = COALESCE(report_count, 0) + 1 WHERE id = $1",
          [listingCheck.rows[0].userid]
        );
      } catch (countError) {
        console.warn("Warning: failed to update report_count", countError);
      }

      res.status(201).json({
        message:
          "Report submitted successfully. Our team will review it shortly.",
        report: result.rows[0],
      });
    } catch (error) {
      console.error("Error submitting listing report:", error);
      res.status(500).json({ error: "Failed to submit report" });
    }
  }
);

// =====================================================
// POST: Report a User
// Suspended users cannot submit reports
// =====================================================
router.post(
  "/reports/user/:id",
  authMiddleware,
  blockIfSuspended,
  async (req, res) => {
    const { id } = req.params;
    const { reasonId, customReason, evidenceUrls } = req.body;
    const reporterId = req.user.id;

    try {
      // Prevent self-reporting
      if (parseInt(id) === reporterId) {
        return res.status(400).json({ error: "You cannot report yourself" });
      }

      // Validate user exists
      const userCheck = await db.query("SELECT id FROM users WHERE id = $1", [
        id,
      ]);

      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check for duplicate report
      const duplicateCheck = await db.query(
        `SELECT id FROM reports 
       WHERE reporter_id = $1 AND reported_user_id = $2 AND report_type = 'user' AND status = 'pending'`,
        [reporterId, id]
      );

      if (duplicateCheck.rows.length > 0) {
        return res.status(400).json({
          error: "You have already reported this user. Please wait for review.",
        });
      }

      // Validate reason
      if (!reasonId) {
        return res
          .status(400)
          .json({ error: "Please select a reason for reporting" });
      }

      const reasonCheck = await db.query(
        "SELECT severity FROM report_reasons WHERE id = $1 AND is_active = true",
        [reasonId]
      );

      if (reasonCheck.rows.length === 0) {
        return res.status(400).json({ error: "Invalid report reason" });
      }

      const priority = reasonCheck.rows[0].severity;

      // Create report
      const result = await db.query(
        `INSERT INTO reports 
       (reporter_id, report_type, reported_user_id, reason_id, custom_reason, evidence_urls, priority, created_at)
       VALUES ($1, 'user', $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
        [
          reporterId,
          id,
          reasonId,
          customReason || null,
          evidenceUrls || null,
          priority,
        ]
      );

      // Increment report count for the user (non-blocking)
      try {
        await db.query(
          "UPDATE users SET report_count = COALESCE(report_count, 0) + 1 WHERE id = $1",
          [id]
        );
      } catch (countError) {
        console.warn("Warning: failed to update report_count", countError);
      }

      res.status(201).json({
        message:
          "Report submitted successfully. Our team will review it shortly.",
        report: result.rows[0],
      });
    } catch (error) {
      console.error("Error submitting user report:", error);
      res.status(500).json({ error: "Failed to submit report" });
    }
  }
);

// =====================================================
// GET: User's Submitted Reports
// =====================================================
router.get("/reports/my-reports", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT 
        r.*,
        rr.reason as reason_text,
        CASE 
          WHEN r.report_type = 'listing' THEN l.title
          ELSE u.name
        END as reported_name
      FROM reports r
      LEFT JOIN report_reasons rr ON r.reason_id = rr.id
      LEFT JOIN userlistings l ON r.reported_listing_id = l.id
      LEFT JOIN users u ON r.reported_user_id = u.id AND r.report_type = 'user'
      WHERE r.reporter_id = $1
      ORDER BY r.created_at DESC`,
      [userId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching user reports:", error);
    res.status(500).json({ error: "Failed to fetch your reports" });
  }
});

// NOTE: Public profile endpoint moved to users.js (no auth required)

// =====================================================
// GET: Account Status (Suspension Check)
// =====================================================
router.get("/account/status", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const userResult = await db.query(
      `SELECT is_suspended, suspension_reason, warning_count FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userResult.rows[0];

    // Get active suspension details if suspended
    let suspensionDetails = null;
    if (user.is_suspended) {
      const suspensionResult = await db.query(
        `SELECT * FROM account_suspensions 
         WHERE user_id = $1 AND is_active = true 
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (suspensionResult.rows.length > 0) {
        suspensionDetails = suspensionResult.rows[0];
      }
    }

    // Get unacknowledged warnings
    const warningsResult = await db.query(
      `SELECT * FROM violation_warnings 
       WHERE user_id = $1 AND acknowledged = false
       ORDER BY created_at DESC`,
      [userId]
    );

    // Check for pending appeals
    const appealsResult = await db.query(
      `SELECT * FROM appeals 
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [userId]
    );

    res.status(200).json({
      isSuspended: user.is_suspended,
      suspensionReason: user.suspension_reason,
      suspensionDetails,
      warningCount: user.warning_count,
      unacknowledgedWarnings: warningsResult.rows,
      pendingAppeals: appealsResult.rows,
    });
  } catch (error) {
    console.error("Error fetching account status:", error);
    res.status(500).json({ error: "Failed to fetch account status" });
  }
});

// =====================================================
// POST: Submit Appeal
// =====================================================
router.post("/appeals/submit", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const {
    appealType,
    suspensionId,
    warningId,
    listingId,
    reason,
    evidenceUrls,
  } = req.body;

  try {
    // Validate appeal type
    if (!["suspension", "warning", "listing_removal"].includes(appealType)) {
      return res.status(400).json({ error: "Invalid appeal type" });
    }

    if (!reason || reason.length < 20) {
      return res.status(400).json({
        error:
          "Please provide a detailed reason for your appeal (at least 20 characters)",
      });
    }

    // Check for existing pending appeal of same type
    let duplicateCheck;
    if (appealType === "suspension" && suspensionId) {
      duplicateCheck = await db.query(
        `SELECT id FROM appeals 
         WHERE user_id = $1 AND suspension_id = $2 AND status = 'pending'`,
        [userId, suspensionId]
      );
    } else if (appealType === "warning" && warningId) {
      duplicateCheck = await db.query(
        `SELECT id FROM appeals 
         WHERE user_id = $1 AND warning_id = $2 AND status = 'pending'`,
        [userId, warningId]
      );
    } else if (appealType === "listing_removal" && listingId) {
      duplicateCheck = await db.query(
        `SELECT id FROM appeals 
         WHERE user_id = $1 AND related_listing_id = $2 AND status = 'pending'`,
        [userId, listingId]
      );
    }

    if (duplicateCheck && duplicateCheck.rows.length > 0) {
      return res.status(400).json({
        error:
          "You already have a pending appeal for this. Please wait for review.",
      });
    }

    // Create appeal
    const result = await db.query(
      `INSERT INTO appeals 
       (user_id, appeal_type, suspension_id, warning_id, related_listing_id, reason, evidence_urls, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [
        userId,
        appealType,
        suspensionId || null,
        warningId || null,
        listingId || null,
        reason,
        evidenceUrls || null,
      ]
    );

    // Create notification for admins (optional - can be implemented)

    res.status(201).json({
      message:
        "Appeal submitted successfully. Our team will review it within 24-48 hours.",
      appeal: result.rows[0],
    });
  } catch (error) {
    console.error("Error submitting appeal:", error);
    res.status(500).json({ error: "Failed to submit appeal" });
  }
});

// =====================================================
// GET: User's Appeals
// =====================================================
router.get("/appeals/my-appeals", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT 
        a.*,
        s.reason as suspension_reason,
        w.reason as warning_reason,
        l.title as listing_title
      FROM appeals a
      LEFT JOIN account_suspensions s ON a.suspension_id = s.id
      LEFT JOIN violation_warnings w ON a.warning_id = w.id
      LEFT JOIN userlistings l ON a.related_listing_id = l.id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC`,
      [userId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching appeals:", error);
    res.status(500).json({ error: "Failed to fetch your appeals" });
  }
});

// =====================================================
// GET: User's Warnings
// =====================================================
router.get("/warnings/my-warnings", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT 
        w.*,
        l.title as related_listing_title
      FROM violation_warnings w
      LEFT JOIN userlistings l ON w.related_listing_id = l.id
      WHERE w.user_id = $1
      ORDER BY w.created_at DESC`,
      [userId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching warnings:", error);
    res.status(500).json({ error: "Failed to fetch your warnings" });
  }
});

// =====================================================
// PUT: Acknowledge Warning
// =====================================================
router.put("/warnings/:id/acknowledge", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Verify warning belongs to user
    const warningCheck = await db.query(
      "SELECT * FROM violation_warnings WHERE id = $1 AND user_id = $2",
      [id, userId]
    );

    if (warningCheck.rows.length === 0) {
      return res.status(404).json({ error: "Warning not found" });
    }

    await db.query(
      `UPDATE violation_warnings 
       SET acknowledged = true, acknowledged_at = NOW() 
       WHERE id = $1`,
      [id]
    );

    res.status(200).json({ message: "Warning acknowledged" });
  } catch (error) {
    console.error("Error acknowledging warning:", error);
    res.status(500).json({ error: "Failed to acknowledge warning" });
  }
});

export default router;
