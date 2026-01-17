-- =====================================================
-- Admin Broadcast System Setup
-- =====================================================

-- Admin broadcasts log table
CREATE TABLE IF NOT EXISTS admin_broadcasts (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'announcement',
    priority VARCHAR(20) DEFAULT 'normal',
    recipients_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_admin_broadcasts_created_at ON admin_broadcasts(created_at DESC);

-- Grant permissions if needed
GRANT ALL ON admin_broadcasts TO postgres;
GRANT USAGE, SELECT ON SEQUENCE admin_broadcasts_id_seq TO postgres;

-- Verify the notifications table has the relatedtype column for broadcasts
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'notifications' AND column_name = 'relatedtype'
    ) THEN
        ALTER TABLE notifications ADD COLUMN relatedtype VARCHAR(50);
    END IF;
END $$;

-- Success message
SELECT 'Admin broadcast system setup complete!' as status;
