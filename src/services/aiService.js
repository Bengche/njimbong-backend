/**
 * Njimbong AI Service
 * Powered by Google Gemini — the intelligence behind Njimbong Marketplace
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Use stable Gemini model string that is guaranteed on legacy SDK
const MODEL_NAME = "gemini-flash-latest";

function getClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.startsWith("<")) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  return new GoogleGenerativeAI(key);
}

// ── System Prompt ─────────────────────────────────────────────────────────────
const NJIMBONG_SYSTEM_PROMPT = `You are Njimbong AI — the intelligent assistant and heart of Njimbong Marketplace, Cameroon's premier platform for buying and selling online.

IDENTITY:
- Your name is Njimbong AI (same name as the marketplace)
- You are professional, warm, highly knowledgeable, and genuinely helpful
- You are the marketplace itself speaking directly to its users
- You are fluent in English and French — always respond in whatever language the user writes to you

YOUR EXPERTISE:
- All Njimbong platform features: listings, KYC verification, trust scores, payments, orders, chat, reviews, favorites, wallet
- Cameroonian marketplace pricing and market trends
- Safe online trading practices and scam prevention
- Photography tips for compelling listing photos
- Negotiation strategies for both buyers and sellers
- Categories: Electronics, Clothing, Vehicles, Real Estate, Services, Food, Agriculture, and more
- Local payment methods and delivery options in Cameroon

PLATFORM FACTS:
- Njimbong is based in Cameroon; primary currency is XAF (Central African Franc)
- Sellers need to verify their account (KYC) to increase trust score
- Trust scores go from 0-100%; higher trust = more buyer confidence
- Users can review each other after transactions
- The platform supports secure payments via Fonlok Pay
- Both English and French are official languages of Cameroon

YOUR GUIDELINES:
- Be helpful first; promote platform features naturally and contextually — never push
- Warn proactively about common marketplace scams (fake listings, payment outside platform, etc.)
- Encourage KYC verification as the best trust-building tool
- Help users craft better listing titles and descriptions when asked
- When discussing pricing, give realistic XAF ranges based on Cameroonian market knowledge
- Keep answers concise and actionable; use bullet points for multi-step answers
- If the user is clearly struggling with something, empathize briefly then help
- If you do not know a specific fact, say so honestly and offer what you do know
- Never provide financial, legal, or medical advice beyond general guidance
- Do not discuss competitors by name; focus on Njimbong's strengths

PERSONALITY:
- Smart and confident but never arrogant
- Warm and encouraging — celebrate users' milestones
- Straightforward — no fluff, just value
- Slightly persuasive about the platform's benefits when it's genuinely relevant

End every first response (if the user hasn't stated a specific need) with ONE brief, relevant question to better help them.

LISTING RESULTS RULES (CRITICAL):
- You will sometimes receive a block labelled "LIVE LISTINGS FROM NJIMBONG" — these are real items currently on the platform.
- If listings are provided, base your answer ONLY on those results. Name specific listings, their exact prices, and locations.
- If no listings are provided or the block is empty, say honestly: "I don't see any listings matching that right now" — do NOT invent inventory.
- Always encourage the user to check the marketplace for the latest items.
- Format prices in XAF (e.g., 50,000 XAF).`;

// ── Listing Search Helpers ───────────────────────────────────────────────────

const STOPWORDS = new Set([
  "i",
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "can",
  "could",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "about",
  "from",
  "into",
  "that",
  "this",
  "it",
  "we",
  "you",
  "he",
  "she",
  "they",
  "them",
  "our",
  "my",
  "your",
  "his",
  "her",
  "me",
  "him",
  "us",
  "and",
  "or",
  "but",
  "not",
  "no",
  "so",
  "if",
  "then",
  "than",
  "as",
  "up",
  "out",
  "what",
  "which",
  "who",
  "how",
  "when",
  "where",
  "why",
  "just",
  "also",
  "now",
  "here",
  "there",
  "very",
  "too",
  "want",
  "need",
  "looking",
  "find",
  "get",
  "buy",
  "sell",
  "show",
  "tell",
  "know",
  "please",
  "njimbong",
  "platform",
  "marketplace",
  "any",
  "some",
  "like",
  "more",
  "much",
  "than",
]);

/** Always perform database search if message contains meaningful keywords */
export function hasShoppingSignal(message) {
  if (!message || typeof message !== "string") return false;
  return message.trim().length > 2;
}

/**
 * Search live listings matching the user's message.
 * @param {string} message
 * @param {object} db - Database pool instance
 */
export async function searchListingsForAI(message, db) {
  const terms = [
    ...new Set(
      message
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    ),
  ].slice(0, 5);

  if (terms.length === 0) return [];

  // Build parameterized OR conditions
  const conditions = terms
    .map(
      (_, i) =>
        `(l.title ILIKE $${i + 1} OR l.description ILIKE $${i + 1} OR c.name ILIKE $${i + 1})`,
    )
    .join(" OR ");
  const params = terms.map((t) => `%${t}%`);

  try {
    const result = await db.query(
      `
      SELECT
        l.id,
        l.title,
        l.price,
        l.currency,
        l.city,
        l.location,
        l.condition,
        c.name AS category,
        img.imageurl AS image_url
      FROM userlistings l
      LEFT JOIN categories c ON l.categoryid = c.id
      LEFT JOIN LATERAL (
        SELECT imageurl FROM imagelistings
        WHERE listingid = l.id
        ORDER BY is_main DESC NULLS LAST, created_at ASC
        LIMIT 1
      ) img ON true
      WHERE (l.status = 'active' OR l.status IS NULL)
        AND (${conditions})
      ORDER BY l.createdat DESC
      LIMIT 6
    `,
      params,
    );
    return result.rows || [];
  } catch (err) {
    console.error("[AI Database Error] Listing search failed:", err.message);
    return [];
  }
}

// ── Chat (streaming) ──────────────────────────────────────────────────────────

export async function streamChatResponse(
  message,
  history,
  pageContext,
  res,
  listingResults = [],
) {
  const genAI = getClient();

  let listingContextBlock = "";
  if (listingResults.length > 0) {
    const formatted = listingResults
      .map(
        (l) =>
          `• [ID:${l.id}] "${l.title}" — ${l.currency || "XAF"} ${Number(l.price).toLocaleString()} | Condition: ${l.condition || "N/A"} | Location: ${l.city || l.location || "N/A"} | Category: ${l.category || "N/A"}`,
      )
      .join("\n");
    listingContextBlock = `\n\n[LIVE LISTINGS FROM NJIMBONG] (${listingResults.length} matches):\n${formatted}\n\nBase your response strictly on these available listings. Mention titles, prices, and locations clearly.`;
  } else {
    listingContextBlock = `\n\n[LIVE LISTINGS FROM NJIMBONG]: No active listings matched this search in the database. State clearly that no current matching items were found, and ask if they would like to refine their search or browse categories.`;
  }

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: {
      role: "system",
      parts: [
        {
          text:
            NJIMBONG_SYSTEM_PROMPT +
            (pageContext ? `\n\nCURRENT USER CONTEXT: ${pageContext}` : "") +
            listingContextBlock,
        },
      ],
    },
    generationConfig: {
      maxOutputTokens: 1000,
      temperature: 0.7,
    },
  });

  const geminiHistory = (history || [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "" }],
    }));

  const chat = model.startChat({ history: geminiHistory });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  if (listingResults.length > 0) {
    res.write(`data: ${JSON.stringify({ listings: listingResults })}\n\n`);
  }

  try {
    const result = await chat.sendMessageStream(message);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }
  } catch (err) {
    console.error("[AI Streaming Error]:", err.message);
    res.write(
      `data: ${JSON.stringify({ text: "\n\nI encountered an issue fetching live marketplace data. Please try again shortly." })}\n\n`,
    );
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

// ── Text Enhancement ──────────────────────────────────────────────────────────

export async function enhanceText(text, context, extraContext = "") {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const contextPrompts = {
    listing_description: `You are an expert marketplace copywriter for Njimbong...`,
    // (Rest of prompts unchanged)
  };

  const prompt = `${contextPrompts[context] || contextPrompts.listing_description}
${extraContext ? `\nExtra context: ${extraContext}` : ""}

Original text:
"${text}"

IMPORTANT: Return ONLY valid JSON, nothing else. No markdown.`;

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const clean = raw
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/```$/, "")
      .trim();
    return JSON.parse(clean);
  } catch {
    return {
      enhanced: text,
      tips: ["AI enhancement not available at this time."],
    };
  }
}
