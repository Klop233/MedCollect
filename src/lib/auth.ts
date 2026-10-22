import { createHash, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { authSchema, rateLimit } from "./auth-schema";
import { createMailer, getMailConfiguration, type AuthMailer, type MailEnvironment } from "./mail";

type AuthOptions = {
  env?: MailEnvironment;
  mailer?: AuthMailer;
  /** Isolated integration tests can turn off throttling without changing production policy. */
  rateLimitEnabled?: boolean;
};

const emailPaths = new Set(["/sign-up/email", "/send-verification-email", "/request-password-reset"]);

export function createAuth(database: typeof db, options: AuthOptions = {}) {
  const env = options.env || process.env;
  const baseURL = env.BETTER_AUTH_URL || "http://localhost:3000";
  const origin = new URL(baseURL);
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("BETTER_AUTH_URL 必须是应用的完整来源地址，不含路径或查询参数。");
  }
  if (env.NODE_ENV === "production" && origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error("公网生产环境的 BETTER_AUTH_URL 必须使用 HTTPS。");
  }
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("请配置至少 32 字符的随机 BETTER_AUTH_SECRET。");
  }
  const send = options.mailer || createMailer(env);
  const throttling = options.rateLimitEnabled !== false;

  const deliver: AuthMailer = async (mail) => {
    try {
      await send(mail);
    } catch {
      // Never return provider diagnostics, recipient addresses or one-time tokens to clients.
      throw new APIError("SERVICE_UNAVAILABLE", {
        code: "MAIL_DELIVERY_FAILED",
        message: "邮件发送失败，请检查邮件服务配置或稍后重试。",
      });
    }
  };

  const instance = betterAuth({
    appName: "MedCollect",
    baseURL: origin.origin,
    secret,
    database: drizzleAdapter(database, { provider: "sqlite", schema: authSchema, transaction: true }),
    trustedOrigins: [origin.origin],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) => deliver({ to: user.email, url, kind: "reset" }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: ({ user, url }) => deliver({ to: user.email, url, kind: "verify" }),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    user: { changeEmail: { enabled: false } },
    rateLimit: {
      enabled: throttling,
      storage: "database",
      window: 60,
      max: 90,
      customRules: {
        "/sign-up/email": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 10 },
        "/send-verification-email": { window: 60, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: origin.protocol === "https:",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    // Auth diagnostics may contain email addresses; responses expose only deliberate errors.
    logger: { disabled: true },
    // Let unexpected failures escape the library router rather than its console.error,
    // which includes SQL parameter values (possibly password hashes or reset tokens).
    onAPIError: { throw: true },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Better Auth's default background-or-await helper logs and swallows mail
        // rejections even without background tasks. This app promises honest delivery
        // feedback, so await them strictly; signup failures also roll back its transaction.
        ctx.context.runInBackgroundOrAwait = async (promise) => await promise;
        if (emailPaths.has(ctx.path) && !options.mailer) {
          try {
            getMailConfiguration(env);
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "MAIL_NOT_CONFIGURED",
              message: "邮件服务未配置或配置无效，暂时无法注册、重发验证邮件或找回密码。",
            });
          }
        }
        if (ctx.path === "/sign-up/email" && ctx.body) {
          const name = typeof ctx.body.name === "string" ? ctx.body.name.trim() : "";
          if (!name || name.length > 40) {
            throw new APIError("BAD_REQUEST", { code: "INVALID_NAME", message: "昵称需要 1–40 个字符。" });
          }
          ctx.body.name = name;
        }
        // Recipient-based counters remain effective even behind a proxy or when IP headers vary.
        const email = typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : "";
        if (!throttling || !email || (!emailPaths.has(ctx.path) && ctx.path !== "/sign-in/email")) return;
        const now = Date.now();
        const key = "mail:" + createHash("sha256").update(`${ctx.path}:${email}`).digest("hex");
        const max = ctx.path === "/sign-in/email" ? 10 : ctx.path === "/sign-up/email" ? 5 : 3;
        const [counter] = await database.insert(rateLimit).values({ id: randomUUID(), key, count: 1, lastRequest: now })
          .onConflictDoUpdate({ target: rateLimit.key, set: {
            count: sql`case when ${rateLimit.lastRequest} < ${now - 60_000} then 1 else ${rateLimit.count} + 1 end`,
            lastRequest: sql`case when ${rateLimit.lastRequest} < ${now - 60_000} then ${now} else ${rateLimit.lastRequest} end`,
          } }).returning({ count: rateLimit.count });
        if (counter.count > max) {
          throw new APIError("TOO_MANY_REQUESTS", { code: "TOO_MANY_REQUESTS", message: "操作过于频繁，请稍后再试。" });
        }
      }),
    },
  });
  return {
    ...instance,
    handler: async (request: Request) => {
      try {
        return await instance.handler(request);
      } catch {
        return Response.json({ code: "AUTH_UNAVAILABLE", message: "账号服务暂时不可用，请稍后重试。" }, {
          status: 500,
          headers: { "Cache-Control": "no-store" },
        });
      }
    },
  };
}

export const auth = createAuth(db);
