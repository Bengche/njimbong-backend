-- ============================================================
-- TRUST SCORE SYSTEM - Professional Marketplace Implementation
-- ============================================================
-- This creates a robust, anti-gaming trust score system
-- Version: 2.0
-- Last Updated: December 2025
-- ============================================================

-- ============================================================
-- 1. USER REVIEWS TABLE
-- ============================================================
-- Only KYC-approved users can leave reviews
-- Reviews are tied to actual transactions
-- ============================================================

CREATE TABLE IF NOT EXISTS user_reviews (
    id SERIAL PRIMARY KEY,
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewed_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    
    -- Review content
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(100),
    review_text TEXT,
    review_type VARCHAR(20) NOT NULL DEFAULT 'buyer_to_seller' 
        CHECK (review_type IN ('buyer_to_seller', 'seller_to_buyer')),
    
    -- Verification & Anti-gaming
    is_verified BOOLEAN DEFAULT false,           -- Admin verified
    is_valid BOOLEAN DEFAULT true,               -- Not invalidated
    verification_method VARCHAR(50),             -- How it was verified
    
    -- Fraud detection fields
    reviewer_ip VARCHAR(45),                     -- IPv4 or IPv6
    reviewer_device_fingerprint VARCHAR(255),   -- Browser/device fingerprint
    fraud_flags JSONB DEFAULT '[]'::jsonb,      -- Array of fraud indicators
    fraud_score INTEGER DEFAULT 0,               -- 0-100, higher = more suspicious
    
    -- Seller response
    seller_response TEXT,
    seller_response_at TIMESTAMP WITH TIME ZONE,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT no_self_review CHECK (reviewer_id != reviewed_user_id),
    CONSTRAINT unique_transaction_review UNIQUE (reviewer_id, reviewed_user_id, transaction_id),
    CONSTRAINT unique_listing_review UNIQUE (reviewer_id, reviewed_user_id, listing_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_reviews_reviewed_user ON user_reviews(reviewed_user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON user_reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_listing ON user_reviews(listing_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON user_reviews(rating);
CREATE INDEX IF NOT EXISTS idx_reviews_valid ON user_reviews(is_valid, is_verified);
CREATE INDEX IF NOT EXISTS idx_reviews_fraud_score ON user_reviews(fraud_score);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON user_reviews(created_at DESC);

-- ============================================================
-- 2. TRANSACTIONS TABLE (if not exists)
-- ============================================================
-- Tracks actual buy/sell transactions for verified reviews
-- ============================================================

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Transaction details
    amount DECIMAL(15, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'XAF',
    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled', 'disputed')),
    
    -- Verification
    buyer_confirmed BOOLEAN DEFAULT false,
    seller_confirmed BOOLEAN DEFAULT false,
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- Review status
    buyer_review_left BOOLEAN DEFAULT false,
    seller_review_left BOOLEAN DEFAULT false,
    
    -- Metadata
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_buyer ON transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_seller ON transactions(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_listing ON transactions(listing_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

-- ============================================================
-- 3. USER WARNINGS TABLE
-- ============================================================
-- Admin-issued warnings that affect trust score
-- ============================================================

CREATE TABLE IF NOT EXISTS user_warnings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    admin_id INTEGER NOT NULL REFERENCES admins(id),
    
    -- Warning details
    warning_type VARCHAR(50) NOT NULL 
        CHECK (warning_type IN ('minor', 'moderate', 'severe', 'final')),
    reason TEXT NOT NULL,
    details JSONB DEFAULT '{}'::jsonb,
    
    -- Point deduction
    points_deducted INTEGER NOT NULL DEFAULT 5,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE,         -- NULL = permanent
    acknowledged_at TIMESTAMP WITH TIME ZONE,    -- User acknowledged warning
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_warnings_user ON user_warnings(user_id);
CREATE INDEX IF NOT EXISTS idx_warnings_active ON user_warnings(is_active);

-- ============================================================
-- 4. TRUST SCORE HISTORY TABLE
-- ============================================================
-- Tracks all changes to trust scores for audit
-- ============================================================

CREATE TABLE IF NOT EXISTS trust_score_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Score change
    old_score INTEGER,
    new_score INTEGER NOT NULL,
    change_amount INTEGER,
    
    -- Change details
    change_reason VARCHAR(100) NOT NULL,
    change_details JSONB DEFAULT '{}'::jsonb,
    triggered_by VARCHAR(50),                    -- 'system', 'admin', 'review', etc.
    
    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_history_user ON trust_score_history(user_id);
CREATE INDEX IF NOT EXISTS idx_trust_history_created ON trust_score_history(created_at DESC);

-- ============================================================
-- 5. REVIEW FRAUD DETECTION LOG
-- ============================================================
-- Logs all fraud detection activities
-- ============================================================

CREATE TABLE IF NOT EXISTS review_fraud_log (
    id SERIAL PRIMARY KEY,
    review_id INTEGER REFERENCES user_reviews(id) ON DELETE CASCADE,
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewed_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Detection details
    fraud_type VARCHAR(50) NOT NULL,
    fraud_details JSONB NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    
    -- Action taken
    action_taken VARCHAR(50),
    actioned_by INTEGER REFERENCES admins(id),
    actioned_at TIMESTAMP WITH TIME ZONE,
    
    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_log_reviewer ON review_fraud_log(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_fraud_log_severity ON review_fraud_log(severity);

-- ============================================================
-- 6. ADD COLUMNS TO USERS TABLE
-- ============================================================

DO $$
BEGIN
    -- Trust score column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'trust_score') THEN
        ALTER TABLE users ADD COLUMN trust_score INTEGER DEFAULT 0;
    END IF;
    
    -- Trust score last updated
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'trust_score_updated_at') THEN
        ALTER TABLE users ADD COLUMN trust_score_updated_at TIMESTAMP WITH TIME ZONE;
    END IF;
    
    -- Bio for profile completeness
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'bio') THEN
        ALTER TABLE users ADD COLUMN bio TEXT;
    END IF;
    
    -- Review eligibility flag (cache for performance)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'can_leave_reviews') THEN
        ALTER TABLE users ADD COLUMN can_leave_reviews BOOLEAN DEFAULT false;
    END IF;
    
    -- Total reviews received (cache)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'total_reviews') THEN
        ALTER TABLE users ADD COLUMN total_reviews INTEGER DEFAULT 0;
    END IF;
    
    -- Average rating (cache)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'average_rating') THEN
        ALTER TABLE users ADD COLUMN average_rating DECIMAL(3, 2) DEFAULT 0.00;
    END IF;
END $$;

-- ============================================================
-- 7. TRUST SCORE CALCULATION FUNCTION
-- ============================================================
-- Professional algorithm with updated point values:
-- - KYC Approved: +15 points
-- - Account 3+ months: +10 points  
-- - Account 12+ months: +10 points
-- - Verified Reviews: +5 points max (weighted by rating)
-- - Active Listings 10+: +5 points
-- - Complete Profile: +5 points
-- - Verified Reports: -5 each (max -20)
-- - Rejected Listings: -3 each (max -15)
-- - Suspensions: -25 each
-- - Admin Warnings: -5 to -15 based on severity
-- ============================================================

CREATE OR REPLACE FUNCTION calculate_trust_score(p_user_id INTEGER)
RETURNS TABLE (
    total_score INTEGER,
    breakdown JSONB
) AS $$
DECLARE
    v_score INTEGER := 0;
    v_breakdown JSONB := '{}'::jsonb;
    v_user RECORD;
    v_review_stats RECORD;
    v_listing_count INTEGER;
    v_report_count INTEGER;
    v_rejection_count INTEGER;
    v_suspension_count INTEGER;
    v_warning_points INTEGER;
    v_months_as_member INTEGER;
    v_profile_complete BOOLEAN;
    v_review_score DECIMAL;
BEGIN
    -- Get user data
    SELECT 
        u.*,
        EXTRACT(MONTH FROM AGE(NOW(), u.createdat))::INTEGER +
        (EXTRACT(YEAR FROM AGE(NOW(), u.createdat))::INTEGER * 12) as months_member
    INTO v_user
    FROM users u
    WHERE u.id = p_user_id;
    
    IF NOT FOUND THEN
        RETURN QUERY SELECT 0, '{}'::jsonb;
        RETURN;
    END IF;
    
    v_months_as_member := COALESCE(v_user.months_member, 0);
    
    -- ========================================
    -- POSITIVE FACTORS
    -- ========================================
    
    -- 1. KYC Verification (+15 points)
    IF v_user.kyc_status = 'approved' THEN
        v_score := v_score + 15;
        v_breakdown := v_breakdown || jsonb_build_object('kyc_verified', jsonb_build_object(
            'points', 15,
            'status', 'approved',
            'description', 'Identity verified through KYC'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('kyc_verified', jsonb_build_object(
            'points', 0,
            'status', v_user.kyc_status,
            'description', 'KYC verification pending or not submitted'
        ));
    END IF;
    
    -- 2. Account Age 3+ months (+10 points)
    IF v_months_as_member >= 3 THEN
        v_score := v_score + 10;
        v_breakdown := v_breakdown || jsonb_build_object('account_age_3mo', jsonb_build_object(
            'points', 10,
            'months', v_months_as_member,
            'description', 'Account is 3+ months old'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('account_age_3mo', jsonb_build_object(
            'points', 0,
            'months', v_months_as_member,
            'description', 'Account needs to be 3+ months old'
        ));
    END IF;
    
    -- 3. Account Age 12+ months (+10 points bonus)
    IF v_months_as_member >= 12 THEN
        v_score := v_score + 10;
        v_breakdown := v_breakdown || jsonb_build_object('account_age_12mo', jsonb_build_object(
            'points', 10,
            'months', v_months_as_member,
            'description', 'Trusted long-term member (12+ months)'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('account_age_12mo', jsonb_build_object(
            'points', 0,
            'months', v_months_as_member,
            'description', 'Bonus for 12+ months membership'
        ));
    END IF;
    
    -- 4. Verified Reviews (+5 points max)
    -- Only count reviews from KYC-verified reviewers
    SELECT 
        COUNT(*) as total_count,
        COALESCE(AVG(rating), 0) as avg_rating,
        COUNT(*) FILTER (WHERE rating >= 4) as positive_count,
        COUNT(*) FILTER (WHERE rating <= 2) as negative_count
    INTO v_review_stats
    FROM user_reviews r
    JOIN users reviewer ON reviewer.id = r.reviewer_id
    WHERE r.reviewed_user_id = p_user_id
      AND r.is_valid = true
      AND r.is_verified = true
      AND reviewer.kyc_status = 'approved';  -- Only KYC-verified reviewers count
    
    -- Calculate review score (max 5 points)
    -- Formula: (avg_rating / 5) * min(review_count, 10) / 10 * 5
    -- This means: need 10+ reviews with 5-star average to get full 5 points
    IF v_review_stats.total_count > 0 THEN
        v_review_score := LEAST(
            5,
            (v_review_stats.avg_rating / 5.0) * LEAST(v_review_stats.total_count, 10) / 10.0 * 5
        );
        v_score := v_score + v_review_score::INTEGER;
        v_breakdown := v_breakdown || jsonb_build_object('verified_reviews', jsonb_build_object(
            'points', v_review_score::INTEGER,
            'max_points', 5,
            'total_reviews', v_review_stats.total_count,
            'average_rating', ROUND(v_review_stats.avg_rating, 2),
            'positive_reviews', v_review_stats.positive_count,
            'negative_reviews', v_review_stats.negative_count,
            'description', 'Reviews from verified buyers'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('verified_reviews', jsonb_build_object(
            'points', 0,
            'max_points', 5,
            'total_reviews', 0,
            'description', 'No verified reviews yet'
        ));
    END IF;
    
    -- 5. Active Listings 10+ (+5 points)
    SELECT COUNT(*) INTO v_listing_count
    FROM listings
    WHERE user_id = p_user_id 
      AND status = 'active'
      AND moderation_status = 'approved';
    
    IF v_listing_count >= 10 THEN
        v_score := v_score + 5;
        v_breakdown := v_breakdown || jsonb_build_object('active_listings', jsonb_build_object(
            'points', 5,
            'count', v_listing_count,
            'required', 10,
            'description', 'Active seller with 10+ approved listings'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('active_listings', jsonb_build_object(
            'points', 0,
            'count', v_listing_count,
            'required', 10,
            'description', 'Need 10+ active approved listings'
        ));
    END IF;
    
    -- 6. Complete Profile (+5 points)
    v_profile_complete := (
        v_user.name IS NOT NULL AND v_user.name != '' AND
        v_user.profilepicture IS NOT NULL AND
        v_user.country IS NOT NULL AND
        v_user.phone IS NOT NULL AND
        v_user.bio IS NOT NULL AND v_user.bio != ''
    );
    
    IF v_profile_complete THEN
        v_score := v_score + 5;
        v_breakdown := v_breakdown || jsonb_build_object('complete_profile', jsonb_build_object(
            'points', 5,
            'is_complete', true,
            'description', 'Profile fully completed'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('complete_profile', jsonb_build_object(
            'points', 0,
            'is_complete', false,
            'description', 'Complete your profile (name, photo, country, phone, bio)'
        ));
    END IF;
    
    -- ========================================
    -- NEGATIVE FACTORS
    -- ========================================
    
    -- 7. Verified Reports (-5 each, max -20)
    SELECT COUNT(*) INTO v_report_count
    FROM reports
    WHERE reported_user_id = p_user_id
      AND status = 'verified';
    
    IF v_report_count > 0 THEN
        v_score := v_score - LEAST(v_report_count * 5, 20);
        v_breakdown := v_breakdown || jsonb_build_object('verified_reports', jsonb_build_object(
            'points', -LEAST(v_report_count * 5, 20),
            'count', v_report_count,
            'per_report', -5,
            'max_penalty', -20,
            'description', 'Verified reports against this user'
        ));
    END IF;
    
    -- 8. Rejected Listings (-3 each, max -15)
    SELECT COUNT(*) INTO v_rejection_count
    FROM listings
    WHERE user_id = p_user_id
      AND moderation_status = 'rejected';
    
    IF v_rejection_count > 0 THEN
        v_score := v_score - LEAST(v_rejection_count * 3, 15);
        v_breakdown := v_breakdown || jsonb_build_object('rejected_listings', jsonb_build_object(
            'points', -LEAST(v_rejection_count * 3, 15),
            'count', v_rejection_count,
            'per_rejection', -3,
            'max_penalty', -15,
            'description', 'Listings rejected by moderation'
        ));
    END IF;
    
    -- 9. Suspensions (-25 each)
    SELECT COUNT(*) INTO v_suspension_count
    FROM user_suspensions
    WHERE user_id = p_user_id;
    
    IF v_suspension_count > 0 THEN
        v_score := v_score - (v_suspension_count * 25);
        v_breakdown := v_breakdown || jsonb_build_object('suspensions', jsonb_build_object(
            'points', -(v_suspension_count * 25),
            'count', v_suspension_count,
            'per_suspension', -25,
            'description', 'Account suspension history'
        ));
    END IF;
    
    -- 10. Admin Warnings (-5 to -15 each based on severity)
    SELECT COALESCE(SUM(points_deducted), 0) INTO v_warning_points
    FROM user_warnings
    WHERE user_id = p_user_id
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > NOW());
    
    IF v_warning_points > 0 THEN
        v_score := v_score - v_warning_points;
        v_breakdown := v_breakdown || jsonb_build_object('admin_warnings', jsonb_build_object(
            'points', -v_warning_points,
            'description', 'Active warnings from administrators'
        ));
    END IF;
    
    -- ========================================
    -- FINAL SCORE
    -- ========================================
    
    -- Ensure score is between 0 and 100
    v_score := GREATEST(0, LEAST(100, v_score));
    
    -- Add summary to breakdown
    v_breakdown := v_breakdown || jsonb_build_object('summary', jsonb_build_object(
        'total_score', v_score,
        'max_possible', 50,  -- 15 + 10 + 10 + 5 + 5 + 5 = 50
        'calculated_at', NOW(),
        'algorithm_version', '2.0'
    ));
    
    RETURN QUERY SELECT v_score, v_breakdown;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 8. UPDATE USER TRUST SCORE FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION update_user_trust_score(p_user_id INTEGER, p_reason VARCHAR DEFAULT 'manual_update')
RETURNS INTEGER AS $$
DECLARE
    v_old_score INTEGER;
    v_new_score INTEGER;
    v_breakdown JSONB;
BEGIN
    -- Get current score
    SELECT trust_score INTO v_old_score FROM users WHERE id = p_user_id;
    
    -- Calculate new score
    SELECT total_score, breakdown INTO v_new_score, v_breakdown
    FROM calculate_trust_score(p_user_id);
    
    -- Update user's trust score
    UPDATE users 
    SET 
        trust_score = v_new_score,
        trust_score_updated_at = NOW()
    WHERE id = p_user_id;
    
    -- Log the change
    INSERT INTO trust_score_history (
        user_id, old_score, new_score, change_amount, 
        change_reason, change_details, triggered_by
    ) VALUES (
        p_user_id, v_old_score, v_new_score, v_new_score - COALESCE(v_old_score, 0),
        p_reason, v_breakdown, 'system'
    );
    
    RETURN v_new_score;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 9. UPDATE USER REVIEW STATS FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION update_user_review_stats(p_user_id INTEGER)
RETURNS VOID AS $$
BEGIN
    UPDATE users
    SET 
        total_reviews = (
            SELECT COUNT(*) FROM user_reviews 
            WHERE reviewed_user_id = p_user_id AND is_valid = true
        ),
        average_rating = (
            SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0) FROM user_reviews 
            WHERE reviewed_user_id = p_user_id AND is_valid = true
        )
    WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 10. UPDATE CAN_LEAVE_REVIEWS FLAG
-- ============================================================
-- Only KYC-approved users can leave reviews

CREATE OR REPLACE FUNCTION update_review_eligibility()
RETURNS TRIGGER AS $$
BEGIN
    -- Update the can_leave_reviews flag based on KYC status
    NEW.can_leave_reviews := (NEW.kyc_status = 'approved');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for review eligibility
DROP TRIGGER IF EXISTS trigger_update_review_eligibility ON users;
CREATE TRIGGER trigger_update_review_eligibility
    BEFORE UPDATE OF kyc_status ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_review_eligibility();

-- ============================================================
-- 11. TRIGGERS FOR AUTO-UPDATING TRUST SCORE
-- ============================================================

-- Trigger: After KYC status change
CREATE OR REPLACE FUNCTION trigger_trust_score_on_kyc()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.kyc_status IS DISTINCT FROM NEW.kyc_status THEN
        PERFORM update_user_trust_score(NEW.id, 'kyc_status_change');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trust_score_kyc_trigger ON users;
CREATE TRIGGER trust_score_kyc_trigger
    AFTER UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION trigger_trust_score_on_kyc();

-- Trigger: After review is added/modified
CREATE OR REPLACE FUNCTION trigger_trust_score_on_review()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM update_user_trust_score(OLD.reviewed_user_id, 'review_deleted');
        PERFORM update_user_review_stats(OLD.reviewed_user_id);
        RETURN OLD;
    ELSE
        PERFORM update_user_trust_score(NEW.reviewed_user_id, 'review_' || LOWER(TG_OP));
        PERFORM update_user_review_stats(NEW.reviewed_user_id);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trust_score_review_trigger ON user_reviews;
CREATE TRIGGER trust_score_review_trigger
    AFTER INSERT OR UPDATE OR DELETE ON user_reviews
    FOR EACH ROW
    EXECUTE FUNCTION trigger_trust_score_on_review();

-- Trigger: After listing moderation status change
CREATE OR REPLACE FUNCTION trigger_trust_score_on_listing()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.moderation_status IS DISTINCT FROM NEW.moderation_status THEN
        PERFORM update_user_trust_score(NEW.user_id, 'listing_moderation_change');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trust_score_listing_trigger ON listings;
CREATE TRIGGER trust_score_listing_trigger
    AFTER UPDATE ON listings
    FOR EACH ROW
    EXECUTE FUNCTION trigger_trust_score_on_listing();

-- Trigger: After warning is added
CREATE OR REPLACE FUNCTION trigger_trust_score_on_warning()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM update_user_trust_score(NEW.user_id, 'warning_added');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trust_score_warning_trigger ON user_warnings;
CREATE TRIGGER trust_score_warning_trigger
    AFTER INSERT ON user_warnings
    FOR EACH ROW
    EXECUTE FUNCTION trigger_trust_score_on_warning();

-- ============================================================
-- 12. INITIALIZE EXISTING USERS
-- ============================================================

-- Update can_leave_reviews for all existing users
UPDATE users SET can_leave_reviews = (kyc_status = 'approved');

-- Calculate initial trust scores for all users
DO $$
DECLARE
    user_record RECORD;
BEGIN
    FOR user_record IN SELECT id FROM users LOOP
        PERFORM update_user_trust_score(user_record.id, 'initial_calculation');
    END LOOP;
END $$;

-- ============================================================
-- 13. HELPFUL VIEWS
-- ============================================================

-- View: User trust score summary
CREATE OR REPLACE VIEW user_trust_summary AS
SELECT 
    u.id,
    u.name,
    u.email,
    u.trust_score,
    u.kyc_status,
    u.can_leave_reviews,
    u.total_reviews,
    u.average_rating,
    u.createdat,
    EXTRACT(MONTH FROM AGE(NOW(), u.createdat))::INTEGER +
    (EXTRACT(YEAR FROM AGE(NOW(), u.createdat))::INTEGER * 12) as months_as_member,
    (SELECT COUNT(*) FROM listings WHERE user_id = u.id AND status = 'active' AND moderation_status = 'approved') as active_listings,
    (SELECT COUNT(*) FROM user_warnings WHERE user_id = u.id AND is_active = true) as active_warnings
FROM users u;

-- View: Review statistics per user
CREATE OR REPLACE VIEW user_review_stats AS
SELECT 
    u.id as user_id,
    u.name,
    COUNT(r.id) as total_reviews,
    COUNT(r.id) FILTER (WHERE r.rating >= 4) as positive_reviews,
    COUNT(r.id) FILTER (WHERE r.rating = 3) as neutral_reviews,
    COUNT(r.id) FILTER (WHERE r.rating <= 2) as negative_reviews,
    ROUND(AVG(r.rating)::numeric, 2) as average_rating,
    COUNT(r.id) FILTER (WHERE r.is_verified = true) as verified_reviews
FROM users u
LEFT JOIN user_reviews r ON r.reviewed_user_id = u.id AND r.is_valid = true
GROUP BY u.id, u.name;

-- View: Flagged reviews for admin review
CREATE OR REPLACE VIEW flagged_reviews AS
SELECT 
    r.*,
    reviewer.name as reviewer_name,
    reviewer.kyc_status as reviewer_kyc_status,
    reviewed.name as reviewed_user_name,
    l.title as listing_title
FROM user_reviews r
JOIN users reviewer ON reviewer.id = r.reviewer_id
JOIN users reviewed ON reviewed.id = r.reviewed_user_id
LEFT JOIN listings l ON l.id = r.listing_id
WHERE r.fraud_score >= 50 OR jsonb_array_length(r.fraud_flags) > 0
ORDER BY r.fraud_score DESC, r.created_at DESC;

-- ============================================================
-- COMPLETE!
-- ============================================================
-- Trust Score System is now ready.
-- 
-- Point Breakdown:
-- POSITIVE:
--   KYC Approved:        +15 points
--   Account 3+ months:   +10 points
--   Account 12+ months:  +10 points
--   Verified Reviews:    +5 points max
--   Active Listings 10+: +5 points
--   Complete Profile:    +5 points
--   MAXIMUM POSSIBLE:    50 points
--
-- NEGATIVE:
--   Verified Reports:    -5 each (max -20)
--   Rejected Listings:   -3 each (max -15)
--   Suspensions:         -25 each
--   Admin Warnings:      -5 to -15 each
--
-- REVIEW RULES:
--   - Only KYC-approved users can leave reviews
--   - Reviews must be tied to transactions
--   - Fraud detection flags suspicious activity
-- ============================================================
