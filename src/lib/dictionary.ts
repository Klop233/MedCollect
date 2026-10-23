/**
 * 共享药品字典的服务端实现（D1）。
 *
 * 和 services/trace-api/drug_dict.py 是同一套规则，只是从「每台设备各记各的」
 * 变成「谁查到谁上报，所有人共用」：
 *
 *   只存产品级信息：药名、规格、生产企业、批准文号、剂型
 *   不存每盒信息：批号、生产日期、有效期、扫码次数、码状态
 *
 * 前缀长度必须和 sidecar 的 MSFX_DICT_PREFIX 默认值保持一致。
 */
import type { D1Database } from "@cloudflare/workers-types";

export const PREFIX_LENGTH = 7;
export const MAX_TEXT = 200;

export type DictionaryProduct = {
  genericName: string;
  specification?: string;
  manufacturer?: string;
  approvalNumber?: string;
  dosageForm?: string;
};

const FIELDS = ["genericName", "specification", "manufacturer", "approvalNumber", "dosageForm"] as const;
type Field = (typeof FIELDS)[number];

type Row = { prefix: string; product_json: string; fingerprint: string; samples: number; ambiguous: number };

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
}

/** 只保留产品级字段；没有药名就当没收到。 */
export function normalizeProduct(raw: unknown): DictionaryProduct | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const product: Partial<Record<Field, string>> = {};
  for (const field of FIELDS) {
    const value = clean(source[field]);
    if (value) product[field] = value;
  }
  return product.genericName ? (product as DictionaryProduct) : null;
}

/** 药名|规格|企业，忽略大小写和空白；存进指纹列，方便排查。 */
export function fingerprintOf(product: DictionaryProduct): string {
  const norm = (value: string | undefined) => (value ?? "").replace(/\s+/g, "").toLowerCase();
  return [product.genericName, product.specification, product.manufacturer].map(norm).join("|");
}

/**
 * 两次上报是不是「不同的药」。
 *
 * 药名必须一致；规格/企业/批准文号只在两边都有值时比较——第一次可能只拿到药名，
 * 第二次更完整，这不算冲突，只是补全。
 */
export function conflicts(existing: DictionaryProduct, incoming: DictionaryProduct): boolean {
  const norm = (value: string | undefined) => (value ?? "").replace(/\s+/g, "").toLowerCase();
  if (norm(existing.genericName) !== norm(incoming.genericName)) return true;
  for (const field of ["specification", "manufacturer", "approvalNumber"] as const) {
    const a = norm(existing[field]);
    const b = norm(incoming[field]);
    if (a && b && a !== b) return true;
  }
  return false;
}

export function prefixOf(code: string): string {
  return code.slice(0, PREFIX_LENGTH);
}

function parse(row: Row | null): DictionaryProduct | null {
  if (!row) return null;
  try {
    return normalizeProduct(JSON.parse(row.product_json));
  } catch {
    return null;
  }
}

export type DictionaryHit = { prefix: string; product: DictionaryProduct; samples: number };

/** 按标识码前缀找一款以前查过的产品；没有、停用、或数据坏了都返回 null。 */
export async function lookupProduct(db: D1Database, code: string): Promise<DictionaryHit | null> {
  if (code.length < PREFIX_LENGTH) return null;
  const prefix = prefixOf(code);
  const row = await db.prepare("SELECT prefix,product_json,fingerprint,samples,ambiguous FROM drug_dictionary WHERE prefix=?").bind(prefix).first<Row>();
  if (!row || row.ambiguous) return null;
  const product = parse(row);
  if (!product) return null;
  return { prefix: row.prefix, product, samples: row.samples };
}

export type StoreResult = "new" | "updated" | "conflict" | "ignored" | "unchanged";

/**
 * 记一次真实的查询结果。同一前缀出现不同药品时立刻停用这一条，
 * 之后只保留原来的产品信息，不再对外命中。
 */
export async function rememberProduct(db: D1Database, code: string, product: DictionaryProduct): Promise<StoreResult> {
  if (code.length < PREFIX_LENGTH) return "ignored";
  const prefix = prefixOf(code);
  const now = new Date().toISOString();
  const row = await db.prepare("SELECT prefix,product_json,fingerprint,samples,ambiguous FROM drug_dictionary WHERE prefix=?").bind(prefix).first<Row>();
  const existing = parse(row);

  if (!row || !existing) {
    await db.prepare("INSERT INTO drug_dictionary(prefix,product_json,fingerprint,samples,ambiguous,created_at,updated_at) VALUES(?,?,?,1,0,?,?) ON CONFLICT(prefix) DO UPDATE SET product_json=excluded.product_json,fingerprint=excluded.fingerprint,ambiguous=0")
      .bind(prefix, JSON.stringify(product), fingerprintOf(product), now, now).run();
    return "new";
  }
  if (row.ambiguous) return "ignored";

  if (conflicts(existing, product)) {
    await db.prepare("UPDATE drug_dictionary SET ambiguous=1,updated_at=? WHERE prefix=?").bind(now, prefix).run();
    return "conflict";
  }

  // 同一款药：次数 +1，并把这次多出来的字段补进去（不覆盖已有的）
  const merged: DictionaryProduct = { ...existing };
  for (const [field, value] of Object.entries(product)) {
    if (value) (merged as unknown as Record<string, string>)[field] = value;
  }
  const fingerprint = fingerprintOf(merged);
  if (fingerprint === row.fingerprint) {
    await db.prepare("UPDATE drug_dictionary SET samples=samples+1,updated_at=? WHERE prefix=?").bind(now, prefix).run();
    return "unchanged";
  }
  await db.prepare("UPDATE drug_dictionary SET product_json=?,fingerprint=?,samples=samples+1,updated_at=? WHERE prefix=?")
    .bind(JSON.stringify(merged), fingerprint, now, prefix).run();
  return "updated";
}

export async function dictionaryStats(db: D1Database): Promise<{ entries: number; ambiguous: number; samples: number }> {
  const row = await db.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(ambiguous),0) AS ambiguous, COALESCE(SUM(samples),0) AS samples FROM drug_dictionary")
    .first<{ entries: number; ambiguous: number; samples: number }>();
  return { entries: row?.entries ?? 0, ambiguous: row?.ambiguous ?? 0, samples: row?.samples ?? 0 };
}
