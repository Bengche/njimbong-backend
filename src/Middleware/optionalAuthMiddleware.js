import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";

/**
 * Optional authentication middleware.
 * If a valid token is present, sets req.user and continues.
 * If no token or an invalid token is found, continues without setting req.user.
 * Never returns 401 — designed for public routes that benefit from user context
 * when available (e.g. listing detail: view-count tracking, personalisation).
 */
export default function optionalAuthMiddleware(req, _res, next) {
  let token = null;

  if (req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith("Bearer ") && authHeader.length > 7) {
      const bearerToken = authHeader.substring(7);
      if (bearerToken && bearerToken !== "undefined" && bearerToken !== "null") {
        token = bearerToken;
      }
    }
  }

  if (!token) {
    token = req.cookies?.adminAuthToken || req.cookies?.authToken || null;
  }

  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // Invalid / expired token — treat as unauthenticated, continue.
    }
  }

  next();
}
