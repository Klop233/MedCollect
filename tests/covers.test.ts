import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCover, createCoverService } from "../src/lib/covers";
import { workerFixture } from "./worker-fixture";
import { createWorkerCollectionService } from "../src/lib/worker-collections";
import { AppError } from "../src/lib/collections";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
test("cover sanitization rejects active/oversized inputs and strips hidden metadata from a valid image", () => {
  const payload = Buffer.from("GPS=private-location"), header = Buffer.alloc(8); header.writeUInt32BE(payload.length); header.write("tEXt", 4);
  const withMetadata = Buffer.concat([png.subarray(0,33), header, payload, Buffer.alloc(4), png.subarray(33)]);
  const cleaned = sanitizeCover(withMetadata); assert.equal(cleaned.type, "image/png"); assert.deepEqual(Buffer.from(cleaned.bytes), png);
  assert.throws(() => sanitizeCover(Buffer.from('<svg onload="alert(1)"/>'))); assert.throws(() => sanitizeCover(new Uint8Array(5*1024*1024+1)));
});
test("R2 covers remain owner-private and replacing/deleting a cover cleans the previous object", async () => {
  const f = await workerFixture(); try {
    await f.DB.batch([f.DB.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('a','A','a@cover.test',1)"), f.DB.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('b','B','b@cover.test',1)")]);
    const saved = await createWorkerCollectionService(f.DB).save("a", { traceCode: "00000000000000000001", genericName: "封面示例片", mass: { mode: "pending" } });
    const service = createCoverService(f.env); await service.put("a", saved.medicine.id, png);
    assert.equal((await service.get("a", saved.medicine.id)).headers.get("cache-control"), "private, no-store");
    await assert.rejects(service.get("b", saved.medicine.id), (e: unknown) => e instanceof AppError && e.status===404);
    await assert.rejects(service.put("b", saved.medicine.id, png));
    await service.put("a", saved.medicine.id, png); assert.equal((await f.env.COVERS!.list()).objects.length, 1);
    await service.remove("a", saved.medicine.id); assert.equal((await f.env.COVERS!.list()).objects.length, 0);
    assert.equal((await createWorkerCollectionService(f.DB).list("a"))[0].hasCover, false);
  } finally { await f.dispose(); }
});
