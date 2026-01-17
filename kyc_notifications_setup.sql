-- KYC Verifications Table
CREATE TABLE IF NOT EXISTS kyc_verifications (
  id SERIAL PRIMARY KEY,
  userid INTEGER REFERENCES users(id) ON DELETE CASCADE,
  documenttype VARCHAR(50) NOT NULL, -- 'id_card', 'passport', 'drivers_license'
  documentfronturl TEXT NOT NULL,
  documentbackurl TEXT, -- NULL for passport
  selfieurl TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  rejectionreason TEXT,
  reviewedby INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewedat TIMESTAMP,
  createdat TIMESTAMP DEFAULT NOW(),
  updatedat TIMESTAMP DEFAULT NOW()
);

-- Notifications Table
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  userid INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'kyc_approved', 'kyc_rejected', 'info', 'warning', 'success'
  isread BOOLEAN DEFAULT FALSE,
  relatedid INTEGER, -- Related entity ID (e.g., kyc_verification id)
  relatedtype VARCHAR(50), -- Related entity type (e.g., 'kyc_verification')
  createdat TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_kyc_userid ON kyc_verifications(userid);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_verifications(status);
CREATE INDEX IF NOT EXISTS idx_notifications_userid ON notifications(userid);
CREATE INDEX IF NOT EXISTS idx_notifications_isread ON notifications(isread);
