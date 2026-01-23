/**
 * Admin Moderation Routes
 * ========================
 * Handles all admin operations for managing reports, suspensions, warnings, and appeals.
 *
 * Routes:
 * - GET /api/admin/reports/stats - Get report statistics
 * - GET /api/admin/reports - Get all reports with filters
 * - GET /api/admin/reports/:id - Get single report details
 * - PUT /api/admin/reports/:id/status - Update report status
 * - POST /api/admin/users/:id/warn - Issue warning to user
 * - POST /api/admin/users/:id/suspend - Suspend user account
 * - PUT /api/admin/users/:id/unsuspend - Lift user suspension
 * - DELETE /api/admin/listings/:id/remove - Remove listing (violation)
 * - GET /api/admin/appeals - Get all appeals
 * - PUT /api/admin/appeals/:id/review - Review appeal
 * - GET /api/admin/users/:id/moderation-history - Get user's moderation history
 */

import express from "express";
import dotenv from "dotenv";
dotenv.config();
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";

const router = express.Router();

// =====================================================
// MIDDLEWARE: Admin Authorization Check
// =====================================================
const adminCheck = async (req, res, next) => {
  try {
    // Check if this is an env-based admin (has isAdmin flag or matching email)
    if (
      req.user.isAdmin === true ||
      req.user.email === process.env.ADMIN_EMAIL
    ) {
      return next();
    }

    // Check if user has admin role in database
    if (req.user.id) {
      const result = await db.query("SELECT role FROM users WHERE id = $1", [
        req.user.id,
      ]);

      if (result.rows.length > 0 && result.rows[0].role === "admin") {
        return next();
      }
    }

    return res.status(403).json({
      error: "Access denied. Admin privileges required.",
    });
  } catch (error) {
    console.error("Admin check error:", error);
    return res.status(500).json({ error: "Authorization check failed" });
  }
};

// =====================================================
// GET: Report Statistics
// =====================================================
router.get(
  "/admin/reports/stats",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    try {
      const stats = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending_reports,
        COUNT(*) FILTER (WHERE status = 'reviewing') as reviewing_reports,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved_reports,
        COUNT(*) FILTER (WHERE status = 'dismissed') as dismissed_reports,
        COUNT(*) FILTER (WHERE report_type = 'listing') as listing_reports,
        COUNT(*) FILTER (WHERE report_type = 'user') as user_reports,
        COUNT(*) FILTER (WHERE priority >= 3 AND status = 'pending') as high_priority,
        COUNT(*) as total_reports
      FROM reports
    `);

      // Get pending appeals count
      const appealsCount = await db.query(
        "SELECT COUNT(*) as count FROM appeals WHERE status = 'pending'",
      );

      // Get active suspensions count
      const suspensionsCount = await db.query(
        "SELECT COUNT(*) as count FROM account_suspensions WHERE is_active = true",
      );

      res.status(200).json({
        ...stats.rows[0],
        pending_appeals: parseInt(appealsCount.rows[0].count),
        active_suspensions: parseInt(suspensionsCount.rows[0].count),
      });
    } catch (error) {
      console.error("Error fetching report stats:", error);
      res.status(500).json({ error: "Failed to fetch statistics" });
    }
  },
);

// =====================================================
// GET: Users List (Admin)
// =====================================================
router.get("/admin/users", authMiddleware, adminCheck, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      role,
      sortBy = "created_at",
      sortOrder = "desc",
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const columnsResult = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'",
    );
    const columns = new Set(columnsResult.rows.map((row) => row.column_name));

    const createdAtSelect = columns.has("created_at")
      ? "u.created_at"
      : columns.has("createdat")
        ? "u.createdat"
        : "NOW()";
    const isSuspendedSelect = columns.has("is_suspended")
      ? "u.is_suspended"
      : "false";
    const warningCountSelect = columns.has("warning_count")
      ? "u.warning_count"
      : "0";
    const reportCountSelect = columns.has("report_count")
      ? "u.report_count"
      : "0";
    const roleSelect = columns.has("role") ? "u.role" : "'user'";

    let queryText = `
      SELECT 
        u.id,
        u.name,
        u.email,
        u.profilepictureurl,
        ${createdAtSelect} as created_at,
        ${isSuspendedSelect} as is_suspended,
        ${warningCountSelect} as warning_count,
        ${reportCountSelect} as report_count,
        ${roleSelect} as role,
        (SELECT COUNT(*) FROM userlistings l WHERE l.userid = u.id) as total_listings,
        (SELECT COUNT(*) FROM userlistings l WHERE l.userid = u.id AND l.moderation_status = 'approved' AND l.status = 'Available') as active_listings,
        (SELECT COUNT(*) FROM reports r WHERE r.reported_user_id = u.id) as total_reports
      FROM users u
      WHERE 1=1
    `;

    const queryParams = [];
    let paramCount = 1;

    if (search) {
      queryText += ` AND (LOWER(u.name) LIKE LOWER($${paramCount}) OR LOWER(u.email) LIKE LOWER($${paramCount}))`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    if (status === "suspended") {
      if (columns.has("is_suspended")) {
        queryText += ` AND u.is_suspended = true`;
      } else {
        queryText += ` AND 1=0`;
      }
    }

    if (status === "active" && columns.has("is_suspended")) {
      queryText += ` AND u.is_suspended = false`;
    }

    if (role && columns.has("role")) {
      queryText += ` AND u.role = $${paramCount}`;
      queryParams.push(role);
      paramCount++;
    }

    const sortMap = {
      created_at: "created_at",
      warning_count: "warning_count",
      report_count: "report_count",
      total_listings: "total_listings",
      active_listings: "active_listings",
    };
    const sortColumn = sortMap[sortBy] || "created_at";
    const order = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";
    queryText += ` ORDER BY ${sortColumn} ${order}`;

    queryText += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await db.query(queryText, queryParams);

    // Count query
    let countQuery = "SELECT COUNT(*) FROM users u WHERE 1=1";
    const countParams = [];
    let countParamCount = 1;

    if (search) {
      countQuery += ` AND (LOWER(u.name) LIKE LOWER($${countParamCount}) OR LOWER(u.email) LIKE LOWER($${countParamCount}))`;
      countParams.push(`%${search}%`);
      countParamCount++;
    }
    if (status === "suspended") {
      if (columns.has("is_suspended")) {
        countQuery += ` AND u.is_suspended = true`;
      } else {
        countQuery += ` AND 1=0`;
      }
    }
    if (status === "active" && columns.has("is_suspended")) {
      countQuery += ` AND u.is_suspended = false`;
    }
    if (role && columns.has("role")) {
      countQuery += ` AND u.role = $${countParamCount}`;
      countParams.push(role);
      countParamCount++;
    }

    const countResult = await db.query(countQuery, countParams);

    res.status(200).json({
      users: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(
          parseInt(countResult.rows[0].count) / parseInt(limit),
        ),
      },
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// =====================================================
// GET: All Reports with Filters
// =====================================================
router.get("/admin/reports", authMiddleware, adminCheck, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      type,
      priority,
      sortBy = "created_at",
      sortOrder = "desc",
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let queryText = `
      SELECT 
        r.*,
        rr.reason as reason_text,
        rr.severity,
        reporter.name as reporter_name,
        reporter.email as reporter_email,
        reported_user.name as reported_user_name,
        reported_user.email as reported_user_email,
        reported_user.profilepictureurl as reported_user_picture,
        l.title as listing_title,
        reviewer.name as reviewed_by_name
      FROM reports r
      LEFT JOIN report_reasons rr ON r.reason_id = rr.id
      LEFT JOIN users reporter ON r.reporter_id = reporter.id
      LEFT JOIN users reported_user ON r.reported_user_id = reported_user.id
      LEFT JOIN userlistings l ON r.reported_listing_id = l.id
      LEFT JOIN users reviewer ON r.reviewed_by = reviewer.id
      WHERE 1=1
    `;
    const queryParams = [];
    let paramCount = 1;

    if (status) {
      queryText += ` AND r.status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    if (type) {
      queryText += ` AND r.report_type = $${paramCount}`;
      queryParams.push(type);
      paramCount++;
    }

    if (priority) {
      queryText += ` AND r.priority >= $${paramCount}`;
      queryParams.push(parseInt(priority));
      paramCount++;
    }

    // Sorting
    const validSortColumns = ["created_at", "priority", "status"];
    const sortColumn = validSortColumns.includes(sortBy)
      ? sortBy
      : "created_at";
    const order = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";
    queryText += ` ORDER BY r.${sortColumn} ${order}, r.priority DESC`;

    // Pagination
    queryText += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await db.query(queryText, queryParams);

    // Get total count
    let countQuery = "SELECT COUNT(*) FROM reports r WHERE 1=1";
    const countParams = [];
    let countParamNum = 1;

    if (status) {
      countQuery += ` AND r.status = $${countParamNum}`;
      countParams.push(status);
      countParamNum++;
    }
    if (type) {
      countQuery += ` AND r.report_type = $${countParamNum}`;
      countParams.push(type);
      countParamNum++;
    }
    if (priority) {
      countQuery += ` AND r.priority >= $${countParamNum}`;
      countParams.push(parseInt(priority));
    }

    const countResult = await db.query(countQuery, countParams);

    // Fetch listing images for listing reports
    const reportsWithImages = await Promise.all(
      result.rows.map(async (report) => {
        if (report.reported_listing_id) {
          const images = await db.query(
            `SELECT imageurl FROM imagelistings WHERE listingid = $1 ORDER BY is_main DESC LIMIT 3`,
            [report.reported_listing_id],
          );
          return { ...report, listing_images: images.rows };
        }
        return report;
      }),
    );

    res.status(200).json({
      reports: reportsWithImages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(
          parseInt(countResult.rows[0].count) / parseInt(limit),
        ),
      },
    });
  } catch (error) {
    console.error("Error fetching reports:", error);
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

// =====================================================
// GET: Single Report Details
// =====================================================
router.get(
  "/admin/reports/:id",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;

    try {
      const result = await db.query(
        `SELECT 
        r.*,
        rr.reason as reason_text,
        rr.description as reason_description,
        rr.severity,
        reporter.name as reporter_name,
        reporter.email as reporter_email,
        reporter.profilepictureurl as reporter_picture,
        reported_user.name as reported_user_name,
        reported_user.email as reported_user_email,
        reported_user.phone as reported_user_phone,
        reported_user.profilepictureurl as reported_user_picture,
        reported_user.verified as reported_user_verified,
        reported_user.warning_count as reported_user_warnings,
        reported_user.report_count as reported_user_reports,
        reported_user.is_suspended as reported_user_suspended,
        l.*,
        reviewer.name as reviewed_by_name
      FROM reports r
      LEFT JOIN report_reasons rr ON r.reason_id = rr.id
      LEFT JOIN users reporter ON r.reporter_id = reporter.id
      LEFT JOIN users reported_user ON r.reported_user_id = reported_user.id
      LEFT JOIN userlistings l ON r.reported_listing_id = l.id
      LEFT JOIN users reviewer ON r.reviewed_by = reviewer.id
      WHERE r.id = $1`,
        [id],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Report not found" });
      }

      const report = result.rows[0];

      // Get listing images if applicable
      if (report.reported_listing_id) {
        const images = await db.query(
          `SELECT * FROM imagelistings WHERE listingid = $1 ORDER BY is_main DESC`,
          [report.reported_listing_id],
        );
        report.listing_images = images.rows;
      }

      // Get previous reports on same user/listing
      let previousReports;
      if (report.report_type === "user") {
        previousReports = await db.query(
          `SELECT r.*, rr.reason as reason_text 
         FROM reports r 
         LEFT JOIN report_reasons rr ON r.reason_id = rr.id
         WHERE r.reported_user_id = $1 AND r.id != $2
         ORDER BY r.created_at DESC LIMIT 10`,
          [report.reported_user_id, id],
        );
      } else {
        previousReports = await db.query(
          `SELECT r.*, rr.reason as reason_text 
         FROM reports r 
         LEFT JOIN report_reasons rr ON r.reason_id = rr.id
         WHERE r.reported_listing_id = $1 AND r.id != $2
         ORDER BY r.created_at DESC LIMIT 10`,
          [report.reported_listing_id, id],
        );
      }
      report.previous_reports = previousReports.rows;

      // Get user's moderation history
      const warnings = await db.query(
        `SELECT * FROM violation_warnings WHERE user_id = $1 ORDER BY created_at DESC`,
        [report.reported_user_id],
      );
      report.user_warnings = warnings.rows;

      res.status(200).json(report);
    } catch (error) {
      console.error("Error fetching report:", error);
      res.status(500).json({ error: "Failed to fetch report details" });
    }
  },
);

// =====================================================
// PUT: Update Report Status
// =====================================================
router.put(
  "/admin/reports/:id/status",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;
    const { status, adminNotes, actionTaken } = req.body;
    const adminId = req.user.id;

    try {
      const validStatuses = ["pending", "reviewing", "resolved", "dismissed"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      const result = await db.query(
        `UPDATE reports 
       SET status = $1, admin_notes = $2, action_taken = $3, 
           reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
        [status, adminNotes || null, actionTaken || null, adminId, id],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Report not found" });
      }

      res.status(200).json({
        message: "Report status updated",
        report: result.rows[0],
      });
    } catch (error) {
      console.error("Error updating report:", error);
      res.status(500).json({ error: "Failed to update report" });
    }
  },
);

// =====================================================
// POST: Issue Warning to User
// =====================================================
router.post(
  "/admin/users/:id/warn",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;
    const {
      warningType,
      reason,
      relatedReportId,
      relatedListingId,
      expiresAt,
    } = req.body;
    const adminId = req.user.id;

    try {
      const validTypes = ["mild", "moderate", "severe", "final"];
      if (!validTypes.includes(warningType)) {
        return res.status(400).json({ error: "Invalid warning type" });
      }

      if (!reason || reason.length < 10) {
        return res
          .status(400)
          .json({ error: "Please provide a detailed reason" });
      }

      // Check user exists
      const userCheck = await db.query(
        "SELECT id, name, email FROM users WHERE id = $1",
        [id],
      );
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      // Create warning
      const result = await db.query(
        `INSERT INTO violation_warnings 
       (user_id, warning_type, reason, related_report_id, related_listing_id, issued_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
        [
          id,
          warningType,
          reason,
          relatedReportId || null,
          relatedListingId || null,
          adminId,
          expiresAt || null,
        ],
      );

      // Increment user's warning count
      await db.query(
        "UPDATE users SET warning_count = COALESCE(warning_count, 0) + 1 WHERE id = $1",
        [id],
      );

      // Create notification for user
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          id,
          "⚠️ Account Warning",
          `You have received a ${warningType} warning: ${reason}`,
          "warning",
          result.rows[0].id,
          "warning",
        ],
      );

      await sendPushToUser(
        id,
        buildNotificationPayload({
          title: "⚠️ Account Warning",
          body: `You have received a ${warningType} warning: ${reason}`,
          type: "warning",
          relatedId: result.rows[0].id,
          relatedType: "warning",
        }),
      );

      // Update related report if provided
      if (relatedReportId) {
        await db.query(
          `UPDATE reports SET status = 'resolved', action_taken = 'warning', 
         reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
          [adminId, relatedReportId],
        );
      }

      res.status(201).json({
        message: "Warning issued successfully",
        warning: result.rows[0],
      });
    } catch (error) {
      console.error("Error issuing warning:", error);
      res.status(500).json({ error: "Failed to issue warning" });
    }
  },
);

// =====================================================
// POST: Suspend User Account
// =====================================================
router.post(
  "/admin/users/:id/suspend",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;
    const { suspensionType, reason, relatedReportId, endsAt } = req.body;
    const adminId = req.user.id;

    try {
      // Prevent suspending admins
      const userCheck = await db.query(
        "SELECT id, name, email, role FROM users WHERE id = $1",
        [id],
      );
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }
      if (userCheck.rows[0].role === "admin") {
        return res.status(400).json({ error: "Cannot suspend admin accounts" });
      }

      const validTypes = ["temporary", "permanent"];
      if (!validTypes.includes(suspensionType)) {
        return res.status(400).json({ error: "Invalid suspension type" });
      }

      if (!reason || reason.length < 10) {
        return res
          .status(400)
          .json({ error: "Please provide a detailed reason" });
      }

      if (suspensionType === "temporary" && !endsAt) {
        return res
          .status(400)
          .json({ error: "Temporary suspensions require an end date" });
      }

      // Create suspension record
      const result = await db.query(
        `INSERT INTO account_suspensions 
       (user_id, suspension_type, reason, related_report_id, suspended_by, ends_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
        [
          id,
          suspensionType,
          reason,
          relatedReportId || null,
          adminId,
          endsAt || null,
        ],
      );

      // Update user's suspension status
      await db.query(
        `UPDATE users SET is_suspended = true, suspension_reason = $1 WHERE id = $2`,
        [reason, id],
      );

      // Create notification for user
      const endDateText = endsAt
        ? `Your account will be restored on ${new Date(
            endsAt,
          ).toLocaleDateString()}.`
        : "This is a permanent suspension.";

      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          id,
          "🚫 Account Suspended",
          `Your account has been suspended. Reason: ${reason}. ${endDateText} You may submit an appeal if you believe this was a mistake.`,
          "suspension",
          result.rows[0].id,
          "suspension",
        ],
      );

      await sendPushToUser(
        id,
        buildNotificationPayload({
          title: "🚫 Account Suspended",
          body: `Your account has been suspended. Reason: ${reason}. ${endDateText} You may submit an appeal if you believe this was a mistake.`,
          type: "suspension",
          relatedId: result.rows[0].id,
          relatedType: "suspension",
        }),
      );

      // Update related report if provided
      if (relatedReportId) {
        await db.query(
          `UPDATE reports SET status = 'resolved', action_taken = 'account_suspended', 
         reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
          [adminId, relatedReportId],
        );
      }

      res.status(201).json({
        message: "Account suspended successfully",
        suspension: result.rows[0],
      });
    } catch (error) {
      console.error("Error suspending account:", error);
      res.status(500).json({ error: "Failed to suspend account" });
    }
  },
);

// =====================================================
// PUT: Unsuspend User Account
// =====================================================
router.put(
  "/admin/users/:id/unsuspend",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;
    const { liftReason } = req.body;
    const adminId = req.user.id;

    try {
      // Check if user is actually suspended
      const userCheck = await db.query(
        "SELECT is_suspended FROM users WHERE id = $1",
        [id],
      );
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!userCheck.rows[0].is_suspended) {
        return res.status(400).json({ error: "User is not suspended" });
      }

      // Update suspension record
      await db.query(
        `UPDATE account_suspensions 
       SET is_active = false, lifted_by = $1, lifted_at = NOW(), lift_reason = $2
       WHERE user_id = $3 AND is_active = true`,
        [adminId, liftReason || "Suspension lifted by admin", id],
      );

      // Update user status
      await db.query(
        `UPDATE users SET is_suspended = false, suspension_reason = NULL WHERE id = $1`,
        [id],
      );

      // Notify user
      await db.query(
        `INSERT INTO notifications (userid, title, message, type, createdat)
       VALUES ($1, $2, $3, $4, NOW())`,
        [
          id,
          "✅ Account Restored",
          `Your account has been restored. ${
            liftReason || "You can now use all features again."
          }`,
          "account_restored",
        ],
      );

      await sendPushToUser(
        id,
        buildNotificationPayload({
          title: "✅ Account Restored",
          body: `Your account has been restored. ${
            liftReason || "You can now use all features again."
          }`,
          type: "account_restored",
          relatedType: "account",
        }),
      );

      res
        .status(200)
        .json({ message: "Account suspension lifted successfully" });
    } catch (error) {
      console.error("Error unsuspending account:", error);
      res.status(500).json({ error: "Failed to lift suspension" });
    }
  },
);

// =====================================================
// DELETE: Remove Listing (Violation)
// =====================================================
router.delete(
  "/admin/listings/:id/remove",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;
    const { reason, relatedReportId, notifyUser } = req.body;
    const adminId = req.user.id;

    try {
      // Get listing info before deletion
      const listingCheck = await db.query(
        "SELECT id, title, userid FROM userlistings WHERE id = $1",
        [id],
      );
      if (listingCheck.rows.length === 0) {
        return res.status(404).json({ error: "Listing not found" });
      }

      const listing = listingCheck.rows[0];

      // Instead of deleting, mark as removed (for audit trail)
      await db.query(
        `UPDATE userlistings 
       SET moderation_status = 'removed', rejection_reason = $1, reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $3`,
        [reason || "Removed for policy violation", adminId, id],
      );

      // Notify user if requested
      if (notifyUser !== false) {
        await db.query(
          `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            listing.userid,
            "Listing Removed",
            `Your listing "${listing.title}" has been removed. Reason: ${
              reason || "Policy violation"
            }`,
            "listing_removed",
            id,
            "listing",
          ],
        );

        await sendPushToUser(
          listing.userid,
          buildNotificationPayload({
            title: "Listing Removed",
            body: `Your listing "${listing.title}" has been removed. Reason: ${
              reason || "Policy violation"
            }`,
            type: "listing_removed",
            relatedId: id,
            relatedType: "listing",
          }),
        );
      }

      // Update related report if provided
      if (relatedReportId) {
        await db.query(
          `UPDATE reports SET status = 'resolved', action_taken = 'listing_removed', 
         reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
          [adminId, relatedReportId],
        );
      }

      res.status(200).json({ message: "Listing removed successfully" });
    } catch (error) {
      console.error("Error removing listing:", error);
      res.status(500).json({ error: "Failed to remove listing" });
    }
  },
);

// =====================================================
// GET: All Appeals
// =====================================================
router.get("/admin/appeals", authMiddleware, adminCheck, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let queryText = `
      SELECT 
        a.*,
        u.name as user_name,
        u.email as user_email,
        u.profilepictureurl as user_picture,
        s.reason as suspension_reason,
        s.suspension_type,
        w.reason as warning_reason,
        w.warning_type,
        l.title as listing_title,
        reviewer.name as reviewed_by_name
      FROM appeals a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN account_suspensions s ON a.suspension_id = s.id
      LEFT JOIN violation_warnings w ON a.warning_id = w.id
      LEFT JOIN userlistings l ON a.related_listing_id = l.id
      LEFT JOIN users reviewer ON a.reviewed_by = reviewer.id
      WHERE 1=1
    `;
    const queryParams = [];
    let paramCount = 1;

    if (status) {
      queryText += ` AND a.status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    queryText += ` ORDER BY a.created_at ASC`;
    queryText += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await db.query(queryText, queryParams);

    // Get count
    let countQuery = "SELECT COUNT(*) FROM appeals WHERE 1=1";
    if (status) {
      countQuery += ` AND status = '${status}'`;
    }
    const countResult = await db.query(countQuery);

    res.status(200).json({
      appeals: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(
          parseInt(countResult.rows[0].count) / parseInt(limit),
        ),
      },
    });
  } catch (error) {
    console.error("Error fetching appeals:", error);
    res.status(500).json({ error: "Failed to fetch appeals" });
  }
});

// =====================================================
// PUT: Review Appeal
// =====================================================
router.put(
  "/admin/appeals/:id/review",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;
    const { decision, adminNotes } = req.body; // decision: 'approved' or 'denied'
    const adminId = req.user.id;

    try {
      if (!["approved", "denied"].includes(decision)) {
        return res.status(400).json({ error: "Invalid decision" });
      }

      // Get appeal details
      const appealCheck = await db.query(
        "SELECT * FROM appeals WHERE id = $1",
        [id],
      );
      if (appealCheck.rows.length === 0) {
        return res.status(404).json({ error: "Appeal not found" });
      }

      const appeal = appealCheck.rows[0];

      // Update appeal
      await db.query(
        `UPDATE appeals 
       SET status = $1, admin_notes = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4`,
        [decision, adminNotes || null, adminId, id],
      );

      // If approved, take action based on appeal type
      if (decision === "approved") {
        if (appeal.appeal_type === "suspension" && appeal.suspension_id) {
          // Lift suspension
          await db.query(
            `UPDATE account_suspensions 
           SET is_active = false, lifted_by = $1, lifted_at = NOW(), lift_reason = 'Appeal approved'
           WHERE id = $2`,
            [adminId, appeal.suspension_id],
          );
          await db.query(
            `UPDATE users SET is_suspended = false, suspension_reason = NULL WHERE id = $1`,
            [appeal.user_id],
          );
        } else if (
          appeal.appeal_type === "listing_removal" &&
          appeal.related_listing_id
        ) {
          // Restore listing
          await db.query(
            `UPDATE userlistings SET moderation_status = 'approved', rejection_reason = NULL WHERE id = $1`,
            [appeal.related_listing_id],
          );
        }
      }

      // Notify user
      const notificationTitle =
        decision === "approved" ? "✅ Appeal Approved" : "❌ Appeal Denied";
      const notificationMessage =
        decision === "approved"
          ? `Your appeal has been approved. ${
              adminNotes || "The action has been reversed."
            }`
          : `Your appeal has been denied. ${
              adminNotes || "The original decision stands."
            }`;

      await db.query(
        `INSERT INTO notifications (userid, title, message, type, relatedid, relatedtype, createdat)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          appeal.user_id,
          notificationTitle,
          notificationMessage,
          "appeal_decision",
          id,
          "appeal",
        ],
      );

      await sendPushToUser(
        appeal.user_id,
        buildNotificationPayload({
          title: notificationTitle,
          body: notificationMessage,
          type: "appeal_decision",
          relatedId: id,
          relatedType: "appeal",
        }),
      );

      res.status(200).json({ message: `Appeal ${decision}` });
    } catch (error) {
      console.error("Error reviewing appeal:", error);
      res.status(500).json({ error: "Failed to review appeal" });
    }
  },
);

// =====================================================
// GET: User Moderation History
// =====================================================
router.get(
  "/admin/users/:id/moderation-history",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { id } = req.params;

    try {
      // Get user info (defensive against missing columns)
      const userColumnsResult = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
      );
      const userColumns = new Set(
        userColumnsResult.rows.map((row) => row.column_name),
      );
      const userSelect = [
        "id",
        "name",
        "email",
        "profilepictureurl",
        "verified",
        userColumns.has("created_at")
          ? "created_at"
          : userColumns.has("createdat")
            ? "createdat as created_at"
            : "NOW() as created_at",
        userColumns.has("is_suspended")
          ? "is_suspended"
          : "false as is_suspended",
        userColumns.has("suspension_reason")
          ? "suspension_reason"
          : "NULL as suspension_reason",
        userColumns.has("warning_count")
          ? "warning_count"
          : "0 as warning_count",
        userColumns.has("report_count") ? "report_count" : "0 as report_count",
      ];

      const user = await db.query(
        `SELECT ${userSelect.join(", ")} FROM users WHERE id = $1`,
        [id],
      );

      if (user.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get reports against this user
      const reports = await db.query(
        `SELECT r.*, rr.reason as reason_text, reporter.name as reporter_name
       FROM reports r
       LEFT JOIN report_reasons rr ON r.reason_id = rr.id
       LEFT JOIN users reporter ON r.reporter_id = reporter.id
       WHERE r.reported_user_id = $1
       ORDER BY r.created_at DESC`,
        [id],
      );

      // Get warnings
      const warnings = await db.query(
        `SELECT w.*, admin.name as issued_by_name
       FROM violation_warnings w
       LEFT JOIN users admin ON w.issued_by = admin.id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
        [id],
      );

      // Get suspensions
      const suspensions = await db.query(
        `SELECT s.*, admin.name as suspended_by_name, lifter.name as lifted_by_name
       FROM account_suspensions s
       LEFT JOIN users admin ON s.suspended_by = admin.id
       LEFT JOIN users lifter ON s.lifted_by = lifter.id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC`,
        [id],
      );

      // Get appeals
      const appeals = await db.query(
        `SELECT a.*, reviewer.name as reviewed_by_name
       FROM appeals a
       LEFT JOIN users reviewer ON a.reviewed_by = reviewer.id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
        [id],
      );

      res.status(200).json({
        user: user.rows[0],
        reports: reports.rows,
        warnings: warnings.rows,
        suspensions: suspensions.rows,
        appeals: appeals.rows,
      });
    } catch (error) {
      console.error("Error fetching moderation history:", error);
      res.status(500).json({ error: "Failed to fetch moderation history" });
    }
  },
);

// =====================================================
// POST: Broadcast Message to All Users
// =====================================================
router.post(
  "/admin/broadcast",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const {
      title,
      message,
      type = "announcement",
      priority = "normal",
    } = req.body;
    const adminId = req.user.id;

    try {
      if (!title || !message) {
        return res
          .status(400)
          .json({ error: "Title and message are required" });
      }

      if (title.length < 3 || title.length > 100) {
        return res
          .status(400)
          .json({ error: "Title must be between 3 and 100 characters" });
      }

      if (message.length < 10 || message.length > 1000) {
        return res
          .status(400)
          .json({ error: "Message must be between 10 and 1000 characters" });
      }

      // Get all active users (not suspended)
      const usersResult = await db.query(
        "SELECT id FROM users WHERE is_suspended = false OR is_suspended IS NULL",
      );

      if (usersResult.rows.length === 0) {
        return res
          .status(400)
          .json({ error: "No active users to broadcast to" });
      }

      // Create notifications for all users
      const notificationPromises = usersResult.rows.map((user) =>
        db.query(
          `INSERT INTO notifications (userid, title, message, type, relatedtype, createdat)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [user.id, `📢 ${title}`, message, type, "broadcast"],
        ),
      );

      await Promise.all(notificationPromises);

      await Promise.all(
        usersResult.rows.map((user) =>
          sendPushToUser(
            user.id,
            buildNotificationPayload({
              title: `📢 ${title}`,
              body: message,
              type,
              relatedType: "broadcast",
            }),
          ),
        ),
      );

      // Log the broadcast
      await db
        .query(
          `INSERT INTO admin_broadcasts (admin_id, title, message, type, priority, recipients_count, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [adminId, title, message, type, priority, usersResult.rows.length],
        )
        .catch(() => {
          // Table might not exist yet, that's okay
          console.log("Admin broadcasts table not found, skipping log");
        });

      res.status(201).json({
        message: "Broadcast sent successfully",
        recipientsCount: usersResult.rows.length,
      });
    } catch (error) {
      console.error("Error sending broadcast:", error);
      res.status(500).json({ error: "Failed to send broadcast" });
    }
  },
);

// =====================================================
// GET: Get Broadcast History
// =====================================================
router.get(
  "/admin/broadcasts",
  authMiddleware,
  adminCheck,
  async (req, res) => {
    const { limit = 20, offset = 0 } = req.query;

    try {
      const result = await db.query(
        `SELECT b.*, a.name as admin_name
         FROM admin_broadcasts b
         LEFT JOIN users a ON b.admin_id = a.id
         ORDER BY b.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      const countResult = await db.query(
        "SELECT COUNT(*) FROM admin_broadcasts",
      );

      res.status(200).json({
        broadcasts: result.rows,
        total: parseInt(countResult.rows[0].count),
      });
    } catch (error) {
      console.error("Error fetching broadcasts:", error);
      // If table doesn't exist, return empty
      res.status(200).json({ broadcasts: [], total: 0 });
    }
  },
);

export default router;
