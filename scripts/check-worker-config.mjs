import fs from "node:fs";
import path from "node:path";

const configPath = path.resolve(process.env.WRANGLER_CONFIG || "dist/server/wrangler.json");
const fail = (message) => {
  console.error(`Worker configuration check failed: ${message}`);
  process.exit(1);
};

if (!fs.existsSync(configPath)) fail(`missing ${path.relative(process.cwd(), configPath)}; run npm run build first`);

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (error) {
  fail(`could not parse ${path.relative(process.cwd(), configPath)}: ${error.message}`);
}

const configDir = path.dirname(configPath);
const main = typeof config.main === "string" ? config.main : "";
if (!main) fail("generated config has no Worker main entry");
if (!fs.existsSync(path.resolve(configDir, main))) fail(`Worker entry does not exist: ${main}`);

const assets = config.assets;
if (!assets || typeof assets.directory !== "string" || !fs.existsSync(path.resolve(configDir, assets.directory))) {
  fail("generated config does not point to an existing assets directory");
}
if (assets.binding !== "ASSETS") fail("the Worker assets binding must be ASSETS");

const database = config.d1_databases?.find(({ binding }) => binding === "DB");
if (!database || typeof database.database_name !== "string" || !database.database_name.trim()) {
  fail("D1 binding DB must include a database_name");
}

const zeroUuid = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
for (const field of ["database_id", "preview_database_id"]) {
  if (database[field] !== undefined && (!uuid.test(database[field]) || zeroUuid.test(database[field]))) {
    fail(`D1 ${field} is not a real UUID; remove the placeholder or set the actual Cloudflare D1 ID`);
  }
}

const bucket = config.r2_buckets?.find(({ binding }) => binding === "COVERS");
if (!bucket || typeof bucket.bucket_name !== "string" || !bucket.bucket_name.trim()) {
  fail("R2 binding COVERS must include a bucket_name");
}

const environment = config.vars?.ENVIRONMENT;
const authUrl = config.vars?.BETTER_AUTH_URL;
if (environment !== "production") fail("ENVIRONMENT must be production for deployment");
try {
  const url = new URL(authUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error();
} catch {
  fail("BETTER_AUTH_URL must be an origin with an HTTPS scheme");
}

const mailMode = config.vars?.MAIL_MODE;
const mailApiUrl = config.vars?.MAIL_API_URL;
const mailFrom = config.vars?.MAIL_FROM;
if (mailMode !== "http") fail("MAIL_MODE must be http for production email delivery");
try {
  const url = new URL(mailApiUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
} catch {
  fail("MAIL_API_URL must be a fixed HTTPS endpoint");
}
if (typeof mailFrom !== "string" || !mailFrom.trim() || /[\r\n]/.test(mailFrom)) {
  fail("MAIL_FROM must be a non-empty single-line sender address");
}

const relative = path.relative(process.cwd(), configPath);
console.log(`Worker configuration is ready: ${relative}`);
console.log(`  entry: ${main}`);
console.log(`  assets: ${assets.directory}`);
console.log(`  D1 DB: ${database.database_name}${database.database_id ? ` (${database.database_id})` : " (resolved/provisioned by name during deploy)"}`);
console.log(`  R2 COVERS: ${bucket.bucket_name}`);
