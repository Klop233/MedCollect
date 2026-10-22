import { config } from "dotenv";
import { spawn } from "node:child_process";
config({ path: ".env.local", quiet: true });
config({ quiet: true });
process.env.NODE_ENV = "production";
const env = process.env;
try {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error("需要至少32字符的随机 BETTER_AUTH_SECRET");
  const origin = new URL(env.BETTER_AUTH_URL || "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("生产环境需要完整且无额外路径的 HTTPS BETTER_AUTH_URL");
  if (env.MAIL_MODE !== "smtp" || !env.SMTP_HOST || !env.SMTP_FROM || /[\r\n]/.test(env.SMTP_FROM)) throw new Error("生产环境需要真实 SMTP 配置，禁止 Mailpit 或禁用邮件验证");
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT 无效");
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) throw new Error("SMTP_USER 与 SMTP_PASS 需同时配置");
} catch (error) {
  console.error(`无法启动：${error.message}`);
  process.exit(1);
}
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"], { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("无法启动 Next.js"); process.exit(1); });
child.on("exit", (code) => process.exit(code ?? 1));
