import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupNatively, mapLocalPayload, mapNativePayload } from "../src/lib/local-lookup";

const code = "81123456789012345678";

// 浏览器直连本机服务：只认这个形状，字段不做任何猜测，超长或类型不对一律丢弃。
test("本机服务的 MedCollect 字段名可以直接变成候选药品", () => {
  const result = mapLocalPayload({
    traceCode: code, genericName: "示例阿莫西林胶囊", manufacturer: "示例制药有限公司",
    specification: "0.25g×24粒/盒", batchNumber: "B2408001", expiresAt: "2028-07-31",
  }, code);
  assert.equal(result?.status, "found");
  assert.deepEqual(result?.candidate, {
    genericName: "示例阿莫西林胶囊", manufacturer: "示例制药有限公司",
    specification: "0.25g×24粒/盒", batchNumber: "B2408001", expiresAt: "2028-07-31",
  });
  assert.equal(JSON.stringify(result?.candidate).includes("suggestedMass"), false);
});

test("只给药名也能用，多余和不合规的字段被丢弃", () => {
  const result = mapLocalPayload({
    traceCode: code, genericName: "  药名  ", manufacturer: 42, specification: "x".repeat(501),
    batchNumber: "", expiresAt: "2028/07/31", suggestedMass: { value: "1", unit: "g", quantity: "1", basis: "猜的" },
  }, code);
  assert.equal(result?.status, "found");
  assert.deepEqual(JSON.parse(JSON.stringify(result?.candidate)), { genericName: "药名" });
});

test("追溯码对不上、没有药名或根本不是该形状时不冒充成功", () => {
  assert.equal(mapLocalPayload({ traceCode: "99999999999999999999", genericName: "别的药" }, code)?.status, "failed");
  assert.equal(mapLocalPayload({ traceCode: code }, code)?.status, "failed");
  assert.equal(mapLocalPayload({ traceCode: code, genericName: 7 }, code)?.status, "failed");
  assert.equal(mapLocalPayload(null, code), null);
  assert.equal(mapLocalPayload("ok", code), null);
  assert.equal(mapLocalPayload([{ traceCode: code, genericName: "数组" }], code), null);
});

// 命中本机药品字典：只有产品级信息，不能让用户以为批号/有效期也已经查到了。
test("药品字典命中时说明批号和有效期要自己补", () => {
  const result = mapLocalPayload({
    traceCode: code, genericName: "示例阿莫西林胶囊", specification: "0.25g×24粒/盒",
    source: "drug_dict", batchKnown: false,
  }, code);
  assert.equal(result?.status, "found");
  assert.equal(result?.message.includes("批号和有效期"), true);
  assert.equal(JSON.stringify(result?.candidate).includes("batchNumber"), false);
  assert.equal(JSON.stringify(result?.candidate).includes("expiresAt"), false);
});

// APK 原生桥：请求由手机直接发给阿里，返回的是 {status, body} 或 {status, message}
test("手机原生桥的返回能变成同样的候选药品", () => {
  const found = mapNativePayload(JSON.stringify({
    status: 200,
    body: { traceCode: code, genericName: "示例阿莫西林胶囊", manufacturer: "示例制药有限公司", batchNumber: "B2408001" },
  }), code);
  assert.equal(found?.status, "found");
  assert.deepEqual(found?.candidate, {
    genericName: "示例阿莫西林胶囊", manufacturer: "示例制药有限公司", batchNumber: "B2408001",
  });

  assert.equal(mapNativePayload(JSON.stringify({ status: 404, error: "not_found", message: "查无此码" }), code)?.status, "not_found");
  assert.equal(mapNativePayload(JSON.stringify({ status: 428, error: "needs_human" }), code)?.status, "failed");
  assert.equal(mapNativePayload(JSON.stringify({ status: 400, message: "追溯码应为 20 位数字" }), code)?.status, "failed");
  assert.equal(mapNativePayload(JSON.stringify({ status: 502, message: "网络不通" }), code)?.message.includes("网络不通"), true);
});

test("原生桥的脏数据不冒充成功", () => {
  assert.equal(mapNativePayload("not json", code), null);
  assert.equal(mapNativePayload(null, code), null);
  assert.equal(mapNativePayload(JSON.stringify({ status: 200 }), code), null);
  assert.equal(mapNativePayload(JSON.stringify({ status: 200, body: { traceCode: "99999999999999999999", genericName: "别的药" } }), code)?.status, "failed");
  // 403 表示「不是本站页面」，当作没有这条路，让调用方回退
  assert.equal(mapNativePayload(JSON.stringify({ status: 403, message: "只接受本站页面调用" }), code), null);
});

// 没有桥（普通浏览器）时必须立刻返回 null，不能把扫码卡住
test("没有原生桥时不阻塞，直接回退", async () => {
  const global = globalThis as unknown as { window?: unknown };
  const before = global.window;
  delete global.window;
  try {
    assert.equal(await lookupNatively(code), null);
  } finally {
    if (before !== undefined) global.window = before;
  }
});

// 模拟 APK：MedCollectNative 回调 window.__medcollectTrace
test("原生桥的回调接线正确，且用完还原全局函数", async () => {
  const global = globalThis as unknown as { window?: Record<string, unknown> };
  const before = global.window;
  const view: Record<string, unknown> = {};
  view.MedCollectNative = {
    lookup(received: string, requestId: string) {
      assert.equal(received, code);
      setTimeout(() => {
        (view.__medcollectTrace as (id: string, json: string) => void)(requestId, JSON.stringify({
          status: 200, body: { traceCode: code, genericName: "示例阿莫西林胶囊" },
        }));
      }, 0);
    },
  };
  global.window = view;
  try {
    const result = await lookupNatively(code, 2000);
    assert.equal(result?.status, "found");
    assert.equal(result?.candidate?.genericName, "示例阿莫西林胶囊");
    assert.equal(view.__medcollectTrace, undefined);   // 回调已清理
  } finally {
    if (before === undefined) delete global.window;
    else global.window = before;
  }
});
