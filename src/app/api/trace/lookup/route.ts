import { workerEnvironment } from "@/lib/worker-runtime";
import { stringSettings } from "@/lib/worker-env";
import { endpoint, json, rateLimit, readJson, requireUser } from "@/lib/api";
import { normalizeTrace, AppError } from "@/lib/collections";
import { lookupTrace } from "@/lib/trace";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return endpoint(async () => {
    const user = await requireUser(request, true);
    await rateLimit(user.id, "lookup", 20);
    const input = await readJson(request) as { code?: unknown; format?: unknown };
    if (!input || typeof input.code !== "string" || input.code.length > 200 || (input.format !== undefined && typeof input.format !== "string")) throw new AppError("请填写有效追溯码");
    const code = normalizeTrace(input.code);
    return json(await lookupTrace(code, input.format as string | undefined, stringSettings(workerEnvironment())));
  });
}
