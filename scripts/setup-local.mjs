import fs from "node:fs";
import crypto from "node:crypto";
const file = ".dev.vars";
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, fs.readFileSync(".dev.vars.example", "utf8").replace("BETTER_AUTH_SECRET=", "BETTER_AUTH_SECRET=" + crypto.randomBytes(48).toString("base64url")));
  console.log("Created .dev.vars with a private random key. No cloud resources were created.");
} else console.log(".dev.vars already exists; no existing settings or secrets were changed.");
