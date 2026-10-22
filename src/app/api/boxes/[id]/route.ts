import { collections, endpoint, mutationJson, rateLimit, readJson, requireUser } from "@/lib/api";
export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(async () => {
    const user = await requireUser(request, true);
    await rateLimit(user.id, "save", 60);
    return mutationJson(await collections.save(user.id, await readJson(request), (await context.params).id));
  });
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(async () => {
    const user = await requireUser(request, true);
    return mutationJson(await collections.remove(user.id, (await context.params).id));
  });
}
