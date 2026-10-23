import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import Decimal from "decimal.js";
import { AppError, normalizeTags, parseCollectionInput } from "./collection-input";
import { getProgress, sumGrams } from "./mass";
import type { CollectionBox, MedicineSummary } from "./contracts";

type Row = Record<string, unknown>;
const BOX_JOIN = `SELECT b.*,m.generic_name FROM collection_boxes b JOIN medicines m ON m.id=b.medicine_id AND m.owner_id=b.owner_id`;
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function tags(value: unknown): string[] { try { return normalizeTags(JSON.parse(text(value) || "[]")); } catch { return []; } }
function box(row: Row): CollectionBox {
  return { id: text(row.id), medicineId: text(row.medicine_id), traceCode: text(row.trace_code), genericName: text(row.generic_name),
    manufacturer: text(row.manufacturer), specification: text(row.specification), batchNumber: text(row.batch_number), expiresAt: text(row.expires_at), notes: text(row.notes),
    massGrams: row.mass_grams == null ? null : text(row.mass_grams), massBasis: text(row.mass_basis), source: row.source === "manual" ? "manual" : "api", createdAt: text(row.created_at), updatedAt: text(row.updated_at) };
}
const shanghaiDate = (value: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

/** D1 writes use one atomic batch, not a non-existent interactive transaction. */
export function createWorkerCollectionService(db: D1Database) {
  const stmt = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).bind(...values);
  async function list(owner: string): Promise<MedicineSummary[]> {
    const result = await db.batch<Row>([stmt("SELECT * FROM medicines WHERE owner_id=? ORDER BY updated_at DESC,id", owner), stmt("SELECT * FROM collection_boxes WHERE owner_id=?", owner)]);
    return result[0].results.flatMap(m => {
      const records = result[1].results.filter(b => b.medicine_id === m.id);
      if (!records.length) return [];
      const totalGrams = sumGrams(records.map(r => r.mass_grams == null ? null : text(r.mass_grams)));
      return [{ id: text(m.id), genericName: text(m.generic_name), totalGrams, boxCount: records.length, pendingCount: records.filter(r => r.mass_grams == null).length,
        ...getProgress(totalGrams), updatedAt: text(m.updated_at), tags: tags(m.tags_json), manufacturers: [...new Set(records.map(r => text(r.manufacturer)).filter(Boolean))], hasCover: !!m.cover_key, coverUpdatedAt: m.cover_updated_at == null ? null : text(m.cover_updated_at) }];
    });
  }
  async function detail(owner: string, id: string) {
    const medicine = (await list(owner)).find(m => m.id === id);
    if (!medicine) throw new AppError("收藏不存在", 404);
    const records = await stmt(`${BOX_JOIN} WHERE b.owner_id=? AND b.medicine_id=? ORDER BY b.created_at DESC,b.id`, owner, id).all<Row>();
    return { medicine, boxes: records.results.map(box) };
  }
  async function save(owner: string, raw: unknown, id?: string) {
    const input = parseCollectionInput(raw), now = new Date().toISOString(), newId = id || crypto.randomUUID();
    const old = id ? await stmt("SELECT * FROM collection_boxes WHERE owner_id=? AND id=?", owner, id).first<Row>() : null;
    if (id && !old) throw new AppError("收藏不存在", 404);
    const duplicate = await stmt(`${BOX_JOIN} WHERE b.owner_id=? AND b.trace_key=?`, owner, input.traceKey).first<Row>();
    if (duplicate && duplicate.id !== id) {
      if (id) throw new AppError("这个追溯码已存在，不能覆盖其他收藏", 409);
      return { box: box(duplicate), duplicate: true, medicine: (await detail(owner, text(duplicate.medicine_id))).medicine, retiredCoverKeys: [] as string[] };
    }
    const statements: D1PreparedStatement[] = [];
    const guard = id ? "EXISTS(SELECT 1 FROM collection_boxes WHERE id=? AND owner_id=? AND updated_at=?)" : "NOT EXISTS(SELECT 1 FROM collection_boxes WHERE owner_id=? AND trace_key=?)";
    const guardValues = id ? [id, owner, text(old?.updated_at)] : [owner, input.traceKey];
    statements.push(stmt(`INSERT INTO medicines(id,owner_id,generic_name,name_key,tags_json,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(owner_id,name_key) DO NOTHING`, crypto.randomUUID(), owner, input.genericName, input.nameKey, JSON.stringify(input.tags || []), now, now, ...guardValues));
    const values = [input.traceCode, input.traceKey, input.manufacturer.trim(), input.specification.trim(), input.batchNumber.trim(), input.expiresAt, input.notes.trim(), input.massGrams, input.massBasis, input.source, now];
    if (id) statements.push(stmt(`UPDATE collection_boxes SET medicine_id=(SELECT id FROM medicines WHERE owner_id=? AND name_key=?),trace_code=?,trace_key=?,manufacturer=?,specification=?,batch_number=?,expires_at=?,notes=?,mass_grams=?,mass_basis=?,source=?,updated_at=? WHERE id=? AND owner_id=? AND updated_at=? RETURNING *`, owner, input.nameKey, ...values, id, owner, text(old?.updated_at)));
    else statements.push(stmt(`INSERT INTO collection_boxes(id,owner_id,medicine_id,trace_code,trace_key,manufacturer,specification,batch_number,expires_at,notes,mass_grams,mass_basis,source,updated_at,created_at) SELECT ?,?,id,?,?,?,?,?,?,?,?,?,?,?,? FROM medicines WHERE owner_id=? AND name_key=? AND NOT EXISTS(SELECT 1 FROM collection_boxes WHERE owner_id=? AND trace_key=?) ON CONFLICT(owner_id,trace_key) DO NOTHING RETURNING *`, newId, owner, ...values, now, owner, input.nameKey, owner, input.traceKey));
    statements.push(stmt(`UPDATE medicines SET updated_at=?${input.tags === undefined ? "" : ",tags_json=?"} WHERE owner_id=? AND id=(SELECT medicine_id FROM collection_boxes WHERE owner_id=? AND id=? AND updated_at=?)`, now, ...(input.tags === undefined ? [] : [JSON.stringify(input.tags)]), owner, owner, newId, now));
    if (old) statements.push(stmt("DELETE FROM medicines WHERE owner_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM collection_boxes WHERE medicine_id=medicines.id) RETURNING cover_key", owner, text(old.medicine_id)));
    statements.push(stmt(`${BOX_JOIN} WHERE b.owner_id=? AND b.trace_key=?`, owner, input.traceKey));
    let results;
    try { results = await db.batch<Row>(statements); }
    catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error))) throw new AppError("追溯码已存在或记录被同时更改，请刷新重试", 409);
      throw error;
    }
    if (id && !results[1].results.length) throw new AppError("记录刚被修改，请刷新后重试", 409);
    const record = results.at(-1)?.results[0];
    if (!record) throw new AppError("收藏未能保存，请重试", 409);
    const retiredCoverKeys = old ? results[3].results.map(r => text(r.cover_key)).filter(Boolean) : [];
    return { box: box(record), duplicate: text(record.id) !== newId, medicine: (await detail(owner, text(record.medicine_id))).medicine, retiredCoverKeys };
  }
  async function remove(owner: string, id: string) {
    const record = await stmt("SELECT medicine_id FROM collection_boxes WHERE owner_id=? AND id=?", owner, id).first<Row>();
    if (!record) throw new AppError("收藏不存在", 404);
    const results = await db.batch<Row>([
      stmt("DELETE FROM collection_boxes WHERE owner_id=? AND id=? RETURNING id", owner, id),
      stmt("UPDATE medicines SET updated_at=? WHERE id=? AND owner_id=?", new Date().toISOString(), text(record.medicine_id), owner),
      stmt("DELETE FROM medicines WHERE owner_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM collection_boxes WHERE medicine_id=medicines.id) RETURNING cover_key", owner, text(record.medicine_id)),
    ]);
    if (!results[0].results.length) throw new AppError("收藏不存在", 404);
    return { ok: true, retiredCoverKeys: results[2].results.map(r => text(r.cover_key)).filter(Boolean) };
  }
  async function setTags(owner: string, id: string, input: unknown) {
    const normalized = normalizeTags(input);
    const record = await stmt("UPDATE medicines SET tags_json=?,updated_at=? WHERE owner_id=? AND id=? RETURNING id", JSON.stringify(normalized), new Date().toISOString(), owner, id).first();
    if (!record) throw new AppError("收藏不存在", 404);
    return (await detail(owner, id)).medicine;
  }
  async function stats(owner: string) {
    const items = await list(owner);
    const records = (await stmt("SELECT created_at,medicine_id FROM collection_boxes WHERE owner_id=?", owner).all<Row>()).results;
    const now = new Date(), months = Array.from({ length: 6 }, (_, i) => {
      const local = new Date(now.getTime() + 8 * 3600_000);
      return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 5 + i, 1)).toISOString().slice(0, 7);
    });
    return { medicineCount: items.length, boxCount: records.length, pendingCount: items.reduce((n, m) => n + m.pendingCount, 0), tagCount: new Set(items.flatMap(m => m.tags || [])).size,
      activeDays: new Set(records.map(r => shanghaiDate(text(r.created_at)))).size,
      monthly: months.map(month => { const filtered = records.filter(r => shanghaiDate(text(r.created_at)).startsWith(month)); return { month, boxCount: filtered.length, medicineCount: new Set(filtered.map(r => r.medicine_id)).size }; }),
      topMedicines: [...items].sort((a, b) => new Decimal(b.totalGrams).cmp(a.totalGrams)).slice(0, 5) };
  }
  async function exportData(owner: string) {
    return { version: 2, exportedAt: new Date().toISOString(), medicines: await list(owner), boxes: (await stmt(`${BOX_JOIN} WHERE b.owner_id=? ORDER BY b.created_at DESC`, owner).all<Row>()).results.map(box) };
  }
  return { list, detail, save, remove, setTags, stats, exportData };
}
