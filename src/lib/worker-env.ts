import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

/** Request-scoped Workers bindings. Never copy bindings into a process-global singleton. */
export interface WorkerEnv {
  DB: D1Database;
  COVERS?: R2Bucket;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  MAIL_MODE?: string;
  MAIL_API_URL?: string;
  MAIL_API_TOKEN?: string;
  MAIL_FROM?: string;
  ENVIRONMENT?: string;
  TRACE_API_URL?: string;
  TRACE_API_METHOD?: string;
  TRACE_API_BODY_TYPE?: string;
  TRACE_API_CODE_PARAM?: string;
  TRACE_API_PARAMS_JSON?: string;
  TRACE_API_TOKEN?: string;
  TRACE_API_HEADERS_JSON?: string;
  TRACE_API_RESPONSE_PATH?: string;
  TRACE_API_FIELD_MAP_JSON?: string;
}

/** String settings may go to server-only adapters; D1/R2 bindings must not. */
export function stringSettings(env: WorkerEnv): Record<string, string | undefined> {
  return { ...Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")), NODE_ENV: env.ENVIRONMENT === "development" ? "development" : "production" };
}
