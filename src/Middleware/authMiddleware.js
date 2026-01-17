import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";

export default function authMiddleware(req, res, next) {
  let token = null;

  console.log("=== Auth Middleware ===");
  console.log("Path:", req.path);
  console.log(
    "Authorization header:",
    req.headers.authorization
      ? req.headers.authorization.substring(0, 50) + "..."
      : "none"
  );
  console.log("Cookies:", req.cookies);

  // Check Authorization header FIRST (takes priority for admin requests)
  if (req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith("Bearer ") && authHeader.length > 7) {
      const bearerToken = authHeader.substring(7);
      // Only use if it's not "undefined" or empty
      if (
        bearerToken &&
        bearerToken !== "undefined" &&
        bearerToken !== "null"
      ) {
        token = bearerToken;
        console.log("Using token from Authorization header");
      }
    }
  }

  // Fall back to cookies if no valid Authorization header
  if (!token) {
    token = req.cookies.adminAuthToken || req.cookies.authToken;
    if (token) {
      console.log("Using token from cookies");
    }
  }

  if (!token) {
    console.log("No token found - returning 401");
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("Token decoded:", decoded);
    req.user = decoded;
    next();
  } catch (error) {
    console.log("Token verification failed:", error.message);
    return res.status(401).json({ message: "Unauthorized: Invalid token" });
  }
}
