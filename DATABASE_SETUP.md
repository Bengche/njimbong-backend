# Database Setup

## Setting up Tables

To set up the required database tables for the marketplace application, run the following command from the backend directory:

```bash
psql -U your_username -d your_database_name -f setup.sql
```

Replace `your_username` and `your_database_name` with your actual PostgreSQL credentials.

Alternatively, you can copy the contents of `setup.sql` and run it directly in your PostgreSQL client (pgAdmin, psql, etc.).

## Tables Created

1. **categories** - Stores product categories

   - id, name, description, created_at

2. **listings** - Stores marketplace listings

   - id, title, description, price, currency, category_id, location, country, city, condition, phone, tags, status, created_at, updated_at

3. **imagelistings** - Stores listing images from Cloudinary
   - id, listingid (FK to listings), imageurl, is_main (boolean), created_at, updated_at
   - Images are uploaded to Cloudinary and URLs stored here
   - First uploaded image is automatically set as main image

## Sample Data

The setup script also inserts 8 sample categories:

- Electronics
- Vehicles
- Real Estate
- Furniture
- Clothing
- Books
- Sports
- Toys
