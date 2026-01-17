/**
 * Suspension Middleware
 *
 * This middleware checks if a user is currently suspended and restricts
 * their actions accordingly. Suspended users can:
 * - View listings and other content (read-only)
 * - Submit appeals
 * - View their own profile
 *
 * Suspended users CANNOT:
 * - Create new listings
 * - Edit or delete listings
 * - Post comments
 * - Send messages
 * - Submit reports
 */

import pool from "../db.js";

/**
 * Check if user has an active suspension
 * Returns suspension details if suspended, null otherwise
 */
export const getUserSuspensionStatus = async (userId) => {
  try {
    const result = await pool.query(
      `
            SELECT 
                s.id,
                s.suspension_type,
                s.reason,
                s.starts_at,
                s.ends_at,
                s.is_active,
                a.username as suspended_by_username,
                -- Check if there's a pending appeal
                (
                    SELECT COUNT(*) 
                    FROM appeals 
                    WHERE user_id = s.user_id 
                    AND suspension_id = s.id 
                    AND status = 'pending'
                ) as pending_appeals
            FROM account_suspensions s
            LEFT JOIN users a ON s.suspended_by = a.id
            WHERE s.user_id = $1
            AND s.is_active = true
            AND (
                s.suspension_type = 'permanent' 
                OR s.ends_at > CURRENT_TIMESTAMP
            )
            ORDER BY s.starts_at DESC
            LIMIT 1
        `,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error("Error checking suspension status:", error);
    throw error;
  }
};

/**
 * Middleware that blocks suspended users from performing write actions
 * Use this on routes that create, update, or delete content
 */
export const blockIfSuspended = async (req, res, next) => {
  try {
    // Skip if no user is authenticated
    if (!req.user || !req.user.id) {
      return next();
    }

    const suspension = await getUserSuspensionStatus(req.user.id);

    if (suspension) {
      const isPermanent = suspension.suspension_type === "permanent";
      const expiresAt = suspension.ends_at;

      return res.status(403).json({
        success: false,
        error: "account_suspended",
        message: isPermanent
          ? "Your account has been permanently suspended. You can only view content and submit appeals."
          : `Your account is suspended until ${new Date(
              expiresAt
            ).toLocaleDateString()}. You can only view content and submit appeals.`,
        suspension: {
          type: suspension.suspension_type,
          reason: suspension.reason,
          suspendedAt: suspension.starts_at,
          expiresAt: expiresAt,
          hasPendingAppeal: suspension.pending_appeals > 0,
        },
      });
    }

    next();
  } catch (error) {
    console.error("Error in suspension check middleware:", error);
    res.status(500).json({
      success: false,
      message: "Error checking account status",
    });
  }
};

/**
 * Middleware that attaches suspension info to request but doesn't block
 * Use this to show suspension notices or restrict UI features
 */
export const attachSuspensionStatus = async (req, res, next) => {
  try {
    // Skip if no user is authenticated
    if (!req.user || !req.user.id) {
      return next();
    }

    const suspension = await getUserSuspensionStatus(req.user.id);

    if (suspension) {
      req.suspensionStatus = {
        isSuspended: true,
        type: suspension.suspension_type,
        reason: suspension.reason,
        suspendedAt: suspension.starts_at,
        expiresAt: suspension.ends_at,
        hasPendingAppeal: suspension.pending_appeals > 0,
      };
    } else {
      req.suspensionStatus = {
        isSuspended: false,
      };
    }

    next();
  } catch (error) {
    console.error("Error attaching suspension status:", error);
    // Don't block on error, just continue without status
    req.suspensionStatus = { isSuspended: false, error: true };
    next();
  }
};

/**
 * Helper function to check and clean up expired suspensions
 * Run this periodically (e.g., via cron job) or during suspension checks
 */
export const cleanupExpiredSuspensions = async () => {
  try {
    // Mark temporary suspensions as inactive when they expire
    const result = await pool.query(`
            UPDATE account_suspensions
            SET 
                is_active = false,
                lifted_at = CURRENT_TIMESTAMP,
                lift_reason = 'Suspension period expired automatically'
            WHERE 
                suspension_type = 'temporary'
                AND is_active = true
                AND ends_at <= CURRENT_TIMESTAMP
            RETURNING user_id
        `);

    if (result.rows.length > 0) {
      console.log(`Auto-lifted ${result.rows.length} expired suspensions`);

      // Send notifications to users whose suspensions expired
      for (const row of result.rows) {
        await pool.query(
          `
                    INSERT INTO notifications (user_id, type, title, message)
                    VALUES ($1, 'general', 'Suspension Lifted', 
                        'Your account suspension has expired. Your full account access has been restored. Please ensure you follow our community guidelines to avoid future suspensions.')
                `,
          [row.user_id]
        );
      }
    }

    return result.rows.length;
  } catch (error) {
    console.error("Error cleaning up expired suspensions:", error);
    throw error;
  }
};

export default {
  getUserSuspensionStatus,
  blockIfSuspended,
  attachSuspensionStatus,
  cleanupExpiredSuspensions,
};
