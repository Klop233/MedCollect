// Offline export only. Stop the old Node service first; never overwrite an existing backup.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client/node";
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const source = option("--source", process.env.DATABASE_URL || "file:./data/medcollect.db");
const output = path.resolve(option("--output", ".tools/legacy-export.sql"));
if (!source.startsWith("file:") || source.includes(":memory:")) throw new Error("Only a local legacy database file can be exported");
const sourcePath = path.resolve(source.slice(5));
if (!fs.existsSync(sourcePath) || output === sourcePath || fs.existsSync(output)) throw new Error("Source must exist and backup destination must be a new, different file");
const client = createClient({ url: source, concurrency: 1 });
const tables = ["user", "account", "medicines", "collection_boxes"];
const quote = value => value == null ? "NULL" : typeof value === "number" || typeof value === "bigint" ? String(value) : "'" + String(value).replaceAll("'", "''") + "'";
let count = 0, sql = "-- PRIVATE MedCollect migration export: contains password hashes and personal records.\n-- Import only into an empty D1 database after applying the project migrations.\n-- Sessions and one-time tokens are intentionally omitted; sign in again.\n";
try {
  for (const table of tables) {
    const rows = (await client.execute(`SELECT * FROM "${table}"`)).rows;
    for (const row of rows) {
      const columns = Object.keys(row).filter(key => !/^\d+$/.test(key));
      sql += `INSERT INTO "${table}" (${columns.map(key => '"' + key.replaceAll('"', '""') + '"').join(',')}) VALUES (${columns.map(key => quote(row[key])).join(',')});\n`;
      count++;
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, sql, { flag: "wx", mode: 0o600 });
  console.log(`Private export written: ${count} rows. Source database was not modified. Keep the output out of Git and public storage.`);
} finally { client.close(); }
