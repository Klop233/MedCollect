import { Miniflare } from "miniflare";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkerEnv } from "../src/lib/worker-env";

export async function workerFixture() {
  const mf = new Miniflare({ workers: [{ name: "test", modules: true, script: "export default { fetch() { return new Response('test'); } }", compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "test-db" }, r2Buckets: ["COVERS"] }] });
  const DB = await mf.getD1Database("DB") as unknown as WorkerEnv["DB"];
  for (const file of readdirSync(resolve("drizzle")).filter(f => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve("drizzle", file), "utf8").split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
    await DB.batch(sql.map(statement => DB.prepare(statement)));
  }
  const env: WorkerEnv = { DB, COVERS: await mf.getR2Bucket("COVERS") as unknown as WorkerEnv["COVERS"], ENVIRONMENT: "development", BETTER_AUTH_URL: "http://localhost:5173", BETTER_AUTH_SECRET: "worker-test-only-not-a-real-deployment-secret-0123456789", MAIL_MODE: "disabled" };
  return { env, DB, dispose: () => mf.dispose() };
}
