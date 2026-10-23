import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthMailContent } from "../src/lib/auth-mail-template";

test("verification mail includes a styled HTML action and a text fallback", () => {
  const url = "https://med.miolab.ink/api/auth/verify-email?token=abc&callbackURL=%2Fverify-email";
  const mail = createAuthMailContent(url, "verify");
  assert.equal(mail.subject, "MedCollect · 验证你的邮箱");
  assert.match(mail.html, /验证我的邮箱/);
  assert.match(mail.html, /href="https:\/\/med\.miolab\.ink\/api\/auth\/verify-email\?token=abc&amp;callbackURL=%2Fverify-email"/);
  assert.match(mail.text, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(mail.html, /如果不是你本人操作/);
});

test("password reset mail keeps reset-specific copy", () => {
  const mail = createAuthMailContent("https://med.miolab.ink/reset-password?token=reset", "reset");
  assert.equal(mail.subject, "MedCollect · 重置你的密码");
  assert.match(mail.html, /设置新密码/);
  assert.match(mail.text, /其他设备会退出登录/);
});
