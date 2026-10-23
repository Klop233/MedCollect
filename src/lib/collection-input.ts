import { z } from "zod";
import { calculateMass } from "./mass";

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
