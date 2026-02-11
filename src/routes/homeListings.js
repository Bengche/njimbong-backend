import express from "express";
const router = express.Router();
import db from "../db.js";

// Route to get home listings
router.get("/listings", (req, res) => {
  db.query(
    "SELECT * FROM userlistings ORDER BY random() LIMIT 10;",
    (err, result) => {
      if (err) {
        console.error("Error fetching home listings:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
      res.status(200).json(result.rows);
    },
  );
});
export default router;
