export type AuthMailKind = "verify" | "reset";

export type AuthMailContent = {
  subject: string;
  text: string;
  html: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function copyFor(kind: AuthMailKind) {
  return kind === "verify"
    ? {
        subject: "验证你的邮箱",
        eyebrow: "WELCOME TO YOUR ARCHIVE",
        title: "确认邮箱，收藏即将开始",
        intro: "欢迎加入 MedCollect。确认邮箱后，你就可以登录并开始整理自己的药品收藏图鉴。",
        action: "验证我的邮箱",
        actionHint: "按钮将在 1 小时后失效。",
      }
    : {
        subject: "重置你的密码",
        eyebrow: "A FRESH KEY FOR YOUR ARCHIVE",
        title: "重新打开你的 MedCollect",
        intro: "我们收到了密码重置请求。点击下方按钮设置新密码，完成后其他设备会退出登录。",
        action: "设置新密码",
        actionHint: "重置链接将在 1 小时后失效。",
      };
}

export function createAuthMailContent(url: string, kind: AuthMailKind): AuthMailContent {
  const copy = copyFor(kind);
  const safeUrl = escapeHtml(url);
  const text = `${copy.intro}\n\n${copy.action}：${url}\n\n${copy.actionHint} 如果不是你本人操作，请忽略此邮件。\n此邮件仅用于 MedCollect 账号操作，不涉及药品认证或用药建议。`;
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="x-apple-disable-message-reformatting">
    <title>${copy.subject} · MedCollect</title>
  </head>
  <body style="margin:0;padding:0;background:#edf1e8;color:#183d32;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${copy.intro}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#edf1e8;">
      <tr>
        <td align="center" style="padding:34px 16px 42px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td style="padding:0 10px 18px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td width="38" height="38" align="center" valign="middle" style="width:38px;height:38px;border-radius:12px;background:#1b5a45;color:#f7f7e9;font-size:20px;line-height:38px;font-family:Georgia,'Times New Roman',serif;">M</td>
                    <td style="padding-left:10px;color:#183d32;font-size:16px;font-weight:700;letter-spacing:-.3px;">MedCollect<br><span style="color:#718778;font-size:10px;font-weight:400;letter-spacing:1.4px;">药品收藏图鉴</span></td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#fffdf8;border:1px solid #dce5d9;border-radius:22px;overflow:hidden;box-shadow:0 12px 34px rgba(24,61,50,.08);">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:30px 34px 28px;background:#e2ede1;border-bottom:1px solid #d3e1d2;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td valign="top">
                            <p style="margin:0;color:#5e7d67;font-size:10px;font-weight:700;letter-spacing:1.6px;line-height:1.6;">${copy.eyebrow}</p>
                            <h1 style="margin:13px 0 0;color:#173f33;font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:400;letter-spacing:-.5px;line-height:1.3;">${copy.title}</h1>
                          </td>
                          <td width="118" valign="middle" align="right" style="width:118px;padding-left:18px;">
                            <div style="position:relative;width:106px;height:74px;">
                              <div style="position:absolute;left:3px;top:19px;width:99px;height:38px;border:1px solid #91ac8f;border-radius:25px;transform:rotate(-22deg);overflow:hidden;background:#d1e1cc;box-shadow:5px 10px 15px rgba(50,93,63,.14);">
                                <span style="display:block;float:left;width:50%;height:100%;background:#f0f2df;"></span><span style="display:block;float:left;width:50%;height:100%;background:#7da17f;border-left:1px solid #638a6a;box-sizing:border-box;"></span>
                              </div>
                              <span style="position:absolute;right:2px;top:1px;color:#88a68a;font-size:20px;">✦</span>
                              <span style="position:absolute;left:2px;bottom:0;color:#9ab39a;font-size:13px;">·</span>
                            </div>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:30px 34px 34px;">
                      <p style="margin:0;color:#526c5d;font-size:15px;line-height:1.9;">${copy.intro}</p>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;">
                        <tr>
                          <td align="center" style="border-radius:11px;background:#1b5a45;box-shadow:0 5px 13px rgba(27,90,69,.18);">
                            <a href="${safeUrl}" style="display:block;padding:15px 20px;color:#ffffff;font-size:14px;font-weight:700;line-height:1.4;text-decoration:none;">${copy.action}&nbsp;&nbsp;↗</a>
                          </td>
                        </tr>
                      </table>
                      <p style="margin:14px 0 0;color:#91a095;font-size:11px;line-height:1.8;text-align:center;">${copy.actionHint}</p>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:27px;">
                        <tr><td style="height:1px;background:#e7ece3;font-size:0;line-height:0;">&nbsp;</td></tr>
                      </table>
                      <p style="margin:22px 0 8px;color:#789080;font-size:11px;font-weight:700;letter-spacing:.5px;line-height:1.6;">按钮无法点击？</p>
                      <p style="margin:0;padding:11px 13px;border:1px solid #e1e9df;border-radius:8px;background:#f5f7f0;color:#6c8173;font-size:11px;line-height:1.8;word-break:break-all;overflow-wrap:anywhere;">${safeUrl}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 12px 0;color:#7d9083;font-size:11px;line-height:1.9;">
                <p style="margin:0 0 7px;"><strong style="color:#5d7767;">安全提示</strong>　如果不是你本人操作，请直接忽略此邮件。</p>
                <p style="margin:0;">此邮件仅用于 MedCollect 账号操作，不涉及药品认证或用药建议。</p>
                <p style="margin:17px 0 0;color:#a0aea3;font-size:10px;">© ${new Date().getFullYear()} MedCollect · 让收藏有迹可循。</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { subject: `MedCollect · ${copy.subject}`, text, html };
}
