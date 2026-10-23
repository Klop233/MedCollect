// Local development only. This does not deliver real email or belong in the Worker.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
if (process.env.NODE_ENV === "production") throw new Error("Development mail capture is forbidden in production");
const messages = [];
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "POST" && req.url === "/send") {
    let total = 0, chunks = [];
    for await (const chunk of req) { total += chunk.length; if (total > 65536) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    try { const message = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!Array.isArray(message.to) || typeof message.text !== "string" || (message.html !== undefined && typeof message.html !== "string")) throw new Error(); messages.unshift({ ...message, id: randomUUID() }); messages.splice(50); res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: messages[0].id })); }
    catch { res.writeHead(400).end(); }
  } else if (req.method === "GET" && req.url === "/messages") res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(messages));
  else if (req.method === "DELETE" && req.url === "/messages") { messages.length = 0; res.writeHead(204).end(); }
  else if (req.method === "GET" && req.url === "/") {
    const escape = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const preview = m => m.html ? `<iframe title="${escape(m.subject || "邮件预览")}" sandbox srcdoc="${escape(m.html)}"></iframe>` : `<pre>${escape(m.text).replace(/https?:\/\/[^\s<>]+/g, url => `<a href="${url}">${url}</a>`)}</pre>`;
    res.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'" }).end(`<html lang="zh-CN"><meta charset="utf-8"><title>MedCollect 本机测试邮件</title><style>body{max-width:960px;margin:40px auto;padding:0 20px;font:16px/1.8 sans-serif;background:#f7f8f2;color:#245b42}article{background:white;padding:25px;margin:20px 0;border:1px solid #dce4d3;border-radius:12px}iframe{display:block;width:100%;height:720px;border:1px solid #e4e9df;border-radius:8px;background:#edf1e8}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>本机测试邮件 · 不会发到真实邮箱</h1><p>手动刷新查看最新验证/重置链接。HTML 邮件会在安全沙箱中预览，请勿将此工具暴露到公网。</p>${messages.map(m => `<article><h2>${escape(m.subject)}</h2><p>${escape(m.to.join(", "))}</p>${preview(m)}</article>`).join("")}</html>`);
  } else res.writeHead(404).end();
});
server.listen(8026, "127.0.0.1", () => console.log("Local test mail: http://127.0.0.1:8026 (loopback only, no real delivery)"));
