/**
 * Chat Routes
 * ============
 * Handles all chat-related API endpoints including:
 * - Conversations: list, create, archive, block
 * - Messages: send, receive, mark as read, delete
 * - Image uploads via Cloudinary
 * - Unread counts and typing indicators
 */

import express from "express";
import db from "../db.js";
import authMiddleware from "../Middleware/authMiddleware.js";
import { blockIfSuspended } from "../Middleware/suspensionMiddleware.js";
import cloudinary from "../storage/cloudinary.js";
import multer from "multer";

const router = express.Router();

const isMissingTableError = (error) => error?.code === "42P01";

// Configure multer for image uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Helper function to get conversation details
async function getConversationDetails(conversationId, userId) {
  const result = await db.query(
    `SELECT 
      c.id,
      c.listing_id,
      c.buyer_id,
      c.seller_id,
      c.last_message_preview,
      c.last_message_at,
      c.created_at,
      l.title as listing_title,
      CASE 
        WHEN c.buyer_id = $2 THEN s.id
        ELSE b.id
      END as other_user_id,
      CASE 
        WHEN c.buyer_id = $2 THEN s.name
        ELSE b.name
      END as other_user_name,
      CASE 
        WHEN c.buyer_id = $2 THEN s.profilepictureurl
        ELSE b.profilepictureurl
      END as other_user_picture
    FROM conversations c
    LEFT JOIN userlistings l ON c.listing_id = l.id
    LEFT JOIN users b ON c.buyer_id = b.id
    LEFT JOIN users s ON c.seller_id = s.id
    WHERE c.id = $1`,
    [conversationId, userId],
  );
  return result.rows[0];
}

// =====================================================
// GET: Get all conversations for current user
// =====================================================
router.get("/chat/conversations", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { archived = "false" } = req.query;

  try {
    const isArchived = archived === "true";

    const result = await db.query(
      `SELECT 
        c.id,
        c.listing_id,
        c.buyer_id,
        c.seller_id,
        c.last_message_preview,
        c.last_message_at,
        c.created_at,
        c.is_blocked_by_buyer,
        c.is_blocked_by_seller,
        -- Listing info
        l.title as listing_title,
        (SELECT imageurl FROM imagelistings WHERE listingid = l.id AND is_main = true LIMIT 1) as listing_image,
        l.price as listing_price,
        l.currency as listing_currency,
        -- Other participant info
        CASE 
          WHEN c.buyer_id = $1 THEN s.id
          ELSE b.id
        END as other_user_id,
        CASE 
          WHEN c.buyer_id = $1 THEN s.name
          ELSE b.name
        END as other_user_name,
        CASE 
          WHEN c.buyer_id = $1 THEN s.profilepictureurl
          ELSE b.profilepictureurl
        END as other_user_picture,
        CASE 
          WHEN c.buyer_id = $1 THEN s.verified
          ELSE b.verified
        END as other_user_verified,
        -- Unread count for current user
        (
          SELECT COUNT(*) FROM messages m 
          WHERE m.conversation_id = c.id 
          AND m.sender_id != $1 
          AND m.status != 'read'
          AND NOT m.is_deleted
        ) as unread_count,
        -- Is blocked
        CASE 
          WHEN c.buyer_id = $1 THEN c.is_blocked_by_buyer
          ELSE c.is_blocked_by_seller
        END as is_blocked_by_me,
        CASE 
          WHEN c.buyer_id = $1 THEN c.is_blocked_by_seller
          ELSE c.is_blocked_by_buyer
        END as is_blocked_by_other
      FROM conversations c
      LEFT JOIN userlistings l ON c.listing_id = l.id
      LEFT JOIN users b ON c.buyer_id = b.id
      LEFT JOIN users s ON c.seller_id = s.id
      WHERE (c.buyer_id = $1 OR c.seller_id = $1)
      AND (
        (c.buyer_id = $1 AND c.is_archived_buyer = $2) OR
        (c.seller_id = $1 AND c.is_archived_seller = $2)
      )
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC`,
      [userId, isArchived],
    );

    // Transform data to match frontend expected format
    const conversations = result.rows.map((row) => ({
      id: row.id,
      listing_id: row.listing_id,
      participant: {
        id: row.other_user_id,
        name: row.other_user_name,
        profile_picture: row.other_user_picture,
        verified: row.other_user_verified,
      },
      listing: row.listing_id
        ? {
            id: row.listing_id,
            title: row.listing_title,
            image: row.listing_image,
            price: row.listing_price,
            currency: row.listing_currency,
          }
        : null,
      last_message: row.last_message_preview
        ? {
            content: row.last_message_preview,
            created_at: row.last_message_at,
          }
        : null,
      unread_count: parseInt(row.unread_count) || 0,
      is_blocked_by_me: row.is_blocked_by_me,
      is_blocked_by_other: row.is_blocked_by_other,
      created_at: row.created_at,
      updated_at: row.last_message_at || row.created_at,
    }));

    res.json({ conversations });
  } catch (error) {
    if (isMissingTableError(error)) {
      return res.json({ conversations: [] });
    }
    console.error("Error fetching conversations:", error);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

// =====================================================
// GET: Get total unread count for current user
// =====================================================
router.get("/chat/unread-count", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT COUNT(*) as total_unread
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE (c.buyer_id = $1 OR c.seller_id = $1)
       AND m.sender_id != $1
       AND m.status != 'read'
       AND NOT m.is_deleted
       AND (
         (c.buyer_id = $1 AND NOT c.is_archived_buyer) OR
         (c.seller_id = $1 AND NOT c.is_archived_seller)
       )`,
      [userId],
    );

    res.json({ unreadCount: parseInt(result.rows[0].total_unread) || 0 });
  } catch (error) {
    if (isMissingTableError(error)) {
      return res.json({ unreadCount: 0 });
    }
    console.error("Error fetching unread count:", error);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// =====================================================
// POST: Start or get existing conversation with seller
// Supports both listing-based and direct user conversations
// =====================================================
router.post(
  "/chat/conversations",
  authMiddleware,
  blockIfSuspended,
  async (req, res) => {
    const buyerId = req.user.id;
    const { sellerId, listingId } = req.body;

    try {
      // Validate inputs - sellerId is always required
      if (!sellerId) {
        return res.status(400).json({ error: "Seller ID is required" });
      }

      // Can't chat with yourself
      if (buyerId === parseInt(sellerId)) {
        return res
          .status(400)
          .json({ error: "You cannot start a conversation with yourself" });
      }

      // Check if the other user exists
      const userCheck = await db.query(
        "SELECT id, name FROM users WHERE id = $1",
        [sellerId],
      );

      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      // If listingId is provided, validate it
      if (listingId) {
        const listingCheck = await db.query(
          "SELECT id, userid FROM userlistings WHERE id = $1",
          [listingId],
        );

        if (listingCheck.rows.length === 0) {
          return res.status(404).json({ error: "Listing not found" });
        }

        if (listingCheck.rows[0].userid !== parseInt(sellerId)) {
          return res
            .status(400)
            .json({ error: "Seller does not own this listing" });
        }

        // Check for existing conversation with this listing
        const existingConvo = await db.query(
          `SELECT id FROM conversations 
           WHERE listing_id = $1 AND buyer_id = $2 AND seller_id = $3`,
          [listingId, buyerId, sellerId],
        );

        if (existingConvo.rows.length > 0) {
          // Return existing conversation
          const convoDetails = await getConversationDetails(
            existingConvo.rows[0].id,
            buyerId,
          );
          return res.json({
            conversation: convoDetails,
            isNew: false,
          });
        }

        // Create new conversation with listing
        const newConvo = await db.query(
          `INSERT INTO conversations (listing_id, buyer_id, seller_id)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [listingId, buyerId, sellerId],
        );

        // Create system message for new conversation
        await db.query(
          `INSERT INTO messages (conversation_id, sender_id, message_type, content)
           VALUES ($1, $2, 'system', $3)`,
          [
            newConvo.rows[0].id,
            buyerId,
            "Conversation started about this listing",
          ],
        );

        // Send notification to seller
        await db.query(
          `INSERT INTO notifications (userid, type, title, message, link)
           VALUES ($1, 'message', 'New Message', $2, $3)`,
          [
            sellerId,
            `Someone is interested in your listing`,
            `/listing/${listingId}`,
          ],
        );

        const convoDetails = await getConversationDetails(
          newConvo.rows[0].id,
          buyerId,
        );
        return res.status(201).json({
          conversation: convoDetails,
          isNew: true,
        });
      } else {
        // Direct message without a listing
        // Check for any existing direct conversation between these users (no listing)
        const existingDirectConvo = await db.query(
          `SELECT id FROM conversations 
           WHERE listing_id IS NULL 
           AND ((buyer_id = $1 AND seller_id = $2) OR (buyer_id = $2 AND seller_id = $1))`,
          [buyerId, sellerId],
        );

        if (existingDirectConvo.rows.length > 0) {
          const convoDetails = await getConversationDetails(
            existingDirectConvo.rows[0].id,
            buyerId,
          );
          return res.json({
            conversation: convoDetails,
            isNew: false,
          });
        }

        // Create new direct conversation (no listing)
        const newConvo = await db.query(
          `INSERT INTO conversations (listing_id, buyer_id, seller_id)
           VALUES (NULL, $1, $2)
           RETURNING id`,
          [buyerId, sellerId],
        );

        // Create system message for new direct conversation
        await db.query(
          `INSERT INTO messages (conversation_id, sender_id, message_type, content)
           VALUES ($1, $2, 'system', $3)`,
          [newConvo.rows[0].id, buyerId, "Direct conversation started"],
        );

        // Send notification to the other user
        await db.query(
          `INSERT INTO notifications (userid, type, title, message, link)
           VALUES ($1, 'message', 'New Message', $2, $3)`,
          [sellerId, `Someone wants to chat with you`, `/chat`],
        );

        const convoDetails = await getConversationDetails(
          newConvo.rows[0].id,
          buyerId,
        );
        return res.status(201).json({
          conversation: convoDetails,
          isNew: true,
        });
      }
    } catch (error) {
      console.error("Error creating conversation:", error);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  },
);

// =====================================================
// GET: Get messages for a conversation
// =====================================================
router.get(
  "/chat/conversations/:conversationId/messages",
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { before, limit = 50 } = req.query;

    try {
      // Verify user is part of conversation
      const convoCheck = await db.query(
        "SELECT buyer_id, seller_id FROM conversations WHERE id = $1",
        [conversationId],
      );

      if (convoCheck.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { buyer_id, seller_id } = convoCheck.rows[0];
      if (buyer_id !== userId && seller_id !== userId) {
        return res
          .status(403)
          .json({ error: "You are not part of this conversation" });
      }

      // Build query for messages
      let query = `
        SELECT 
          m.id,
          m.sender_id,
          m.message_type,
          m.content,
          m.image_url,
          m.image_thumbnail_url,
          m.status,
          m.is_edited,
          m.is_deleted,
          m.reply_to_id,
          m.created_at,
          m.read_at,
          u.name as sender_name,
          u.profilepictureurl as sender_picture,
          -- Reply preview
          rm.content as reply_to_content,
          rm.message_type as reply_to_message_type,
          rm.image_url as reply_to_image_url,
          ru.name as reply_to_sender_name
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        LEFT JOIN messages rm ON m.reply_to_id = rm.id
        LEFT JOIN users ru ON rm.sender_id = ru.id
        WHERE m.conversation_id = $1
      `;

      const params = [conversationId];
      let paramIndex = 2;

      if (before) {
        query += ` AND m.id < $${paramIndex}`;
        params.push(before);
        paramIndex++;
      }

      query += ` ORDER BY m.created_at DESC LIMIT $${paramIndex}`;
      params.push(parseInt(limit));

      const result = await db.query(query, params);

      // Mark messages as read
      await db.query(
        `UPDATE messages 
         SET status = 'read', read_at = CURRENT_TIMESTAMP
         WHERE conversation_id = $1 
         AND sender_id != $2 
         AND status != 'read'`,
        [conversationId, userId],
      );

      res.json({
        messages: result.rows.reverse(), // Return in chronological order
        hasMore: result.rows.length === parseInt(limit),
      });
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  },
);

// =====================================================
// POST: Send a text message
// =====================================================
router.post(
  "/chat/conversations/:conversationId/messages",
  authMiddleware,
  blockIfSuspended,
  async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { content, replyToId } = req.body;

    try {
      // Validate content
      if (!content || content.trim().length === 0) {
        return res.status(400).json({ error: "Message content is required" });
      }

      if (content.length > 5000) {
        return res
          .status(400)
          .json({ error: "Message too long (max 5000 characters)" });
      }

      // Verify user is part of conversation and not blocked
      const convoCheck = await db.query(
        `SELECT buyer_id, seller_id, is_blocked_by_buyer, is_blocked_by_seller 
         FROM conversations WHERE id = $1`,
        [conversationId],
      );

      if (convoCheck.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { buyer_id, seller_id, is_blocked_by_buyer, is_blocked_by_seller } =
        convoCheck.rows[0];

      if (buyer_id !== userId && seller_id !== userId) {
        return res
          .status(403)
          .json({ error: "You are not part of this conversation" });
      }

      // Check if blocked
      if (
        (buyer_id === userId && is_blocked_by_seller) ||
        (seller_id === userId && is_blocked_by_buyer)
      ) {
        return res
          .status(403)
          .json({ error: "You cannot send messages in this conversation" });
      }

      // Insert message
      const result = await db.query(
        `INSERT INTO messages (conversation_id, sender_id, message_type, content, reply_to_id)
         VALUES ($1, $2, 'text', $3, $4)
         RETURNING id, conversation_id, sender_id, message_type, content, status, created_at, reply_to_id`,
        [conversationId, userId, content.trim(), replyToId || null],
      );

      const msg = result.rows[0];

      // Get sender info for the response
      const senderResult = await db.query(
        `SELECT name, profilepictureurl FROM users WHERE id = $1`,
        [userId],
      );
      const sender = senderResult.rows[0];

      // Get reply message info if replying
      let replyInfo = null;
      if (msg.reply_to_id) {
        const replyResult = await db.query(
          `SELECT m.id, m.content, m.message_type, m.image_url, u.name as sender_name
           FROM messages m
           JOIN users u ON m.sender_id = u.id
           WHERE m.id = $1`,
          [msg.reply_to_id],
        );
        if (replyResult.rows[0]) {
          replyInfo = replyResult.rows[0];
        }
      }

      // Get other user for notification
      const otherUserId = buyer_id === userId ? seller_id : buyer_id;

      // Send notification (wrapped in try-catch in case notifications table doesn't exist)
      try {
        await db.query(
          `INSERT INTO notifications (userid, type, title, message, link)
           VALUES ($1, 'message', 'New Message', $2, $3)`,
          [
            otherUserId,
            `You have a new message`,
            `/chat?conversation=${conversationId}`,
          ],
        );
      } catch (notifErr) {
        console.log("Could not create notification:", notifErr.message);
      }

      // Update conversation's last message
      try {
        await db.query(
          `UPDATE conversations 
           SET last_message_id = $1, last_message_at = $2, last_message_preview = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [
            msg.id,
            msg.created_at,
            content.trim().substring(0, 100),
            conversationId,
          ],
        );
      } catch (updateErr) {
        console.log("Could not update conversation:", updateErr.message);
      }

      // Return message in the format frontend expects
      res.status(201).json({
        message: {
          id: msg.id,
          conversation_id: msg.conversation_id,
          sender_id: msg.sender_id,
          message_type: msg.message_type,
          content: msg.content,
          image_url: null,
          status: msg.status || "sent",
          created_at: msg.created_at,
          sender_name: sender?.name || "Unknown",
          sender_picture: sender?.profilepictureurl || null,
          is_mine: true,
          reply_to_id: msg.reply_to_id || null,
          reply_to_content: replyInfo?.content || null,
          reply_to_sender_name: replyInfo?.sender_name || null,
          reply_to_message_type: replyInfo?.message_type || null,
          reply_to_image_url: replyInfo?.image_url || null,
        },
      });
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  },
);

// =====================================================
// POST: Send an image message
// =====================================================
router.post(
  "/chat/conversations/:conversationId/images",
  authMiddleware,
  blockIfSuspended,
  upload.single("image"),
  async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { caption } = req.body;

    try {
      if (!req.file) {
        return res.status(400).json({ error: "Image file is required" });
      }

      // Verify user is part of conversation and not blocked
      const convoCheck = await db.query(
        `SELECT buyer_id, seller_id, is_blocked_by_buyer, is_blocked_by_seller 
         FROM conversations WHERE id = $1`,
        [conversationId],
      );

      if (convoCheck.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { buyer_id, seller_id, is_blocked_by_buyer, is_blocked_by_seller } =
        convoCheck.rows[0];

      if (buyer_id !== userId && seller_id !== userId) {
        return res
          .status(403)
          .json({ error: "You are not part of this conversation" });
      }

      if (
        (buyer_id === userId && is_blocked_by_seller) ||
        (seller_id === userId && is_blocked_by_buyer)
      ) {
        return res
          .status(403)
          .json({ error: "You cannot send messages in this conversation" });
      }

      // Upload to Cloudinary
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "marketplace/chat",
            resource_type: "image",
            transformation: [{ quality: "auto", fetch_format: "auto" }],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          },
        );

        stream.end(req.file.buffer);
      });

      // Generate thumbnail URL
      const thumbnailUrl = uploadResult.secure_url.replace(
        "/upload/",
        "/upload/c_thumb,w_200,h_200/",
      );

      // Insert message
      const result = await db.query(
        `INSERT INTO messages (conversation_id, sender_id, message_type, content, image_url, image_thumbnail_url)
         VALUES ($1, $2, 'image', $3, $4, $5)
         RETURNING id, created_at`,
        [
          conversationId,
          userId,
          caption || null,
          uploadResult.secure_url,
          thumbnailUrl,
        ],
      );

      const message = result.rows[0];

      // Get sender info for the response
      const senderResult = await db.query(
        `SELECT name, profilepictureurl FROM users WHERE id = $1`,
        [userId],
      );
      const sender = senderResult.rows[0];

      // Get other user for notification
      const otherUserId = buyer_id === userId ? seller_id : buyer_id;

      // Send notification (wrapped in try-catch in case notifications table doesn't exist)
      try {
        await db.query(
          `INSERT INTO notifications (userid, type, title, message, link)
           VALUES ($1, 'message', 'New Message', $2, $3)`,
          [
            otherUserId,
            `You received a photo`,
            `/chat?conversation=${conversationId}`,
          ],
        );
      } catch (notifErr) {
        console.log("Could not create notification:", notifErr.message);
      }

      // Update conversation's last message
      try {
        await db.query(
          `UPDATE conversations 
           SET last_message_id = $1, last_message_at = $2, last_message_preview = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [message.id, message.created_at, "📷 Photo", conversationId],
        );
      } catch (updateErr) {
        console.log("Could not update conversation:", updateErr.message);
      }

      res.status(201).json({
        message: {
          id: message.id,
          conversation_id: parseInt(conversationId),
          sender_id: userId,
          message_type: "image",
          content: caption || null,
          image_url: uploadResult.secure_url,
          image_thumbnail_url: thumbnailUrl,
          created_at: message.created_at,
          status: "sent",
          sender_name: sender?.name || "Unknown",
          sender_picture: sender?.profilepictureurl || null,
          is_mine: true,
        },
      });
    } catch (error) {
      console.error("Error sending image:", error);
      res.status(500).json({ error: "Failed to send image" });
    }
  },
);

// =====================================================
// PUT: Mark messages as read
// =====================================================
router.put(
  "/chat/conversations/:conversationId/read",
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;

    try {
      // Verify user is part of conversation
      const convoCheck = await db.query(
        "SELECT buyer_id, seller_id FROM conversations WHERE id = $1",
        [conversationId],
      );

      if (convoCheck.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { buyer_id, seller_id } = convoCheck.rows[0];
      if (buyer_id !== userId && seller_id !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Mark all unread messages from other user as read and return their IDs with read_at
      const result = await db.query(
        `UPDATE messages 
         SET status = 'read', read_at = CURRENT_TIMESTAMP
         WHERE conversation_id = $1 
         AND sender_id != $2 
         AND status != 'read'
         RETURNING id, read_at`,
        [conversationId, userId],
      );

      // Return the IDs of messages that were marked as read
      res.json({
        markedAsRead: result.rows.length,
        messageIds: result.rows.map((r) => r.id),
        readAt: result.rows.length > 0 ? result.rows[0].read_at : null,
      });
    } catch (error) {
      console.error("Error marking messages as read:", error);
      res.status(500).json({ error: "Failed to mark messages as read" });
    }
  },
);

// =====================================================
// GET: Get read receipts for messages in a conversation
// This endpoint is used by the sender to check if their messages have been read
// =====================================================
router.get(
  "/chat/conversations/:conversationId/read-receipts",
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;

    try {
      // Verify user is part of conversation
      const convoCheck = await db.query(
        "SELECT buyer_id, seller_id FROM conversations WHERE id = $1",
        [conversationId],
      );

      if (convoCheck.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { buyer_id, seller_id } = convoCheck.rows[0];
      if (buyer_id !== userId && seller_id !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Get read status of messages sent by the current user
      const result = await db.query(
        `SELECT id, status, read_at, delivered_at
         FROM messages 
         WHERE conversation_id = $1 
         AND sender_id = $2
         AND NOT is_deleted
         ORDER BY created_at DESC
         LIMIT 100`,
        [conversationId, userId],
      );

      // Get the ID of the last message that was read
      const lastReadMessage = result.rows.find((m) => m.status === "read");

      res.json({
        receipts: result.rows.map((r) => ({
          id: r.id,
          status: r.status,
          read_at: r.read_at,
          delivered_at: r.delivered_at,
        })),
        lastReadMessageId: lastReadMessage?.id || null,
        lastReadAt: lastReadMessage?.read_at || null,
      });
    } catch (error) {
      console.error("Error fetching read receipts:", error);
      res.status(500).json({ error: "Failed to fetch read receipts" });
    }
  },
);

// =====================================================
// DELETE: Delete a message (soft delete)
// =====================================================
router.delete("/chat/messages/:messageId", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { messageId } = req.params;

  try {
    // Verify user owns the message
    const msgCheck = await db.query(
      "SELECT sender_id FROM messages WHERE id = $1",
      [messageId],
    );

    if (msgCheck.rows.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }

    if (msgCheck.rows[0].sender_id !== userId) {
      return res
        .status(403)
        .json({ error: "You can only delete your own messages" });
    }

    // Soft delete
    await db.query(
      `UPDATE messages 
         SET is_deleted = true, content = 'This message was deleted', image_url = NULL
         WHERE id = $1`,
      [messageId],
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting message:", error);
    res.status(500).json({ error: "Failed to delete message" });
  }
});

// =====================================================
// PUT: Archive/Unarchive conversation
// =====================================================
router.put(
  "/chat/conversations/:conversationId/archive",
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { archive = true } = req.body;

    try {
      // Verify user is part of conversation
      const convoCheck = await db.query(
        "SELECT buyer_id, seller_id FROM conversations WHERE id = $1",
        [conversationId],
      );

      if (convoCheck.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { buyer_id, seller_id } = convoCheck.rows[0];
      if (buyer_id !== userId && seller_id !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Update archive status for the user
      const column =
        buyer_id === userId ? "is_archived_buyer" : "is_archived_seller";
      await db.query(`UPDATE conversations SET ${column} = $1 WHERE id = $2`, [
        archive,
        conversationId,
      ]);

      res.json({ success: true, archived: archive });
    } catch (error) {
      console.error("Error archiving conversation:", error);
      res.status(500).json({ error: "Failed to archive conversation" });
    }
  },
);

// =====================================================
// PUT: Block/Unblock user in conversation
// =====================================================
router.put(
  "/chat/conversations/:conversationId/block",
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { block = true } = req.body;

    try {
      // Verify user is part of conversation
      const convoCheck = await db.query(
        "SELECT buyer_id, seller_id FROM conversations WHERE id = $1",
        [conversationId],
      );

      if (convoCheck.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { buyer_id, seller_id } = convoCheck.rows[0];
      if (buyer_id !== userId && seller_id !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Update block status for the user
      const column =
        buyer_id === userId ? "is_blocked_by_buyer" : "is_blocked_by_seller";
      await db.query(`UPDATE conversations SET ${column} = $1 WHERE id = $2`, [
        block,
        conversationId,
      ]);

      res.json({ success: true, blocked: block });
    } catch (error) {
      console.error("Error blocking user:", error);
      res.status(500).json({ error: "Failed to block user" });
    }
  },
);

// =====================================================
// GET: Get conversation details with messages
// =====================================================
router.get(
  "/chat/conversations/:conversationId",
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;

    try {
      // Get conversation details
      const result = await db.query(
        `SELECT 
          c.*,
          l.title as listing_title,
          l.price as listing_price,
          l.currency as listing_currency,
          (SELECT imageurl FROM imagelistings WHERE listingid = l.id AND is_main = true LIMIT 1) as listing_image,
          b.name as buyer_name,
          b.profilepictureurl as buyer_picture,
          b.verified as buyer_verified,
          s.name as seller_name,
          s.profilepictureurl as seller_picture,
          s.verified as seller_verified
        FROM conversations c
        LEFT JOIN userlistings l ON c.listing_id = l.id
        LEFT JOIN users b ON c.buyer_id = b.id
        LEFT JOIN users s ON c.seller_id = s.id
        WHERE c.id = $1`,
        [conversationId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const convo = result.rows[0];
      if (convo.buyer_id !== userId && convo.seller_id !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Format response to match frontend expectations
      const isUserBuyer = convo.buyer_id === userId;
      const conversation = {
        id: convo.id,
        buyer_id: convo.buyer_id,
        seller_id: convo.seller_id,
        listing_id: convo.listing_id,
        participant: {
          id: isUserBuyer ? convo.seller_id : convo.buyer_id,
          name: isUserBuyer ? convo.seller_name : convo.buyer_name,
          profile_picture: isUserBuyer
            ? convo.seller_picture
            : convo.buyer_picture,
          verified: isUserBuyer ? convo.seller_verified : convo.buyer_verified,
        },
        listing: convo.listing_id
          ? {
              id: convo.listing_id,
              title: convo.listing_title,
              price: convo.listing_price,
              currency: convo.listing_currency,
              image: convo.listing_image,
            }
          : null,
        is_blocked_by_me: isUserBuyer
          ? convo.is_blocked_by_buyer
          : convo.is_blocked_by_seller,
        is_blocked_by_other: isUserBuyer
          ? convo.is_blocked_by_seller
          : convo.is_blocked_by_buyer,
        status: "active",
        created_at: convo.created_at,
        updated_at: convo.updated_at,
      };

      // Also fetch messages for this conversation
      const messagesResult = await db.query(
        `SELECT 
          m.id,
          m.conversation_id,
          m.sender_id,
          m.message_type,
          m.content,
          m.image_url,
          m.image_thumbnail_url,
          m.status,
          m.is_edited,
          m.is_deleted,
          m.reply_to_id,
          m.created_at,
          m.read_at,
          u.name as sender_name,
          u.profilepictureurl as sender_picture
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.conversation_id = $1
        ORDER BY m.created_at DESC
        LIMIT 50`,
        [conversationId],
      );

      // Add is_mine flag to each message
      const messages = messagesResult.rows.map((msg) => ({
        ...msg,
        is_mine: msg.sender_id === userId,
      }));

      res.json({ conversation, messages });
    } catch (error) {
      console.error("Error fetching conversation:", error);
      res.status(500).json({ error: "Failed to fetch conversation" });
    }
  },
);

export default router;
