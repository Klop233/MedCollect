import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { lookupTrace } from "../src/lib/trace";

const code = "01234567890123456789";
const envNames = ["NODE_ENV", "TRACE_API_URL", "TRACE_API_METHOD", "TRACE_API_BODY_TYPE", "TRACE_API_CODE_PARAM", "TRACE_API_PARAMS_JSON", "TRACE_API_TOKEN", "TRACE_API_HEADERS_JSON", "TRACE_API_RESPONSE_PATH", "TRACE_API_FIELD_MAP_JSON"];
const savedEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
beforeEach(() => { for (const key of envNames) delete process.env[key]; Object.assign(process.env, { NODE_ENV: "test" }); });
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envNames) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
});
function enable(values: Record<string, string> = {}) { Object.assign(process.env, { TRACE_API_URL: "https://medicine.example.test/query", ...values }); }
function candidate(overrides: Record<string, unknown> = {}) { return { traceCode: code, genericName: "示例药片", manufacturer: "示例企业", specification: "250mg × 24片", ...overrides }; }

// Contract: configured transports receive the exact string code and private credentials.
// Independent regression paths: URL merging/form coercion and a leftover provider-specific filter.
test("GET sends a long non-provider-specific code and static query parameters to the configured endpoint with private bearer auth", async () => {
  enable({ TRACE_API_URL: "https://medicine.example.test/query?locale=zh", TRACE_API_CODE_PARAM: "trace_code", TRACE_API_TOKEN: "private-test-token", TRACE_API_PARAMS_JSON: '{"channel":"archive","limit":1,"trace_code":"stale-configured-code"}' });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, "https://medicine.example.test/query");
    assert.equal(url.searchParams.get("locale"), "zh");
    assert.equal(url.searchParams.get("trace_code"), code);
    assert.equal(url.searchParams.get("channel"), "archive");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-test-token");
    assert.equal(init?.redirect, "manual");
    return Response.json(candidate());
  };
  const result = await lookupTrace(code, "CODE_128");
  assert.equal(result.status, "found");
  assert.equal(result.candidate?.genericName, "示例药片");
  assert.ok(!JSON.stringify(result).includes("private-test-token"));
});

test("POST JSON and form transports keep the code as data and apply custom authentication headers", async () => {
  for (const bodyType of ["json", "form"]) {
    enable({ TRACE_API_METHOD: "POST", TRACE_API_BODY_TYPE: bodyType, TRACE_API_CODE_PARAM: "serial", TRACE_API_PARAMS_JSON: '{"key":"provider-key","code":"static-value"}', TRACE_API_HEADERS_JSON: '{"X-API-Key":"private-header"}' });
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).searchParams.has("serial"), false);
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "private-header");
      const body = bodyType === "json" ? JSON.parse(String(init?.body)) : Object.fromEntries(new URLSearchParams(String(init?.body)));
      assert.equal(body.serial, code); assert.equal(body.key, "provider-key"); assert.equal(body.code, "static-value");
      return Response.json(candidate());
    };
    assert.equal((await lookupTrace(code)).status, "found");
  }
});

test("response root and field paths adapt nested data and explicit mass instead of guessing specifications", async () => {
  enable({ TRACE_API_METHOD: "POST", TRACE_API_PARAMS_JSON: '{"options":{"language":"zh"}}', TRACE_API_RESPONSE_PATH: "data.items", TRACE_API_FIELD_MAP_JSON: JSON.stringify({
    genericName: "drug.name", manufacturer: "drug.factory", specification: "drug.pack", traceCode: "serial", batchNumber: "batch.number", expiresAt: "batch.expiry",
    massValue: "mass.amount", massUnit: "mass.unit", massQuantity: "mass.count", massBasis: "mass.note",
  }) });
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).options, { language: "zh" });
    return Response.json({ data: { items: [{ serial: code, drug: { name: "示例药片", factory: "示例企业", pack: "明确标注规格" }, batch: { number: "B-01", expiry: "20281231" }, mass: { amount: "250", unit: "mg", count: 24, note: "标签每片250mg，共24片，经用户核对" } }] } });
  };
  const result = await lookupTrace(code);
  assert.equal(result.status, "found"); assert.equal(result.candidate?.manufacturer, "示例企业");
  assert.equal(result.candidate?.batchNumber, "B-01"); assert.equal(result.candidate?.expiresAt, "2028-12-31");
  assert.deepEqual(result.candidate?.suggestedMass, { value: "250", unit: "mg", quantity: "24", basis: "标签每片250mg，共24片，经用户核对" });
});

test("arrays require a unique code match and never silently choose another box", async () => {
  enable();
  const cases: [unknown, string][] = [
    [[candidate({ traceCode: "different", genericName: "另一盒" }), candidate()], "found"],
    [[candidate(), candidate()], "failed"], [[{ genericName: "候选一" }, { genericName: "候选二" }], "failed"],
    [[candidate({ traceCode: "different" })], "failed"], [candidate({ traceCode: Number(code) }), "failed"],
    [{ genericName: "不返回单盒码的查询服务" }, "found"], [{ message: "business error, no drug" }, "failed"],
    [null, "not_found"], [[], "not_found"],
  ];
  for (const [payload, status] of cases) { globalThis.fetch = async () => Response.json(payload); assert.equal((await lookupTrace(code)).status, status); }
});

test("field paths support numeric indexes but never inherit prototype values", async () => {
  enable({ TRACE_API_RESPONSE_PATH: "records.0", TRACE_API_FIELD_MAP_JSON: '{"genericName":"names.0","traceCode":""}' });
  globalThis.fetch = async () => Response.json({ records: [{ names: ["数组字段药名"] }] });
  assert.equal((await lookupTrace(code)).candidate?.genericName, "数组字段药名");
  process.env.TRACE_API_FIELD_MAP_JSON = '{"genericName":"toString"}';
  globalThis.fetch = async () => Response.json({ records: [{}] });
  assert.equal((await lookupTrace(code)).status, "failed");
});

test("missing/invalid configuration and unsafe code content never make an outbound request", async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not request"); };
  assert.equal((await lookupTrace(code)).status, "unconfigured");
  for (const input of ["https://untrusted.test/", "6900000000000", "a".repeat(201), "code\nheader"]) assert.equal((await lookupTrace(input)).status, "unsupported");
  const invalid: Record<string, string>[] = [
    { TRACE_API_URL: "http://public.example.test/query" }, { TRACE_API_URL: "https://user:secret@medicine.example.test/query" },
    { TRACE_API_URL: "https://medicine.example.test/{code}" }, { TRACE_API_URL: "https://medicine.example.test/%7Bcode%7D" }, { TRACE_API_URL: "https://medicine.example.test/#fragment" },
    { TRACE_API_METHOD: "DELETE" }, { TRACE_API_HEADERS_JSON: '{"Authorization":"Basic custom"}', TRACE_API_TOKEN: "conflicting-token" },
    { TRACE_API_HEADERS_JSON: '{"Host":"untrusted.test"}' }, { TRACE_API_PARAMS_JSON: '{"nested":{"value":"not-a-query-scalar"}}' },
    { TRACE_API_FIELD_MAP_JSON: '{"genericName":"__proto__.name"}' }, { TRACE_API_RESPONSE_PATH: "constructor.prototype" },
  ];
  for (const values of invalid) {
    for (const name of envNames) if (name !== "NODE_ENV") delete process.env[name];
    enable(values); assert.equal((await lookupTrace(code)).status, "failed");
  }
  assert.equal(calls, 0);
});

test("local HTTP endpoints are usable for development but not production", async () => {
  enable({ TRACE_API_URL: "http://127.0.0.1:4567/lookup" });
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json(candidate()); };
  assert.equal((await lookupTrace(code)).status, "found");
  Object.assign(process.env, { NODE_ENV: "production" });
  assert.equal((await lookupTrace(code)).status, "failed"); assert.equal(calls, 1);
});

test("unconvertible or incomplete mass remains manual even when the interface returns a drug", async () => {
  enable();
  for (const suggestedMass of [
    { value: "10", unit: "ml", quantity: "1", basis: "体积" }, { value: "400", unit: "IU", quantity: "24", basis: "效价单位" },
    { value: "250", unit: "mg", quantity: "24" }, { value: "0", unit: "g", quantity: "1", basis: "错误值" },
    { value: "1", unit: "g", quantity: "0", basis: "错误数量" },
  ]) {
    globalThis.fetch = async () => Response.json(candidate({ suggestedMass }));
    const result = await lookupTrace(code); assert.equal(result.status, "found"); assert.equal(result.candidate?.suggestedMass, undefined);
  }
});

test("HTTP access, missing data, malformed/oversized/non-JSON results preserve truthful fallback states", async () => {
  enable({ TRACE_API_TOKEN: "secret-never-returned" });
  const cases: [Response, string][] = [
    [new Response("sensitive upstream", { status: 401 }), "forbidden"], [new Response("sensitive upstream", { status: 403 }), "forbidden"],
    [new Response("missing", { status: 404 }), "not_found"], [new Response(null, { status: 204 }), "not_found"], [new Response("upstream failed", { status: 500 }), "failed"],
    [new Response("{}", { status: 428 }), "failed"], [new Response("{}", { status: 429 }), "failed"],
    [new Response(null, { status: 307, headers: { Location: "https://another-endpoint.example.test/" } }), "failed"],
    [new Response("not JSON", { headers: { "content-type": "application/json" } }), "failed"], [new Response("{}", { headers: { "content-type": "text/html" } }), "failed"],
    [new Response("{}", { headers: { "content-type": "application/json", "content-length": "2000000" } }), "failed"],
    [new Response("x".repeat(1_000_001), { headers: { "content-type": "application/json" } }), "failed"],
  ];
  for (const [response, status] of cases) {
    globalThis.fetch = async () => response;
    const result = await lookupTrace(code); assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result).includes("secret-never-returned")); assert.ok(!JSON.stringify(result).includes("sensitive upstream"));
  }
});

test("需要人机验证或被限流时给出可执行说明，而不是笼统的接口不可用", async () => {
  enable();
  for (const [status, pattern] of [[428, /人工验证/], [429, /限流/]] as [number, RegExp][]) {
    globalThis.fetch = async () => new Response("{}", { status });
    const result = await lookupTrace(code);
    assert.equal(result.status, "failed"); assert.match(result.message, pattern);
  }
});

test("the timeout also cancels a body that stops streaming after HTTP headers", async (t) => {
  enable(); t.mock.timers.enable({ apis: ["setTimeout"] });
  let canceled = false;
  globalThis.fetch = async (_url, init) => {
    assert.ok(init?.signal);
    return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
  };
  const pending = lookupTrace(code);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(10_000);
  assert.equal((await pending).status, "failed"); assert.equal(canceled, true);
  t.mock.timers.reset();
});
