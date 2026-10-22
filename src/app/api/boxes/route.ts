import { collections, endpoint, mutationJson, rateLimit, readJson, requireUser } from "@/lib/api";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return endpoint(async () => {
    const user = await requireUser(request, true);
    await rateLimit(user.id, "save", 60);
    const result = await collections.save(user.id, await readJson(request));
    return mutationJson(result, result.duplicate ? 200 : 201);
  });
}
