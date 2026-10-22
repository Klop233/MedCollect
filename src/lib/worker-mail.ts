import type { WorkerEnv } from "./worker-env";
export type WorkerMail = { to: string; url: string; kind: "verify" | "reset" };
export type WorkerMailer = (mail: WorkerMail) => Promise<void>;

export function mailConfiguration(env: WorkerEnv) {
  if (env.MAIL_MODE !== "http" || !env.MAIL_API_URL || !env.MAIL_FROM) throw new Error("邮件服务未配置，请设置 HTTP 邮件接口");
  const url = new URL(env.MAIL_API_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(env.ENVIRONMENT === "development" && local && url.protocol === "http:")) throw new Error("邮件接口必须使用HTTPS");
  if (url.username || url.password || url.hash || /[\r\n]/.test(env.MAIL_FROM)) throw new Error("邮件配置无效");
  return { url, from: env.MAIL_FROM, token: env.MAIL_API_TOKEN };
}
export function createWorkerMailer(env: WorkerEnv): WorkerMailer {
  return async ({ to, url, kind }) => {
    const config = mailConfiguration(env);
    if (new URL(url).origin !== new URL(env.BETTER_AUTH_URL!).origin) throw new Error("邮件链接来源无效");
    const action = kind === "verify" ? "验证邮箱" : "重置密码";
    const response = await fetch(config.url.href, { method: "POST", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
      body: JSON.stringify({ from: config.from, to: [to], subject: `MedCollect · ${action}`, text: `${kind === "verify" ? "欢迎创建药品收藏图鉴，请验证邮箱后登录。" : "重置后所有设备将退出登录。"}\n\n${url}\n\n链接1小时内有效。非本人操作请忽略。此邮件不涉及药品验真或用药建议。` }) });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error("邮件接口未接受投递");
  };
}
