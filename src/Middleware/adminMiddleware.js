import dotenv from "dotenv";
import db from "../db.js";

dotenv.config();

const adminMiddleware = async (req, res, next) => {
  try {
    if (req.user?.isAdmin === true || req.user?.email === process.env.ADMIN_EMAIL) {
      return next();
    }

    if (req.user?.id) {
      const result = await db.query("SELECT role FROM users WHERE id = $1", [
        req.user.id,
      ]);

      if (result.rows.length > 0 && result.rows[0].role === "admin") {
        return next();
      }
    }

    return res.status(403).json({
      error: "Access denied. Admin privileges required.",
    });
  } catch (error) {
    console.error("Admin check error:", error);
    return res.status(500).json({ error: "Authorization check failed" });
  }
};

export default adminMiddleware;
