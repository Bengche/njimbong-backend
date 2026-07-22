import express from "express";
import https from "https";
import http from "http";
import { URL } from "url";

const router = express.Router();

// Allowed CDN host suffixes — keeps this from becoming an open proxy
const ALLOWED_HOSTS = [".cloudinary.com", "cloudinary.com"];

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(h));
}

/**
 * GET /api/proxy-image?url=<encoded-url>
 *
 * Fetches an image server-side (no browser CORS restrictions) and pipes it
 * back to the client.  Restricted to Cloudinary CDN URLs to prevent open-proxy
 * abuse.  No auth required — the images are already public on Cloudinary.
 */
router.get("/proxy-image", async (req, res) => {
  const rawUrl = req.query.url;

  if (!rawUrl || typeof rawUrl !== "string") {
    return res.status(400).json({ error: "url query parameter is required." });
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: "url is not a valid URL." });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res
      .status(400)
      .json({ error: "Only http/https URLs are supported." });
  }

  if (!isAllowedHost(parsed.hostname)) {
    return res.status(403).json({
      error: "Only Cloudinary CDN URLs may be proxied.",
    });
  }

  const lib = parsed.protocol === "https:" ? https : http;

  try {
    await new Promise((resolve, reject) => {
      const request = lib.get(rawUrl, (upstream) => {
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
          upstream.resume(); // drain to free memory
          reject(new Error(`Upstream returned HTTP ${upstream.statusCode}`));
          return;
        }

        const contentType = upstream.headers["content-type"] || "image/jpeg";

        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=604800, immutable"); // 7 days
        res.set("Access-Control-Allow-Origin", "*");

        upstream.pipe(res);
        upstream.on("end", resolve);
        upstream.on("error", reject);
      });

      request.on("error", reject);
      request.setTimeout(10000, () => {
        request.destroy(new Error("Upstream request timed out"));
      });
    });
  } catch (err) {
    console.error("[proxy-image] Error:", err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to fetch image from upstream." });
    }
  }
});

export default router;
