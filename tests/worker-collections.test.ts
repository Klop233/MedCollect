import { test } from "node:test";
import assert from "node:assert/strict";
import { workerFixture } from "./worker-fixture";
import { createWorkerCollectionService } from "../src/lib/worker-collections";
import { AppError } from "../src/lib/collections";
const record = (code: string, name = "迁移示例药片") => ({ traceCode: code, genericName: name, mass: { mode: "unit", value: "0.5", unit: "g", quantity: "20" } });
async function setup() { const f = await workerFixture(); await f.DB.batch([f.DB.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('a','A','a@test.local',1)"), f.DB.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('b','B','b@test.local',1)")]); return { ...f, service: createWorkerCollectionService(f.DB) }; }

// Migration contract: a real D1 batch replaces the old interactive transaction;
// concurrent worker requests must not overwrite a box or leave half a drug group.
test("D1 atomic batches deduplicate concurrent scans and preserve exact per-drug mass and labels", async () => {
  const f = await setup(); try {
    const results = await Promise.all([f.service.save("a", { ...record("00000000000000000001"), tags: ["抽屉", "常用", "抽屉"] }), f.service.save("a", { ...record("00000000000000000001"), tags: ["不应覆盖"] })]);
    assert.equal(results.filter(r => r.duplicate).length, 1); assert.equal(results[0].box.id, results[1].box.id);
    await f.service.save("a", { ...record("00000000000000000002"), mass: { mode: "unit", value: "250", unit: "mg", quantity: "24" }, manufacturer: "另一厂家" });
    await f.service.save("a", { ...record("00000000000000000003"), mass: { mode: "pending" } });
    const list = await f.service.list("a"); assert.equal(list.length, 1); assert.equal(list[0].totalGrams, "16"); assert.equal(list[0].pendingCount, 1); assert.equal(list[0].boxCount, 3);
    assert.deepEqual(list[0].manufacturers, ["另一厂家"]);
    await f.service.setTags("a", list[0].id, [" 新标签 ", "新标签"]); assert.deepEqual((await f.service.list("a"))[0].tags, ["新标签"]);
    const stats = await f.service.stats("a"); assert.equal(stats.tagCount, 1); assert.equal(stats.boxCount, 3); assert.equal(stats.pendingCount, 1); assert.equal(stats.monthly.at(-1)?.boxCount, 3);
  } finally { await f.dispose(); }
});
test("D1 insert failure rolls back the drug row; ownership and last-record deletion remain enforced", async () => {
  const f = await setup(); try {
    await f.DB.prepare("CREATE TRIGGER fail_box BEFORE INSERT ON collection_boxes BEGIN SELECT RAISE(ABORT,'injected'); END").run();
    await assert.rejects(f.service.save("a", record("00000000000000000001")));
    assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM medicines").first<{ n: number }>())?.n, 0);
    await f.DB.prepare("DROP TRIGGER fail_box").run();
    const one = await f.service.save("a", record("00000000000000000001", "原药名"));
    const two = await f.service.save("a", record("00000000000000000002", "正确药名"));
    const denied = (e: unknown) => e instanceof AppError && e.status === 404;
    await assert.rejects(f.service.detail("b", one.medicine.id), denied); await assert.rejects(f.service.setTags("b", one.medicine.id, ["越权"]), denied); await assert.rejects(f.service.remove("b", one.box.id), denied);
    const moved = await f.service.save("a", record("00000000000000000001", "正确药名"), one.box.id); assert.equal(moved.medicine.id, two.medicine.id); assert.equal(moved.medicine.totalGrams, "20"); assert.equal((await f.service.list("a")).length, 1);
    await f.service.remove("a", one.box.id); await f.service.remove("a", two.box.id); assert.deepEqual(await f.service.list("a"), []); assert.deepEqual((await f.service.exportData("b")).boxes, []);
  } finally { await f.dispose(); }
});
