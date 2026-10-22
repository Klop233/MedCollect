import { collections, endpoint, json, readJson, requireUser } from "@/lib/api";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(async () => {
    const user = await requireUser(request, true), value = await readJson(request) as { tags?: unknown };
    return json({ medicine: await collections.setTags(user.id, (await context.params).id, value?.tags) });
  });
}
