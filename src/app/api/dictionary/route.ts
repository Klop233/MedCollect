import { endpoint, json, rateLimit, readJson, requireUser } from "@/lib/api";
import { AppError, normalizeTrace } from "@/lib/collection-input";
import { lookupProduct, normalizeProduct, rememberProduct } from "@/lib/dictionary";
import { workerEnvironment } from "@/lib/worker-runtime";

export const runtime = "nodejs";

/**
 * 共享药品字典。查到过一次的药，所有设备都不用再问上游。
 *
 *   GET  /api/dictionary?code=<20 位追溯码>   按药品标识码前缀查
 *   POST /api/dictionary  {code, product}     把一次真实查询的结果记下来
 *
 * 只收发产品级字段；批号、有效期这类每盒都不同的信息由用户在界面上补。
 */
export async function GET(request: Request) {
  return endpoint(async () => {
    const user = await requireUser(request);
    await rateLimit(user.id, "dictionary", 120);
    const raw = new URL(request.url).searchParams.get("code") ?? "";
    const code = normalizeTrace(raw);
    const hit = await lookupProduct(workerEnvironment().DB, code);
    return hit ? json({ ok: true, hit: true, ...hit }) : json({ ok: true, hit: false });
  });
}

export async function POST(request: Request) {
  return endpoint(async () => {
    const user = await requireUser(request, true);
    await rateLimit(user.id, "dictionary", 60);
    const input = (await readJson(request)) as { code?: unknown; product?: unknown };
    if (!input || typeof input !== "object") throw new AppError("请求内容无效");
    const code = normalizeTrace(typeof input.code === "string" ? input.code : "");
    const product = normalizeProduct(input.product);
    if (!product) throw new AppError("缺少药品名称，无法记录");
    const stored = await rememberProduct(workerEnvironment().DB, code, product);
    return json({ ok: true, stored });
  });
}
