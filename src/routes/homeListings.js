import express from "express";
const router = express.Router();
import db from "../db.js";

// Route to get home listings
router.get("/listings", (req, res) => {
  // 1. Changed table name to 'imagelistings'
  // 2. Ensuring we use 'listingid' and 'imageurl' as you specified
  const query = `
    SELECT l.*, i.imageurl 
    FROM userlistings l
    LEFT JOIN (
      SELECT DISTINCT ON (listingid) listingid, imageurl 
      FROM imagelistings
    ) i ON l.id = i.listingid
    ORDER BY random() 
    LIMIT 10;
  `;

  db.query(query, (err, result) => {
    if (err) {
      console.error("Database Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.status(200).json(result.rows);
  });
});
export default router;
