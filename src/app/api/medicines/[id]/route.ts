import { collections, endpoint, json, requireUser } from "@/lib/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(async () => json(await collections.detail((await requireUser(request)).id, (await context.params).id)));
}
