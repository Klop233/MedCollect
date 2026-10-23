import { randomUUID } from "node:crypto";
import { and, desc, eq, notExists, sql } from "drizzle-orm";
import type { Database } from "./db";
import { boxes, medicines } from "./schema";
import { getProgress, sumGrams } from "./mass";
import type { CollectionBox, MedicineSummary } from "./contracts";
import { AppError, parseCollectionInput } from "./collection-input";

export { AppError, normalizeTags, normalizeTrace, parseCollectionInput } from "./collection-input";

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
