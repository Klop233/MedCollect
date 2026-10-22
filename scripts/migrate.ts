import { config } from "dotenv";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";

config({ path: ".env.local", quiet: true });
config({ quiet: true });
const { createDatabase } = await import("../src/lib/db");
const { db, client } = createDatabase(process.env.DATABASE_URL || "file:./data/medcollect.db");
try {
  await client.execute("PRAGMA foreign_keys = ON");
  await migrate(db, { migrationsFolder: resolve("drizzle") });
  console.log("Database migrations applied.");
} finally {
  client.close();
}
