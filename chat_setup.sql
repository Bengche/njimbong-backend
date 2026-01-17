-- =====================================================
-- Chat System Database Schema
-- =====================================================
-- This schema implements a professional messaging system with:
-- - Conversations between users (linked to listings)
-- - Messages with text and image support
-- - Read receipts and typing indicators
-- - Message status tracking (sent, delivered, read)
-- =====================================================

-- Conversations table
-- Each conversation is linked to a listing and has two participants
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    listing_id INTEGER REFERENCES userlistings(id) ON DELETE SET NULL,
    buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Last message info for quick display
    last_message_id INTEGER,
    last_message_at TIMESTAMP,
    last_message_preview VARCHAR(100),
    
    -- Conversation status
    is_archived_buyer BOOLEAN DEFAULT FALSE,
    is_archived_seller BOOLEAN DEFAULT FALSE,
    is_blocked_by_buyer BOOLEAN DEFAULT FALSE,
    is_blocked_by_seller BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Ensure unique conversation per listing between two users
    UNIQUE(listing_id, buyer_id, seller_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Message content
    message_type VARCHAR(20) DEFAULT 'text', -- 'text', 'image', 'system'
    content TEXT,
    image_url TEXT,
    image_thumbnail_url TEXT,
    
    -- Message status
    status VARCHAR(20) DEFAULT 'sent', -- 'sent', 'delivered', 'read'
    is_edited BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    
    -- For replies
    reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP
);

-- Add foreign key for last_message_id after messages table is created
ALTER TABLE conversations 
    DROP CONSTRAINT IF EXISTS fk_last_message;
ALTER TABLE conversations 
    ADD CONSTRAINT fk_last_message 
    FOREIGN KEY (last_message_id) 
    REFERENCES messages(id) 
    ON DELETE SET NULL;

-- Message read status per user (for group chats in future)
CREATE TABLE IF NOT EXISTS message_read_status (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id)
);

-- Typing indicators (ephemeral, but useful for real-time updates)
CREATE TABLE IF NOT EXISTS typing_indicators (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, user_id)
);

-- User chat preferences
CREATE TABLE IF NOT EXISTS chat_preferences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    
    -- Notification settings
    email_notifications BOOLEAN DEFAULT TRUE,
    push_notifications BOOLEAN DEFAULT TRUE,
    sound_enabled BOOLEAN DEFAULT TRUE,
    
    -- Privacy settings
    read_receipts_enabled BOOLEAN DEFAULT TRUE,
    online_status_visible BOOLEAN DEFAULT TRUE,
    
    -- Auto-reply
    auto_reply_enabled BOOLEAN DEFAULT FALSE,
    auto_reply_message TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- Indexes for Performance
-- =====================================================

-- Conversation indexes
CREATE INDEX IF NOT EXISTS idx_conversations_buyer 
    ON conversations(buyer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_seller 
    ON conversations(seller_id);
CREATE INDEX IF NOT EXISTS idx_conversations_listing 
    ON conversations(listing_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message 
    ON conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_buyer_active 
    ON conversations(buyer_id) WHERE is_archived_buyer = FALSE;
CREATE INDEX IF NOT EXISTS idx_conversations_seller_active 
    ON conversations(seller_id) WHERE is_archived_seller = FALSE;

-- Message indexes
CREATE INDEX IF NOT EXISTS idx_messages_conversation 
    ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender 
    ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created 
    ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created 
    ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread 
    ON messages(conversation_id, status) WHERE status != 'read';

-- Read status indexes
CREATE INDEX IF NOT EXISTS idx_read_status_message 
    ON message_read_status(message_id);
CREATE INDEX IF NOT EXISTS idx_read_status_user 
    ON message_read_status(user_id);

-- =====================================================
-- Helper Functions
-- =====================================================

-- Function to update conversation last message
CREATE OR REPLACE FUNCTION update_conversation_last_message()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE conversations 
    SET 
        last_message_id = NEW.id,
        last_message_at = NEW.created_at,
        last_message_preview = LEFT(
            CASE 
                WHEN NEW.message_type = 'image' THEN '📷 Photo'
                WHEN NEW.message_type = 'system' THEN NEW.content
                ELSE NEW.content
            END, 
            100
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updating last message
DROP TRIGGER IF EXISTS trigger_update_last_message ON messages;
CREATE TRIGGER trigger_update_last_message
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_conversation_last_message();

-- Function to clean up old typing indicators (older than 10 seconds)
CREATE OR REPLACE FUNCTION cleanup_typing_indicators()
RETURNS void AS $$
BEGIN
    DELETE FROM typing_indicators 
    WHERE started_at < CURRENT_TIMESTAMP - INTERVAL '10 seconds';
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- Views for Common Queries
-- =====================================================

-- View for unread message counts per conversation for a user
CREATE OR REPLACE VIEW user_unread_counts AS
SELECT 
    c.id as conversation_id,
    c.buyer_id,
    c.seller_id,
    COUNT(m.id) FILTER (
        WHERE m.sender_id != c.buyer_id 
        AND m.status != 'read'
        AND NOT m.is_deleted
    ) as unread_for_buyer,
    COUNT(m.id) FILTER (
        WHERE m.sender_id != c.seller_id 
        AND m.status != 'read'
        AND NOT m.is_deleted
    ) as unread_for_seller
FROM conversations c
LEFT JOIN messages m ON m.conversation_id = c.id
GROUP BY c.id, c.buyer_id, c.seller_id;

-- =====================================================
-- Sample Data (Optional - for testing)
-- =====================================================

-- You can uncomment these for testing
/*
INSERT INTO conversations (listing_id, buyer_id, seller_id) 
VALUES (1, 2, 1) 
ON CONFLICT DO NOTHING;
*/

-- =====================================================
-- Verification
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE 'Chat system tables created successfully!';
    RAISE NOTICE 'Tables: conversations, messages, message_read_status, typing_indicators, chat_preferences';
END $$;
