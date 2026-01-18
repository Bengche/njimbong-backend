import express from "express";
import db from "../db.js";
import multer from "multer";
import cloudinary from "../storage/cloudinary.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import adminMiddleware from "../Middleware/adminMiddleware.js";

const router = express.Router();

// Configure multer for memory storage (we'll upload to Cloudinary)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Get all categories (public - no auth required)
router.get("/categories", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM categories ORDER BY sortoder ASC, name ASC"
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// Create a new category with optional image upload
router.post(
  "/categories",
  authMiddleware,
  adminMiddleware,
  upload.single("image"),
  async (req, res) => {
    const { name, slug, description, icon, imageurl, sortorder } = req.body;

    try {
      // Validate required fields
      if (!name) {
        return res.status(400).json({ error: "Category name is required" });
      }

      // Generate slug if not provided
      const categorySlug =
        slug ||
        name
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^\w-]/g, "");

      // Upload image to Cloudinary if provided
      let finalImageUrl = imageurl || null;
      if (req.file) {
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: "marketplace/categories",
              transformation: [
                { width: 400, height: 300, crop: "fill" },
                { quality: "auto" },
              ],
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(req.file.buffer);
        });
        finalImageUrl = uploadResult.secure_url;
      }

      const result = await db.query(
        `INSERT INTO categories (name, slug, description, icon, imageurl, sortoder, createdat) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) 
       RETURNING *`,
        [
          name,
          categorySlug,
          description || null,
          icon || null,
          finalImageUrl,
          sortorder || 0,
        ]
      );

      res.status(201).json({
        message: "Category created successfully",
        category: result.rows[0],
      });
    } catch (error) {
      console.error("Error creating category:", error);
      if (error.code === "23505") {
        // Unique constraint violation
        res.status(400).json({ error: "Category name or slug already exists" });
      } else {
        res.status(500).json({ error: "Failed to create category" });
      }
    }
  }
);

// Update a category with optional image upload
router.put(
  "/categories/:id",
  authMiddleware,
  adminMiddleware,
  upload.single("image"),
  async (req, res) => {
    const { id } = req.params;
    const { name, slug, description, icon, imageurl, sortorder } = req.body;

    try {
      // Upload new image to Cloudinary if provided
      let finalImageUrl = imageurl;
      if (req.file) {
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: "marketplace/categories",
              transformation: [
                { width: 400, height: 300, crop: "fill" },
                { quality: "auto" },
              ],
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(req.file.buffer);
        });
        finalImageUrl = uploadResult.secure_url;
      }

      const result = await db.query(
        `UPDATE categories 
       SET name = $1, slug = $2, description = $3, icon = $4, imageurl = $5, sortorder = $6
       WHERE id = $7 
       RETURNING *`,
        [name, slug, description, icon, finalImageUrl, sortorder || 0, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Category not found" });
      }

      res.status(200).json({
        message: "Category updated successfully",
        category: result.rows[0],
      });
    } catch (error) {
      console.error("Error updating category:", error);
      if (error.code === "23505") {
        res.status(400).json({ error: "Category name or slug already exists" });
      } else {
        res.status(500).json({ error: "Failed to update category" });
      }
    }
  }
);

// Delete a category
router.delete(
  "/categories/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      "DELETE FROM categories WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }

    res.status(200).json({
      message: "Category deleted successfully",
      category: result.rows[0],
    });
  } catch (error) {
    console.error("Error deleting category:", error);
    res.status(500).json({ error: "Failed to delete category" });
  }
  }
);

export default router;
