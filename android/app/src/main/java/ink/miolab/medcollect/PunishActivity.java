package ink.miolab.medcollect;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 阿里的滑块页。用户拖完以后浏览器里会出现 x5sec cookie，
 * 这里把它取出来交给原生请求使用，然后关闭窗口。
 */
public class PunishActivity extends Activity {
    static final String EXTRA_URL = "url";
    static final String EXTRA_COOKIES = "cookies";
    private static final long TIMEOUT_MS = 180_000;
    private static final long POLL_MS = 800;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private String url;
    private long deadline;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        url = getIntent().getStringExtra(EXTRA_URL);
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(MtopClient.UA);   // 和原生请求用同一个 UA，风控端看到的是同一个客户端
        web.setWebViewClient(new WebViewClient());
        setContentView(web);
        if (url == null || url.isEmpty()) {
            finishCancelled();
            return;
        }
        deadline = System.currentTimeMillis() + TIMEOUT_MS;
        web.loadUrl(url);
        handler.postDelayed(this::poll, POLL_MS);
    }

    private void poll() {
        if (isFinishing()) return;
        // x5sec 可能挂在目标站点上，也可能挂在 punish 页自己的域上，两边都看一眼
        String cookie = CookieManager.getInstance().getCookie("https://www.mashangfangxin.com/");
        if (cookie == null || !cookie.contains("x5sec=")) {
            String onPunish = CookieManager.getInstance().getCookie(url);
            if (onPunish != null && onPunish.contains("x5sec=")) cookie = onPunish;
            else cookie = null;
        }
        if (cookie != null) {
            Intent result = new Intent();
            result.putExtra(EXTRA_COOKIES, cookie);
            setResult(RESULT_OK, result);
            finish();
            return;
        }
        if (System.currentTimeMillis() > deadline) {
            finishCancelled();
            return;
        }
        handler.postDelayed(this::poll, POLL_MS);
    }

    private void finishCancelled() {
        setResult(RESULT_CANCELED);
        finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
