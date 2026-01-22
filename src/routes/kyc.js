import express from "express";
import db from "../db.js";
import multer from "multer";
import cloudinary from "../storage/cloudinary.js";
import {
  buildNotificationPayload,
  sendPushToUser,
} from "../utils/pushNotifications.js";
import authMiddleware from "../Middleware/authMiddleware.js";

const router = express.Router();

const updateUserKycStatus = async (userId, status) => {
  try {
    const columnCheck = await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'kyc_status'"
    );
    if (columnCheck.rowCount === 0) return;
    await db.query("UPDATE users SET kyc_status = $1 WHERE id = $2", [
      status,
      userId,
    ]);
  } catch (error) {
    console.warn("Failed to update users.kyc_status:", error);
  }
};

// Configure multer for KYC document uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Submit KYC verification
router.post(
  "/kyc/submit",
  authMiddleware,
  upload.fields([
    { name: "documentFront", maxCount: 1 },
    { name: "documentBack", maxCount: 1 },
    { name: "selfie", maxCount: 1 },
  ]),
  async (req, res) => {
    const { userId, documentType } = req.body;

    try {
      // Validate required fields
      if (!userId || !documentType) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (!req.files.documentFront || !req.files.selfie) {
        return res
          .status(400)
          .json({ error: "Document front and selfie are required" });
      }

      // For ID card and driver's license, back is required
      if (
        (documentType === "id_card" || documentType === "drivers_license") &&
        !req.files.documentBack
      ) {
        return res
          .status(400)
          .json({ error: "Document back is required for this document type" });
      }

      // Check if user already has a pending or approved KYC
      const existingKyc = await db.query(
        "SELECT * FROM kyc_verifications WHERE userid = $1 AND status IN ('pending', 'approved') ORDER BY createdat DESC LIMIT 1",
        [userId]
      );

      if (existingKyc.rows.length > 0) {
        if (existingKyc.rows[0].status === "approved") {
          return res.status(400).json({ error: "You are already verified" });
        }
        if (existingKyc.rows[0].status === "pending") {
          return res
            .status(400)
            .json({ error: "You already have a pending verification request" });
        }
      }

      // Upload document front to Cloudinary
      const documentFrontUpload = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "marketplace/kyc/documents",
            resource_type: "image",
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(req.files.documentFront[0].buffer);
      });

      // Upload document back to Cloudinary (if provided)
      let documentBackUrl = null;
      if (req.files.documentBack) {
        const documentBackUpload = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: "marketplace/kyc/documents",
              resource_type: "image",
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(req.files.documentBack[0].buffer);
        });
        documentBackUrl = documentBackUpload.secure_url;
      }

      // Upload selfie to Cloudinary
      const selfieUpload = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "marketplace/kyc/selfies",
            resource_type: "image",
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(req.files.selfie[0].buffer);
      });

      // Insert KYC verification request
      const result = await db.query(
        `INSERT INTO kyc_verifications 
         (userid, documenttype, documentfronturl, documentbackurl, selfieurl, status, createdat, updatedat) 
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW()) 
         RETURNING *`,
        [
          userId,
          documentType,
          documentFrontUpload.secure_url,
          documentBackUrl,
          selfieUpload.secure_url,
        ]
      );

      await updateUserKycStatus(userId, "pending");

      // Create notification for user
      await db.query(
        `INSERT INTO notifications 
         (userid, title, message, type, relatedid, relatedtype, createdat) 
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          userId,
          "KYC Verification Submitted",
          "Your KYC verification has been submitted successfully. We will review it within 24-48 hours.",
          "info",
          result.rows[0].id,
          "kyc_verification",
        ]
      );

      await sendPushToUser(
        userId,
        buildNotificationPayload({
          title: "KYC Verification Submitted",
          body:
            "Your KYC verification has been submitted successfully. We will review it within 24-48 hours.",
          type: "info",
          relatedId: result.rows[0].id,
          relatedType: "kyc_verification",
          url: "/profile",
        })
      );

      res.status(201).json({
        message: "KYC verification submitted successfully",
        verification: result.rows[0],
      });
    } catch (error) {
      console.error("Error submitting KYC:", error);
      res.status(500).json({ error: "Failed to submit KYC verification" });
    }
  }
);

// Get user's KYC status
router.get("/kyc/status/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await db.query(
      `SELECT * FROM kyc_verifications 
       WHERE userid = $1 
       ORDER BY createdat DESC 
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ status: "not_submitted" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching KYC status:", error);
    res.status(500).json({ error: "Failed to fetch KYC status" });
  }
});

// Get all pending KYC verifications (Admin only)
router.get("/kyc/pending", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT k.*, u.name, u.email, u.username 
       FROM kyc_verifications k
       LEFT JOIN users u ON k.userid = u.id
       WHERE k.status = 'pending'
       ORDER BY k.createdat ASC`
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching pending KYC:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch pending KYC verifications" });
  }
});

// Get all KYC verifications (Admin only)
router.get("/kyc/all", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT k.*, u.name, u.email, u.username 
       FROM kyc_verifications k
       LEFT JOIN users u ON k.userid = u.id
       ORDER BY k.createdat DESC`
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching KYC verifications:", error);
    res.status(500).json({ error: "Failed to fetch KYC verifications" });
  }
});

// Approve KYC verification (Admin only)
router.put("/kyc/approve/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  // Use adminId from body if provided, otherwise use authenticated user's id
  const adminId = req.body.adminId || req.user?.id || 1;

  try {
    // Get KYC verification details
    const kycResult = await db.query(
      "SELECT * FROM kyc_verifications WHERE id = $1",
      [id]
    );

    if (kycResult.rows.length === 0) {
      return res.status(404).json({ error: "KYC verification not found" });
    }

    const kyc = kycResult.rows[0];

    // Update KYC status
    await db.query(
      `UPDATE kyc_verifications 
       SET status = 'approved', reviewedby = $1, reviewedat = NOW(), updatedat = NOW() 
       WHERE id = $2`,
      [adminId, id]
    );

    // Update user's verified status
    await db.query("UPDATE users SET verified = TRUE WHERE id = $1", [
      kyc.userid,
    ]);

    await updateUserKycStatus(kyc.userid, "approved");

    // Create notification for user
    await db.query(
      `INSERT INTO notifications 
       (userid, title, message, type, relatedid, relatedtype, createdat) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        kyc.userid,
        "KYC Verification Approved! 🎉",
        "Congratulations! Your KYC verification has been approved. You are now a verified user on our platform.",
        "kyc_approved",
        id,
        "kyc_verification",
      ]
    );

    await sendPushToUser(
      kyc.userid,
      buildNotificationPayload({
        title: "KYC Verification Approved! 🎉",
        body:
          "Congratulations! Your KYC verification has been approved. You are now a verified user on our platform.",
        type: "kyc_approved",
        relatedId: id,
        relatedType: "kyc_verification",
        url: "/profile",
      })
    );

    res.status(200).json({ message: "KYC verification approved successfully" });
  } catch (error) {
    console.error("Error approving KYC:", error);
    res.status(500).json({ error: "Failed to approve KYC verification" });
  }
});

// Reject KYC verification (Admin only)
router.put("/kyc/reject/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { adminId, reason } = req.body;

  try {
    if (!reason) {
      return res.status(400).json({ error: "Rejection reason is required" });
    }

    // Get KYC verification details
    const kycResult = await db.query(
      "SELECT * FROM kyc_verifications WHERE id = $1",
      [id]
    );

    if (kycResult.rows.length === 0) {
      return res.status(404).json({ error: "KYC verification not found" });
    }

    const kyc = kycResult.rows[0];

    // Update KYC status
    await db.query(
      `UPDATE kyc_verifications 
       SET status = 'rejected', rejectionreason = $1, reviewedby = $2, reviewedat = NOW(), updatedat = NOW() 
       WHERE id = $3`,
      [reason, adminId, id]
    );

    await updateUserKycStatus(kyc.userid, "rejected");

    // Create notification for user
    await db.query(
      `INSERT INTO notifications 
       (userid, title, message, type, relatedid, relatedtype, createdat) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        kyc.userid,
        "KYC Verification Rejected",
        `Unfortunately, your KYC verification has been rejected. Reason: ${reason}. You can submit a new verification request with corrected documents.`,
        "kyc_rejected",
        id,
        "kyc_verification",
      ]
    );

    await sendPushToUser(
      kyc.userid,
      buildNotificationPayload({
        title: "KYC Verification Rejected",
        body: `Unfortunately, your KYC verification has been rejected. Reason: ${reason}. You can submit a new verification request with corrected documents.`,
        type: "kyc_rejected",
        relatedId: id,
        relatedType: "kyc_verification",
        url: "/profile",
      })
    );

    res.status(200).json({ message: "KYC verification rejected successfully" });
  } catch (error) {
    console.error("Error rejecting KYC:", error);
    res.status(500).json({ error: "Failed to reject KYC verification" });
  }
});

export default router;
