import { collections, endpoint, json, requireUser } from "@/lib/api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return endpoint(async () => json(await collections.stats((await requireUser(request)).id))); }
