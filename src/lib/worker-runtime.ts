import { env } from "cloudflare:workers";
import type { WorkerEnv } from "./worker-env";

export function workerEnvironment(): WorkerEnv {
  const bindings = env as unknown as WorkerEnv;
  if (!bindings.DB) throw new Error("D1 binding DB is missing");
  return bindings;
}
