-- =====================================================
-- USER PREFERENCES & PERSONALIZATION SYSTEM
-- Marketplace Platform - December 2025
-- =====================================================

-- 1. User Preferences Table
-- Stores user's preferred categories and onboarding status
CREATE TABLE IF NOT EXISTS user_preferences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    onboarding_complete BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id)
);

-- 2. User Category Preferences Table
-- Stores which categories a user is interested in
CREATE TABLE IF NOT EXISTS user_category_preferences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    priority INTEGER DEFAULT 0, -- Higher = more preferred
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, category_id)
);

-- 3. User Search History Table
-- Tracks what users search for to improve recommendations
CREATE TABLE IF NOT EXISTS user_search_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    search_term VARCHAR(255) NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    search_count INTEGER DEFAULT 1,
    last_searched_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, search_term)
);

-- 4. User Listing Views Table
-- Tracks which listings users view to understand preferences
CREATE TABLE IF NOT EXISTS user_listing_views (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES userlistings(id) ON DELETE CASCADE,
    view_count INTEGER DEFAULT 1,
    last_viewed_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, listing_id)
);

-- 5. User Category Affinity Table
-- Calculated based on views, searches, and interactions
CREATE TABLE IF NOT EXISTS user_category_affinity (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    affinity_score DECIMAL(5,2) DEFAULT 0, -- Score from 0-100
    view_count INTEGER DEFAULT 0,
    search_count INTEGER DEFAULT 0,
    interaction_count INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, category_id)
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_user_category_prefs_user ON user_category_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_user_category_prefs_category ON user_category_preferences(category_id);
CREATE INDEX IF NOT EXISTS idx_user_search_history_user ON user_search_history(user_id);
CREATE INDEX IF NOT EXISTS idx_user_search_history_term ON user_search_history(search_term);
CREATE INDEX IF NOT EXISTS idx_user_listing_views_user ON user_listing_views(user_id);
CREATE INDEX IF NOT EXISTS idx_user_listing_views_listing ON user_listing_views(listing_id);
CREATE INDEX IF NOT EXISTS idx_user_category_affinity_user ON user_category_affinity(user_id);
CREATE INDEX IF NOT EXISTS idx_user_category_affinity_score ON user_category_affinity(affinity_score DESC);

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Function to update category affinity based on user behavior
CREATE OR REPLACE FUNCTION update_user_category_affinity(p_user_id INTEGER, p_category_id INTEGER, p_action_type VARCHAR)
RETURNS VOID AS $$
DECLARE
    v_weight DECIMAL(5,2);
    v_current_affinity DECIMAL(5,2);
BEGIN
    -- Assign weights based on action type
    CASE p_action_type
        WHEN 'view' THEN v_weight := 1.0;
        WHEN 'search' THEN v_weight := 2.0;
        WHEN 'contact' THEN v_weight := 5.0;
        WHEN 'favorite' THEN v_weight := 3.0;
        ELSE v_weight := 0.5;
    END CASE;
    
    -- Insert or update affinity
    INSERT INTO user_category_affinity (user_id, category_id, affinity_score, view_count, search_count, interaction_count, updated_at)
    VALUES (p_user_id, p_category_id, v_weight, 
            CASE WHEN p_action_type = 'view' THEN 1 ELSE 0 END,
            CASE WHEN p_action_type = 'search' THEN 1 ELSE 0 END,
            CASE WHEN p_action_type IN ('contact', 'favorite') THEN 1 ELSE 0 END,
            NOW())
    ON CONFLICT (user_id, category_id) DO UPDATE SET
        affinity_score = LEAST(100, user_category_affinity.affinity_score + v_weight),
        view_count = user_category_affinity.view_count + CASE WHEN p_action_type = 'view' THEN 1 ELSE 0 END,
        search_count = user_category_affinity.search_count + CASE WHEN p_action_type = 'search' THEN 1 ELSE 0 END,
        interaction_count = user_category_affinity.interaction_count + CASE WHEN p_action_type IN ('contact', 'favorite') THEN 1 ELSE 0 END,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to get personalized category IDs for a user
CREATE OR REPLACE FUNCTION get_user_preferred_categories(p_user_id INTEGER)
RETURNS TABLE(category_id INTEGER, priority_score DECIMAL) AS $$
BEGIN
    RETURN QUERY
    -- First, get explicit preferences (highest priority)
    SELECT ucp.category_id, (100 + ucp.priority)::DECIMAL as priority_score
    FROM user_category_preferences ucp
    WHERE ucp.user_id = p_user_id
    
    UNION ALL
    
    -- Then, get learned affinities (lower priority)
    SELECT uca.category_id, uca.affinity_score as priority_score
    FROM user_category_affinity uca
    WHERE uca.user_id = p_user_id
    AND NOT EXISTS (
        SELECT 1 FROM user_category_preferences ucp 
        WHERE ucp.user_id = p_user_id AND ucp.category_id = uca.category_id
    )
    
    ORDER BY priority_score DESC;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- TRIGGERS
-- =====================================================

-- Trigger to auto-update affinity when a listing is viewed
CREATE OR REPLACE FUNCTION trigger_update_affinity_on_view()
RETURNS TRIGGER AS $$
DECLARE
    v_category_id INTEGER;
BEGIN
    -- Get the category of the viewed listing
    SELECT categoryid INTO v_category_id
    FROM userlistings
    WHERE id = NEW.listing_id;
    
    IF v_category_id IS NOT NULL THEN
        PERFORM update_user_category_affinity(NEW.user_id, v_category_id, 'view');
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_affinity_on_view ON user_listing_views;
CREATE TRIGGER trg_update_affinity_on_view
    AFTER INSERT OR UPDATE ON user_listing_views
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_affinity_on_view();

-- Trigger to auto-update affinity when a search is made
CREATE OR REPLACE FUNCTION trigger_update_affinity_on_search()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.category_id IS NOT NULL THEN
        PERFORM update_user_category_affinity(NEW.user_id, NEW.category_id, 'search');
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_affinity_on_search ON user_search_history;
CREATE TRIGGER trg_update_affinity_on_search
    AFTER INSERT OR UPDATE ON user_search_history
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_affinity_on_search();

-- =====================================================
-- Initialize preferences for existing users
-- =====================================================
INSERT INTO user_preferences (user_id, onboarding_complete)
SELECT id, FALSE FROM users
WHERE id NOT IN (SELECT user_id FROM user_preferences)
ON CONFLICT (user_id) DO NOTHING;
