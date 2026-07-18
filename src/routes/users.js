import express from "express";
import db from "../db.js";
import bcrypt from "bcrypt";
import multer from "multer";
import cloudinary from "../storage/cloudinary.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";

const router = express.Router();

// Configure multer for profile picture upload
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Get public user profile (no auth required)
router.get("/user/:id/public-profile", async (req, res) => {
  const { id } = req.params;

  try {
    // Get user info with all relevant public data (defensive for optional columns)
    const userColumnsResult = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'",
    );
    const userColumns = new Set(
      userColumnsResult.rows.map((row) => row.column_name),
    );
    const userSelect = [
      "id",
      "name",
      "email",
      "phone",
      "profilepictureurl",
      "country",
      "verified",
      userColumns.has("createdat")
        ? "createdat"
        : userColumns.has("created_at")
          ? "created_at as createdat"
          : "NOW() as createdat",
      userColumns.has("is_suspended")
        ? "is_suspended"
        : "false as is_suspended",
      userColumns.has("suspension_reason")
        ? "suspension_reason"
        : "NULL as suspension_reason",
    ];

    const userResult = await db.query(
      `SELECT ${userSelect.join(", ")} FROM users WHERE id = $1`,
      [id],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userResult.rows[0];

    // Get KYC verification status
    let kycStatus = "none";
    try {
      const kycResult = await db.query(
        `SELECT status FROM kyc_verifications WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
        [id],
      );
      if (kycResult.rows.length > 0) {
        kycStatus = kycResult.rows[0].status;
      }
    } catch (e) {
      // KYC table may not exist
    }

    // Get user's listings count
    let totalListings = 0;
    let activeListings = 0;
    try {
      const countResult = await db.query(
        `SELECT 
          COUNT(*) FILTER (WHERE moderation_status = 'approved' AND status = 'Available') as active,
          COUNT(*) as total
         FROM userlistings WHERE userid = $1`,
        [id],
      );
      if (countResult.rows.length > 0) {
        activeListings = parseInt(countResult.rows[0].active) || 0;
        totalListings = parseInt(countResult.rows[0].total) || 0;
      }
    } catch (e) {
      // Ignore count errors
    }

    // Get user's active listings with images
    let listings = [];
    try {
      const listingsResult = await db.query(
        `SELECT l.id, l.title, l.description, l.price, l.currency, l.city, l.country, 
                l.condition, l.createdat, l.categoryid,
                c.name as category_name
         FROM userlistings l
         LEFT JOIN categories c ON l.categoryid = c.id
         WHERE l.userid = $1 AND l.status = 'Available' AND l.moderation_status = 'approved'
         ORDER BY l.createdat DESC
         LIMIT 12`,
        [id],
      );

      listings = listingsResult.rows;

      // Fetch images for each listing
      for (const listing of listings) {
        try {
          const imagesResult = await db.query(
            `SELECT imageurl FROM imagelistings WHERE listingid = $1 ORDER BY is_main DESC`,
            [listing.id],
          );
          listing.images = imagesResult.rows.map((img) => img.imageurl);
        } catch {
          listing.images = [];
        }
      }
    } catch (e) {
      console.log("Listings query error:", e.message);
    }

    // Calculate member duration
    const memberSince = user.createdat ? new Date(user.createdat) : new Date();
    const now = new Date();
    const monthsDiff =
      (now.getFullYear() - memberSince.getFullYear()) * 12 +
      (now.getMonth() - memberSince.getMonth());

    res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        profilepicture: user.profilepictureurl,
        country: user.country,
        is_verified: user.verified || false,
        is_suspended: user.is_suspended || false,
        suspension_reason: user.suspension_reason || null,
        kyc_status: kycStatus,
        member_since: user.createdat,
        months_as_member: monthsDiff,
      },
      stats: {
        total_listings: totalListings,
        active_listings: activeListings,
      },
      listings: listings,
    });
  } catch (error) {
    console.error("Error fetching public profile:", error.message);
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

// Get current user's own profile (authenticated)
router.get("/users/me", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, name, email, username, phone, country, profilepictureurl, verified, updatedat FROM users WHERE id = $1",
      [req.user.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching current user:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Also support /user/me path
router.get("/user/me", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, name, email, username, phone, country, profilepictureurl, verified, updatedat FROM users WHERE id = $1",
      [req.user.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching current user:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Get user profile by ID (authenticated)
router.get("/users/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      "SELECT id, name, email, username, phone, country, profilepictureurl, verified, updatedat FROM users WHERE id = $1",
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Update user profile
router.put(
  "/users/:id",
  authMiddleware,
  upload.single("profilePicture"),
  async (req, res) => {
    const { id } = req.params;
    const { name, phone, country } = req.body;

    try {
      let profilePictureUrl = null;

      // Upload profile picture to Cloudinary if provided
      if (req.file) {
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: "marketplace/profiles",
              transformation: [
                { width: 400, height: 400, crop: "fill", gravity: "face" },
              ],
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            },
          );
          uploadStream.end(req.file.buffer);
        });

        profilePictureUrl = uploadResult.secure_url;
      }

      // Build update query dynamically
      const updates = [];
      const values = [];
      let paramCount = 1;

      if (name) {
        updates.push(`name = $${paramCount}`);
        values.push(name);
        paramCount++;
      }
      if (phone) {
        updates.push(`phone = $${paramCount}`);
        values.push(phone);
        paramCount++;
      }
      if (country) {
        updates.push(`country = $${paramCount}`);
        values.push(country);
        paramCount++;
      }
      if (profilePictureUrl) {
        updates.push(`profilepictureurl = $${paramCount}`);
        values.push(profilePictureUrl);
        paramCount++;
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      values.push(id);
      const query = `UPDATE users SET ${updates.join(
        ", ",
      )} WHERE id = $${paramCount} RETURNING id, name, email, username, phone, country, profilepictureurl, verified, updatedat`;

      const result = await db.query(query, values);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      res.status(200).json({
        message: "Profile updated successfully",
        user: result.rows[0],
      });
    } catch (error) {
      console.error("Error updating profile:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  },
);

// Update user password
router.put("/users/:id/password", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { currentPassword, newPassword } = req.body;

  try {
    // Validate input
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    // Get current user password
    const userResult = await db.query(
      "SELECT passwordhash FROM users WHERE id = $1",
      [id],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(
      currentPassword,
      userResult.rows[0].passwordhash,
    );

    if (!isValidPassword) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await db.query("UPDATE users SET passwordhash = $1 WHERE id = $2", [
      hashedPassword,
      id,
    ]);

    res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error updating password:", error);
    res.status(500).json({ error: "Failed to update password" });
  }
});

// ─── Follow / Unfollow a seller ──────────────────────────────────────────────

const ensureFollowersTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seller_followers (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seller_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (follower_id, seller_id)
    )
  `);
};

// GET /api/users/:id/follow-status
router.get("/users/:id/follow-status", authMiddleware, async (req, res) => {
  await ensureFollowersTable();
  const followerId = req.user.id;
  const sellerId = parseInt(req.params.id);
  if (followerId === sellerId) return res.json({ following: false });
  try {
    const r = await db.query(
      `SELECT 1 FROM seller_followers WHERE follower_id=$1 AND seller_id=$2`,
      [followerId, sellerId],
    );
    res.json({ following: r.rows.length > 0 });
  } catch (err) {
    res.json({ following: false });
  }
});

// POST /api/users/:id/follow
router.post("/users/:id/follow", authMiddleware, async (req, res) => {
  await ensureFollowersTable();
  const followerId = req.user.id;
  const sellerId = parseInt(req.params.id);
  if (followerId === sellerId)
    return res.status(400).json({ error: "Cannot follow yourself." });
  try {
    await db.query(
      `INSERT INTO seller_followers (follower_id, seller_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [followerId, sellerId],
    );
    // Notify the seller
    sendPushToUser(
      sellerId,
      buildNotificationPayload("new_follower", {
        title: "Someone followed you",
        body: "A buyer is now following your listings and will be notified when you post.",
        url: `/profile/${sellerId}`,
      }),
    );
    res.json({ following: true });
  } catch (err) {
    console.error("[Follow] POST error:", err.message);
    res.status(500).json({ error: "Failed to follow." });
  }
});

// DELETE /api/users/:id/follow
router.delete("/users/:id/follow", authMiddleware, async (req, res) => {
  const followerId = req.user.id;
  const sellerId = parseInt(req.params.id);
  try {
    await db.query(
      `DELETE FROM seller_followers WHERE follower_id=$1 AND seller_id=$2`,
      [followerId, sellerId],
    );
    res.json({ following: false });
  } catch (err) {
    console.error("[Follow] DELETE error:", err.message);
    res.status(500).json({ error: "Failed to unfollow." });
  }
});

export default router;
