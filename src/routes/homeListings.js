import express from "express";
const router = express.Router();
import db from "../db.js";

// Home page carousel — latest 50 approved listings
router.get("/listings", (req, res) => {
  const query = `
    SELECT l.*, i.imageurl 
    FROM userlistings l
    LEFT JOIN (
      SELECT DISTINCT ON (listingid) listingid, imageurl 
      FROM imagelistings
    ) i ON l.id = i.listingid
    WHERE LOWER(l.moderation_status) = 'approved'
    ORDER BY l.createdat DESC
    LIMIT 50;
  `;

  db.query(query, (err, result) => {
    if (err) {
      console.error("Database Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.status(200).json(result.rows);
  });
});

// Paginated browse endpoint — GET /home/listings/browse?page=1&limit=10
router.get("/listings/browse", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 10;
  const offset = (page - 1) * limit;

  try {
    const [countRes, listingsRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM userlistings WHERE LOWER(moderation_status) = 'approved'`
      ),
      db.query(
        `SELECT l.*, i.imageurl 
         FROM userlistings l
         LEFT JOIN (
           SELECT DISTINCT ON (listingid) listingid, imageurl 
           FROM imagelistings
         ) i ON l.id = i.listingid
         WHERE LOWER(l.moderation_status) = 'approved'
         ORDER BY l.createdat DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
    ]);

    const total = parseInt(countRes.rows[0].count, 10);
    res.status(200).json({
      listings: listingsRes.rows,
      total,
      page,
      hasMore: offset + listingsRes.rows.length < total,
    });
  } catch (err) {
    console.error("Browse listings error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
