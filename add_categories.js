import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";
dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function fixElectronics() {
  await pool.query(
    "UPDATE categories SET icon = '📱' WHERE name = 'Electronics'"
  );
  console.log("Fixed Electronics icon to 📱");

  const result = await pool.query(
    "SELECT id, name, icon FROM categories ORDER BY name"
  );
  console.log("\nAll Categories:");
  result.rows.forEach((r, i) => {
    console.log(`${i + 1}. ${r.icon} ${r.name}`);
  });
  process.exit(0);
}

fixElectronics();
