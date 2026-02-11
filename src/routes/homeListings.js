import express from "express";
const router = express.Router();
import db from "../db.js";

// Route to get home listings
router.get("/listings", (req, res) => {
  const query = `
    SELECT l.*, i.imageurl 
    FROM userlistings l
    LEFT JOIN (
      SELECT DISTINCT ON (listingid) listingid, imageurl 
      FROM listing_images
    ) i ON l.id = i.listingid
    ORDER BY random() 
    LIMIT 10;
  `;

  db.query(query, (err, result) => {
    if (err) {
      console.error("Error fetching home listings:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
    res.status(200).json(result.rows);
  });
});
export default router;
