/**
 * Njimbong AI Service
 * Powered by Google Gemini — the intelligence behind Njimbong Marketplace
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ── Utility ──────────────────────────────────────────────────────────────────
// Use v1 (stable) endpoint — gemini-2.5-flash is available there on free tier
const AI_REQUEST_OPTIONS = { apiVersion: "v1" };

function getClient() {
  // Read at call time so Railway env vars injected after module load still work
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

End every first response (if the user hasn't stated a specific need) with ONE brief, relevant question to better help them.`;

// ── Chat (streaming) ──────────────────────────────────────────────────────────
/**
 * Stream a Njimbong AI chat response via SSE.
 * @param {string} message - User's current message
 * @param {Array<{role: string, content: string}>} history - Previous turns
 * @param {string} pageContext - What page the user is on
 * @param {import('http').ServerResponse} res - Express response (SSE)
 */
export async function streamChatResponse(message, history, pageContext, res) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel(
    {
      model: "gemini-2.5-flash",
      systemInstruction:
        NJIMBONG_SYSTEM_PROMPT +
        (pageContext ? `\n\nCURRENT USER CONTEXT: ${pageContext}` : ""),
    },
    AI_REQUEST_OPTIONS,
  );

  // Convert history to Gemini format
  const geminiHistory = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const chat = model.startChat({ history: geminiHistory });

  const result = await chat.sendMessageStream(message);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

// ── Text Enhancement ──────────────────────────────────────────────────────────
/**
 * Improve a piece of text for a given context (listing description, chat message, dispute, etc.)
 * @param {string} text - Original text
 * @param {"listing_description"|"listing_title"|"chat_message"|"dispute"|"review"} context
 * @param {string} [extraContext] - Additional context (e.g., category name)
 * @returns {Promise<{enhanced: string, tips: string[]}>}
 */
export async function enhanceText(text, context, extraContext = "") {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, AI_REQUEST_OPTIONS);

  const contextPrompts = {
    listing_description: `You are an expert marketplace copywriter for Njimbong, a Cameroonian online marketplace. Rewrite the following product listing description to be more compelling, clear, and SEO-friendly. Keep it honest, highlight key features, mention condition if relevant, and make it easy to scan. Write for Cameroonian buyers. Return ONLY a JSON object with keys "enhanced" (the improved text) and "tips" (array of 2-3 brief improvement tips you made).`,
    listing_title: `You are an expert marketplace copywriter. Rewrite this product listing title to be clear, searchable, and compelling. Include brand name, model, and key spec if relevant. Max 80 characters. Cameroonian marketplace context. Return ONLY JSON with "enhanced" and "tips".`,
    chat_message: `Improve this marketplace chat message to be more professional, clear, and polite while keeping the original intent. Keep it concise. Return ONLY JSON with "enhanced" (improved message) and "tips" (1-2 brief notes).`,
    dispute: `Rewrite this dispute message to be professional, factual, and persuasive. Keep a neutral tone. Return ONLY JSON with "enhanced" and "tips".`,
    review: `Improve this review to be helpful, balanced, specific, and professional. Keep the original sentiment. Return ONLY JSON with "enhanced" and "tips".`,
  };

  const prompt = `${contextPrompts[context] || contextPrompts.listing_description}
${extraContext ? `\nExtra context: ${extraContext}` : ""}

Original text:
"${text}"

IMPORTANT: Return ONLY valid JSON, nothing else. No markdown. No explanation.`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();

  // Strip markdown code fences if present
  const clean = raw
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    // Fallback: return the raw text as-is
    return {
      enhanced: text,
      tips: ["AI enhancement not available at this time."],
    };
  }
}

// ── Listing Image Analysis ────────────────────────────────────────────────────
/**
 * Analyze a product image and suggest listing fields.
 * @param {Buffer} imageBuffer - Image buffer from multer
 * @param {string} mimeType - MIME type (e.g., "image/jpeg")
 * @param {Array<{id: number, name: string}>} categories - Available categories
 * @returns {Promise<{title, description, condition, categoryId, suggestedPrice, tags}>}
 */
export async function analyzeListingImage(imageBuffer, mimeType, categories) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, AI_REQUEST_OPTIONS);

  const categoryList = categories.map((c) => `${c.id}: ${c.name}`).join(", ");

  const prompt = `You are an expert marketplace listing assistant for Njimbong, a Cameroonian online marketplace.

Analyze this product image and extract listing details. Be specific and professional.

Available categories (id: name): ${categoryList}

Return ONLY a valid JSON object with these EXACT keys:
{
  "title": "Clear, specific product title (max 80 chars, include brand/model if visible)",
  "description": "Professional product description (3-5 sentences, mention visible features, condition, and any relevant specs). Slightly SEO-optimized for the Cameroonian market.",
  "condition": "new" or "like new" or "good" or "fair" or "poor",
  "categoryId": number (the best matching category id from the list above, or null if none fits),
  "suggestedPriceMin": number (minimum suggested price in XAF based on Cameroonian market, integer only),
  "suggestedPriceMax": number (maximum suggested price in XAF based on Cameroonian market, integer only),
  "tags": "comma-separated relevant keywords for search"
}

IMPORTANT: Return ONLY valid JSON. No markdown. No explanation outside the JSON.`;

  const imagePart = {
    inlineData: {
      data: imageBuffer.toString("base64"),
      mimeType,
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  const raw = result.response.text().trim();
  const clean = raw
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error("Could not parse AI response");
  }
}

// ── Chat Summarization ────────────────────────────────────────────────────────
/**
 * Summarize a chat conversation into a short, readable summary.
 * @param {Array<{sender_name: string, content: string, created_at: string}>} messages
 * @returns {Promise<{summary: string, keyPoints: string[], status: string}>}
 */
export async function summarizeConversation(messages) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, AI_REQUEST_OPTIONS);

  const transcript = messages
    .filter((m) => m.content && m.message_type === "text")
    .slice(-50) // Last 50 text messages
    .map((m) => `${m.sender_name}: ${m.content}`)
    .join("\n");

  if (!transcript.trim()) {
    return {
      summary: "No text messages to summarize.",
      keyPoints: [],
      status: "empty",
    };
  }

  const prompt = `You are summarizing a marketplace chat conversation for Njimbong platform. Be concise and professional.

Conversation:
${transcript}

Return ONLY valid JSON:
{
  "summary": "2-3 sentence summary of what was discussed and current status",
  "keyPoints": ["key point 1", "key point 2", "key point 3"],
  "status": "negotiating" or "agreed" or "inquiry" or "completed" or "disputed" or "other"
}

IMPORTANT: Return ONLY valid JSON. No markdown.`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();
  const clean = raw
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    return {
      summary: "Unable to generate summary at this time.",
      keyPoints: [],
      status: "other",
    };
  }
}

// ── Smart Search Suggestions ──────────────────────────────────────────────────
/**
 * Generate smart search suggestions based on a partial query.
 * @param {string} query - User's partial search query
 * @param {Array<{id: number, name: string}>} categories
 * @param {string[]} recentSearches - Recent search terms from the DB
 * @returns {Promise<{suggestions: string[], refinements: string[]}>}
 */
export async function getSearchSuggestions(
  query,
  categories,
  recentSearches = [],
) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, AI_REQUEST_OPTIONS);

  const categoryNames = categories.map((c) => c.name).join(", ");

  const prompt = `You are a smart search assistant for Njimbong, a Cameroonian online marketplace.

User is searching for: "${query}"
Available categories: ${categoryNames}
${recentSearches.length > 0 ? `Trending searches: ${recentSearches.slice(0, 5).join(", ")}` : ""}

Generate helpful search suggestions and refinements for this Cameroonian marketplace.

Return ONLY valid JSON:
{
  "suggestions": ["suggestion 1", "suggestion 2", "suggestion 3", "suggestion 4", "suggestion 5"],
  "refinements": ["more specific search term 1", "more specific search term 2", "more specific search term 3"]
}

Suggestions should be complete, specific search terms that might yield good results.
Refinements should be more targeted versions of the original query.
IMPORTANT: Return ONLY valid JSON. No markdown.`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();
  const clean = raw
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    return { suggestions: [], refinements: [] };
  }
}

// ── Visual Search ─────────────────────────────────────────────────────────────
/**
 * Analyze an image and extract search terms for visual search.
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @param {Array<{id: number, name: string}>} categories
 * @returns {Promise<{searchQuery: string, category: string|null, keywords: string[]}>}
 */
export async function analyzeImageForVisualSearch(
  imageBuffer,
  mimeType,
  categories,
) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, AI_REQUEST_OPTIONS);

  const categoryNames = categories.map((c) => c.name).join(", ");

  const prompt = `You are a visual search assistant for Njimbong, a Cameroonian online marketplace.

Analyze this image and identify what product/item is shown. Extract search terms that would help find this or similar items in an online marketplace.

Available categories: ${categoryNames}

Return ONLY valid JSON:
{
  "searchQuery": "the best single search query to find this item (2-5 words)",
  "category": "the most matching category name from the list, or null",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "productDescription": "one sentence describing what you see"
}

IMPORTANT: Return ONLY valid JSON. No markdown.`;

  const imagePart = {
    inlineData: {
      data: imageBuffer.toString("base64"),
      mimeType,
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  const raw = result.response.text().trim();
  const clean = raw
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error("Could not analyze image");
  }
}

// ── Generate SEO Listing Description ─────────────────────────────────────────
/**
 * Generate an SEO-optimized description for a listing.
 * @param {{title: string, category: string, condition: string, price: number, city: string}} listing
 * @returns {Promise<{description: string, seoTips: string[]}>}
 */
export async function generateSEODescription(listing) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, AI_REQUEST_OPTIONS);

  const prompt = `You are an SEO copywriter for Njimbong, Cameroon's premier online marketplace.

Write an SEO-optimized product listing description for:
- Title: ${listing.title}
- Category: ${listing.category}
- Condition: ${listing.condition}
- Price: ${listing.price} XAF
- City: ${listing.city}, Cameroon

The description should be:
- 4-6 sentences
- Include naturally placed keywords for search
- Mention condition, city, and price context
- Written for Cameroonian buyers
- Professional but accessible

Return ONLY valid JSON:
{
  "description": "the full SEO-optimized description",
  "seoTips": ["tip 1", "tip 2", "tip 3"]
}

IMPORTANT: Return ONLY valid JSON. No markdown.`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();
  const clean = raw
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    return { description: "", seoTips: [] };
  }
}


