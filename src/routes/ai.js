/**
 * Njimbong AI Routes
 * All AI-powered endpoints for the marketplace
 */
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import {
  streamChatResponse,
  enhanceText,
  analyzeListingImage,
  summarizeConversation,
  getSearchSuggestions,
  analyzeImageForVisualSearch,
  generateSEODescription,
} from "../services/aiService.js";

const router = express.Router();

// ── Multer for AI image uploads (up to 10MB) ──────────────────────────────────
const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    cb(new Error("Only image files are allowed"));
  },
});

// ── AI-specific rate limiter ──────────────────────────────────────────────────
const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI requests. Please slow down a moment." },
  keyGenerator: (req) => req.ip + (req.user?.id || "anon"),
});

const imageAiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many image analysis requests. Please wait a moment." },
  keyGenerator: (req) => req.ip + (req.user?.id || "anon"),
});

// ── Guard: check if AI is configured ─────────────────────────────────────────
const requireAI = (req, res, next) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.startsWith("<")) {
    return res.status(503).json({
      error:
        "Njimbong AI is not configured. Please add a valid GEMINI_API_KEY to your environment.",
    });
  }
  next();
};

// ── Diagnostic: list available models for this key ───────────────────────────
router.get("/ai/models", requireAI, async (req, res) => {
  try {
    const key = process.env.GEMINI_API_KEY;
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1/models?key=${key}`,
    );
    const data = await r.json();
    const names = (data.models || []).map((m) => m.name);
    return res.json({ models: names, raw: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/chat — Stream a Njimbong AI chat response (SSE)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/ai/chat", requireAI, aiLimiter, async (req, res) => {
  const { message, history = [], pageContext = "" } = req.body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Message is required" });
  }

  if (message.length > 2000) {
    return res
      .status(400)
      .json({ error: "Message too long (max 2000 characters)" });
  }

  // Sanitize history (keep last 20 turns)
  const safeHistory = Array.isArray(history)
    ? history
        .filter(
          (m) =>
            m && typeof m.role === "string" && typeof m.content === "string",
        )
        .slice(-20)
    : [];

  try {
    await streamChatResponse(message.trim(), safeHistory, pageContext, res);
  } catch (err) {
    console.error("AI chat error:", err.message);
    if (!res.headersSent) {
      // Distinguish Gemini auth/quota errors from generic errors
      const msg = err.message || "";
      const isKeyError =
        msg.includes("API key") ||
        msg.includes("PERMISSION_DENIED") ||
        msg.includes("not configured") ||
        msg.includes("401") ||
        msg.includes("403");
      const isQuota =
        msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");
      return res.status(503).json({
        error: isKeyError
          ? "Njimbong AI is not configured. Please contact the administrator."
          : isQuota
            ? "Njimbong AI is over its request limit. Please try again in a minute."
            : "Njimbong AI is temporarily unavailable. Please try again.",
      });
    }
    // If headers already sent (SSE started), send error event
    res.write(
      `data: ${JSON.stringify({ error: "AI response interrupted." })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/enhance — Enhance a text field
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/ai/enhance",
  requireAI,
  authMiddleware,
  aiLimiter,
  async (req, res) => {
    const {
      text,
      context = "listing_description",
      extraContext = "",
    } = req.body;

    if (!text || typeof text !== "string" || text.trim().length < 5) {
      return res
        .status(400)
        .json({ error: "Text too short to enhance (min 5 characters)" });
    }

    if (text.length > 5000) {
      return res
        .status(400)
        .json({ error: "Text too long for enhancement (max 5000 characters)" });
    }

    const validContexts = [
      "listing_description",
      "listing_title",
      "chat_message",
      "dispute",
      "review",
    ];
    const safeContext = validContexts.includes(context)
      ? context
      : "listing_description";

    try {
      const result = await enhanceText(text.trim(), safeContext, extraContext);
      res.json(result);
    } catch (err) {
      console.error("AI enhance error:", err.message);
      res.status(500).json({ error: "Could not enhance text at this time." });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/analyze-listing-image — Analyze image → listing fields
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/ai/analyze-listing-image",
  requireAI,
  authMiddleware,
  imageAiLimiter,
  aiUpload.single("image"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No image provided" });
    }

    // Fetch categories from DB for matching
    let categories = [];
    try {
      const result = await db.query(
        "SELECT id, name FROM categories ORDER BY name ASC",
      );
      categories = result.rows;
    } catch (err) {
      console.error("Could not fetch categories for AI:", err.message);
    }

    try {
      const analysis = await analyzeListingImage(
        req.file.buffer,
        req.file.mimetype,
        categories,
      );
      res.json(analysis);
    } catch (err) {
      console.error("AI image analysis error:", err.message);
      res
        .status(500)
        .json({ error: "Could not analyze the image. Please try again." });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/summarize-chat — Summarize a conversation
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/ai/summarize-chat",
  requireAI,
  authMiddleware,
  aiLimiter,
  async (req, res) => {
    const { conversationId } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    // Fetch messages from DB (only messages the authenticated user can access)
    let messages = [];
    try {
      const result = await db.query(
        `SELECT m.content, m.message_type, m.created_at, u.name as sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = $1
         AND (c.buyer_id = $2 OR c.seller_id = $2)
         AND m.is_deleted = false
       ORDER BY m.created_at ASC
       LIMIT 100`,
        [conversationId, req.user.id],
      );
      messages = result.rows;
    } catch (err) {
      console.error("Could not fetch messages for summary:", err.message);
      return res.status(500).json({ error: "Could not load conversation." });
    }

    if (messages.length === 0) {
      return res.json({
        summary: "No messages yet.",
        keyPoints: [],
        status: "empty",
      });
    }

    try {
      const summary = await summarizeConversation(messages);
      res.json(summary);
    } catch (err) {
      console.error("AI summarize error:", err.message);
      res
        .status(500)
        .json({ error: "Could not generate summary at this time." });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai/search-suggestions — Smart search suggestions
// ─────────────────────────────────────────────────────────────────────────────
router.get("/ai/search-suggestions", requireAI, aiLimiter, async (req, res) => {
  const { query = "" } = req.query;

  if (!query || query.trim().length < 2) {
    return res.json({ suggestions: [], refinements: [] });
  }

  // Fetch categories + recent searches
  let categories = [];
  let recentSearches = [];
  try {
    const [catResult, searchResult] = await Promise.all([
      db.query("SELECT id, name FROM categories ORDER BY name ASC"),
      db
        .query(
          "SELECT query, COUNT(*) as cnt FROM search_logs GROUP BY query ORDER BY cnt DESC LIMIT 10",
        )
        .catch(() => ({ rows: [] })),
    ]);
    categories = catResult.rows;
    recentSearches = searchResult.rows.map((r) => r.query);
  } catch (err) {
    console.error("Could not fetch data for search suggestions:", err.message);
  }

  try {
    const suggestions = await getSearchSuggestions(
      query.trim(),
      categories,
      recentSearches,
    );
    res.json(suggestions);
  } catch (err) {
    console.error("AI search suggestions error:", err.message);
    res.status(500).json({ error: "Could not generate suggestions." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/visual-search — Upload image → search listings
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/ai/visual-search",
  requireAI,
  imageAiLimiter,
  aiUpload.single("image"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No image provided" });
    }

    let categories = [];
    try {
      const result = await db.query(
        "SELECT id, name FROM categories ORDER BY name ASC",
      );
      categories = result.rows;
    } catch (err) {
      console.error("Could not fetch categories:", err.message);
    }

    let searchData;
    try {
      searchData = await analyzeImageForVisualSearch(
        req.file.buffer,
        req.file.mimetype,
        categories,
      );
    } catch (err) {
      console.error("AI visual search analysis error:", err.message);
      return res.status(500).json({ error: "Could not analyze image." });
    }

    // Search listings using the AI-extracted keywords
    const terms = [searchData.searchQuery, ...(searchData.keywords || [])]
      .filter(Boolean)
      .join(" ");

    let listings = [];
    try {
      const searchWords = terms.split(/\s+/).filter((w) => w.length > 2);
      const tsQuery = searchWords.map((w) => `${w}:*`).join(" & ");

      const result = await db.query(
        `SELECT l.id, l.title, l.price, l.currency, l.city, l.country, l.condition, l.createdat,
                i.imageurl,
                c.name as category_name
         FROM userlistings l
         LEFT JOIN (
           SELECT DISTINCT ON (listingid) listingid, imageurl
           FROM imagelistings ORDER BY listingid, id ASC
         ) i ON i.listingid = l.id
         LEFT JOIN categories c ON c.id = l.category_id
         WHERE LOWER(l.moderation_status) = 'approved'
           AND (
             to_tsvector('english', COALESCE(l.title,'') || ' ' || COALESCE(l.description,'') || ' ' || COALESCE(l.tags,''))
             @@ to_tsquery('english', $1)
             OR l.title ILIKE $2
           )
         ORDER BY l.createdat DESC
         LIMIT 20`,
        [tsQuery, `%${searchData.searchQuery}%`],
      );
      listings = result.rows;
    } catch (err) {
      console.error("Visual search DB query error:", err.message);
      // Fallback: simple ILIKE search
      try {
        const fallback = await db.query(
          `SELECT l.id, l.title, l.price, l.currency, l.city, l.country, l.condition,
                  i.imageurl, c.name as category_name
           FROM userlistings l
           LEFT JOIN (
             SELECT DISTINCT ON (listingid) listingid, imageurl
             FROM imagelistings ORDER BY listingid, id ASC
           ) i ON i.listingid = l.id
           LEFT JOIN categories c ON c.id = l.category_id
           WHERE LOWER(l.moderation_status) = 'approved'
             AND l.title ILIKE $1
           ORDER BY l.createdat DESC
           LIMIT 20`,
          [`%${searchData.searchQuery}%`],
        );
        listings = fallback.rows;
      } catch {}
    }

    res.json({
      searchQuery: searchData.searchQuery,
      productDescription: searchData.productDescription,
      keywords: searchData.keywords,
      category: searchData.category,
      listings,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/seo-description — Generate SEO description
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/ai/seo-description",
  requireAI,
  authMiddleware,
  aiLimiter,
  async (req, res) => {
    const { title, category, condition, price, city } = req.body;

    if (!title) {
      return res.status(400).json({ error: "title is required" });
    }

    try {
      const result = await generateSEODescription({
        title,
        category,
        condition,
        price,
        city,
      });
      res.json(result);
    } catch (err) {
      console.error("AI SEO description error:", err.message);
      res.status(500).json({ error: "Could not generate SEO description." });
    }
  },
);

export default router;
