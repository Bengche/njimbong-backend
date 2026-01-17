import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";

export default function authMiddleware(req, res, next) {
  let token = null;
  const debugAuth =
    process.env.NODE_ENV !== "production" && process.env.DEBUG_AUTH === "true";
  if (debugAuth) {
    console.log("=== Auth Middleware ===");
    console.log("Path:", req.path);
    console.log("Has Authorization header:", Boolean(req.headers.authorization));
    console.log("Has auth cookies:", Boolean(req.cookies?.authToken));
    console.log("Has admin cookies:", Boolean(req.cookies?.adminAuthToken));
  }

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
        if (debugAuth) {
          console.log("Using token from Authorization header");
        }
      }
    }
  }

  // Fall back to cookies if no valid Authorization header
  if (!token) {
    token = req.cookies.adminAuthToken || req.cookies.authToken;
    if (token) {
      if (debugAuth) {
        console.log("Using token from cookies");
      }
    }
  }

  if (!token) {
    if (debugAuth) {
      console.log("No token found - returning 401");
    }
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (debugAuth) {
      console.log("Token verified");
    }
    req.user = decoded;
    next();
  } catch (error) {
    if (debugAuth) {
      console.log("Token verification failed:", error.message);
    }
    return res.status(401).json({ message: "Unauthorized: Invalid token" });
  }
}
