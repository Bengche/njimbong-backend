import db from "../db.js";
import express from "express";
import multer from "multer";
import bcrypt from "bcrypt";
import cloudinary from "../storage/cloudinary.js";

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

router.post("/signup", upload.single("profileImage"), async (req, res) => {
  const { name, username, email, phone, country, password } = req.body;

  try {
    let profilePictureUrl = null;

    // Upload profile picture to Cloudinary if provided
    if (req.file) {
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "marketplace/profile_pictures",
            transformation: [
              { width: 400, height: 400, crop: "fill", gravity: "face" },
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
      profilePictureUrl = uploadResult.secure_url;
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    await db.query(
      "INSERT INTO users (name, username, email, phone, country, passwordHash, profilePictureUrl, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())",
      [name, username, email, phone, country, passwordHash, profilePictureUrl]
    );
    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    console.error("Error adding user to database:", error.message);
    res.status(500).json({ message: "Database error" });
  }
});

export default router;
