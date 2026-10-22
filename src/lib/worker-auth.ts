import { betterAuth } from "better-auth";
import { createEmailVerificationToken, createAuthMiddleware } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { authSchema } from "./auth-schema";
import type { WorkerEnv } from "./worker-env";
import { createWorkerMailer, mailConfiguration, type WorkerMailer } from "./worker-mail";

class AuthFailure extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new AuthFailure("仅支持JSON请求", 415);
  const reader = request.body?.getReader(); if (!reader) throw new AuthFailure("请求不能为空");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 32_768) { void reader.cancel().catch(() => undefined); throw new AuthFailure("请求过大", 413); } chunks.push(value); }
  try { const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(c => [...c])))); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw new AuthFailure("JSON格式无效"); }
}
function password(value: unknown): string { if (typeof value !== "string" || value.length < 8 || value.length > 128) throw new AuthFailure("密码需要8–128个字符"); return value; }

/** Better Auth handles sessions; security-sensitive D1 writes use explicit atomic batches. */
export function createWorkerAuth(env: WorkerEnv, options: { mailer?: WorkerMailer; rateLimitEnabled?: boolean } = {}) {
  const origin = new URL(env.BETTER_AUTH_URL || "http://localhost:5173");
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || (origin.protocol !== "https:" && !(env.ENVIRONMENT === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && origin.protocol === "http:"))) throw new Error("需要正确的可信应用来源");
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error("请配置随机BETTER_AUTH_SECRET");
  const send = options.mailer || createWorkerMailer(env);
  const db = drizzle(env.DB, { schema: authSchema });
  const instance = betterAuth({
    appName: "MedCollect", baseURL: origin.origin, secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema, transaction: false }),
    trustedOrigins: [origin.origin],
    emailAndPassword: { enabled: true, requireEmailVerification: true, autoSignIn: false, minPasswordLength: 8, maxPasswordLength: 128, revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) => send({ to: user.email, url, kind: "reset" }) },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: ({ user, url }) => send({ to: user.email, url, kind: "verify" }) },
    session: { cookieCache: { enabled: false }, expiresIn: 7 * 86400, updateAge: 86400 },
    account: { accountLinking: { enabled: false } }, user: { changeEmail: { enabled: false } },
    advanced: { useSecureCookies: origin.protocol === "https:", defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" } },
    rateLimit: { enabled: false }, logger: { disabled: true }, onAPIError: { throw: true },
    hooks: { before: createAuthMiddleware(async ctx => { ctx.context.runInBackgroundOrAwait = async promise => await promise; }) },
  });
  async function throttle(request: Request, path: string, parsed?: Record<string, unknown>) {
    if (options.rateLimitEnabled === false) return;
    const email = typeof parsed?.email === "string" ? parsed.email.trim().toLowerCase() : "";
    // Only CF's verified connection header is trusted in production; clients cannot override it there.
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const counters: [string, number][] = [[`ip:${ip}`, 60], ...(email ? [[`email:${path}:${email}`, path.includes("sign-in") ? 10 : 5] as [string, number]] : [])];
    for (const [identity, max] of counters) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)));
      const key = `worker-auth:${Array.from(digest, b => b.toString(16).padStart(2, "0")).join("")}`, now = Date.now();
      const row = await env.DB.prepare(`INSERT INTO rate_limit(id,key,count,last_request) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN last_request<? THEN 1 ELSE count+1 END,last_request=CASE WHEN last_request<? THEN ? ELSE last_request END RETURNING count`).bind(crypto.randomUUID(), key, now, now - 60_000, now - 60_000, now).first<{ count: number }>();
      if (row && row.count > max) throw new AuthFailure("操作过于频繁，请稍后再试", 429);
    }
  }
  function callback(value: unknown, fallback: string) {
    const url = new URL(typeof value === "string" ? value : fallback, origin);
    if (url.origin !== origin.origin) throw new AuthFailure("回调地址来源无效", 403);
    return url.href;
  }
  async function signup(data: Record<string, unknown>) {
    if (!options.mailer) mailConfiguration(env);
    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "", name = typeof data.name === "string" ? data.name.trim() : "";
    if (!z.email().safeParse(email).success || email.length > 254 || !name || name.length > 40) throw new AuthFailure("请填写有效邮箱和1–40字昵称");
    const secret = password(data.password), redirect = callback(data.callbackURL, "/verify-email?verified=true");
    const hash = await hashPassword(secret);
    const existing = await env.DB.prepare("SELECT id FROM user WHERE email=?").bind(email).first();
    if (existing) return response({ token: null, status: true });
    const id = crypto.randomUUID(), now = Date.now();
    try { await env.DB.batch([
      env.DB.prepare("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,0,?,?)").bind(id, name, email, now, now),
      env.DB.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,'credential',?,?,?,?)").bind(crypto.randomUUID(), id, id, hash, now, now),
    ]); } catch (error) { if (/UNIQUE constraint failed.*email/i.test(String(error))) return response({ token: null, status: true }); throw error; }
    try {
      const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET!, email, undefined, 3600);
      const url = `${origin.origin}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(redirect)}`;
      await send({ to: email, url, kind: "verify" });
    } catch {
      await env.DB.prepare("DELETE FROM user WHERE id=? AND email_verified=0").bind(id).run();
      throw new AuthFailure("邮件发送失败，请检查邮件接口后重试", 503);
    }
    return response({ token: null, status: true });
  }
  async function reset(data: Record<string, unknown>, request: Request) {
    const token = typeof data.token === "string" ? data.token : new URL(request.url).searchParams.get("token");
    if (!token || !/^[A-Za-z0-9_-]{1,200}$/.test(token)) throw new AuthFailure("重置链接无效或已过期");
    const hash = await hashPassword(password(data.newPassword)), now = Date.now(), identifier = `reset-password:${token}`;
    const target = `SELECT v.value FROM verification v JOIN account a ON a.user_id=v.value AND a.provider_id='credential' WHERE v.identifier=? AND v.expires_at>? LIMIT 1`;
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE account SET password=?,updated_at=? WHERE provider_id='credential' AND user_id=(${target}) RETURNING user_id`).bind(hash, now, identifier, now),
      env.DB.prepare(`DELETE FROM session WHERE user_id=(${target})`).bind(identifier, now),
      env.DB.prepare(`DELETE FROM verification WHERE identifier=? AND expires_at>? AND value IN(SELECT user_id FROM account WHERE provider_id='credential') RETURNING id`).bind(identifier, now),
    ]);
    if (!result[0].results.length || !result[2].results.length) throw new AuthFailure("重置链接无效或已过期");
    return response({ status: true });
  }
  async function change(data: Record<string, unknown>, request: Request) {
    const session = await instance.api.getSession({ headers: request.headers });
    if (!session?.user.emailVerified) throw new AuthFailure("请先登录", 401);
    const row = await env.DB.prepare("SELECT password FROM account WHERE user_id=? AND provider_id='credential'").bind(session.user.id).first<{ password: string }>();
    if (!row || typeof data.currentPassword !== "string" || data.currentPassword.length > 128 || !await verifyPassword({ hash: row.password, password: data.currentPassword })) throw new AuthFailure("当前密码不正确");
    const hash = await hashPassword(password(data.newPassword)), now = Date.now();
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE account SET password=?,updated_at=? WHERE user_id=? AND provider_id='credential' AND password=? AND EXISTS(SELECT 1 FROM session WHERE token=? AND user_id=? AND expires_at>?) RETURNING id").bind(hash, now, session.user.id, row.password, session.session.token, session.user.id, now),
      env.DB.prepare("DELETE FROM session WHERE user_id=? AND token<>? AND EXISTS(SELECT 1 FROM account WHERE user_id=? AND password=?)").bind(session.user.id, session.session.token, session.user.id, hash),
    ]);
    if (!result[0].results.length) throw new AuthFailure("账号刚发生变化，请重新登录", 409);
    return response({ token: session.session.token, user: session.user });
  }
  return { ...instance, handler: async (request: Request) => {
    try {
      const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
      let parsed: Record<string, unknown> | undefined;
      if (request.method === "POST") {
        if (request.headers.get("origin") !== origin.origin) throw new AuthFailure("请求来源无效", 403);
        parsed = await body(request.clone());
        await throttle(request, path, parsed);
        if (["/sign-up/email", "/send-verification-email", "/request-password-reset"].includes(path) && !options.mailer) {
          try { mailConfiguration(env); } catch { throw new AuthFailure("邮件服务未配置或配置无效", 503); }
        }
        if (path === "/sign-up/email") return await signup(parsed);
        if (path === "/reset-password") return await reset(parsed, request);
        if (path === "/change-password") return await change(parsed, request);
      }
      return await instance.handler(request);
    } catch (error) {
      if (error instanceof AuthFailure) {
        if (error.status === 413) void request.body?.cancel().catch(() => undefined);
        return response({ code: "AUTH_ACTION_FAILED", message: error.message }, error.status);
      }
      // Do not log SQL diagnostics, password hashes or one-time links.
      return response({ code: "AUTH_UNAVAILABLE", message: "账号服务暂时不可用，请检查邮件配置或稍后重试" }, 503);
    }
  } };
}
