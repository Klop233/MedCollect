import { createWorkerAuth } from "./worker-auth";
import { workerEnvironment } from "./worker-runtime";
import { AppError } from "./collections";
import { createWorkerCollectionService } from "./worker-collections";

type Service = ReturnType<typeof createWorkerCollectionService>;
export const collections = new Proxy({} as Service, { get: (_target, key: keyof Service) => (...args: unknown[]) => {
  const service = createWorkerCollectionService(workerEnvironment().DB);
  return (service[key] as (...values: unknown[]) => unknown)(...args);
} });
export async function requireUser(request: Request, write = false) {
  const env = workerEnvironment();
  if (write) {
    const expected = new URL(env.BETTER_AUTH_URL || "http://localhost:5173").origin;
    if (request.headers.get("origin") !== expected) throw new AppError("请求来源无效，请从本站页面操作", 403);
  }
  const session = await createWorkerAuth(env).api.getSession({ headers: request.headers });
  if (!session?.user.emailVerified) throw new AppError("请先验证邮箱并登录", 401);
  return session.user;
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AppError("仅支持 JSON 请求", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("请求内容不能为空");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 32_768) { await reader.cancel(); throw new AppError("请求内容过大", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError("JSON 格式无效"); }
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
}
export async function endpoint(work: () => Promise<Response>) {
  try { return await work(); }
  catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    // SQL diagnostics can contain raw trace codes; do not log unsanitized exceptions.
    console.error("MedCollect request failed; no private payload was logged.");
    return json({ error: "服务暂时无法完成操作，请稍后重试；若刚启动，请确认已执行数据库迁移" }, 500);
  }
}
export async function rateLimit(ownerId: string, kind: string, max: number) {
  const now = Date.now();
  const counter = await workerEnvironment().DB.prepare("INSERT INTO request_limits(key,count,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<? THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<? THEN ? ELSE window_start END RETURNING count").bind(`${kind}:${ownerId}`, now, now - 60_000, now - 60_000, now).first<{ count: number }>();
  if (counter && counter.count > max) throw new AppError("操作过于频繁，请一分钟后重试", 429);
}

export async function mutationJson<T extends { retiredCoverKeys?: string[] }>(result: T, status = 200) {
  const { retiredCoverKeys, ...data } = result;
  const bucket = workerEnvironment().COVERS;
  if (bucket && retiredCoverKeys?.length) await bucket.delete(retiredCoverKeys).catch(() => undefined);
  return json(data, status);
}
