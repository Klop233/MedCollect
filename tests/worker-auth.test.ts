import { test } from "node:test";
import assert from "node:assert/strict";
import { workerFixture } from "./worker-fixture";
import { createWorkerAuth } from "../src/lib/worker-auth";
import type { WorkerMail } from "../src/lib/worker-mail";
const base = "http://localhost:5173", email = "worker@test.local", password = "worker-original-12345", next = "worker-replaced-12345";
function cookie(r: Response) { return r.headers.getSetCookie().map(c => c.split(";", 1)[0]).join("; "); }
async function setup() { const f = await workerFixture(); const sent: WorkerMail[] = []; const auth = createWorkerAuth(f.env, { rateLimitEnabled: false, mailer: async mail => { sent.push(mail); } });
  const request = (path: string, value?: unknown, cookies?: string) => auth.handler(new Request(base + "/api/auth" + path, { method: value === undefined ? "GET" : "POST", headers: { origin: base, ...(value === undefined ? {} : { "content-type": "application/json" }), ...(cookies ? { cookie: cookies } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }));
  const signup = await request("/sign-up/email", { email, password, name: "Worker收藏者", callbackURL: "/verify-email?verified=true" }); assert.equal(signup.status, 200, await signup.text());
  return { ...f, auth, sent, request }; }
test("D1 authentication verifies email and atomically resets a one-use token while revoking both devices", async () => {
  const f = await setup(); try {
    assert.equal((await f.request("/sign-in/email", { email, password })).status, 403);
    assert.ok((await f.auth.handler(new Request(f.sent[0].url))).status < 400);
    const a = await f.request("/sign-in/email", { email, password }), b = await f.request("/sign-in/email", { email, password }); assert.equal(a.status, 200, await a.clone().text()); assert.equal(b.status, 200, await b.clone().text());
    const cookies = [cookie(a), cookie(b)]; await f.request("/request-password-reset", { email, redirectTo: "/reset-password" }); const token = new URL(f.sent.at(-1)!.url).pathname.split("/").at(-1)!;
    await f.DB.prepare("CREATE TRIGGER fail_password BEFORE UPDATE OF password ON account BEGIN SELECT RAISE(ABORT,'injected'); END").run();
    assert.equal((await f.request("/reset-password", { token, newPassword: next })).status, 503);
    for (const c of cookies) assert.ok(await f.auth.api.getSession({ headers: new Headers({ cookie: c }) }));
    assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM verification WHERE identifier=?").bind(`reset-password:${token}`).first<{ n: number }>())?.n, 1);
    await f.DB.prepare("DROP TRIGGER fail_password").run();
    const outcomes = await Promise.all([f.request("/reset-password", { token, newPassword: next }), f.request("/reset-password", { token, newPassword: next })]); assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 400]);
    for (const c of cookies) assert.equal(await f.auth.api.getSession({ headers: new Headers({ cookie: c }) }), null);
    const logged = await f.request("/sign-in/email", { email, password: next });
    const other = await f.request("/sign-in/email", { email, password: next });
    assert.equal(logged.status, 200);
    const current = cookie(logged), otherCookie = cookie(other), changed = "worker-changed-12345";
    assert.equal((await f.request("/change-password", { currentPassword: "incorrect", newPassword: changed }, current)).status, 400);
    await f.DB.prepare("CREATE TRIGGER fail_revoke BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT,'injected'); END").run();
    assert.equal((await f.request("/change-password", { currentPassword: next, newPassword: changed }, current)).status, 503);
    assert.ok(await f.auth.api.getSession({ headers: new Headers({ cookie: otherCookie }) }));
    await f.DB.prepare("DROP TRIGGER fail_revoke").run();
    assert.equal((await f.request("/change-password", { currentPassword: next, newPassword: changed }, current)).status, 200);
    assert.ok(await f.auth.api.getSession({ headers: new Headers({ cookie: current }) }));
    assert.equal(await f.auth.api.getSession({ headers: new Headers({ cookie: otherCookie }) }), null);
    assert.equal((await f.request("/sign-in/email", { email, password: changed })).status, 200);
  } finally { await f.dispose(); }
});
test("D1 signup compensates only its unverified account on delivery failure and missing mail never reports success", async () => {
  const f = await workerFixture(); try {
    const configured = createWorkerAuth(f.env, { rateLimitEnabled: false, mailer: async () => undefined });
    const invalid = await configured.handler(new Request(base + "/api/auth/sign-up/email", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ email: "broken@.example.test", password, name: "无效邮箱" }) }));
    assert.equal(invalid.status, 400);
    const tooLarge = await configured.handler(new Request(base + "/api/auth/sign-up/email", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ email, password, name: "x".repeat(40_000) }) }));
    assert.equal(tooLarge.status, 413);
    for (const mode of ["disabled", "failed"]) {
      const auth = createWorkerAuth(f.env, { rateLimitEnabled: false, ...(mode === "failed" ? { mailer: async () => { throw new Error("private diagnostics"); } } : {}) });
      const r = await auth.handler(new Request(base + "/api/auth/sign-up/email", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ email, password, name: "新账号" }) }));
      assert.equal(r.status, 503); assert.ok(!(await r.text()).includes("private diagnostics")); assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM user").first<{ n: number }>())?.n, 0);
    }
  } finally { await f.dispose(); }
});
