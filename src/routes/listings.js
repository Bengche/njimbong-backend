import express from "express";
import db from "../db.js";
import cloudinary from "../storage/cloudinary.js";
import multer from "multer";
import authMiddleware from "../Middleware/authMiddleware.js";
import { blockIfSuspended } from "../Middleware/suspensionMiddleware.js";

const router = express.Router();

const getUserSuspensionSelect = async () => {
  const result = await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
  );
  const columns = new Set(result.rows.map((row) => row.column_name));
  return columns.has("is_suspended")
    ? "u.is_suspended as user_is_suspended"
    : "false as user_is_suspended";
};

// Configure multer for memory storage (we'll upload to Cloudinary)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Create a new listing with multiple images
// Suspended users cannot create listings
router.post(
  "/listings",
  authMiddleware,
  blockIfSuspended,
  upload.array("images", 10),
  async (req, res) => {
    const {
      title,
      description,
      price,
      currency,
      categoryId,
      location,
      country,
      city,
      condition,
      phone,
      tags,
      status,
    } = req.body;

    try {
      // Log incoming data for debugging
      console.log("Creating listing with data:", {
        userId: req.user?.id,
        title,
        description,
        price,
        currency,
        categoryId,
        location,
        country,
        city,
        condition,
        phone,
        tags,
        status,
        filesCount: req.files?.length,
      });

      // Validate required fields
      if (
        !title ||
        !description ||
        !price ||
        !categoryId ||
        !country ||
        !city ||
        !phone
      ) {
        console.log("Missing required fields check failed:", {
          title: !!title,
          description: !!description,
          price: !!price,
          categoryId: !!categoryId,
          country: !!country,
          city: !!city,
          phone: !!phone,
        });
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Get user ID from auth middleware
      const userId = req.user.id;

      // Insert the listing into the database first
      // Convert tags string to array if tags column is array type
      const tagsArray = tags
        ? tags
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag)
        : [];

      // New listings start with 'pending' moderation status
      const listingResult = await db.query(
        `INSERT INTO userlistings 
       (userid, title, description, price, currency, categoryid, location, country, city, condition, phone, tags, status, moderation_status, createdat) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()) 
       RETURNING *`,
        [
          userId,
          title,
          description,
          price,
          currency || "USD",
          categoryId,
          location || "",
          country,
          city,
          condition || "new",
          phone,
          tagsArray,
          status || "Available",
          "pending", // All new listings require admin approval
        ]
      );

      const listingId = listingResult.rows[0].id;

      // Upload images to Cloudinary and save to imagelistings table
      const uploadedImages = [];
      if (req.files && req.files.length > 0) {
        for (let i = 0; i < req.files.length; i++) {
          const file = req.files[i];
          try {
            // Upload to Cloudinary using buffer
            const result = await new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                {
                  folder: "marketplace/listings",
                  resource_type: "image",
                },
                (error, result) => {
                  if (error) reject(error);
                  else resolve(result);
                }
              );
              uploadStream.end(file.buffer);
            });

            // Insert into imagelistings table
            const imageResult = await db.query(
              `INSERT INTO imagelistings 
             (listingid, imageurl, is_main, created_at, updated_at) 
             VALUES ($1, $2, $3, NOW(), NOW()) 
             RETURNING *`,
              [listingId, result.secure_url, i === 0] // First image is main
            );

            uploadedImages.push(imageResult.rows[0]);
          } catch (uploadError) {
            console.error("Error uploading image to Cloudinary:", uploadError);
          }
        }
      }

      res.status(201).json({
        message: "Listing created successfully",
        listing: listingResult.rows[0],
        uploadedImages: uploadedImages.length,
        images: uploadedImages,
      });
    } catch (error) {
      console.error("Error creating listing:", error.message);
      console.error("Error details:", error);
      console.error("PostgreSQL error code:", error.code);
      console.error("PostgreSQL error detail:", error.detail);
      console.error("PostgreSQL error constraint:", error.constraint);
      res
        .status(500)
        .json({ error: "Failed to create listing", details: error.message });
    }
  }
);

// Get current user's listings (includes all moderation statuses)
router.get("/my-listings", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const listingsResult = await db.query(
      `SELECT l.*, c.name as category_name
       FROM userlistings l 
       LEFT JOIN categories c ON l.categoryid = c.id 
       WHERE l.userid = $1
       ORDER BY l.createdat DESC`,
      [userId]
    );

    // Fetch images for each listing
    const listingsWithImages = await Promise.all(
      listingsResult.rows.map(async (listing) => {
        const imagesResult = await db.query(
          `SELECT * FROM imagelistings 
           WHERE listingid = $1 
           ORDER BY is_main DESC`,
          [listing.id]
        );
        return {
          ...listing,
          images: imagesResult.rows,
        };
      })
    );

    res.status(200).json(listingsWithImages);
  } catch (error) {
    console.error("Error fetching user listings:", error);
    res.status(500).json({ error: "Failed to fetch your listings" });
  }
});

// Get all listings with images and filters
router.get("/listings", authMiddleware, async (req, res) => {
  try {
    const {
      category,
      search,
      country,
      city,
      minPrice,
      maxPrice,
      currency,
      condition,
    } = req.query;

    // Build dynamic query - include user's verification status and profile info
    // Only show approved and available (not sold) listings to the public
    // Include KYC verification status by joining with kyc_verifications table
    const userSuspensionSelect = await getUserSuspensionSelect();

    let queryText = `SELECT l.*, c.name as category_name, 
             u.id as user_id, u.name as username, u.verified as userverified, u.profilepictureurl as user_profile_picture,
             ${userSuspensionSelect},
             CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified
                     FROM userlistings l 
                     LEFT JOIN categories c ON l.categoryid = c.id 
                     LEFT JOIN users u ON l.userid = u.id
                     LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
                     WHERE l.moderation_status = 'approved' AND l.status = 'Available'`;
    const queryParams = [];
    let paramCount = 1;

    // Filter by category
    if (category) {
      queryText += ` AND l.categoryid = $${paramCount}`;
      queryParams.push(category);
      paramCount++;
    }

    // Filter by search term (title or description)
    if (search) {
      queryText += ` AND (LOWER(l.title) LIKE LOWER($${paramCount}) OR LOWER(l.description) LIKE LOWER($${paramCount}))`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    // Filter by country
    if (country) {
      queryText += ` AND LOWER(l.country) = LOWER($${paramCount})`;
      queryParams.push(country);
      paramCount++;
    }

    // Filter by city
    if (city) {
      queryText += ` AND LOWER(l.city) = LOWER($${paramCount})`;
      queryParams.push(city);
      paramCount++;
    }

    // Filter by minimum price
    if (minPrice) {
      queryText += ` AND l.price >= $${paramCount}`;
      queryParams.push(minPrice);
      paramCount++;
    }

    // Filter by maximum price
    if (maxPrice) {
      queryText += ` AND l.price <= $${paramCount}`;
      queryParams.push(maxPrice);
      paramCount++;
    }

    // Filter by currency
    if (currency) {
      queryText += ` AND l.currency = $${paramCount}`;
      queryParams.push(currency);
      paramCount++;
    }

    // Filter by condition
    if (condition) {
      queryText += ` AND l.condition = $${paramCount}`;
      queryParams.push(condition);
      paramCount++;
    }

    // Order by: Available listings first, then by creation date (newest first)
    queryText += ` ORDER BY 
      CASE WHEN l.status = 'Available' THEN 0 ELSE 1 END,
      l.createdat DESC`;

    const listingsResult = await db.query(queryText, queryParams);

    // Fetch images for each listing
    const listingsWithImages = await Promise.all(
      listingsResult.rows.map(async (listing) => {
        const imagesResult = await db.query(
          `SELECT * FROM imagelistings 
           WHERE listingid = $1 
           ORDER BY is_main DESC`,
          [listing.id]
        );
        return {
          ...listing,
          images: imagesResult.rows,
        };
      })
    );

    res.status(200).json(listingsWithImages);
  } catch (error) {
    console.error("Error fetching listings:", error.message);
    console.error("Error details:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch listings", details: error.message });
  }
});

// Get a single listing by ID with images
router.get("/listings/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const userSuspensionSelect = await getUserSuspensionSelect();

    const listingResult = await db.query(
      `SELECT l.*, c.name as categoryname, 
       u.id as user_id, u.name as username, u.verified as userverified, u.profilepictureurl as user_profile_picture,
       ${userSuspensionSelect},
       CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified
       FROM userlistings l 
       LEFT JOIN categories c ON l.categoryid = c.id 
       LEFT JOIN users u ON l.userid = u.id
       LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
       WHERE l.id = $1`,
      [id]
    );

    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const listing = listingResult.rows[0];

    // Fetch images for the listing
    const imagesResult = await db.query(
      `SELECT * FROM imagelistings 
       WHERE listingid = $1 
       ORDER BY is_main DESC`,
      [id]
    );

    res.status(200).json({
      ...listing,
      images: imagesResult.rows,
    });
  } catch (error) {
    console.error("Error fetching listing:", error);
    res.status(500).json({ error: "Failed to fetch listing" });
  }
});

// Get related listings based on category and tags
router.get("/listings/related/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    // First, get the current listing's category and tags
    const currentListing = await db.query(
      `SELECT categoryid, tags FROM userlistings WHERE id = $1`,
      [id]
    );

    if (currentListing.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const { categoryid, tags } = currentListing.rows[0];

    // Find related listings by category or similar tags
    // Only show approved listings
    let queryText = `
      SELECT l.*, c.name as categoryname, u.name as username, u.verified as userverified,
      CASE WHEN kyc.status = 'approved' THEN true ELSE false END as kyc_verified
      FROM userlistings l 
      LEFT JOIN categories c ON l.categoryid = c.id 
      LEFT JOIN users u ON l.userid = u.id
      LEFT JOIN kyc_verifications kyc ON u.id = kyc.userid AND kyc.status = 'approved'
      WHERE l.id != $1 
      AND l.status = 'Available'
      AND l.moderation_status = 'approved'
    `;

    const queryParams = [id];
    let paramCount = 2;

    // Add category filter if exists
    if (categoryid) {
      queryText += ` AND l.categoryid = $${paramCount}`;
      queryParams.push(categoryid);
      paramCount++;
    }

    queryText += ` LIMIT 8`;

    const relatedResult = await db.query(queryText, queryParams);

    // Fetch images for each related listing
    const relatedWithImages = await Promise.all(
      relatedResult.rows.map(async (listing) => {
        const imagesResult = await db.query(
          `SELECT * FROM imagelistings 
           WHERE listingid = $1 
           ORDER BY is_main DESC`,
          [listing.id]
        );
        return {
          ...listing,
          images: imagesResult.rows,
        };
      })
    );

    res.status(200).json(relatedWithImages);
  } catch (error) {
    console.error("Error fetching related listings:", error);
    res.status(500).json({ error: "Failed to fetch related listings" });
  }
});

// Mark listing as sold (only owner can do this)
router.put("/listings/:id/mark-sold", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Check if listing exists and belongs to the user
    const listingCheck = await db.query(
      "SELECT id, userid, status, title FROM userlistings WHERE id = $1",
      [id]
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const listing = listingCheck.rows[0];

    if (listing.userid !== userId) {
      return res
        .status(403)
        .json({ error: "You can only update your own listings" });
    }

    if (listing.status === "Sold") {
      return res
        .status(400)
        .json({ error: "Listing is already marked as sold" });
    }

    // Update the listing status to Sold
    const result = await db.query(
      `UPDATE userlistings 
       SET status = 'Sold', updatedat = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    res.status(200).json({
      message: "Listing marked as sold successfully",
      listing: result.rows[0],
    });
  } catch (error) {
    console.error("Error marking listing as sold:", error);
    res.status(500).json({ error: "Failed to mark listing as sold" });
  }
});

// Mark listing as available again (only owner can do this)
router.put("/listings/:id/mark-available", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Check if listing exists and belongs to the user
    const listingCheck = await db.query(
      "SELECT id, userid, status, title FROM userlistings WHERE id = $1",
      [id]
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const listing = listingCheck.rows[0];

    if (listing.userid !== userId) {
      return res
        .status(403)
        .json({ error: "You can only update your own listings" });
    }

    if (listing.status === "Available") {
      return res.status(400).json({ error: "Listing is already available" });
    }

    // Update the listing status to Available
    const result = await db.query(
      `UPDATE userlistings 
       SET status = 'Available', updatedat = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    res.status(200).json({
      message: "Listing marked as available successfully",
      listing: result.rows[0],
    });
  } catch (error) {
    console.error("Error marking listing as available:", error);
    res.status(500).json({ error: "Failed to mark listing as available" });
  }
});

export default router;
