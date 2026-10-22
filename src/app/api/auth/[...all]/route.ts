import { createWorkerAuth } from "@/lib/worker-auth";
import { workerEnvironment } from "@/lib/worker-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return createWorkerAuth(workerEnvironment()).handler(request); }
export async function POST(request: Request) { return createWorkerAuth(workerEnvironment()).handler(request); }
