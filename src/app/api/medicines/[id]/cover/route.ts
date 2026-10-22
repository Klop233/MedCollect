import { endpoint, json, rateLimit, requireUser } from "@/lib/api";
import { AppError } from "@/lib/collections";
import { createCoverService } from "@/lib/covers";
import { workerEnvironment } from "@/lib/worker-runtime";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return endpoint(async () => createCoverService(workerEnvironment()).get((await requireUser(request)).id, (await context.params).id)); }
export async function PUT(request: Request, context: Context) {
  return endpoint(async () => {
    const user = await requireUser(request, true); await rateLimit(user.id, "cover", 15);
    const reader = request.body?.getReader(); if (!reader) throw new AppError("请选择图片");
    const chunks: Uint8Array[] = []; let total = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > 5 * 1024 * 1024 + 65536) { await reader.cancel(); throw new AppError("封面不能超过5MB", 413); } chunks.push(value); }
    const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData();
    const files = form.getAll("file"); if (files.length !== 1 || typeof files[0] === "string") throw new AppError("请选择一张封面图片");
    return json(await createCoverService(workerEnvironment()).put(user.id, (await context.params).id, new Uint8Array(await files[0].arrayBuffer())));
  });
}
export async function DELETE(request: Request, context: Context) { return endpoint(async () => json(await createCoverService(workerEnvironment()).remove((await requireUser(request, true)).id, (await context.params).id))); }
