import { collections, endpoint, json, requireUser } from "@/lib/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const user = await requireUser(request);
    const medicines = await collections.list(user.id);
    return json({ medicines, summary: { medicineCount: medicines.length,
      boxCount: medicines.reduce((sum, item) => sum + item.boxCount, 0), pendingCount: medicines.reduce((sum, item) => sum + item.pendingCount, 0) } });
  });
}
