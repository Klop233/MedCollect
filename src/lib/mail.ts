import nodemailer from "nodemailer";
import { createAuthMailContent } from "./auth-mail-template";

export type MailEnvironment = Record<string, string | undefined>;
export type AuthMail = { to: string; url: string; kind: "verify" | "reset" };
export type AuthMailer = (mail: AuthMail) => Promise<void>;

export class MailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailConfigurationError";
  }
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Validate lazily: an unconfigured preview can render, but cannot fake email delivery. */
export function getMailConfiguration(env: MailEnvironment = process.env) {
  const mode = env.MAIL_MODE || "disabled";
  if (mode !== "smtp" && mode !== "mailpit") {
    throw new MailConfigurationError("邮件服务未配置，请先设置 SMTP 或启用仅限本地开发的 Mailpit。");
  }
  if (mode === "mailpit" && env.NODE_ENV === "production") {
    throw new MailConfigurationError("生产环境禁止使用 Mailpit，请配置真实 SMTP 服务。");
  }

  const host = env.SMTP_HOST || (mode === "mailpit" ? "127.0.0.1" : "");
  const port = Number(env.SMTP_PORT || (mode === "mailpit" ? "1025" : "587"));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MailConfigurationError("SMTP 主机或端口配置不正确。");
  }
  if (mode === "mailpit" && !loopbackHosts.has(host.toLowerCase())) {
    throw new MailConfigurationError("Mailpit 只允许连接本机回环地址。");
  }
  if ((env.SMTP_USER && !env.SMTP_PASS) || (!env.SMTP_USER && env.SMTP_PASS)) {
    throw new MailConfigurationError("SMTP_USER 和 SMTP_PASS 必须同时配置。");
  }
  const secure = env.SMTP_SECURE === "true" || (!env.SMTP_SECURE && port === 465);
  const from = env.SMTP_FROM || (mode === "mailpit" ? "MedCollect <noreply@medcollect.local>" : "");
  if (!from || /[\r\n]/.test(from)) {
    throw new MailConfigurationError("请配置有效的 SMTP_FROM 发件人。");
  }
  return { mode, host, port, secure, from, user: env.SMTP_USER, pass: env.SMTP_PASS };
}

export function createMailer(env: MailEnvironment = process.env): AuthMailer {
  return async ({ to, url, kind }) => {
    const config = getMailConfiguration(env);
    const base = new URL(env.BETTER_AUTH_URL || "http://localhost:3000");
    const action = new URL(url);
    if (action.origin !== base.origin) {
      throw new MailConfigurationError("邮件链接来源与应用地址不一致。");
    }
    const content = createAuthMailContent(action.toString(), kind);
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.mode === "smtp" && !config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const result = await transport.sendMail({
      from: config.from,
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
    if (!result.accepted.length || result.rejected.length) {
      throw new Error("邮件服务器未接受投递，请稍后重试。");
    }
  };
}
