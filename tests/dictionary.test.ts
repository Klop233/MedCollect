import { test } from "node:test";
import assert from "node:assert/strict";
import { workerFixture } from "./worker-fixture";
import {
  dictionaryStats, fingerprintOf, lookupProduct, normalizeProduct, prefixOf, rememberProduct,
} from "../src/lib/dictionary";

const CODE_A = "81123456789012345678";
const CODE_B = "81123450000000000001";     // 同款药的另一盒，只有序列号不同
const CODE_OTHER = "81123456789012345699";
const PRODUCT = { genericName: "示例阿莫西林胶囊", manufacturer: "示例制药有限公司", specification: "0.25g×24粒/盒" };

test("只收产品级字段：批号、有效期这类每盒不同的信息进不了字典", () => {
  const product = normalizeProduct({
    ...PRODUCT, batchNumber: "B2408001", batch_no: "B2408001", expiresAt: "2028-07-31",
    expiryDate: "2028-07-31", productionDate: "2024-08-01", scanCount: 3, traceCode: CODE_A,
  });
  assert.deepEqual(product, PRODUCT);
  assert.equal(normalizeProduct({ batchNumber: "B1" }), null);          // 没有药名就不收
  assert.equal(normalizeProduct("药"), null);
  assert.equal(normalizeProduct(PRODUCT)?.genericName, PRODUCT.genericName);
});

test("指纹忽略空白和大小写，前缀取前 7 位", () => {
  assert.equal(prefixOf(CODE_A), "8112345");
  assert.equal(fingerprintOf({ genericName: "A 片", specification: "0.5g", manufacturer: "某厂" }),
    fingerprintOf({ genericName: " a片 ", specification: "0.5g ", manufacturer: "某厂" }));
  assert.notEqual(fingerprintOf({ genericName: "A 片" }), fingerprintOf({ genericName: "B 片" }));
});

test("D1：同款药的第二盒直接命中，次数累加", async () => {
  const f = await workerFixture();
  try {
    assert.equal(await rememberProduct(f.DB, CODE_A, PRODUCT), "new");
    assert.equal(await rememberProduct(f.DB, CODE_B, PRODUCT), "unchanged");   // 没有新字段，只加次数

    const hit = await lookupProduct(f.DB, "81123450000000009999");
    assert.equal(hit?.prefix, "8112345");
    assert.equal(hit?.product.genericName, PRODUCT.genericName);
    assert.equal(hit?.samples, 2);
    assert.equal(await lookupProduct(f.DB, "9999999"), null);                  // 别的标识码没有
    assert.deepEqual(await dictionaryStats(f.DB), { entries: 1, ambiguous: 0, samples: 2 });
  } finally {
    await f.dispose();
  }
});

test("D1：同一前缀出现不同药品就停用，宁可少缓存也不给错药名", async () => {
  const f = await workerFixture();
  try {
    await rememberProduct(f.DB, CODE_A, PRODUCT);
    assert.equal(await rememberProduct(f.DB, CODE_OTHER, { ...PRODUCT, genericName: "别的药片" }), "conflict");
    assert.equal(await lookupProduct(f.DB, CODE_B), null);
    assert.equal(await rememberProduct(f.DB, CODE_B, PRODUCT), "ignored");
    assert.deepEqual(await dictionaryStats(f.DB), { entries: 1, ambiguous: 1, samples: 1 });

    const row = await f.DB.prepare("SELECT product_json FROM drug_dictionary WHERE prefix=?").bind("8112345").first<{ product_json: string }>();
    assert.equal(JSON.parse(row!.product_json).genericName, PRODUCT.genericName);   // 原来的资料还在，只是不再命中
  } finally {
    await f.dispose();
  }
});

test("D1：后查到的字段会补进已有条目，不覆盖原来的", async () => {
  const f = await workerFixture();
  try {
    await rememberProduct(f.DB, CODE_A, { genericName: PRODUCT.genericName });
    assert.equal(await rememberProduct(f.DB, CODE_B, { ...PRODUCT, approvalNumber: "国药准字H00000001" }), "updated");
    const product = (await lookupProduct(f.DB, CODE_A))?.product;
    assert.equal(product?.manufacturer, PRODUCT.manufacturer);
    assert.equal(product?.approvalNumber, "国药准字H00000001");
  } finally {
    await f.dispose();
  }
});
