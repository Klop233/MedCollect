package ink.miolab.medcollect;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpCookie;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 「码上放心」追溯码查询的原生实现。
 *
 * 和浏览器不同，App 拥有自己的 cookie jar，可以读着 _m_h5_tk 算签名，
 * 所以请求真的由这台手机直接发给阿里（不经过任何服务器）。
 *
 * Cookie 是手动收发的：Android 的 HttpURLConnection 不会自己走 CookieHandler，
 * 靠它就永远拿不到 MTOP 下发的那枚 _m_h5_tk，请求会一直 FAIL_SYS_TOKEN_EMPTY。
 */
final class MtopClient {
    static final String APP_KEY = "12574478";
    static final String JSV = "2.7.0";
    private static final String GW_WEB = "https://api2.mashangfangxin.com/h5/";
    private static final String GW_DATA = "https://api3.mashangfangxin.com/h5/";
    private static final String API_SHOW_URL = "mtop.alijk.code.search.getshowurl";
    private static final String API_DRUG = "mtop.alijk.code.search.getdrugresource.forweb";
    static final String UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

    private final PersistentCookieStore store;

    MtopClient(Context context) {
        store = new PersistentCookieStore(context);
    }

    /** 需要用户拖滑块时抛出，带上 punish 页地址。 */
    static final class NeedsHuman extends Exception {
        final String punishUrl;

        NeedsHuman(String punishUrl) {
            super("needs human verification");
            this.punishUrl = punishUrl;
        }
    }

    String lookup(String code) throws Exception {
        String token = getToken(code);
        return fetchDrug(code, token);
    }

    private String getToken(String code) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("code", code);
        String body = call(GW_WEB, API_SHOW_URL, payload.toString(), 3);
        JSONObject obj = new JSONObject(body);
        String url = obj.optJSONObject("data") == null ? "" : obj.getJSONObject("data").optString("result", "");
        int index = url.indexOf("token=");
        if (index < 0) throw new IllegalStateException("上游没有返回查询 token");
        String rest = url.substring(index + 6);
        int amp = rest.indexOf('&');
        return amp < 0 ? rest : rest.substring(0, amp);
    }

    private String fetchDrug(String code, String token) throws Exception {
        JSONObject request = new JSONObject();
        request.put("code", code);
        request.put("token", token);
        request.put("queryAppName", "web");
        request.put("imageCode", "");
        request.put("imageToken", "");
        String body = call(GW_DATA, API_DRUG, request.toString(), 3);
        JSONObject obj = new JSONObject(body);
        JSONObject payload = obj.optJSONObject("data");
        if (payload == null) throw new IllegalStateException("上游没有返回数据");

        String retCode = payload.optString("retCode", "");
        String subCode = payload.optString("subRetCode", "");
        if ("2".equals(retCode)) return notFound("该码已被注销");
        if ("1".equals(retCode) && ("11".equals(subCode) || "12".equals(subCode)))
            return notFound("该药品未入驻「码上放心」，系统查无此码");
        if ("1".equals(retCode) && "13".equals(subCode))
            return notFound("生产企业还没有上传批号、生产日期和有效期信息");

        JSONObject out = new JSONObject();
        out.put("status", 200);
        JSONObject candidate = new JSONObject();
        candidate.put("traceCode", code);
        putIfPresent(candidate, "genericName", payload, "drugName", "physicName", "prodName");
        putIfPresent(candidate, "manufacturer", payload, "produceEntName", "entName");
        putIfPresent(candidate, "specification", payload, "pkgSpec", "prepnSpec");
        putIfPresent(candidate, "batchNumber", payload, "productionBatch", "batchNo");
        String expiry = normalizeDate(payload.optString("expiryDate", ""));
        if (expiry != null) candidate.put("expiresAt", expiry);
        out.put("body", candidate);
        return out.toString();
    }

    private static void putIfPresent(JSONObject target, String key, JSONObject source, String... names)
            throws Exception {
        for (String name : names) {
            String value = source.optString(name, "").trim();
            if (!value.isEmpty()) {
                target.put(key, value);
                return;
            }
        }
    }

    private static String normalizeDate(String raw) {
        String text = raw.trim();
        if (text.length() < 8) return null;
        String digits = text.replaceAll("[^0-9]", "");
        if (digits.length() < 8) return null;
        return digits.substring(0, 4) + "-" + digits.substring(4, 6) + "-" + digits.substring(6, 8);
    }

    private static String notFound(String message) throws Exception {
        JSONObject out = new JSONObject();
        out.put("status", 404);
        out.put("error", "not_found");
        out.put("message", message);
        return out.toString();
    }

    /** 发一次 MTOP 请求；TOKEN_EMPTY 时靠 cookie 重签，风控时抛 NeedsHuman。 */
    private String call(String gateway, String api, String data, int attempts) throws Exception {
        String lastError = "";
        for (int i = 0; i < attempts; i++) {
            String ts = String.valueOf(System.currentTimeMillis());
            String sign = md5(token() + "&" + ts + "&" + APP_KEY + "&" + data);
            StringBuilder url = new StringBuilder(gateway).append(api.toLowerCase()).append("/1.0/?");
            url.append("jsv=").append(JSV).append("&appKey=").append(APP_KEY)
                    .append("&t=").append(ts).append("&sign=").append(sign)
                    .append("&api=").append(api).append("&v=1.0")
                    .append("&type=originaljson&dataType=json&data=").append(URLEncoder.encode(data, "UTF-8"));

            HttpURLConnection conn = (HttpURLConnection) new URL(url.toString()).openConnection();
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(20_000);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Referer", "https://www.mashangfangxin.com/");
            conn.setRequestProperty("Origin", "https://www.mashangfangxin.com");
            conn.setRequestProperty("Accept", "application/json, text/javascript, */*; q=0.01");
            String cookie = cookieHeader(gateway);
            if (cookie != null) conn.setRequestProperty("Cookie", cookie);
            String body = read(conn);
            JSONObject parsed = new JSONObject(body);
            JSONArray retArray = parsed.optJSONArray("ret");
            String ret = retArray == null ? "" : retArray.join(",").replace("\"", "");

            if (ret.contains("TOKEN_EMPTY") || ret.contains("TOKEN_EXPIRED") || ret.contains("TOKEN_EXOIRED")) {
                lastError = "token " + ret;
                continue;
            }
            if (ret.contains("RGV587") || ret.contains("FAIL_SYS_USER_VALIDATE")) {
                JSONObject info = parsed.optJSONObject("data");
                String punish = info == null ? "" : info.optString("url", "");
                if (punish.contains("login.taobao.com"))
                    throw new IllegalStateException("风控升级为需要登录淘宝账号，过一段时间再试");
                throw new NeedsHuman(punish);
            }
            if (!ret.contains("SUCCESS")) {
                lastError = "上游返回失败：" + ret;
                continue;
            }
            return body;
        }
        throw new IllegalStateException(lastError.isEmpty() ? "上游请求失败" : lastError);
    }

    /** 按 host 拼 Cookie 请求头；一枚都没有就返回 null。 */
    private String cookieHeader(String url) {
        try {
            List<HttpCookie> matched = store.get(URI.create(url));
            if (matched.isEmpty()) return null;
            StringBuilder out = new StringBuilder();
            for (HttpCookie cookie : matched) {
                if (out.length() > 0) out.append("; ");
                out.append(cookie.getName()).append('=').append(cookie.getValue());
            }
            return out.toString();
        } catch (Exception e) {
            return null;
        }
    }

    /** 收下响应里的 Set-Cookie（_m_h5_tk 和 x5sec 都在这里下来）。 */
    private void absorbCookies(HttpURLConnection conn) {
        for (java.util.Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
            if (entry.getKey() == null || !entry.getKey().equalsIgnoreCase("Set-Cookie")) continue;
            for (String raw : entry.getValue()) absorbCookie(raw);
        }
    }

    private void absorbCookie(String raw) {
        if (raw == null) return;
        String[] parts = raw.split(";");
        int eq = parts[0].indexOf('=');
        if (eq <= 0) return;
        try {
            HttpCookie cookie = new HttpCookie(parts[0].substring(0, eq).trim(),
                    parts[0].substring(eq + 1).trim());
            for (int i = 1; i < parts.length; i++) {
                String attribute = parts[i].trim();
                int at = attribute.indexOf('=');
                String name = (at < 0 ? attribute : attribute.substring(0, at)).trim().toLowerCase();
                String value = at < 0 ? "" : attribute.substring(at + 1).trim();
                if ("domain".equals(name) && !value.isEmpty()) {
                    cookie.setDomain(value.startsWith(".") ? value : "." + value);
                } else if ("path".equals(name) && !value.isEmpty()) {
                    cookie.setPath(value);
                }
            }
            if (cookie.getDomain() == null) cookie.setDomain(".mashangfangxin.com");
            if (cookie.getPath() == null) cookie.setPath("/");
            cookie.setVersion(0);
            store.add(null, cookie);
        } catch (Exception ignored) {
            // 值里有怪字符就跳过，不能让一枚 cookie 毁掉整次查询
        }
    }

    private String token() {
        for (HttpCookie cookie : store.getCookies()) {
            if ("_m_h5_tk".equals(cookie.getName())) {
                int cut = cookie.getValue().indexOf('_');
                return cut > 0 ? cookie.getValue().substring(0, cut) : cookie.getValue();
            }
        }
        return "";
    }

    /** 把 WebView 里过了滑块的 cookie 搬进原生的 cookie jar。 */
    void adoptCookies(String header) {
        if (header == null) return;
        for (String part : header.split(";")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            try {
                HttpCookie cookie = new HttpCookie(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
                cookie.setDomain(".mashangfangxin.com");
                cookie.setPath("/");
                cookie.setVersion(0);
                store.add(new URI("https://api3.mashangfangxin.com"), cookie);
            } catch (Exception ignored) {
            }
        }
    }

    private String read(HttpURLConnection conn) throws Exception {
        int status = conn.getResponseCode();
        absorbCookies(conn);
        InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (stream == null) return "";
        StringBuilder text = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) text.append(line);
        } finally {
            conn.disconnect();
        }
        return text.toString();
    }

    static String md5(String value) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("MD5");
        byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    /** cookie 存本地，重启 App 还在（x5sec 有有效期，过期会重新要求验证）。 */
    private static final class PersistentCookieStore implements java.net.CookieStore {
        private final List<HttpCookie> items = new ArrayList<>();
        private final SharedPreferences prefs;

        PersistentCookieStore(Context context) {
            prefs = context.getSharedPreferences("trace-cookies", Context.MODE_PRIVATE);
            for (String line : prefs.getString("jar", "").split("\n")) {
                String[] parts = line.split("\t", -1);
                if (parts.length < 4) continue;
                try {
                    HttpCookie cookie = new HttpCookie(parts[1], parts[2]);
                    cookie.setDomain(parts[0]);
                    cookie.setPath(parts[3]);
                    items.add(cookie);
                } catch (Exception ignored) {
                }
            }
        }

        private void persist() {
            StringBuilder out = new StringBuilder();
            for (HttpCookie cookie : items) {
                out.append(cookie.getDomain()).append('\t').append(cookie.getName()).append('\t')
                        .append(cookie.getValue()).append('\t').append(cookie.getPath() == null ? "/" : cookie.getPath())
                        .append('\n');
            }
            prefs.edit().putString("jar", out.toString()).apply();
        }

        @Override
        public void add(URI uri, HttpCookie cookie) {
            items.removeIf(existing -> existing.getName().equals(cookie.getName())
                    && String.valueOf(existing.getDomain()).equals(String.valueOf(cookie.getDomain())));
            items.add(cookie);
            persist();
        }

        @Override
        public List<HttpCookie> get(URI uri) {
            String host = uri == null || uri.getHost() == null ? "" : uri.getHost();
            List<HttpCookie> matched = new ArrayList<>();
            for (HttpCookie cookie : items) {
                String domain = cookie.getDomain() == null ? "" : cookie.getDomain().toLowerCase();
                if (domain.startsWith(".")) {
                    String bare = domain.substring(1);
                    if (host.equals(bare) || host.endsWith("." + bare)) matched.add(cookie);
                } else if (host.equals(domain) || host.endsWith("." + domain)) {
                    matched.add(cookie);
                }
            }
            return matched;
        }

        @Override
        public List<HttpCookie> getCookies() {
            return new ArrayList<>(items);
        }

        @Override
        public List<URI> getURIs() {
            return new ArrayList<>();
        }

        @Override
        public boolean remove(URI uri, HttpCookie cookie) {
            boolean removed = items.remove(cookie);
            if (removed) persist();
            return removed;
        }

        @Override
        public boolean removeAll() {
            items.clear();
            persist();
            return true;
        }
    }
}
