import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";

const router = express.Router();

const isMissingTableError = (error) => error?.code === "42P01";

// Get user notifications
router.get("/notifications/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { limit = 50, offset = 0 } = req.query;

  try {
    const result = await db.query(
      `SELECT * FROM notifications 
       WHERE userid = $1 
       ORDER BY createdat DESC 
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    // Get unread count
    const unreadResult = await db.query(
      "SELECT COUNT(*) FROM notifications WHERE userid = $1 AND isread = FALSE",
      [userId]
    );

    res.status(200).json({
      notifications: result.rows,
      unreadCount: parseInt(unreadResult.rows[0].count),
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return res.status(200).json({ notifications: [], unreadCount: 0 });
    }
    console.error("Error fetching notifications:", error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// Mark notification as read
router.put("/notifications/:id/read", authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    await db.query("UPDATE notifications SET isread = TRUE WHERE id = $1", [
      id,
    ]);

    res.status(200).json({ message: "Notification marked as read" });
  } catch (error) {
    if (isMissingTableError(error)) {
      return res.status(200).json({ message: "Notification marked as read" });
    }
    console.error("Error marking notification as read:", error);
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

// Mark all notifications as read
router.put(
  "/notifications/user/:userId/read-all",
  authMiddleware,
  async (req, res) => {
    const { userId } = req.params;

    try {
      await db.query(
        "UPDATE notifications SET isread = TRUE WHERE userid = $1 AND isread = FALSE",
        [userId]
      );

      res.status(200).json({ message: "All notifications marked as read" });
    } catch (error) {
      if (isMissingTableError(error)) {
        return res
          .status(200)
          .json({ message: "All notifications marked as read" });
      }
      console.error("Error marking all notifications as read:", error);
      res
        .status(500)
        .json({ error: "Failed to mark all notifications as read" });
    }
  }
);

// Delete notification
router.delete("/notifications/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    await db.query("DELETE FROM notifications WHERE id = $1", [id]);

    res.status(200).json({ message: "Notification deleted successfully" });
  } catch (error) {
    if (isMissingTableError(error)) {
      return res
        .status(200)
        .json({ message: "Notification deleted successfully" });
    }
    console.error("Error deleting notification:", error);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

// Get unread count
router.get(
  "/notifications/:userId/unread-count",
  authMiddleware,
  async (req, res) => {
    const { userId } = req.params;

    try {
      const result = await db.query(
        "SELECT COUNT(*) FROM notifications WHERE userid = $1 AND isread = FALSE",
        [userId]
      );

      res.status(200).json({ unreadCount: parseInt(result.rows[0].count) });
    } catch (error) {
      if (isMissingTableError(error)) {
        return res.status(200).json({ unreadCount: 0 });
      }
      console.error("Error fetching unread count:", error);
      res.status(500).json({ error: "Failed to fetch unread count" });
    }
  }
);

// Get new notifications since a timestamp (for browser push notifications)
router.get("/notifications/:userId/new", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { since } = req.query;

  try {
    let query = `
        SELECT * FROM notifications 
        WHERE userid = $1 AND isread = FALSE
      `;
    const params = [userId];

    if (since) {
      query += ` AND createdat > $2`;
      params.push(since);
    } else {
      // If no 'since' parameter, only get notifications from last 30 seconds
      query += ` AND createdat > NOW() - INTERVAL '30 seconds'`;
    }

    query += ` ORDER BY createdat DESC LIMIT 10`;

    const result = await db.query(query, params);

    res.status(200).json({
      notifications: result.rows,
      count: result.rows.length,
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return res.status(200).json({ notifications: [], count: 0 });
    }
    console.error("Error fetching new notifications:", error);
    res.status(500).json({ error: "Failed to fetch new notifications" });
  }
});

export default router;
