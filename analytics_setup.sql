-- Analytics Tables for Marketplace Dashboard

-- Table to track individual listing analytics
CREATE TABLE IF NOT EXISTS listing_analytics (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES userlistings(id) ON DELETE CASCADE,
  views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  last_viewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(listing_id)
);

-- Table to track detailed analytics events
CREATE TABLE IF NOT EXISTS analytics_events (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES userlistings(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL, -- 'view', 'click', 'impression', 'contact', 'favorite'
  source VARCHAR(50), -- 'search', 'browse', 'direct', 'external', 'recommendation'
  referrer TEXT,
  device_type VARCHAR(20), -- 'mobile', 'desktop', 'tablet'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Table for daily aggregated user analytics
CREATE TABLE IF NOT EXISTS user_analytics_daily (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  total_views INTEGER DEFAULT 0,
  total_clicks INTEGER DEFAULT 0,
  total_impressions INTEGER DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0,
  revenue DECIMAL(12, 2) DEFAULT 0,
  source_search INTEGER DEFAULT 0,
  source_browse INTEGER DEFAULT 0,
  source_direct INTEGER DEFAULT 0,
  source_external INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_listing_analytics_listing ON listing_analytics(listing_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_listing ON analytics_events(listing_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_user_analytics_daily_user ON user_analytics_daily(user_id);
CREATE INDEX IF NOT EXISTS idx_user_analytics_daily_date ON user_analytics_daily(date);

-- Function to update listing analytics on view
CREATE OR REPLACE FUNCTION increment_listing_views(p_listing_id INTEGER)
RETURNS void AS $$
BEGIN
  INSERT INTO listing_analytics (listing_id, views, last_viewed_at)
  VALUES (p_listing_id, 1, NOW())
  ON CONFLICT (listing_id) 
  DO UPDATE SET 
    views = listing_analytics.views + 1,
    last_viewed_at = NOW(),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to update listing analytics on click
CREATE OR REPLACE FUNCTION increment_listing_clicks(p_listing_id INTEGER)
RETURNS void AS $$
BEGIN
  INSERT INTO listing_analytics (listing_id, clicks)
  VALUES (p_listing_id, 1)
  ON CONFLICT (listing_id) 
  DO UPDATE SET 
    clicks = listing_analytics.clicks + 1,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;
