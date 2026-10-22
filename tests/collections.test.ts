import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { AppError, createCollectionService } from "../src/lib/collections";
import { boxes, medicines, user } from "../src/lib/schema";

// The singleton is unused by these services, but must not touch a real data file.
process.env.DATABASE_URL = "file::memory:";
const { createDatabase } = await import("../src/lib/db");

const codeA = "80000000000000000001";
const codeB = "80000000000000000002";
const codeC = "80000000000000000003";
const pending = { mode: "pending" as const };

function record(traceCode: string, genericName = "测试药片") {
  return {
    traceCode,
    genericName,
    manufacturer: "测试生产企业",
    mass: { mode: "unit" as const, value: "0.5", unit: "g" as const, quantity: "20" },
  };
}

async function context(t: TestContext) {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, "medcollect-collections-"));
  const url = "file:" + join(directory, "collection.db").replaceAll("\\", "/");
  const first = createDatabase(url);
  const clients = [first.client];
  t.after(async () => {
    for (const client of clients) client.close();
    // Guard the only recursive cleanup: it must remain our generated temp directory.
    if (!resolve(directory).startsWith(root + sep + "medcollect-collections-")) {
      throw new Error("Refusing cleanup outside collection test temp directory");
    }
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      // Native SQLite statements can release their Windows file handle after close.
      // Disposable OS-temp artifacts must not hide a successful contract assertion.
      if (!["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      t.diagnostic(`SQLite test artifact temporarily locked; retained in OS temp: ${directory}`);
    }
  });
  await first.ready;
  await migrate(first.db, { migrationsFolder: resolve("drizzle") });
  await first.db.insert(user).values([
    { id: "owner-a", name: "A", email: "a@example.test", emailVerified: true },
    { id: "owner-b", name: "B", email: "b@example.test", emailVerified: true },
  ]);
  const second = createDatabase(url);
  clients.push(second.client);
  await second.ready;
  return {
    db: first.db,
    client: first.client,
    a: createCollectionService(first.db),
    otherConnection: createCollectionService(second.db),
  };
}

test("two device connections collecting the same trace code create one box without overwriting its data", async (t) => {
  const { a, otherConnection } = await context(t);
  const results = await Promise.all([
    a.save("owner-a", record(codeA)),
    otherConnection.save("owner-a", record(codeA)),
  ]);
  assert.equal(results.filter((result) => result.duplicate).length, 1);
  assert.equal(results[0].box.id, results[1].box.id);
  assert.equal((await a.list("owner-a"))[0].totalGrams, "10");
  assert.equal((await a.list("owner-a"))[0].boxCount, 1);
  const duplicate = await a.save("owner-a", { ...record(codeA, "不能覆盖原药名"), mass: pending });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.box.genericName, "测试药片");
  assert.equal(duplicate.box.massGrams, "10");
  assert.equal((await a.list("owner-a")).length, 1);
  // A code is unique within an account, not globally; another owner learns nothing about A.
  const own = await a.save("owner-b", record(codeA, "B自己的药品"));
  assert.equal(own.duplicate, false);
  assert.notEqual(own.box.id, results[0].box.id);
});

test("different traces for the same normalized drug merge across connections and preserve per-box manufacturer and mass", async (t) => {
  const { a, otherConnection } = await context(t);
  await Promise.all([
    a.save("owner-a", record(codeA, "  测试  药片  ")),
    otherConnection.save("owner-a", {
      ...record(codeB, "测试 药片"), manufacturer: "另一厂家",
      mass: { mode: "unit", value: "250", unit: "mg", quantity: "24" },
    }),
  ]);
  await a.save("owner-a", { ...record(codeC, "测试 药片"), mass: pending });
  const items = await a.list("owner-a");
  assert.equal(items.length, 1);
  assert.equal(items[0].totalGrams, "16");
  assert.equal(items[0].boxCount, 3);
  assert.equal(items[0].pendingCount, 1);
  const detail = await a.detail("owner-a", items[0].id);
  assert.equal(detail.boxes.find((box) => box.traceCode === codeB)?.manufacturer, "另一厂家");
  assert.equal(detail.boxes.find((box) => box.traceCode === codeC)?.massGrams, null);
});

test("read, update, delete, list and export remain scoped to the session owner even when another object's ID is known", async (t) => {
  const { a } = await context(t);
  const alice = await a.save("owner-a", record(codeA, "A的私人药品"));
  const bob = await a.save("owner-b", record(codeB, "B的私人药品"));
  const missing = (error: unknown) => error instanceof AppError && error.status === 404;
  await assert.rejects(a.detail("owner-b", alice.medicine.id), missing);
  await assert.rejects(a.save("owner-b", record(codeC, "越权改名"), alice.box.id), missing);
  await assert.rejects(a.remove("owner-b", alice.box.id), missing);
  const exported = await a.exportData("owner-b");
  assert.deepEqual(exported.boxes.map((box) => box.id), [bob.box.id]);
  assert.deepEqual(exported.medicines.map((medicine) => medicine.id), [bob.medicine.id]);
  assert.ok(!JSON.stringify(exported).includes(codeA));
  assert.ok(!JSON.stringify(exported).includes("ownerId"));
  assert.ok(!JSON.stringify(exported).includes("traceKey"));
  assert.equal((await a.detail("owner-a", alice.medicine.id)).boxes[0].genericName, "A的私人药品");
});

test("correcting the last box's drug name merges groups, recomputes mass and removes empty album entries", async (t) => {
  const { a, db } = await context(t);
  const first = await a.save("owner-a", record(codeA, "错别字药名"));
  const second = await a.save("owner-a", { ...record(codeB, "正确药名"), mass: { mode: "unit", value: "250", unit: "mg", quantity: "24" } });
  const corrected = await a.save("owner-a", record(codeA, "正确药名"), first.box.id);
  assert.equal(corrected.medicine.id, second.medicine.id);
  assert.equal(corrected.medicine.totalGrams, "16");
  assert.equal((await a.list("owner-a")).length, 1);
  assert.equal((await db.select().from(medicines).where(eq(medicines.ownerId, "owner-a"))).length, 1);
  await a.remove("owner-a", first.box.id);
  const reduced = await a.detail("owner-a", second.medicine.id);
  assert.equal(reduced.medicine.totalGrams, "6");
  assert.ok(reduced.medicine.level < corrected.medicine.level);
  await a.remove("owner-a", second.box.id);
  assert.deepEqual(await a.list("owner-a"), []);
  assert.equal((await db.select().from(medicines).where(eq(medicines.ownerId, "owner-a"))).length, 0);
});

test("editing to another stored code is a conflict, never an overwrite or an extra empty drug", async (t) => {
  const { a, db } = await context(t);
  const first = await a.save("owner-a", record(codeA));
  const second = await a.save("owner-a", record(codeB));
  await assert.rejects(
    a.save("owner-a", record(codeB, "不应残留的药名"), first.box.id),
    (error: unknown) => error instanceof AppError && error.status === 409,
  );
  const detail = await a.detail("owner-a", first.medicine.id);
  assert.deepEqual(new Set(detail.boxes.map((box) => box.id)), new Set([first.box.id, second.box.id]));
  assert.equal(detail.medicine.totalGrams, "20");
  assert.equal((await db.select().from(medicines).where(eq(medicines.ownerId, "owner-a"))).length, 1);
});

test("failure while inserting a box rolls back the newly created drug instead of leaving a phantom item", async (t) => {
  const { a, db, client } = await context(t);
  // Deliberate independent failure after the drug insert exercises our transaction boundary.
  await client.execute("CREATE TRIGGER collection_insert_failure BEFORE INSERT ON collection_boxes BEGIN SELECT RAISE(ABORT, 'test insertion failure'); END");
  await assert.rejects(a.save("owner-a", record(codeA)));
  assert.equal((await db.select().from(medicines).where(eq(medicines.ownerId, "owner-a"))).length, 0);
  assert.deepEqual((await a.exportData("owner-a")).boxes, []);
});

test("normalization must not bypass the trace length boundary and invalid calendar dates cannot be stored", async (t) => {
  const { a } = await context(t);
  const invalid = (error: unknown) => error instanceof AppError && error.status === 400;
  // Each ligature is one input character but NFKC expands it to three ASCII characters.
  await assert.rejects(a.save("owner-a", record("ﬃ".repeat(100))), invalid);
  await assert.rejects(a.save("owner-a", { ...record(codeA), expiresAt: "2026-02-30" }), invalid);
  assert.deepEqual(await a.list("owner-a"), []);
});

test("provider-neutral provenance preserves legacy collections through detail, export and editing", async (t) => {
  const { a, db } = await context(t);
  const saved = await a.save("owner-a", { ...record(codeA), source: "api" });
  assert.equal(saved.box.source, "api");
  // Reproduce a pre-refactor stored row independently of the new input contract.
  // A missed read mapper would otherwise leak the obsolete source or make editing fail.
  await db.update(boxes).set({ source: "alihealth" }).where(eq(boxes.id, saved.box.id));
  const detail = await a.detail("owner-a", saved.medicine.id);
  const exported = await a.exportData("owner-a");
  for (const box of [detail.boxes[0], exported.boxes[0]]) {
    assert.equal(box.source, "api");
    assert.equal(box.id, saved.box.id);
    assert.equal(box.genericName, saved.box.genericName);
    assert.equal(box.massGrams, "10");
    assert.equal(box.massBasis, saved.box.massBasis);
  }
  const edited = await a.save("owner-a", { ...record(codeA), source: detail.boxes[0].source, notes: "updated note" }, saved.box.id);
  assert.equal(edited.box.source, "api");
  assert.equal(edited.box.notes, "updated note");
  assert.equal(edited.medicine.totalGrams, "10");
});
