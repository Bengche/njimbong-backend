-- =====================================================
-- LISTING MODERATION SYSTEM DATABASE SETUP
-- =====================================================
-- This script adds listing moderation capabilities
-- Run this after your main database setup
-- =====================================================

-- Add moderation_status column to userlistings if it doesn't exist
-- Possible values: 'pending', 'approved', 'rejected'
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'userlistings' 
    AND column_name = 'moderation_status'
  ) THEN
    ALTER TABLE userlistings ADD COLUMN moderation_status VARCHAR(20) DEFAULT 'pending';
  END IF;
  
  -- Add rejection_reason column for storing why a listing was rejected
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'userlistings' 
    AND column_name = 'rejection_reason'
  ) THEN
    ALTER TABLE userlistings ADD COLUMN rejection_reason TEXT;
  END IF;
  
  -- Add reviewed_by column to track which admin reviewed the listing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'userlistings' 
    AND column_name = 'reviewed_by'
  ) THEN
    ALTER TABLE userlistings ADD COLUMN reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  
  -- Add reviewed_at column to track when the listing was reviewed
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'userlistings' 
    AND column_name = 'reviewed_at'
  ) THEN
    ALTER TABLE userlistings ADD COLUMN reviewed_at TIMESTAMP;
  END IF;
END $$;

-- Create listing_reviews table for audit trail
-- This keeps a history of all moderation actions
CREATE TABLE IF NOT EXISTS listing_reviews (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES userlistings(id) ON DELETE CASCADE,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(20) NOT NULL, -- 'approved', 'rejected'
  reason TEXT, -- Reason for rejection (if applicable)
  notes TEXT, -- Admin notes
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_userlistings_moderation_status ON userlistings(moderation_status);
CREATE INDEX IF NOT EXISTS idx_userlistings_reviewed_by ON userlistings(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_listing_reviews_listing_id ON listing_reviews(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_reviews_admin_id ON listing_reviews(admin_id);

-- Update existing listings to 'approved' if they don't have a moderation_status
-- This ensures existing listings remain visible
UPDATE userlistings 
SET moderation_status = 'approved' 
WHERE moderation_status IS NULL;

-- Create a view for easy access to pending listings count
CREATE OR REPLACE VIEW pending_listings_count AS
SELECT COUNT(*) as count 
FROM userlistings 
WHERE moderation_status = 'pending';

-- Comments for future reference
COMMENT ON COLUMN userlistings.moderation_status IS 'Listing moderation status: pending, approved, rejected';
COMMENT ON COLUMN userlistings.rejection_reason IS 'Reason provided by admin when rejecting a listing';
COMMENT ON COLUMN userlistings.reviewed_by IS 'Admin user ID who reviewed the listing';
COMMENT ON COLUMN userlistings.reviewed_at IS 'Timestamp when the listing was reviewed';
COMMENT ON TABLE listing_reviews IS 'Audit trail of all listing moderation actions';
