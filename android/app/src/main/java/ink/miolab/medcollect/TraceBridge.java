package ink.miolab.medcollect;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 页面和原生之间的桥：
 *
 *   window.MedCollectNative.lookup(code, requestId)
 *   → 原生发请求 → window.__medcollectTrace(requestId, json)
 *
 * 每个 requestId 只回调一次；超时由页面自己控制。
 */
final class TraceBridge {
    interface Lookup { String run(String code); }

    private final MainActivity activity;
    private final WebView web;
    private final Lookup lookup;
    private final ExecutorService pool = Executors.newFixedThreadPool(2);

    TraceBridge(MainActivity activity, WebView web, Lookup lookup) {
        this.activity = activity;
        this.web = web;
        this.lookup = lookup;
    }

    @JavascriptInterface
    public void lookup(String code, String requestId) {
        if (requestId == null || requestId.isEmpty() || requestId.length() > 100) return;
        try {
            if (!activity.isOurPage()) {
                respond(requestId, MainActivity.error(403, "forbidden", "只接受本站页面调用"));
                return;
            }
            String normalized = code == null ? "" : code.replaceAll("[^0-9A-Za-z()]", "");
            if (!normalized.matches("\\d{20}")) {
                respond(requestId, MainActivity.error(400, "invalid_code", "追溯码应为 20 位数字"));
                return;
            }
            pool.execute(() -> respond(requestId, lookup.run(normalized)));
        } catch (Throwable error) {
            // 桥抛异常时 JS 只会看到一句「Java exception」，这里换成能看懂的信息
            respond(requestId, MainActivity.error(500, "bridge_error", String.valueOf(error)));
        }
    }

    private void respond(String requestId, String json) {
        web.post(() -> {
            String script = "window.__medcollectTrace && window.__medcollectTrace("
                    + JSONObject.quote(requestId) + "," + JSONObject.quote(json) + ")";
            web.evaluateJavascript(script, null);
        });
    }
}
