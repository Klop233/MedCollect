package ink.miolab.medcollect;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 一个 WebView 外壳：界面仍然是 med.miolab.ink，追溯码查询交给原生代码发。
 * 这样请求由手机直接发给阿里，不受浏览器的跨域和第三方 cookie 限制。
 */
public class MainActivity extends Activity {
    private static final int REQUEST_PUNISH = 41;
    private static final int REQUEST_CAMERA = 7;

    private WebView web;
    private MtopClient client;
    private CountDownLatch punishLatch;
    private volatile boolean punishPassed;
    /** 当前页面地址。WebView 的方法只能在 UI 线程调用，而桥在 JavaBridge 线程，
     *  所以地址必须在 onPageStarted/onPageFinished 里缓存下来给桥用。 */
    private volatile String currentUrl;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        client = new MtopClient(this);

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                currentUrl = url;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                currentUrl = url;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 扫码要相机；其他能力一律不给
                boolean wantsCamera = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) wantsCamera = true;
                }
                if (wantsCamera && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else {
                    request.deny();
                }
            }
        });
        web.addJavascriptInterface(new TraceBridge(this, web, this::runLookup), "MedCollectNative");
        setContentView(web);
        warnIfWebViewTooOld();
        web.loadUrl(getString(R.string.start_url));

        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
        }
    }

    /**
     * 站点用的是现代 JS，老 WebView 会整页白屏且不给任何提示。
     * 这里只做一次粗略判断（拿默认 UA 里的 Chrome 版本），把话说清楚。
     */
    private void warnIfWebViewTooOld() {
        String ua = WebSettings.getDefaultUserAgent(this);
        Matcher matcher = Pattern.compile("Chrome/(\\d+)").matcher(ua);
        int chrome = matcher.find() ? Integer.parseInt(matcher.group(1)) : 0;
        if (chrome == 0 || chrome >= 90) return;
        new AlertDialog.Builder(this)
                .setTitle("系统 WebView 版本过旧")
                .setMessage("这台手机的 WebView 是 Chrome " + chrome + "，打不开 MedCollect 的页面。"
                        + "请到应用商店更新「Android System WebView」或 Chrome 后再试；"
                        + "也可以先用浏览器打开，功能除了离线查询以外都一样。")
                .setPositiveButton("仍然打开", null)
                .setNegativeButton("用浏览器打开", (dialog, which) -> {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(getString(R.string.start_url))));
                    finish();
                })
                .show();
    }

    /** 只允许自己站点上的页面调用原生查询桥，别的网页跳进来一律拒绝。
     *  注意这里不能碰 WebView（桥跑在 JavaBridge 线程），只读缓存下来的地址。 */
    boolean isOurPage() {
        String url = currentUrl;
        if (url == null) return false;
        String host = Uri.parse(url).getHost();
        if (host == null) return false;
        for (String allowed : getString(R.string.allowed_hosts).split("\\s*,\\s*")) {
            if (allowed.equalsIgnoreCase(host)) return true;
        }
        return false;
    }

    /** 在后台线程执行：查一次，遇到滑块就开窗口等人拖，拖完再查一次。 */
    String runLookup(String code) {
        try {
            return client.lookup(code);
        } catch (MtopClient.NeedsHuman needsHuman) {
            if (!askHuman(needsHuman.punishUrl)) return error(428, "needs_human", "需要人工验证：请在弹出的页面里拖动滑块");
            try {
                return client.lookup(code);
            } catch (MtopClient.NeedsHuman again) {
                return error(428, "needs_human", "滑块没有通过，可以再试一次");
            } catch (Exception e) {
                return error(502, "upstream_error", e.getMessage());
            }
        } catch (Exception e) {
            return error(502, "upstream_error", e.getMessage());
        }
    }

    /** 打开滑块页并阻塞当前（后台）线程，直到用户拖完或超时。 */
    private boolean askHuman(String punishUrl) {
        if (punishUrl == null || punishUrl.isEmpty()) return false;
        CountDownLatch latch = new CountDownLatch(1);
        punishLatch = latch;
        punishPassed = false;
        runOnUiThread(() -> {
            Intent intent = new Intent(this, PunishActivity.class);
            intent.putExtra(PunishActivity.EXTRA_URL, punishUrl);
            startActivityForResult(intent, REQUEST_PUNISH);
        });
        try {
            return latch.await(200, TimeUnit.SECONDS) && punishPassed;
        } catch (InterruptedException e) {
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_PUNISH) {
            punishPassed = resultCode == RESULT_OK && data != null;
            if (punishPassed) client.adoptCookies(data.getStringExtra(PunishActivity.EXTRA_COOKIES));
            CountDownLatch latch = punishLatch;
            punishLatch = null;
            if (latch != null) latch.countDown();
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    static String error(int status, String code, String message) {
        try {
            JSONObject out = new JSONObject();
            out.put("status", status);
            out.put("error", code);
            out.put("message", message == null ? "" : message);
            return out.toString();
        } catch (Exception e) {
            return "{\"status\":502,\"error\":\"upstream_error\",\"message\":\"查询失败\"}";
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("MedCollectNative");
            web.destroy();
        }
        super.onDestroy();
    }
}
