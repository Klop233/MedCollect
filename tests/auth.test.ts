import { before, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { account, rateLimit, user, verification } from "../src/lib/auth-schema";
import { getMailConfiguration, type AuthMail, type AuthMailer } from "../src/lib/mail";

const base = "http://localhost:3000";
const email = "collector@example.com";
const password = "Original-password-913";
const replacement = "Replacement-password-284";
let createAuth: typeof import("../src/lib/auth").createAuth;
let createDatabase: typeof import("../src/lib/db").createDatabase;

before(async () => {
  // Test processes never open the user's configured database or read SMTP secrets.
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.DATABASE_URL = "file::memory:";
  process.env.BETTER_AUTH_SECRET = "integration-test-only-secret-at-least-32-characters";
  process.env.BETTER_AUTH_URL = base;
  process.env.MAIL_MODE = "disabled";
  ({ createAuth } = await import("../src/lib/auth"));
  ({ createDatabase } = await import("../src/lib/db"));
});

async function fixture(options: { mailer?: AuthMailer; disabled?: boolean; throttle?: boolean } = {}) {
  const connection = createDatabase("file::memory:");
  await connection.client.execute("PRAGMA foreign_keys = ON");
  await migrate(connection.db, { migrationsFolder: resolve("drizzle") });
  const sent: AuthMail[] = [];
  const env = {
    NODE_ENV: "test",
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "integration-test-only-secret-at-least-32-characters",
    MAIL_MODE: "disabled",
  };
  const auth = createAuth(connection.db, {
    env,
    mailer: options.disabled ? undefined : options.mailer || (async (mail) => { sent.push(mail); }),
    rateLimitEnabled: options.throttle || false,
  });
  const request = (path: string, body?: unknown, cookie?: string) => auth.handler(new Request(`${base}/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: base,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  return { ...connection, auth, sent, request };
}

function cookie(response: Response) {
  return response.headers.getSetCookie().map((part) => part.split(";", 1)[0]).join("; ");
}

async function registerAndVerify(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.request("/sign-up/email", { email, password, name: "收藏者", callbackURL: `${base}/auth?verified=1` });
  assert.equal(response.status, 200, await response.text());
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].kind, "verify");
  const verifyResponse = await f.auth.handler(new Request(f.sent[0].url));
  assert.ok(verifyResponse.status >= 200 && verifyResponse.status < 400, await verifyResponse.text());
}

// Contract: our required-verification configuration gates real sessions, and resetting
// through the selected adapter invalidates every device without a stale cookie cache.
test("verified email gates collection sessions; password reset is single-use and revokes both devices", async () => {
  const f = await fixture();
  try {
    const signup = await f.request("/sign-up/email", { email, password, name: "收藏者", callbackURL: `${base}/auth?verified=1` });
    assert.equal(signup.status, 200, await signup.text());
    const blocked = await f.request("/sign-in/email", { email, password });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, "EMAIL_NOT_VERIFIED");

    const verified = await f.auth.handler(new Request(f.sent[0].url));
    assert.ok(verified.status < 400);
    const first = await f.request("/sign-in/email", { email, password });
    const second = await f.request("/sign-in/email", { email, password });
    assert.equal(first.status, 200, await first.text());
    assert.equal(second.status, 200, await second.text());
    const firstCookie = cookie(first);
    const secondCookie = cookie(second);
    assert.notEqual(firstCookie, secondCookie);
    assert.ok(await f.auth.api.getSession({ headers: new Headers({ cookie: firstCookie }) }));

    const unknown = await f.request("/request-password-reset", { email: "unknown@example.com", redirectTo: `${base}/auth?mode=reset` });
    const known = await f.request("/request-password-reset", { email, redirectTo: `${base}/auth?mode=reset` });
    assert.equal(known.status, 200);
    assert.deepEqual(await known.json(), await unknown.json(), "reset response must not enumerate registered emails");
    const reset = f.sent.find((mail) => mail.kind === "reset")!;
    const token = new URL(reset.url).pathname.split("/").at(-1)!;
    const response = await f.request("/reset-password", { token, newPassword: replacement });
    assert.equal(response.status, 200, await response.text());
    for (const deviceCookie of [firstCookie, secondCookie]) {
      assert.equal(await f.auth.api.getSession({ headers: new Headers({ cookie: deviceCookie }) }), null);
    }
    assert.equal((await f.request("/sign-in/email", { email, password })).status, 401);
    assert.equal((await f.request("/sign-in/email", { email, password: replacement })).status, 200);
    assert.equal((await f.request("/reset-password", { token, newPassword: "Another-password-571" })).status, 400);
  } finally {
    f.client.close();
  }
});

// Regression path: a driver with ineffective async transactions could consume the reset
// token or revoke sessions even though saving the password failed halfway through.
test("libSQL authentication transaction rolls back a failed reset, retaining sessions and the usable token", async () => {
  const f = await fixture();
  try {
    await registerAndVerify(f);
    const login = await f.request("/sign-in/email", { email, password });
    const deviceCookie = cookie(login);
    await f.request("/request-password-reset", { email, redirectTo: `${base}/auth?mode=reset` });
    const token = new URL(f.sent.find((mail) => mail.kind === "reset")!.url).pathname.split("/").at(-1)!;
    await f.client.execute("CREATE TRIGGER reject_password_change BEFORE UPDATE OF password ON account BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    const failed = await f.request("/reset-password", { token, newPassword: replacement });
    assert.ok(failed.status >= 400);
    assert.ok(await f.auth.api.getSession({ headers: new Headers({ cookie: deviceCookie }) }));
    assert.equal((await f.request("/sign-in/email", { email, password })).status, 200);
    await f.client.execute("DROP TRIGGER reject_password_change");
    const retried = await f.request("/reset-password", { token, newPassword: replacement });
    assert.equal(retried.status, 200, await retried.text());
    assert.equal(await f.auth.api.getSession({ headers: new Headers({ cookie: deviceCookie }) }), null);
  } finally {
    f.client.close();
  }
});

test("unconfigured and failed email delivery never report successful signup or leave a half-created account", async () => {
  for (const options of [{ disabled: true }, { mailer: async () => { throw new Error("provider offline"); } }]) {
    const f = await fixture(options);
    try {
      const response = await f.request("/sign-up/email", { email, password, name: "收藏者" });
      assert.equal(response.status, 503, await response.text());
      assert.equal((await f.db.select().from(user).where(eq(user.email, email))).length, 0);
      assert.equal((await f.db.select().from(account)).length, 0);
      assert.equal((await f.db.select().from(verification)).length, 0);
    } finally {
      f.client.close();
    }
  }
});

test("recipient resend limits persist across auth instances rather than reset on server recreation", async () => {
  const f = await fixture({ throttle: true });
  try {
    await f.request("/sign-up/email", { email, password, name: "收藏者" });
    for (let i = 0; i < 3; i++) {
      const response = await f.request("/send-verification-email", { email, callbackURL: `${base}/auth?verified=1` });
      assert.equal(response.status, 200, await response.text());
    }
    const restarted = createAuth(f.db, {
      env: { NODE_ENV: "test", BETTER_AUTH_URL: base, BETTER_AUTH_SECRET: "integration-test-only-secret-at-least-32-characters" },
      mailer: async () => { throw new Error("throttled requests must not reach delivery"); },
    });
    const response = await restarted.handler(new Request(`${base}/api/auth/send-verification-email`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ email }),
    }));
    assert.equal(response.status, 429, await response.text());
    assert.ok((await f.db.select().from(rateLimit)).length > 0);
  } finally {
    f.client.close();
  }
});

test("development mail capture cannot be pointed at a remote host or enabled in production", () => {
  assert.throws(() => getMailConfiguration({ MAIL_MODE: "mailpit", NODE_ENV: "production" }));
  assert.throws(() => getMailConfiguration({ MAIL_MODE: "mailpit", NODE_ENV: "development", SMTP_HOST: "mail.example.com" }));
});
