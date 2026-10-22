/** Node-only HTTP adapter. Endpoint, credentials and mapping are server configuration. */
import { calculateMass } from "./mass";

export type TraceStatus = "found" | "unconfigured" | "forbidden" | "not_found" | "unsupported" | "failed";
export type TraceCandidate = {
  genericName: string; manufacturer?: string; specification?: string; batchNumber?: string; expiresAt?: string;
  suggestedMass?: { value: string; unit: "g" | "mg" | "ug"; quantity: string; basis: string };
};
export type TraceLookupResult = { status: TraceStatus; message: string; candidate?: TraceCandidate };
type JsonObject = Record<string, unknown>;
const DEFAULT_FIELDS = {
  genericName: "genericName", manufacturer: "manufacturer", specification: "specification",
  batchNumber: "batchNumber", expiresAt: "expiresAt", traceCode: "traceCode",
  massValue: "suggestedMass.value", massUnit: "suggestedMass.unit",
  massQuantity: "suggestedMass.quantity", massBasis: "suggestedMass.basis",
};
type FieldMap = typeof DEFAULT_FIELDS;
type TraceConfig = {
  url: URL; method: "GET" | "POST"; bodyType: "json" | "form"; codeParam: string;
  params: JsonObject; headers: Headers; responsePath: string; fields: FieldMap;
};
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const UNSAFE_PARTS = new Set(["__proto__", "prototype", "constructor"]);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseObject(raw: string | undefined): JsonObject {
  if (!raw?.trim()) return {};
  if (raw.length > 32_768) throw new Error("Configuration is too large");
  const value: unknown = JSON.parse(raw);
  if (!isObject(value)) throw new Error("Expected a JSON object");
  return value;
}
function validatePath(path: string): void {
  if (!path) return;
  const parts = path.split(".");
  if (path.length > 500 || parts.length > 20 || parts.some((part) => !part || UNSAFE_PARTS.has(part) || /[\s[\]{}]/.test(part))) throw new Error("Invalid field path");
}
/** Dot paths read own JSON properties only. No scripts or prototype traversal. */
function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let cursor = value;
  for (const part of path.split(".")) {
    if (UNSAFE_PARTS.has(part) || cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, part)) return undefined;
    cursor = (cursor as JsonObject)[part];
  }
  return cursor;
}
function mapped(value: unknown, path: string): unknown { return path ? readPath(value, path) : undefined; }
function scalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}
function configFromEnvironment(environment: Record<string,string|undefined>): TraceConfig | undefined {
  const rawUrl = environment.TRACE_API_URL?.trim();
  if (!rawUrl) return undefined;
  const url = new URL(rawUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback && environment.NODE_ENV !== "production"))
    || url.username || url.password || url.hash || /[{}]/.test(rawUrl) || /[{}]/.test(decodeURIComponent(url.pathname))) throw new Error("Expected a fixed HTTPS URL");
  const method = (environment.TRACE_API_METHOD?.trim() || "GET").toUpperCase();
  const bodyType = environment.TRACE_API_BODY_TYPE?.trim() || "json";
  if (method !== "GET" && method !== "POST") throw new Error("Unsupported request method");
  if (bodyType !== "json" && bodyType !== "form") throw new Error("Unsupported body type");
  const codeParam = environment.TRACE_API_CODE_PARAM?.trim() || "code";
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(codeParam) || UNSAFE_PARTS.has(codeParam)) throw new Error("Invalid trace parameter name");
  const params = parseObject(environment.TRACE_API_PARAMS_JSON);
  if ((method === "GET" || bodyType === "form") && Object.values(params).some((value) => !scalar(value))) throw new Error("Query and form parameters must be scalar");
  const headerValues = parseObject(environment.TRACE_API_HEADERS_JSON);
  if (Object.values(headerValues).some((value) => typeof value !== "string")) throw new Error("Header values must be strings");
  const headers = new Headers(headerValues as Record<string, string>);
  if (["host", "connection", "content-length", "transfer-encoding"].some((key) => headers.has(key))) throw new Error("Transport headers cannot be configured");
  const token = environment.TRACE_API_TOKEN?.trim();
  if (token) {
    if (headers.has("authorization")) throw new Error("Conflicting authorization configuration");
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (!headers.has("accept")) headers.set("Accept", "application/json");
  const responsePath = environment.TRACE_API_RESPONSE_PATH?.trim() || "";
  validatePath(responsePath);
  const overrides = parseObject(environment.TRACE_API_FIELD_MAP_JSON);
  if (Object.entries(overrides).some(([key, value]) => !Object.hasOwn(DEFAULT_FIELDS, key) || typeof value !== "string")) throw new Error("Unknown field mapping");
  const fields = { ...DEFAULT_FIELDS, ...overrides } as FieldMap;
  if (!fields.genericName) throw new Error("Drug name mapping is required");
  for (const path of Object.values(fields)) validatePath(path);
  return { url, method, bodyType, codeParam, params, headers, responsePath, fields };
}
function buildRequest(code: string, config: TraceConfig, signal: AbortSignal) {
  const url = new URL(config.url);
  const headers = new Headers(config.headers);
  // Scanned content is a value, never a destination or template fragment.
  const parameters = { ...config.params, [config.codeParam]: code };
  const init: RequestInit = { method: config.method, headers, cache: "no-store", redirect: "manual", signal };
  if (config.method === "GET") {
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  } else if (config.bodyType === "form") {
    headers.set("Content-Type", "application/x-www-form-urlencoded;charset=utf-8");
    init.body = new URLSearchParams(Object.entries(parameters).map(([key, value]) => [key, String(value)])).toString();
  } else {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(parameters);
  }
  return { url, init };
}
function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}
function normalizeDate(value: unknown): string | undefined {
  const raw = optionalString(value, 32);
  if (!raw) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})(?:0{6})?$/.exec(raw);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
  const date = new Date(iso + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : undefined;
}
function explicitMass(record: JsonObject, fields: FieldMap): TraceCandidate["suggestedMass"] {
  const rawValue = mapped(record, fields.massValue);
  const rawQuantity = mapped(record, fields.massQuantity);
  const value = typeof rawValue === "string" ? rawValue.trim() : undefined;
  const quantity = typeof rawQuantity === "string" ? rawQuantity.trim()
    : typeof rawQuantity === "number" && Number.isSafeInteger(rawQuantity) ? String(rawQuantity) : undefined;
  const rawUnit = optionalString(mapped(record, fields.massUnit), 8)?.toLowerCase();
  const unit = rawUnit === "g" || rawUnit === "mg" ? rawUnit : ["ug", "μg", "µg"].includes(rawUnit || "") ? "ug" : undefined;
  const basis = optionalString(mapped(record, fields.massBasis), 1000);
  if (!value || !quantity || !unit || !basis) return undefined;
  try { calculateMass({ mode: "unit", value, unit, quantity, basis }); return { value, unit, quantity, basis }; }
  catch { return undefined; }
}
function mapResponse(payload: unknown, requestedCode: string, config: TraceConfig): TraceLookupResult {
  const result = readPath(payload, config.responsePath);
  if (result === null || (Array.isArray(result) && result.length === 0)) return { status: "not_found", message: "查询接口未找到此追溯码，你可以手动补全收藏。" };
  let record: unknown = result;
  if (Array.isArray(result)) {
    if (result.length === 1) record = result[0];
    else {
      const matches = result.filter((item) => mapped(item, config.fields.traceCode) === requestedCode);
      if (matches.length !== 1) return { status: "failed", message: "查询接口返回多条无法唯一匹配的记录，请核对后手动补全。" };
      record = matches[0];
    }
  }
  if (!isObject(record)) return { status: "failed", message: "查询接口响应格式与字段配置不符，请检查配置或手动补全。" };
  const returnedCode = mapped(record, config.fields.traceCode);
  if (returnedCode !== undefined && (typeof returnedCode !== "string" || returnedCode !== requestedCode)) return { status: "failed", message: "查询结果中的追溯码与本次扫码不一致，请核对后手动补全。" };
  const genericName = optionalString(mapped(record, config.fields.genericName), 120);
  if (!genericName) return { status: "failed", message: "查询结果没有可用的通用药名，请检查字段映射或手动补全。" };
  return {
    status: "found", message: "找到候选药品，请按药盒确认药名、规格和有效成分质量；查询结果不等于实物验真。",
    candidate: {
      genericName, manufacturer: optionalString(mapped(record, config.fields.manufacturer), 200),
      specification: optionalString(mapped(record, config.fields.specification), 500),
      batchNumber: optionalString(mapped(record, config.fields.batchNumber), 100),
      expiresAt: normalizeDate(mapped(record, config.fields.expiresAt)), suggestedMass: explicitMass(record, config.fields),
    },
  };
}
async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error("Response too large");
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "";
    if (type !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(type)) throw new Error("Expected JSON response");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("Response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
  }
}
/** No endpoint comes from scanned data. Only the operator's configured endpoint is called. */
export async function lookupTrace(code: string, format?: string, environment: Record<string,string|undefined> = process.env): Promise<TraceLookupResult> {
  const normalized = code.normalize("NFKC").trim();
  if ((format && /EAN|UPC/i.test(format)) || (/^\d+$/.test(normalized) && [8, 12, 13, 14].includes(normalized.length))) return { status: "unsupported", message: "这是商品条码，不是每盒唯一的追溯码，请扫描药盒追溯码。" };
  if (!/^[A-Za-z0-9._+\-/=]{1,200}$/.test(normalized)) return { status: "unsupported", message: "不支持网址或未知码内容，请输入包装上的纯追溯码。" };
  let config: TraceConfig | undefined;
  try { config = configFromEnvironment(environment); }
  catch { return { status: "failed", message: "查询接口配置无效，请检查服务端接口地址、参数、鉴权及字段映射；仍可手动补全。" }; }
  if (!config) return { status: "unconfigured", message: "尚未配置药品查询接口。已识别码值，你可以手动补全收藏。" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { url, init } = buildRequest(normalized, config, controller.signal);
    const response = await fetch(url, init);
    if (!response.ok || response.status === 204) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) return { status: "forbidden", message: "查询接口拒绝访问，请核实服务端密钥或接口权限，或手动补全。" };
      if (response.status === 404 || response.status === 204) return { status: "not_found", message: "查询接口未找到此追溯码，可手动补全收藏。" };
      // 428/429 是服务端明确表示「需要人机验证 / 被上游限流」，比笼统的“不可用”更有用。
      if (response.status === 428) return { status: "failed", message: "查询服务需要先完成一次人工验证：本机会自动弹出验证窗口，拖完滑块后点“重新查询”。" };
      if (response.status === 429) return { status: "failed", message: "查询服务当前被上游限流，请稍后再试或手动补全。" };
      return { status: "failed", message: "药品查询接口暂不可用，请稍后重试或手动补全。" };
    }
    return mapResponse(await readBoundedJson(response, controller.signal), normalized, config);
  } catch {
    // Never return or log configured URLs, auth headers, scanned codes, or upstream bodies.
    return { status: "failed", message: "药品查询超时或返回异常，可重试或手动补全收藏。" };
  } finally { clearTimeout(timeout); }
}
