import { randomUUID } from "node:crypto";
import { and, desc, eq, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./db";
import { boxes, medicines } from "./schema";
import { calculateMass, getProgress, sumGrams } from "./mass";
import type { CollectionBox, MedicineSummary } from "./contracts";

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const optionalText = (max: number) => z.string().max(max).optional().default("");
const massSchema = z.object({
  mode: z.enum(["pending", "total", "unit"]), value: z.string().max(30).optional(),
  unit: z.enum(["g", "mg", "ug"]).optional(), quantity: z.string().max(12).optional(), basis: z.string().max(1000).optional(),
}).strict();
const inputSchema = z.object({
  traceCode: z.string().max(200), genericName: z.string().max(120),
  manufacturer: optionalText(200), specification: optionalText(500), batchNumber: optionalText(100),
  expiresAt: optionalText(10).refine((value) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value), "有效期必须是有效的 YYYY-MM-DD 日期"),
  notes: optionalText(2000), mass: massSchema, source: z.enum(["manual", "api"]).optional().default("manual"),
  tags: z.array(z.string().max(40)).max(8).optional(),
}).strict();

export function normalizeTrace(value: string): string {
  let code = value.normalize("NFKC").trim();
  if (/^[\d\s]+$/.test(code)) code = code.replace(/\s/g, "");
  if (!code || code.length > 200 || !/^[A-Za-z0-9._+\-/=]+$/.test(code)) throw new AppError("请输入不超过200字符的纯追溯码；不支持网址、控制字符或未知二维码内容");
  if (/^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length)) throw new AppError("这可能是商品条码，不能作为单盒唯一追溯码收藏");
  return code;
}

export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 8 || input.some(x => typeof x !== "string")) throw new AppError("每种药最多8个标签");
  const tags = [...new Set((input as string[]).map(x => x.normalize("NFC").trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (tags.some(x => x.length > 20)) throw new AppError("标签最多20个字符");
  return tags;
}
export function parseCollectionInput(raw: unknown) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || "收藏信息无效");
  const data = parsed.data;
  const genericName = data.genericName.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!genericName) throw new AppError("请填写通用药名");
  const traceCode = normalizeTrace(data.traceCode);
  let mass;
  try { mass = calculateMass(data.mass); } catch (error) { throw new AppError((error as Error).message); }
  return { ...data, ...(data.tags === undefined ? {} : { tags: normalizeTags(data.tags) }), genericName, nameKey: genericName.toLowerCase(), traceCode, traceKey: traceCode, massGrams: mass.grams, massBasis: mass.basis };
}

type BoxRow = typeof boxes.$inferSelect;
function toBox(row: BoxRow, genericName: string): CollectionBox {
  const { ownerId: _owner, traceKey: _key, ...publicRow } = row;
  return { ...publicRow, genericName, source: row.source === "alihealth" ? "api" : row.source };
}

export function createCollectionService(db: Database) {
  const owned = (ownerId: string, id: string) => and(eq(boxes.ownerId, ownerId), eq(boxes.id, id));
  async function transaction<T>(work: Parameters<Database["transaction"]>[0]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await db.transaction(work) as T; }
      catch (error) {
        const cause = String(error) + String((error as { cause?: unknown }).cause ?? "");
        if (attempt >= 4 || !/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(cause)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
  async function list(ownerId: string): Promise<MedicineSummary[]> {
    const [items, records] = await Promise.all([
      db.select().from(medicines).where(eq(medicines.ownerId, ownerId)).orderBy(desc(medicines.updatedAt)),
      db.select().from(boxes).where(eq(boxes.ownerId, ownerId)),
    ]);
    const grouped = new Map<string, BoxRow[]>();
    for (const record of records) grouped.set(record.medicineId, [...(grouped.get(record.medicineId) || []), record]);
    return items.flatMap((item) => {
      const entries = grouped.get(item.id) || [];
      if (!entries.length) return [];
      const totalGrams = sumGrams(entries.map((record) => record.massGrams));
      return [{ id: item.id, genericName: item.genericName, totalGrams, boxCount: entries.length,
        pendingCount: entries.filter((record) => record.massGrams === null).length,
        ...getProgress(totalGrams), updatedAt: item.updatedAt }];
    });
  }
  async function detail(ownerId: string, id: string) {
    const medicine = (await list(ownerId)).find((item) => item.id === id);
    if (!medicine) throw new AppError("收藏不存在", 404);
    const entries = await db.select().from(boxes).where(and(eq(boxes.ownerId, ownerId), eq(boxes.medicineId, id))).orderBy(desc(boxes.createdAt));
    return { medicine, boxes: entries.map((row) => toBox(row, medicine.genericName)) };
  }
  async function save(ownerId: string, raw: unknown, id?: string) {
    const input = parseCollectionInput(raw);
    const outcome = await transaction<{ row: BoxRow; duplicate: boolean; genericName: string }>(async (tx) => {
      const old = id ? (await tx.select().from(boxes).where(owned(ownerId, id)))[0] : undefined;
      if (id && !old) throw new AppError("收藏不存在", 404);
      const existing = (await tx.select().from(boxes).where(and(eq(boxes.ownerId, ownerId), eq(boxes.traceKey, input.traceKey))))[0];
      if (existing && existing.id !== id) {
        if (id) throw new AppError("这个追溯码已经在你的收藏中，无法覆盖另一盒记录", 409);
        const [medicine] = await tx.select().from(medicines).where(and(eq(medicines.ownerId, ownerId), eq(medicines.id, existing.medicineId)));
        return { row: existing, duplicate: true, genericName: medicine.genericName };
      }
      const now = new Date().toISOString();
      await tx.insert(medicines).values({ id: randomUUID(), ownerId, genericName: input.genericName, nameKey: input.nameKey, createdAt: now, updatedAt: now })
        .onConflictDoNothing({ target: [medicines.ownerId, medicines.nameKey] });
      const [medicine] = await tx.select().from(medicines).where(and(eq(medicines.ownerId, ownerId), eq(medicines.nameKey, input.nameKey)));
      const values = {
        medicineId: medicine.id, traceCode: input.traceCode, traceKey: input.traceKey,
        manufacturer: input.manufacturer.trim(), specification: input.specification.trim(), batchNumber: input.batchNumber.trim(),
        expiresAt: input.expiresAt, notes: input.notes.trim(), massGrams: input.massGrams, massBasis: input.massBasis,
        // This is user-declared provenance, not a verification or authentication claim.
        source: input.source, updatedAt: now,
      };
      const [row] = id
        ? await tx.update(boxes).set(values).where(owned(ownerId, id)).returning()
        : await tx.insert(boxes).values({ id: randomUUID(), ownerId, ...values, createdAt: now }).returning();
      await tx.update(medicines).set({ updatedAt: now }).where(and(eq(medicines.ownerId, ownerId), eq(medicines.id, medicine.id)));
      if (old && old.medicineId !== medicine.id) {
        await tx.update(medicines).set({ updatedAt: now }).where(and(eq(medicines.ownerId, ownerId), eq(medicines.id, old.medicineId)));
        await tx.delete(medicines).where(and(eq(medicines.ownerId, ownerId), eq(medicines.id, old.medicineId),
          notExists(tx.select({ id: boxes.id }).from(boxes).where(eq(boxes.medicineId, old.medicineId)))));
      }
      return { row, duplicate: false, genericName: medicine.genericName };
    });
    const medicine = (await list(ownerId)).find((item) => item.id === outcome.row.medicineId)!;
    return { box: toBox(outcome.row, outcome.genericName), duplicate: outcome.duplicate, medicine };
  }
  async function remove(ownerId: string, id: string) {
    await transaction(async (tx) => {
      const [row] = await tx.delete(boxes).where(owned(ownerId, id)).returning();
      if (!row) throw new AppError("收藏不存在", 404);
      await tx.update(medicines).set({ updatedAt: new Date().toISOString() }).where(and(eq(medicines.id, row.medicineId), eq(medicines.ownerId, ownerId)));
      await tx.delete(medicines).where(and(eq(medicines.id, row.medicineId), eq(medicines.ownerId, ownerId),
        notExists(tx.select({ id: boxes.id }).from(boxes).where(eq(boxes.medicineId, row.medicineId)))));
    });
    return { ok: true };
  }
  async function exportData(ownerId: string) {
    const entries = await db.select({ box: boxes, name: medicines.genericName }).from(boxes)
      .innerJoin(medicines, and(eq(boxes.medicineId, medicines.id), eq(boxes.ownerId, medicines.ownerId)))
      .where(eq(boxes.ownerId, ownerId)).orderBy(desc(boxes.createdAt));
    return { version: 1, exportedAt: new Date().toISOString(), medicines: await list(ownerId), boxes: entries.map(({ box, name }) => toBox(box, name)) };
  }
  return { list, detail, save, remove, exportData };
}
