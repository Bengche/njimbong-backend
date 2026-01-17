-- Create categories table if it doesn't exist
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  slug VARCHAR(100) UNIQUE,
  description TEXT,
  icon VARCHAR(255),
  imageurl TEXT,
  sortorder INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add new columns if they don't exist (for existing tables)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='categories' AND column_name='slug') THEN
    ALTER TABLE categories ADD COLUMN slug VARCHAR(100) UNIQUE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='categories' AND column_name='icon') THEN
    ALTER TABLE categories ADD COLUMN icon VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='categories' AND column_name='imageurl') THEN
    ALTER TABLE categories ADD COLUMN imageurl TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='categories' AND column_name='sortorder') THEN
    ALTER TABLE categories ADD COLUMN sortorder INTEGER DEFAULT 0;
  END IF;
END $$;

-- Create listings table if it doesn't exist
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  location VARCHAR(255),
  country VARCHAR(100) NOT NULL,
  city VARCHAR(100) NOT NULL,
  condition VARCHAR(20) DEFAULT 'new',
  phone VARCHAR(50) NOT NULL,
  tags TEXT,
  status VARCHAR(20) DEFAULT 'Available',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create imagelistings table if it doesn't exist
CREATE TABLE IF NOT EXISTS imagelistings (
  id SERIAL PRIMARY KEY,
  listingid INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  imageurl TEXT NOT NULL,
  is_main BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Insert sample categories if none exist
INSERT INTO categories (name, description) VALUES
  ('Electronics', 'Electronic devices and gadgets'),
  ('Vehicles', 'Cars, motorcycles, and other vehicles'),
  ('Real Estate', 'Houses, apartments, and land'),
  ('Furniture', 'Home and office furniture'),
  ('Clothing', 'Fashion and apparel'),
  ('Books', 'Books and educational materials'),
  ('Sports', 'Sports equipment and gear'),
  ('Toys', 'Children toys and games')
ON CONFLICT (name) DO NOTHING;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imagelistings_listingid ON imagelistings(listingid);
CREATE INDEX IF NOT EXISTS idx_imagelistings_main ON imagelistings(is_main);
