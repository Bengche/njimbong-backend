-- =====================================================
-- REPORTING & ACCOUNT MODERATION SYSTEM
-- =====================================================
-- This script creates tables for:
-- - Reporting listings and users
-- - Account suspensions
-- - Violation warnings
-- - Appeals system
-- =====================================================

-- Report reasons lookup table
CREATE TABLE IF NOT EXISTS report_reasons (
  id SERIAL PRIMARY KEY,
  category VARCHAR(50) NOT NULL, -- 'listing', 'user', 'both'
  reason VARCHAR(100) NOT NULL,
  description TEXT,
  severity INTEGER DEFAULT 1, -- 1=low, 2=medium, 3=high
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Insert default report reasons
INSERT INTO report_reasons (category, reason, description, severity) VALUES
  ('both', 'Spam', 'Repetitive or unsolicited content', 1),
  ('both', 'Harassment', 'Bullying or intimidating behavior', 3),
  ('both', 'Hate Speech', 'Content promoting discrimination or violence', 3),
  ('both', 'Scam/Fraud', 'Deceptive practices or fraudulent activity', 3),
  ('listing', 'Prohibited Item', 'Item not allowed on the marketplace', 2),
  ('listing', 'Counterfeit Product', 'Fake or knockoff products', 2),
  ('listing', 'Misleading Description', 'Inaccurate or deceptive listing details', 2),
  ('listing', 'Wrong Category', 'Listing placed in incorrect category', 1),
  ('listing', 'Inappropriate Images', 'Offensive or unsuitable photos', 2),
  ('listing', 'Price Manipulation', 'Unrealistic or deceptive pricing', 1),
  ('user', 'Fake Account', 'Impersonation or fake identity', 2),
  ('user', 'Suspicious Activity', 'Unusual or concerning behavior', 2),
  ('user', 'Offensive Profile', 'Inappropriate profile content', 2),
  ('both', 'Other', 'Other violation not listed above', 1)
ON CONFLICT DO NOTHING;

-- Reports table (for both listings and users)
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  report_type VARCHAR(20) NOT NULL, -- 'listing', 'user'
  reported_listing_id INTEGER REFERENCES userlistings(id) ON DELETE CASCADE,
  reported_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reason_id INTEGER REFERENCES report_reasons(id) ON DELETE SET NULL,
  custom_reason TEXT, -- Additional details from reporter
  evidence_urls TEXT[], -- Array of screenshot/evidence URLs
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'reviewing', 'resolved', 'dismissed'
  priority INTEGER DEFAULT 1, -- 1=low, 2=medium, 3=high, 4=urgent
  admin_notes TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  action_taken VARCHAR(50), -- 'warning', 'listing_removed', 'account_suspended', 'no_action'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Ensure we have either a listing or user being reported
  CONSTRAINT valid_report CHECK (
    (report_type = 'listing' AND reported_listing_id IS NOT NULL) OR
    (report_type = 'user' AND reported_user_id IS NOT NULL)
  )
);

-- Violation warnings table
CREATE TABLE IF NOT EXISTS violation_warnings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  warning_type VARCHAR(50) NOT NULL, -- 'mild', 'moderate', 'severe', 'final'
  reason TEXT NOT NULL,
  related_report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  related_listing_id INTEGER REFERENCES userlistings(id) ON DELETE SET NULL,
  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMP,
  expires_at TIMESTAMP, -- Optional expiration for warnings
  created_at TIMESTAMP DEFAULT NOW()
);

-- Account suspensions table
CREATE TABLE IF NOT EXISTS account_suspensions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  suspension_type VARCHAR(20) NOT NULL, -- 'temporary', 'permanent'
  reason TEXT NOT NULL,
  related_report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  suspended_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  starts_at TIMESTAMP DEFAULT NOW(),
  ends_at TIMESTAMP, -- NULL for permanent suspensions
  is_active BOOLEAN DEFAULT TRUE,
  lifted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  lifted_at TIMESTAMP,
  lift_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Appeals table
CREATE TABLE IF NOT EXISTS appeals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  suspension_id INTEGER REFERENCES account_suspensions(id) ON DELETE CASCADE,
  warning_id INTEGER REFERENCES violation_warnings(id) ON DELETE SET NULL,
  appeal_type VARCHAR(20) NOT NULL, -- 'suspension', 'warning', 'listing_removal'
  related_listing_id INTEGER REFERENCES userlistings(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  evidence_urls TEXT[], -- Supporting evidence
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'reviewing', 'approved', 'denied'
  admin_notes TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Add suspension-related columns to users table
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'is_suspended'
  ) THEN
    ALTER TABLE users ADD COLUMN is_suspended BOOLEAN DEFAULT FALSE;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'suspension_reason'
  ) THEN
    ALTER TABLE users ADD COLUMN suspension_reason TEXT;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'warning_count'
  ) THEN
    ALTER TABLE users ADD COLUMN warning_count INTEGER DEFAULT 0;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'report_count'
  ) THEN
    ALTER TABLE users ADD COLUMN report_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(report_type);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported_listing ON reports(reported_listing_id);
CREATE INDEX IF NOT EXISTS idx_reports_priority ON reports(priority DESC);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_warnings_user ON violation_warnings(user_id);
CREATE INDEX IF NOT EXISTS idx_warnings_acknowledged ON violation_warnings(acknowledged);

CREATE INDEX IF NOT EXISTS idx_suspensions_user ON account_suspensions(user_id);
CREATE INDEX IF NOT EXISTS idx_suspensions_active ON account_suspensions(is_active);

CREATE INDEX IF NOT EXISTS idx_appeals_user ON appeals(user_id);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status);

CREATE INDEX IF NOT EXISTS idx_users_suspended ON users(is_suspended);

-- Create view for report statistics
CREATE OR REPLACE VIEW report_statistics AS
SELECT 
  COUNT(*) FILTER (WHERE status = 'pending') as pending_reports,
  COUNT(*) FILTER (WHERE status = 'reviewing') as reviewing_reports,
  COUNT(*) FILTER (WHERE status = 'resolved') as resolved_reports,
  COUNT(*) FILTER (WHERE report_type = 'listing') as listing_reports,
  COUNT(*) FILTER (WHERE report_type = 'user') as user_reports,
  COUNT(*) FILTER (WHERE priority >= 3) as high_priority_reports
FROM reports;

-- Create view for pending appeals
CREATE OR REPLACE VIEW pending_appeals_view AS
SELECT 
  a.*,
  u.name as user_name,
  u.email as user_email,
  s.reason as suspension_reason,
  s.suspension_type
FROM appeals a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN account_suspensions s ON a.suspension_id = s.id
WHERE a.status = 'pending'
ORDER BY a.created_at ASC;

-- Comments for documentation
COMMENT ON TABLE reports IS 'Stores all reports submitted by users against listings or other users';
COMMENT ON TABLE violation_warnings IS 'Tracks warnings issued to users for policy violations';
COMMENT ON TABLE account_suspensions IS 'Records of account suspensions with duration and reason';
COMMENT ON TABLE appeals IS 'User appeals against suspensions, warnings, or listing removals';
COMMENT ON TABLE report_reasons IS 'Predefined reasons for reporting with severity levels';
