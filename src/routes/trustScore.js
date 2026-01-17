// ============================================================
// TRUST SCORE & REVIEW SYSTEM - Professional Implementation
// ============================================================
// Features:
// - KYC-only review submission
// - Fraud detection (IP, device, velocity)
// - Public review display
// - Admin controls
// ============================================================

import express from "express";
import pool from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";

const router = express.Router();

// ============================================================
// HELPER FUNCTIONS
// ============================================================

let cachedUserColumns = null;
let cachedUserColumnsAt = 0;
const cachedTableColumns = new Map();

const getUserColumns = async () => {
  const now = Date.now();
  if (cachedUserColumns && now - cachedUserColumnsAt < 5 * 60 * 1000) {
    return cachedUserColumns;
  }

  const result = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
  );
  cachedUserColumns = new Set(result.rows.map((row) => row.column_name));
  cachedUserColumnsAt = now;
  return cachedUserColumns;
};

const getUserColumnMap = (columns) => {
  const pick = (...names) => names.find((name) => columns.has(name)) || null;
  return {
    id: pick("id"),
    name: pick("name", "fullname", "full_name", "username"),
    profilePicture: pick(
      "profilepicture",
      "profilepictureurl",
      "profile_picture",
      "profile_picture_url",
      "profilepictureurl"
    ),
    kycStatus: pick("kyc_status"),
  };
};

const getTableColumns = async (tableName) => {
  const cached = cachedTableColumns.get(tableName);
  const now = Date.now();
  if (cached && now - cached.timestamp < 5 * 60 * 1000) {
    return cached.columns;
  }

  const result = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
    [tableName]
  );
  const columns = new Set(result.rows.map((row) => row.column_name));
  cachedTableColumns.set(tableName, { columns, timestamp: now });
  return columns;
};

const getReviewColumnMap = (columns) => {
  const pick = (...names) => names.find((name) => columns.has(name)) || null;
  return {
    reviewerId: pick("reviewer_id", "reviewerid"),
    reviewedUserId: pick("reviewed_user_id", "revieweduserid"),
    listingId: pick("listing_id", "listingid"),
    transactionId: pick("transaction_id", "transactionid"),
    rating: pick("rating"),
    title: pick("title"),
    reviewText: pick("review_text", "reviewtext"),
    reviewType: pick("review_type", "reviewtype"),
    createdAt: pick("created_at", "createdat"),
    sellerResponse: pick("seller_response", "sellerresponse"),
    sellerResponseAt: pick("seller_response_at", "sellerresponseat"),
    isValid: pick("is_valid", "isvalid"),
    isVerified: pick("is_verified", "isverified"),
    reviewSentiment: pick("review_sentiment", "reviewsentiment"),
    reviewerIp: pick("reviewer_ip", "reviewerip"),
    reviewerDeviceFingerprint: pick(
      "reviewer_device_fingerprint",
      "reviewerdevicefingerprint"
    ),
    fraudScore: pick("fraud_score", "fraudscore"),
    fraudFlags: pick("fraud_flags", "fraudflags"),
  };
};

const getListingsTable = async () => {
  if (await tableExists("userlistings")) return "userlistings";
  if (await tableExists("listings")) return "listings";
  return null;
};

const getReviewerKycStatus = async (userId) => {
  const userExists = await pool.query("SELECT id FROM users WHERE id = $1", [
    userId,
  ]);

  if (userExists.rows.length === 0) {
    return { exists: false, kycStatus: "unknown" };
  }

  const columns = await getUserColumns();
  if (columns.has("kyc_status")) {
    const reviewer = await pool.query(
      "SELECT kyc_status FROM users WHERE id = $1",
      [userId]
    );
    return {
      exists: true,
      kycStatus: reviewer.rows[0]?.kyc_status || "pending",
    };
  }

  if (!(await tableExists("kyc_verifications"))) {
    return { exists: true, kycStatus: "pending" };
  }

  const kycColumns = await getTableColumns("kyc_verifications");
  const createdColumn = kycColumns.has("created_at")
    ? "created_at"
    : kycColumns.has("createdat")
    ? "createdat"
    : null;

  const orderBy = createdColumn
    ? `ORDER BY ${createdColumn} DESC NULLS LAST`
    : "";

  const kycResult = await pool.query(
    `SELECT status FROM kyc_verifications
     WHERE userid = $1
     ${orderBy}
     LIMIT 1`,
    [userId]
  );

  return {
    exists: true,
    kycStatus: kycResult.rows[0]?.status || "pending",
  };
};

/**
 * Get client IP address from request
 */
const getClientIP = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown"
  );
};

/**
 * Get device fingerprint from request headers
 */
const getDeviceFingerprint = (req) => {
  const userAgent = req.headers["user-agent"] || "";
  const acceptLanguage = req.headers["accept-language"] || "";
  const acceptEncoding = req.headers["accept-encoding"] || "";

  // Create a simple fingerprint from available headers
  const fingerprint = Buffer.from(
    `${userAgent}|${acceptLanguage}|${acceptEncoding}`
  )
    .toString("base64")
    .substring(0, 255);

  return fingerprint;
};

const tableExists = async (tableName) => {
  const result = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name = $1",
    [tableName]
  );
  return result.rowCount > 0;
};

/**
 * Calculate fraud score for a review
 */
const calculateFraudScore = async (
  reviewerId,
  reviewedUserId,
  ip,
  deviceFingerprint
) => {
  let fraudScore = 0;
  const fraudFlags = [];

  try {
    // 1. Check if same IP has reviewed this user before
    const ipCheck = await pool.query(
      `SELECT COUNT(*) FROM user_reviews 
       WHERE reviewed_user_id = $1 AND reviewer_ip = $2 AND reviewer_id != $3`,
      [reviewedUserId, ip, reviewerId]
    );
    if (parseInt(ipCheck.rows[0].count) > 0) {
      fraudScore += 30;
      fraudFlags.push({
        type: "same_ip",
        message: "Same IP reviewed this user before",
      });
    }

    // 2. Check if same device has reviewed this user before
    const deviceCheck = await pool.query(
      `SELECT COUNT(*) FROM user_reviews 
       WHERE reviewed_user_id = $1 AND reviewer_device_fingerprint = $2 AND reviewer_id != $3`,
      [reviewedUserId, deviceFingerprint, reviewerId]
    );
    if (parseInt(deviceCheck.rows[0].count) > 0) {
      fraudScore += 40;
      fraudFlags.push({
        type: "same_device",
        message: "Same device reviewed this user before",
      });
    }

    // 3. Check review velocity (too many reviews in short time)
    const velocityCheck = await pool.query(
      `SELECT COUNT(*) FROM user_reviews 
       WHERE reviewer_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [reviewerId]
    );
    if (parseInt(velocityCheck.rows[0].count) >= 5) {
      fraudScore += 25;
      fraudFlags.push({
        type: "high_velocity",
        message: "Too many reviews in 24 hours",
      });
    }

    // 4. Check if reviewer account is very new
    const accountAge = await pool.query(
      `SELECT EXTRACT(DAY FROM (NOW() - createdat)) as days_old FROM users WHERE id = $1`,
      [reviewerId]
    );
    if (accountAge.rows[0] && parseInt(accountAge.rows[0].days_old) < 7) {
      fraudScore += 15;
      fraudFlags.push({
        type: "new_account",
        message: "Reviewer account is less than 7 days old",
      });
    }

    // 5. Check if reviewer has reviewed only this one user (potential fake account)
    const reviewPattern = await pool.query(
      `SELECT COUNT(DISTINCT reviewed_user_id) as unique_reviewed, COUNT(*) as total
       FROM user_reviews WHERE reviewer_id = $1`,
      [reviewerId]
    );
    if (reviewPattern.rows[0]) {
      const { unique_reviewed, total } = reviewPattern.rows[0];
      if (parseInt(total) >= 3 && parseInt(unique_reviewed) === 1) {
        fraudScore += 20;
        fraudFlags.push({
          type: "single_target",
          message: "All reviews for same user",
        });
      }
    }
  } catch (error) {
    console.error("Error calculating fraud score:", error);
  }

  return { fraudScore: Math.min(fraudScore, 100), fraudFlags };
};

/**
 * JavaScript fallback for trust score calculation
 */
const calculateTrustScoreJS = async (userId) => {
  try {
    const userColumns = await getUserColumns();
    const userMap = getUserColumnMap(userColumns);
    const createdColumn = userColumns.has("createdat")
      ? "createdat"
      : userColumns.has("created_at")
      ? "created_at"
      : null;

    const selectParts = ["u.id"];
    selectParts.push(
      userMap.name ? `u.${userMap.name} as name` : "NULL as name"
    );
    selectParts.push(
      userMap.profilePicture
        ? `u.${userMap.profilePicture} as profilepicture`
        : "NULL as profilepicture"
    );
    selectParts.push(
      userColumns.has("country") ? "u.country" : "NULL as country"
    );
    selectParts.push(userColumns.has("phone") ? "u.phone" : "NULL as phone");
    selectParts.push(userColumns.has("bio") ? "u.bio" : "NULL as bio");
    selectParts.push(
      userColumns.has("kyc_status") ? "u.kyc_status" : "NULL as kyc_status"
    );
    selectParts.push(
      createdColumn ? `u.${createdColumn} as created_at` : "NULL as created_at"
    );

    const userResult = await pool.query(
      `SELECT ${selectParts.join(", ")} FROM users u WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return { trustScore: 0, breakdown: {} };
    }

    const user = userResult.rows[0];
    let score = 0;
    const breakdown = {};

    const createdAtValue = user.created_at ? new Date(user.created_at) : null;
    const monthsAsMember = createdAtValue
      ? Math.max(
          0,
          (new Date().getFullYear() - createdAtValue.getFullYear()) * 12 +
            (new Date().getMonth() - createdAtValue.getMonth())
        )
      : 0;

    // 1. KYC Verification (+15 points)
    let kycStatus = user.kyc_status;
    if (!kycStatus) {
      const reviewerKyc = await getReviewerKycStatus(userId);
      kycStatus = reviewerKyc?.kycStatus || "pending";
    }

    if (kycStatus === "approved") {
      score += 15;
      breakdown.kyc_verified = { points: 15, status: "approved" };
    } else {
      breakdown.kyc_verified = {
        points: 0,
        status: kycStatus || "not_submitted",
      };
    }

    // 2. Account Age 3+ months (+10 points)
    if (monthsAsMember >= 3) {
      score += 10;
      breakdown.account_age_3mo = { points: 10, months: monthsAsMember };
    } else {
      breakdown.account_age_3mo = { points: 0, months: monthsAsMember };
    }

    // 3. Account Age 12+ months (+10 points)
    if (monthsAsMember >= 12) {
      score += 10;
      breakdown.account_age_12mo = { points: 10, months: monthsAsMember };
    } else {
      breakdown.account_age_12mo = { points: 0, months: monthsAsMember };
    }

    // 4. Verified Reviews (+5 points max)
    if (await tableExists("user_reviews")) {
      const reviewColumns = await getTableColumns("user_reviews");
      const reviewMap = getReviewColumnMap(reviewColumns);
      if (
        !reviewMap.reviewedUserId ||
        !reviewMap.reviewerId ||
        !reviewMap.rating
      ) {
        breakdown.verified_reviews = {
          points: 0,
          max_points: 5,
          total_reviews: 0,
        };
      } else {
        const hasKycStatus = userColumns.has("kyc_status");
        const hasKycTable = await tableExists("kyc_verifications");

        const reviewerJoin = hasKycTable
          ? "LEFT JOIN kyc_verifications kv ON kv.userid = reviewer.id"
          : "";

        const kycFilter = hasKycStatus
          ? "AND reviewer.kyc_status = 'approved'"
          : hasKycTable
          ? "AND kv.status = 'approved'"
          : "";

        const ratingColumn = `r.${reviewMap.rating}`;
        const validFilter = reviewMap.isValid
          ? `AND COALESCE(r.${reviewMap.isValid}, true) = true`
          : "";

        const buildReviewStatsQuery = (applyKyc, applyValid) =>
          `SELECT COUNT(*) as total, COALESCE(AVG(${ratingColumn}), 0) as avg_rating,
            COUNT(*) FILTER (WHERE ${ratingColumn} >= 4) as positive,
            COUNT(*) FILTER (WHERE ${ratingColumn} <= 2) as negative
           FROM user_reviews r
           JOIN users reviewer ON reviewer.id = r.${reviewMap.reviewerId}
           ${reviewerJoin}
           WHERE r.${reviewMap.reviewedUserId} = $1
           ${applyValid ? validFilter : ""}
           ${applyKyc ? kycFilter : ""}`;

        let reviewStats = await pool.query(buildReviewStatsQuery(true, true), [
          userId,
        ]);

        let reviews = reviewStats.rows[0];
        let totalReviews = parseInt(reviews.total) || 0;

        if (totalReviews === 0 && kycFilter) {
          reviewStats = await pool.query(buildReviewStatsQuery(false, true), [
            userId,
          ]);
          reviews = reviewStats.rows[0];
          totalReviews = parseInt(reviews.total) || 0;
        }

        if (totalReviews === 0 && validFilter) {
          reviewStats = await pool.query(buildReviewStatsQuery(false, false), [
            userId,
          ]);
          reviews = reviewStats.rows[0];
          totalReviews = parseInt(reviews.total) || 0;
        }

        const avgRating = parseFloat(reviews.avg_rating) || 0;

        if (totalReviews > 0) {
          const reviewScoreRaw =
            (((avgRating / 5) * Math.min(totalReviews, 10)) / 10) * 5;
          const reviewScore =
            avgRating >= 4
              ? Math.max(1, Math.round(reviewScoreRaw))
              : Math.round(reviewScoreRaw);
          score += Math.min(reviewScore, 5);
          breakdown.verified_reviews = {
            points: Math.min(reviewScore, 5),
            max_points: 5,
            total_reviews: totalReviews,
            average_rating: Math.round(avgRating * 100) / 100,
            positive_reviews: parseInt(reviews.positive) || 0,
            negative_reviews: parseInt(reviews.negative) || 0,
          };
        } else {
          breakdown.verified_reviews = {
            points: 0,
            max_points: 5,
            total_reviews: 0,
          };
        }
      }
    } else {
      breakdown.verified_reviews = {
        points: 0,
        max_points: 5,
        total_reviews: 0,
      };
    }

    // 5. Active Listings 10+ (+5 points)
    if (await tableExists("userlistings")) {
      const listingCount = await pool.query(
        `SELECT COUNT(*) FROM userlistings 
         WHERE userid = $1 AND status = 'Available' AND moderation_status = 'approved'`,
        [userId]
      );
      const activeListings = parseInt(listingCount.rows[0].count) || 0;
      if (activeListings >= 10) {
        score += 5;
        breakdown.active_listings = {
          points: 5,
          count: activeListings,
          required: 10,
        };
      } else {
        breakdown.active_listings = {
          points: 0,
          count: activeListings,
          required: 10,
        };
      }
    } else {
      breakdown.active_listings = { points: 0, count: 0, required: 10 };
    }

    // 6. Complete Profile (+5 points)
    const profileComplete =
      user.name &&
      user.profilepicture &&
      user.country &&
      user.phone &&
      user.bio;
    if (profileComplete) {
      score += 5;
      breakdown.complete_profile = { points: 5, is_complete: true };
    } else {
      breakdown.complete_profile = { points: 0, is_complete: false };
    }

    // 7. Verified Reports (-5 each, max -20)
    if (await tableExists("reports")) {
      const reportCount = await pool.query(
        `SELECT COUNT(*) FROM reports WHERE reported_user_id = $1 AND status = 'verified'`,
        [userId]
      );
      const reports = parseInt(reportCount.rows[0].count) || 0;
      if (reports > 0) {
        const penalty = Math.min(reports * 5, 20);
        score -= penalty;
        breakdown.verified_reports = { points: -penalty, count: reports };
      }
    }

    // 8. Rejected Listings (-3 each, max -15)
    if (await tableExists("userlistings")) {
      const rejectionCount = await pool.query(
        `SELECT COUNT(*) FROM userlistings WHERE userid = $1 AND moderation_status = 'rejected'`,
        [userId]
      );
      const rejections = parseInt(rejectionCount.rows[0].count) || 0;
      if (rejections > 0) {
        const penalty = Math.min(rejections * 3, 15);
        score -= penalty;
        breakdown.rejected_listings = { points: -penalty, count: rejections };
      }
    }

    // 9. Suspensions (-25 each)
    if (await tableExists("user_suspensions")) {
      const suspensionCount = await pool.query(
        `SELECT COUNT(*) FROM user_suspensions WHERE user_id = $1`,
        [userId]
      );
      const suspensions = parseInt(suspensionCount.rows[0].count) || 0;
      if (suspensions > 0) {
        score -= suspensions * 25;
        breakdown.suspensions = {
          points: -(suspensions * 25),
          count: suspensions,
        };
      }
    }

    // 10. Admin Warnings
    if (await tableExists("user_warnings")) {
      const warningPoints = await pool.query(
        `SELECT COALESCE(SUM(points_deducted), 0) as total
         FROM user_warnings WHERE user_id = $1 AND is_active = true 
         AND (expires_at IS NULL OR expires_at > NOW())`,
        [userId]
      );
      const warnings = parseInt(warningPoints.rows[0].total) || 0;
      if (warnings > 0) {
        score -= warnings;
        breakdown.admin_warnings = { points: -warnings };
      }
    }

    // Ensure score is 0-100
    score = Math.max(0, Math.min(100, score));

    breakdown.summary = {
      total_score: score,
      max_possible: 50,
      algorithm_version: "2.0",
    };

    return { trustScore: score, breakdown };
  } catch (error) {
    console.error("Error calculating trust score:", error);
    return { trustScore: 0, breakdown: {} };
  }
};

// ============================================================
// PUBLIC ENDPOINTS
// ============================================================

/**
 * GET /api/user/:id/trust-score
 * Get a user's trust score (public)
 */
router.get("/user/:id/trust-score", async (req, res) => {
  try {
    const { id } = req.params;

    // Always compute JS score (dynamic, schema-safe)
    const jsResult = await calculateTrustScoreJS(id);

    // Prefer DB function only if it exists and yields a meaningful score
    try {
      const result = await pool.query(
        `SELECT * FROM calculate_trust_score($1)`,
        [id]
      );

      if (result.rows.length > 0) {
        const dbScore = result.rows[0].total_score;
        const dbBreakdown = result.rows[0].breakdown;
        if (dbScore > 0 || jsResult.trustScore === 0) {
          return res.json({
            userId: parseInt(id),
            trustScore: dbScore,
            breakdown: dbBreakdown,
            source: "database",
          });
        }
      }
    } catch (dbError) {
      // Ignore DB function errors and use JS
    }

    res.json({
      userId: parseInt(id),
      trustScore: jsResult.trustScore,
      breakdown: jsResult.breakdown,
      source: "javascript",
    });
  } catch (error) {
    console.error("Error fetching trust score:", error);
    res.status(500).json({ error: "Failed to fetch trust score" });
  }
});

/**
 * GET /api/user/:id/trust-score/breakdown
 * Get detailed trust score breakdown (authenticated, own profile only)
 */
router.get(
  "/user/:id/trust-score/breakdown",
  authMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;
      const requestingUserId = req.user.id;

      // Users can only see their own detailed breakdown
      if (parseInt(id) !== requestingUserId) {
        return res
          .status(403)
          .json({ error: "You can only view your own trust score breakdown" });
      }

      const { trustScore, breakdown } = await calculateTrustScoreJS(id);

      res.json({
        userId: parseInt(id),
        trustScore,
        breakdown,
        tips: generateTrustScoreTips(breakdown),
      });
    } catch (error) {
      console.error("Error fetching trust score breakdown:", error);
      res.status(500).json({ error: "Failed to fetch trust score breakdown" });
    }
  }
);

/**
 * Generate tips to improve trust score
 */
const generateTrustScoreTips = (breakdown) => {
  const tips = [];

  if (breakdown.kyc_verified?.points === 0) {
    tips.push({
      priority: "high",
      message: "Complete KYC verification to earn 15 trust points",
      action: "Complete KYC",
    });
  }

  if (breakdown.complete_profile?.points === 0) {
    tips.push({
      priority: "medium",
      message: "Complete your profile (add bio, photo, phone) to earn 5 points",
      action: "Update Profile",
    });
  }

  if (breakdown.account_age_3mo?.points === 0) {
    const months = breakdown.account_age_3mo?.months || 0;
    tips.push({
      priority: "low",
      message: `Your account is ${months} months old. After 3 months, you'll earn 10 points automatically.`,
      action: "Wait",
    });
  }

  if (breakdown.active_listings?.points === 0) {
    const count = breakdown.active_listings?.count || 0;
    tips.push({
      priority: "medium",
      message: `You have ${count} active listings. Get 10+ to earn 5 points.`,
      action: "Add Listings",
    });
  }

  if (breakdown.verified_reviews?.points < 5) {
    tips.push({
      priority: "medium",
      message:
        "Get more positive reviews from verified buyers to increase your score",
      action: "Provide Great Service",
    });
  }

  return tips;
};

/**
 * GET /api/user/:id/reviews
 * Get reviews for a user (public)
 */
router.get("/user/:id/reviews", async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, type = "all" } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    if (!(await tableExists("user_reviews"))) {
      return res.json({
        reviews: [],
        stats: {
          total: 0,
          positive: 0,
          neutral: 0,
          negative: 0,
          averageRating: 0,
          distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
        },
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          totalPages: 0,
        },
      });
    }

    const reviewColumns = await getTableColumns("user_reviews");
    const reviewMap = getReviewColumnMap(reviewColumns);

    if (
      !reviewMap.reviewedUserId ||
      !reviewMap.reviewerId ||
      !reviewMap.rating
    ) {
      return res.json({
        reviews: [],
        stats: {
          total: 0,
          positive: 0,
          neutral: 0,
          negative: 0,
          averageRating: 0,
          distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
        },
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          totalPages: 0,
        },
      });
    }

    const ratingColumn = `r.${reviewMap.rating}`;
    const statsRatingColumn = reviewMap.rating;
    let ratingFilter = "";
    if (type === "positive") {
      ratingFilter = `AND ${ratingColumn} >= 4`;
    } else if (type === "negative") {
      ratingFilter = `AND ${ratingColumn} <= 2`;
    } else if (type === "neutral") {
      ratingFilter = `AND ${ratingColumn} = 3`;
    }

    const listingsTable = await getListingsTable();
    const userColumns = await getUserColumns();
    const userMap = getUserColumnMap(userColumns);
    const hasKycStatus = userColumns.has("kyc_status");
    const hasKycTable = await tableExists("kyc_verifications");

    const reviewerKycSelect = hasKycStatus
      ? "reviewer.kyc_status as reviewer_kyc_status"
      : hasKycTable
      ? "kv.status as reviewer_kyc_status"
      : "NULL as reviewer_kyc_status";

    const reviewerKycJoin = hasKycTable
      ? "LEFT JOIN kyc_verifications kv ON kv.userid = reviewer.id"
      : "";

    const listingJoin = listingsTable
      ? `LEFT JOIN ${listingsTable} l ON l.id = r.listing_id`
      : "";

    const sentimentSelect = reviewMap.reviewSentiment
      ? `r.${reviewMap.reviewSentiment} as review_sentiment`
      : "NULL as review_sentiment";

    let validFilter = reviewMap.isValid
      ? `AND COALESCE(r.${reviewMap.isValid}, true) = true`
      : "";

    if (reviewMap.isValid) {
      const validityCheck = await pool.query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE ${reviewMap.isValid} = true) as valid_count
         FROM user_reviews
         WHERE ${reviewMap.reviewedUserId} = $1`,
        [id]
      );

      const totalCount = parseInt(validityCheck.rows[0]?.total) || 0;
      const validCount = parseInt(validityCheck.rows[0]?.valid_count) || 0;

      if (totalCount > 0 && validCount === 0) {
        validFilter = "";
      }
    }

    const createdAtSelect = reviewMap.createdAt
      ? `r.${reviewMap.createdAt} as created_at`
      : "NULL as created_at";

    const orderByColumn = reviewMap.createdAt
      ? `r.${reviewMap.createdAt}`
      : "r.id";

    const sellerResponseAtSelect = reviewMap.sellerResponseAt
      ? `r.${reviewMap.sellerResponseAt} as seller_response_at`
      : "NULL as seller_response_at";

    const listingSelect = listingsTable
      ? "l.id as listing_id, l.title as listing_title"
      : "NULL as listing_id, NULL as listing_title";

    const listingImageSelect = listingsTable
      ? `(SELECT imageurl FROM imagelistings WHERE listingid = l.id ORDER BY is_main DESC LIMIT 1) as listing_image`
      : "NULL as listing_image";

    const reviewerNameSelect = userMap.name
      ? `reviewer.${userMap.name} as reviewer_name`
      : "NULL as reviewer_name";

    const reviewerPictureSelect = userMap.profilePicture
      ? `reviewer.${userMap.profilePicture} as reviewer_picture`
      : "NULL as reviewer_picture";

    // Get reviews with reviewer info
    const reviews = await pool.query(
      `SELECT 
        r.id,
        ${ratingColumn} as rating,
        ${reviewMap.title ? `r.${reviewMap.title}` : "NULL"} as title,
        ${
          reviewMap.reviewText ? `r.${reviewMap.reviewText}` : "NULL"
        } as review_text,
        ${
          reviewMap.reviewType ? `r.${reviewMap.reviewType}` : "NULL"
        } as review_type,
        ${createdAtSelect},
        ${
          reviewMap.sellerResponse ? `r.${reviewMap.sellerResponse}` : "NULL"
        } as seller_response,
        ${sellerResponseAtSelect},
        reviewer.id as reviewer_id,
        ${reviewerNameSelect},
        ${reviewerPictureSelect},
        ${reviewerKycSelect},
        ${listingSelect},
        ${listingImageSelect},
        ${sentimentSelect}
       FROM user_reviews r
       JOIN users reviewer ON reviewer.id = r.reviewer_id
       ${reviewerKycJoin}
       ${listingJoin}
       WHERE r.${reviewMap.reviewedUserId} = $1 
         ${validFilter}
         ${ratingFilter}
       ORDER BY ${orderByColumn} DESC
       LIMIT $2 OFFSET $3`,
      [id, parseInt(limit), offset]
    );

    // Get review statistics
    const stats = await pool.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE ${statsRatingColumn} >= 4) as positive,
        COUNT(*) FILTER (WHERE ${statsRatingColumn} = 3) as neutral,
        COUNT(*) FILTER (WHERE ${statsRatingColumn} <= 2) as negative,
        COALESCE(ROUND(AVG(${statsRatingColumn})::numeric, 2), 0) as average,
        COUNT(*) FILTER (WHERE ${statsRatingColumn} = 5) as five_star,
        COUNT(*) FILTER (WHERE ${statsRatingColumn} = 4) as four_star,
        COUNT(*) FILTER (WHERE ${statsRatingColumn} = 3) as three_star,
        COUNT(*) FILTER (WHERE ${statsRatingColumn} = 2) as two_star,
        COUNT(*) FILTER (WHERE ${statsRatingColumn} = 1) as one_star
       FROM user_reviews
      WHERE ${reviewMap.reviewedUserId} = $1 ${
        validFilter ? `AND COALESCE(${reviewMap.isValid}, true) = true` : ""
      }`,
      [id]
    );

    const statsData = stats.rows[0];
    const totalReviews = parseInt(statsData.total) || 0;

    res.json({
      reviews: reviews.rows.map((review) => ({
        id: review.id,
        rating: review.rating,
        title: review.title,
        text: review.review_text,
        type: review.review_type,
        createdAt: review.created_at,
        sellerResponse: review.seller_response,
        sellerResponseAt: review.seller_response_at,
        reviewer: {
          id: review.reviewer_id,
          name: review.reviewer_name,
          picture: review.reviewer_picture,
          isVerified: review.reviewer_kyc_status === "approved",
        },
        sentiment:
          review.review_sentiment ||
          (review.rating >= 4
            ? "positive"
            : review.rating === 3
            ? "neutral"
            : "negative"),
        listing: review.listing_id
          ? {
              id: review.listing_id,
              title: review.listing_title,
              image: review.listing_image || null,
            }
          : null,
      })),
      stats: {
        total: totalReviews,
        positive: parseInt(statsData.positive) || 0,
        neutral: parseInt(statsData.neutral) || 0,
        negative: parseInt(statsData.negative) || 0,
        averageRating: parseFloat(statsData.average) || 0,
        distribution: {
          5: parseInt(statsData.five_star) || 0,
          4: parseInt(statsData.four_star) || 0,
          3: parseInt(statsData.three_star) || 0,
          2: parseInt(statsData.two_star) || 0,
          1: parseInt(statsData.one_star) || 0,
        },
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalReviews,
        totalPages: Math.ceil(totalReviews / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching reviews:", error);
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

// ============================================================
// AUTHENTICATED ENDPOINTS
// ============================================================

/**
 * POST /api/user/:id/review
 * Submit a review for a user (KYC-verified users only)
 */
router.post("/user/:id/review", authMiddleware, async (req, res) => {
  try {
    const reviewedUserId = parseInt(req.params.id);
    const reviewerId = req.user.id;
    const {
      rating,
      title,
      reviewText,
      listingId,
      transactionId,
      reviewSentiment,
    } = req.body;

    // Validation
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5" });
    }

    if (!reviewText || reviewText.trim().length < 10) {
      return res
        .status(400)
        .json({ error: "Review must be at least 10 characters long" });
    }

    // Prevent self-review
    if (reviewerId === reviewedUserId) {
      return res.status(400).json({ error: "You cannot review yourself" });
    }

    // Check if reviewer is KYC approved
    const reviewerKyc = await getReviewerKycStatus(reviewerId);

    if (!reviewerKyc.exists) {
      return res.status(404).json({ error: "Reviewer not found" });
    }

    if (reviewerKyc.kycStatus !== "approved") {
      return res.status(403).json({
        error: "Only KYC-verified users can leave reviews",
        message: "Please complete your KYC verification to leave reviews",
      });
    }

    // Check if reviewed user exists
    const reviewedUserCheck = await pool.query(
      `SELECT id FROM users WHERE id = $1`,
      [reviewedUserId]
    );

    if (reviewedUserCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!(await tableExists("user_reviews"))) {
      return res.status(500).json({ error: "user_reviews table not found" });
    }

    const reviewColumns = await getTableColumns("user_reviews");
    const reviewMap = getReviewColumnMap(reviewColumns);

    // Check for existing review on this listing/transaction
    if (
      listingId &&
      reviewMap.reviewerId &&
      reviewMap.reviewedUserId &&
      reviewMap.listingId
    ) {
      const existingReview = await pool.query(
        `SELECT id FROM user_reviews 
         WHERE ${reviewMap.reviewerId} = $1 AND ${reviewMap.reviewedUserId} = $2 AND ${reviewMap.listingId} = $3`,
        [reviewerId, reviewedUserId, listingId]
      );

      if (existingReview.rows.length > 0) {
        return res
          .status(400)
          .json({ error: "You have already reviewed this transaction" });
      }
    }

    // Get fraud detection data
    const ip = getClientIP(req);
    const deviceFingerprint = getDeviceFingerprint(req);
    const { fraudScore, fraudFlags } = await calculateFraudScore(
      reviewerId,
      reviewedUserId,
      ip,
      deviceFingerprint
    );

    // Determine if review should be auto-verified
    // Reviews from long-standing KYC users with low fraud score are auto-verified
    const autoVerify = fraudScore < 25;

    // Insert the review
    // reviewColumns/reviewMap already loaded above
    const sentimentValue =
      reviewSentiment ||
      (rating >= 4 ? "positive" : rating === 3 ? "neutral" : "negative");

    if (
      !reviewMap.reviewerId ||
      !reviewMap.reviewedUserId ||
      !reviewMap.rating
    ) {
      return res.status(500).json({
        error:
          "user_reviews table is missing required columns (reviewer_id, reviewed_user_id, rating)",
      });
    }

    const insertColumns = [];
    const insertValues = [];
    const pushIf = (column, value) => {
      if (!column) return;
      insertColumns.push(column);
      insertValues.push(value);
    };

    pushIf(reviewMap.reviewerId, reviewerId);
    pushIf(reviewMap.reviewedUserId, reviewedUserId);
    pushIf(reviewMap.listingId, listingId || null);
    pushIf(reviewMap.transactionId, transactionId || null);
    pushIf(reviewMap.rating, rating);
    pushIf(reviewMap.title, title || null);
    pushIf(reviewMap.reviewText, reviewText.trim());
    pushIf(reviewMap.reviewType, "buyer_to_seller");
    pushIf(reviewMap.isVerified, autoVerify);
    pushIf(reviewMap.reviewerIp, ip);
    pushIf(reviewMap.reviewerDeviceFingerprint, deviceFingerprint);
    pushIf(reviewMap.fraudScore, fraudScore);
    pushIf(reviewMap.fraudFlags, JSON.stringify(fraudFlags));
    pushIf(reviewMap.reviewSentiment, sentimentValue);
    pushIf(reviewMap.isValid, true);

    const placeholders = insertColumns.map((_, index) => `$${index + 1}`);

    const result = await pool.query(
      `INSERT INTO user_reviews (${insertColumns.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING id, created_at`,
      insertValues
    );

    // Log fraud detection if flags were raised
    if (fraudFlags.length > 0) {
      await pool.query(
        `INSERT INTO review_fraud_log (
          review_id, reviewer_id, reviewed_user_id,
          fraud_type, fraud_details, severity
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          result.rows[0].id,
          reviewerId,
          reviewedUserId,
          "auto_detection",
          JSON.stringify({ score: fraudScore, flags: fraudFlags }),
          fraudScore >= 70 ? "high" : fraudScore >= 40 ? "medium" : "low",
        ]
      );
    }

    res.status(201).json({
      message: "Review submitted successfully",
      review: {
        id: result.rows[0].id,
        createdAt: result.rows[0].created_at,
        isVerified: autoVerify,
        status: autoVerify ? "published" : "pending_review",
      },
    });
  } catch (error) {
    console.error("Error submitting review:", error);
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ error: "You have already reviewed this transaction" });
    }
    res.status(500).json({ error: "Failed to submit review" });
  }
});

/**
 * POST /api/user/:id/review/:reviewId/respond
 * Seller responds to a review
 */
router.post(
  "/user/:id/review/:reviewId/respond",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      const reviewId = parseInt(req.params.reviewId);
      const responderId = req.user.id;
      const { response } = req.body;

      // Only the reviewed user can respond
      if (userId !== responderId) {
        return res
          .status(403)
          .json({ error: "You can only respond to reviews on your profile" });
      }

      if (!response || response.trim().length < 10) {
        return res
          .status(400)
          .json({ error: "Response must be at least 10 characters long" });
      }

      // Check if review exists and belongs to this user
      const review = await pool.query(
        `SELECT id, seller_response FROM user_reviews 
       WHERE id = $1 AND reviewed_user_id = $2`,
        [reviewId, userId]
      );

      if (review.rows.length === 0) {
        return res.status(404).json({ error: "Review not found" });
      }

      if (review.rows[0].seller_response) {
        return res
          .status(400)
          .json({ error: "You have already responded to this review" });
      }

      // Add response
      await pool.query(
        `UPDATE user_reviews 
       SET seller_response = $1, seller_response_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
        [response.trim(), reviewId]
      );

      res.json({ message: "Response added successfully" });
    } catch (error) {
      console.error("Error adding response:", error);
      res.status(500).json({ error: "Failed to add response" });
    }
  }
);

/**
 * POST /api/user/review/:reviewId/report
 * Report an abusive review (reviewed user only)
 */
router.post(
  "/user/review/:reviewId/report",
  authMiddleware,
  async (req, res) => {
    try {
      const reviewId = parseInt(req.params.reviewId);
      const reporterId = req.user.id;
      const { reason } = req.body;

      if (!reason || String(reason).trim().length < 3) {
        return res
          .status(400)
          .json({ error: "Please provide a reason for reporting" });
      }

      if (!(await tableExists("user_reviews"))) {
        return res.status(500).json({ error: "user_reviews table not found" });
      }

      const reviewColumns = await getTableColumns("user_reviews");
      const reviewMap = getReviewColumnMap(reviewColumns);

      if (!reviewMap.reviewedUserId || !reviewMap.fraudFlags) {
        return res.status(500).json({
          error:
            "user_reviews table is missing required columns for reporting abuse",
        });
      }

      const reviewResult = await pool.query(
        `SELECT r.${reviewMap.reviewedUserId} as reviewed_user_id,
              ${
                reviewMap.reviewerId ? `r.${reviewMap.reviewerId}` : "NULL"
              } as reviewer_id
       FROM user_reviews r
       WHERE r.id = $1`,
        [reviewId]
      );

      if (reviewResult.rows.length === 0) {
        return res.status(404).json({ error: "Review not found" });
      }

      const reviewedUserId = parseInt(reviewResult.rows[0].reviewed_user_id);
      if (reviewedUserId !== reporterId) {
        return res.status(403).json({
          error: "You can only report reviews left on your profile",
        });
      }

      const flagsPayload = JSON.stringify([
        {
          type: "user_reported",
          reason: String(reason).trim(),
          at: new Date().toISOString(),
        },
      ]);

      const updateParts = [
        `${reviewMap.fraudFlags} = COALESCE(${reviewMap.fraudFlags}, '[]'::jsonb) || $2::jsonb`,
      ];
      if (reviewColumns.has("updated_at")) {
        updateParts.push("updated_at = NOW()");
      }

      await pool.query(
        `UPDATE user_reviews
       SET ${updateParts.join(", ")}
       WHERE id = $1`,
        [reviewId, flagsPayload]
      );

      if (await tableExists("review_fraud_log")) {
        try {
          await pool.query(
            `INSERT INTO review_fraud_log (
            review_id, reviewer_id, reviewed_user_id,
            fraud_type, fraud_details, severity, action_taken, actioned_by, actioned_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [
              reviewId,
              reviewResult.rows[0].reviewer_id,
              reviewedUserId,
              "user_report",
              JSON.stringify({ reason: String(reason).trim() }),
              "medium",
              "flagged",
              reporterId,
            ]
          );
        } catch (logError) {
          console.error("Error logging review report:", logError);
        }
      }

      res.json({ message: "Review reported for moderation" });
    } catch (error) {
      console.error("Error reporting review:", error);
      res.status(500).json({ error: "Failed to report review" });
    }
  }
);

/**
 * GET /api/user/can-review/:userId
 * Check if current user can review another user
 */
router.get("/user/can-review/:userId", authMiddleware, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);
    const reviewerId = req.user.id;

    // Check reviewer's KYC status
    const reviewerKyc = await getReviewerKycStatus(reviewerId);

    if (!reviewerKyc.exists) {
      return res.json({ canReview: false, reason: "User not found" });
    }

    if (reviewerKyc.kycStatus !== "approved") {
      return res.json({
        canReview: false,
        reason: "KYC verification required",
        message: "Complete your KYC verification to leave reviews",
      });
    }

    // Check if already reviewed
    const existingReview = await pool.query(
      `SELECT id FROM user_reviews 
       WHERE reviewer_id = $1 AND reviewed_user_id = $2`,
      [reviewerId, targetUserId]
    );

    if (existingReview.rows.length > 0) {
      return res.json({
        canReview: false,
        reason: "Already reviewed",
        message: "You have already reviewed this user",
      });
    }

    // Cannot review self
    if (reviewerId === targetUserId) {
      return res.json({ canReview: false, reason: "Cannot review yourself" });
    }

    res.json({ canReview: true });
  } catch (error) {
    console.error("Error checking review eligibility:", error);
    res.status(500).json({ error: "Failed to check review eligibility" });
  }
});

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

/**
 * Admin middleware - check if user is admin
 */
const adminMiddleware = async (req, res, next) => {
  try {
    const adminToken = req.headers.authorization?.replace("Bearer ", "");
    if (!adminToken) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    const admin = await pool.query(
      `SELECT id, email FROM admins WHERE token = $1`,
      [adminToken]
    );

    if (admin.rows.length === 0) {
      return res.status(401).json({ error: "Invalid admin token" });
    }

    req.admin = admin.rows[0];
    next();
  } catch (error) {
    console.error("Admin auth error:", error);
    res.status(500).json({ error: "Authentication failed" });
  }
};

/**
 * POST /api/admin/user/:id/warning
 * Issue a warning to a user
 */
router.post("/admin/user/:id/warning", adminMiddleware, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const adminId = req.admin.id;
    const { warningType, reason, expiresInDays } = req.body;

    // Validate warning type
    const validTypes = ["minor", "moderate", "severe", "final"];
    if (!validTypes.includes(warningType)) {
      return res.status(400).json({ error: "Invalid warning type" });
    }

    if (!reason || reason.trim().length < 10) {
      return res
        .status(400)
        .json({ error: "Reason must be at least 10 characters" });
    }

    // Calculate points based on type
    const pointsMap = { minor: 5, moderate: 10, severe: 15, final: 20 };
    const pointsDeducted = pointsMap[warningType];

    // Calculate expiry
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    // Insert warning
    const result = await pool.query(
      `INSERT INTO user_warnings (user_id, admin_id, warning_type, reason, points_deducted, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [userId, adminId, warningType, reason.trim(), pointsDeducted, expiresAt]
    );

    res.status(201).json({
      message: "Warning issued successfully",
      warning: {
        id: result.rows[0].id,
        pointsDeducted,
        expiresAt,
        createdAt: result.rows[0].created_at,
      },
    });
  } catch (error) {
    console.error("Error issuing warning:", error);
    res.status(500).json({ error: "Failed to issue warning" });
  }
});

/**
 * GET /api/admin/reviews/flagged
 * Get flagged reviews for admin review
 */
router.get("/admin/reviews/flagged", adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const flagged = await pool.query(
      `SELECT 
        r.*,
        reviewer.name as reviewer_name,
        reviewer.email as reviewer_email,
        reviewer.kyc_status as reviewer_kyc,
        reviewed.name as reviewed_name,
        reviewed.email as reviewed_email,
        l.title as listing_title
       FROM user_reviews r
       JOIN users reviewer ON reviewer.id = r.reviewer_id
       JOIN users reviewed ON reviewed.id = r.reviewed_user_id
       LEFT JOIN listings l ON l.id = r.listing_id
       WHERE r.fraud_score >= 40 OR jsonb_array_length(r.fraud_flags) > 0
       ORDER BY r.fraud_score DESC, r.created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM user_reviews 
       WHERE fraud_score >= 40 OR jsonb_array_length(fraud_flags) > 0`
    );

    res.json({
      reviews: flagged.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(
          parseInt(countResult.rows[0].count) / parseInt(limit)
        ),
      },
    });
  } catch (error) {
    console.error("Error fetching flagged reviews:", error);
    res.status(500).json({ error: "Failed to fetch flagged reviews" });
  }
});

/**
 * PUT /api/admin/review/:id/verify
 * Verify a review
 */
router.put("/admin/review/:id/verify", adminMiddleware, async (req, res) => {
  try {
    const reviewId = parseInt(req.params.id);

    await pool.query(
      `UPDATE user_reviews 
       SET is_verified = true, verification_method = 'admin_verified', updated_at = NOW()
       WHERE id = $1`,
      [reviewId]
    );

    res.json({ message: "Review verified successfully" });
  } catch (error) {
    console.error("Error verifying review:", error);
    res.status(500).json({ error: "Failed to verify review" });
  }
});

/**
 * PUT /api/admin/review/:id/invalidate
 * Invalidate a suspicious review
 */
router.put(
  "/admin/review/:id/invalidate",
  adminMiddleware,
  async (req, res) => {
    try {
      const reviewId = parseInt(req.params.id);
      const { reason } = req.body;

      await pool.query(
        `UPDATE user_reviews 
       SET is_valid = false, 
           fraud_flags = fraud_flags || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
        [
          JSON.stringify([
            { type: "admin_invalidated", reason, at: new Date() },
          ]),
          reviewId,
        ]
      );

      // Log the action
      const review = await pool.query(
        `SELECT reviewer_id, reviewed_user_id FROM user_reviews WHERE id = $1`,
        [reviewId]
      );

      if (review.rows.length > 0) {
        await pool.query(
          `INSERT INTO review_fraud_log (
          review_id, reviewer_id, reviewed_user_id,
          fraud_type, fraud_details, severity, action_taken, actioned_by, actioned_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            reviewId,
            review.rows[0].reviewer_id,
            review.rows[0].reviewed_user_id,
            "admin_invalidation",
            JSON.stringify({ reason }),
            "high",
            "invalidated",
            req.admin.id,
          ]
        );
      }

      res.json({ message: "Review invalidated successfully" });
    } catch (error) {
      console.error("Error invalidating review:", error);
      res.status(500).json({ error: "Failed to invalidate review" });
    }
  }
);

/**
 * GET /api/admin/trust-scores
 * Get all users with their trust scores
 */
router.get("/admin/trust-scores", adminMiddleware, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      sortBy = "trust_score",
      order = "DESC",
    } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const validSortColumns = [
      "trust_score",
      "name",
      "createdat",
      "total_reviews",
    ];
    const sortColumn = validSortColumns.includes(sortBy)
      ? sortBy
      : "trust_score";
    const sortOrder = order.toUpperCase() === "ASC" ? "ASC" : "DESC";

    const users = await pool.query(
      `SELECT 
        id, name, email, trust_score, kyc_status, 
        can_leave_reviews, total_reviews, average_rating,
        createdat, trust_score_updated_at
       FROM users
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );

    const countResult = await pool.query(`SELECT COUNT(*) FROM users`);

    res.json({
      users: users.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(
          parseInt(countResult.rows[0].count) / parseInt(limit)
        ),
      },
    });
  } catch (error) {
    console.error("Error fetching trust scores:", error);
    res.status(500).json({ error: "Failed to fetch trust scores" });
  }
});

/**
 * POST /api/admin/user/:id/recalculate-trust-score
 * Force recalculate a user's trust score
 */
router.post(
  "/admin/user/:id/recalculate-trust-score",
  adminMiddleware,
  async (req, res) => {
    try {
      const userId = parseInt(req.params.id);

      // Try database function first
      try {
        await pool.query(
          `SELECT update_user_trust_score($1, 'admin_recalculation')`,
          [userId]
        );
      } catch {
        // Use JS fallback
        const { trustScore } = await calculateTrustScoreJS(userId);
        await pool.query(
          `UPDATE users SET trust_score = $1, trust_score_updated_at = NOW() WHERE id = $2`,
          [trustScore, userId]
        );
      }

      // Get updated score
      const result = await pool.query(
        `SELECT trust_score FROM users WHERE id = $1`,
        [userId]
      );

      res.json({
        message: "Trust score recalculated",
        newScore: result.rows[0]?.trust_score || 0,
      });
    } catch (error) {
      console.error("Error recalculating trust score:", error);
      res.status(500).json({ error: "Failed to recalculate trust score" });
    }
  }
);

export default router;
