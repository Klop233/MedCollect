import { collections, endpoint, json, requireUser } from "@/lib/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => json(await collections.exportData((await requireUser(request)).id), 200,
    { "Content-Disposition": 'attachment; filename="medcollect-export.json"' }));
}
