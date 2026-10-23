# -*- coding: utf-8 -*-
"""
trace_api — 把「码上放心」追溯码查询包成 HTTP JSON API（MedCollect 的查询后端）。

    python server.py --host 127.0.0.1 --port 8787

接口
    GET  /api/trace?code=81123456789012345678[&fresh=1]
    GET  /api/trace/81123456789012345678
    POST /api/trace          {"code": "81123456789012345678"}
    GET  /api/trace/medcollect?code=...       MedCollect 默认字段名（TRACE_API_* 直接可用）
    GET  /health
    GET  /                  简易说明

返回统一为 JSON（UTF-8，中文不转义）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, unquote, urlparse

from msfx_client import (DictAware, FloodControl, MsfxError, NeedsHuman,
                         TraceCodeClient, medcollect_candidate, shape_result)

CLIENT: Optional[Any] = None
API_KEY = os.environ.get("MSFX_API_KEY", "")
# 浏览器直连时用：空 = 允许任意来源；填了就只放行列出的站点（逗号分隔）
ALLOWED_ORIGINS = [item.strip().rstrip("/") for item in
                   os.environ.get("MSFX_ALLOWED_ORIGINS", "").split(",") if item.strip()]
STARTED_AT = time.time()

INDEX_HTML = """<!doctype html>
<meta charset="utf-8"><title>码上放心追溯码查询 API</title>
<style>body{font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:780px;margin:48px auto;padding:0 20px;color:#222}
code,pre{background:#f5f5f5;border-radius:6px}code{padding:2px 5px}pre{padding:14px;overflow:auto}
h1{font-size:22px}td{padding:4px 12px 4px 0;vertical-align:top}</style>
<h1>码上放心 追溯码查询 API</h1>
<table>
<tr><td><code>GET /api/trace?code=&lt;追溯码&gt;</code></td><td>查询（<code>&amp;fresh=1</code> 跳过缓存）</td></tr>
<tr><td><code>GET /api/trace/&lt;追溯码&gt;</code></td><td>同上，路径写法</td></tr>
<tr><td><code>POST /api/trace</code></td><td>body: <code>{"code":"..."}</code></td></tr>
<tr><td><code>GET /api/trace/medcollect?code=&lt;追溯码&gt;</code></td><td>MedCollect 字段名，直接配 <code>TRACE_API_URL</code></td></tr>
<tr><td><code>GET /health</code></td><td>健康检查</td></tr>
</table>
<pre>curl "http://127.0.0.1:8787/api/trace/medcollect?code=81123456789012345678"</pre>
"""


class MockClient(DictAware):
    """离线自测：把 --mock 文件当成 ④ 的 data 返回，不访问任何上游。

    只用于验证 API 形状和 MedCollect 对接，不是真实查询结果。
    显式传了 --dict-file / --dict-prefix 时也走一遍药品字典，方便离线演练命中。
    """

    def __init__(self, data: Dict[str, Any], path: str = "", dictionary=None):
        self.data = data
        self.path = path
        self.dictionary = dictionary
        self.stats = {"queries": 0, "cache_hits": 0, "errors": 0,
                      "browser_fallbacks": 0, "mock": True}

    def query(self, raw_code: str, *, fresh: bool = False) -> Dict[str, Any]:
        code = TraceCodeClient.normalize_code(raw_code)
        TraceCodeClient.validate(code)
        if not fresh:
            known = self._dict_lookup(code)
            if known is not None:
                return known
        self.stats["queries"] += 1
        try:
            result = shape_result(code, "MOCK", self.data)
        except MsfxError:
            self.stats["errors"] += 1
            raise
        self._remember(code, result)
        return dict(result)

    def close(self) -> None:
        return None


def json_bytes(obj: Any, pretty: bool = False) -> bytes:
    text = json.dumps(obj, ensure_ascii=False, indent=2 if pretty else None)
    return text.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "trace-api/1.0"
    protocol_version = "HTTP/1.1"

    # ---------------- 基础工具 ----------------
    def _send(self, status: int, body: bytes, ctype: str = "application/json; charset=utf-8",
              extra: Dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        # Chrome 的 Private Network Access：公网页面访问 127.0.0.1 会先问一句
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def handle(self) -> None:
        # 浏览器会关掉空闲的 keep-alive 连接，这不算错误，别把堆栈打到控制台
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass

    def _send_obj(self, status: int, obj: Any, extra: Dict[str, str] | None = None) -> None:
        pretty = "pretty" in parse_qs(urlparse(self.path).query)
        self._send(status, json_bytes(obj, pretty), extra=extra)

    def _cors_origin(self) -> Optional[str]:
        """默认允许任意来源；设了 MSFX_ALLOWED_ORIGINS 就只放行列出的站点。"""
        if not ALLOWED_ORIGINS:
            return "*"
        origin = (self.headers.get("Origin") or "").strip()
        return origin if origin in ALLOWED_ORIGINS else None

    def log_message(self, fmt: str, *args: Any) -> None:      # 默认日志带时间戳更好调试
        sys.stderr.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _authorized(self, qs: Dict[str, list]) -> bool:
        if not API_KEY:
            return True
        supplied = (self.headers.get("X-API-Key")
                    or (qs.get("key") or [""])[0])
        if not supplied:
            # 也接受 Authorization: Bearer <key>，方便 MedCollect 用 TRACE_API_TOKEN
            auth = self.headers.get("Authorization") or ""
            if auth.lower().startswith("bearer "):
                supplied = auth[7:].strip()
        return supplied == API_KEY

    # ---------------- 路由 ----------------
    def do_OPTIONS(self) -> None:                              # noqa: N802
        self._send(204, b"")

    def do_HEAD(self) -> None:                                 # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:                                  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path.rstrip("/") or "/")
        qs = parse_qs(parsed.query)

        if path == "/":
            self._send(200, INDEX_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/health":
            verifier = getattr(CLIENT, "verifier", None)
            dictionary = getattr(CLIENT, "dictionary", None)
            self._send_obj(200, {
                "ok": True,
                "uptime_s": round(time.time() - STARTED_AT, 1),
                "mock": bool(getattr(CLIENT, "stats", {}).get("mock")),
                "stats": CLIENT.stats if CLIENT else {},
                "dict": dictionary.stats() if dictionary is not None else {"enabled": False},
                "verify": verifier.state() if verifier is not None else {"active": False, "ok": None},
            })
            return
        if path in ("/api/trace/medcollect", "/api/medcollect", "/medcollect"):
            code = (qs.get("code") or qs.get("q") or [""])[0]
            self._handle_query(code, qs, shape="medcollect")
            return
        if path in ("/api/trace", "/api/query", "/query", "/trace"):
            code = (qs.get("code") or qs.get("q") or [""])[0]
            self._handle_query(code, qs)
            return
        if path.startswith("/api/trace/"):
            self._handle_query(path[len("/api/trace/"):], qs)
            return

        self._send_obj(404, {"ok": False, "error": "not_found",
                             "message": f"没有这个路径：{parsed.path}"})

    def do_POST(self) -> None:                                 # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path.rstrip("/") or "/")
        qs = parse_qs(parsed.query)
        if path not in ("/api/trace", "/api/query", "/query", "/trace", "/api/trace/medcollect"):
            self._send_obj(404, {"ok": False, "error": "not_found",
                                 "message": f"没有这个路径：{parsed.path}"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            self._send_obj(400, {"ok": False, "error": "bad_request",
                                 "message": "请求体不是合法 JSON"})
            return
        if isinstance(body, dict):
            qs.update({k: [str(v)] for k, v in body.items() if v is not None})
        shape = "medcollect" if path.endswith("/medcollect") else "full"
        self._handle_query(str(body.get("code", "")) if isinstance(body, dict) else "", qs,
                           shape=shape)

    # ---------------- 业务 ----------------
    def _handle_query(self, code: str, qs: Dict[str, list], shape: str = "full") -> None:
        if not self._authorized(qs):
            self._send_obj(401, {"ok": False, "error": "unauthorized",
                                 "message": "缺少或错误的 X-API-Key"})
            return
        if CLIENT is None:
            self._send_obj(503, {"ok": False, "error": "not_ready", "message": "服务尚未就绪"})
            return

        code = (code or "").strip()
        fresh = (qs.get("fresh") or ["0"])[0] in ("1", "true", "yes")
        if (qs.get("shape") or [""])[0] == "medcollect":
            shape = "medcollect"
        try:
            result = CLIENT.query(code, fresh=fresh)
        except NeedsHuman as exc:
            body = exc.to_dict()
            verifier = getattr(CLIENT, "verifier", None)
            if verifier is not None:
                body["verification"] = verifier.state()   # 窗口是不是已经弹出来了
            self._send_obj(428, body, extra={"Retry-After": "60"})
            return
        except FloodControl as exc:
            self._send_obj(429, exc.to_dict(),
                           extra={"Retry-After": str(exc.extra.get("retry_after", 30))})
            return
        except MsfxError as exc:
            self._send_obj(exc.http_status, exc.to_dict())
            return
        except Exception as exc:                                  # pragma: no cover
            self.log_message("未预期异常: %r", exc)
            self._send_obj(500, {"ok": False, "error": "internal_error", "message": str(exc)})
            return

        self._send_obj(200, medcollect_candidate(result) if shape == "medcollect" else result)


def main(argv: list[str] | None = None) -> int:
    global CLIENT
    ap = argparse.ArgumentParser(description="码上放心追溯码查询 API 服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--min-interval", type=float, default=1.5,
                    help="两次上游请求之间的最小间隔（秒），太快会被风控")
    ap.add_argument("--cache-ttl", type=float, default=600.0, help="结果缓存秒数")
    ap.add_argument("--backend", default="auto", choices=["auto", "http", "browser"],
                    help="auto=先纯 HTTP，被风控再降级到浏览器；http=只走纯 HTTP；browser=只走浏览器")
    ap.add_argument("--headed", action="store_true", help="浏览器后端显示窗口（人可拖滑块）")
    ap.add_argument("--auto-verify", action=argparse.BooleanOptionalAction, default=True,
                    help="被风控拦下时自动弹出验证窗口（默认开，--no-auto-verify 关闭）")
    ap.add_argument("--verify-wait", type=float, default=4.0,
                    help="被拦后本次请求最多等多久（秒）；0=立刻返回 428，窗口留着给人拖")
    ap.add_argument("--verify-timeout", type=float, default=180.0,
                    help="验证窗口最长存在多久（秒）")
    ap.add_argument("--mock", metavar="FILE",
                    help="离线自测：把文件内容当作 ④ 的 data 返回，不访问上游（不是真实查询）")
    ap.add_argument("--no-dict", action="store_true",
                    help="关掉本机药品字典：每个码都老老实实问上游")
    ap.add_argument("--dict-file", metavar="FILE",
                    help="药品字典文件（默认 services/trace-api/drug_dict.json）")
    ap.add_argument("--dict-prefix", type=int, metavar="N",
                    help="药品标识码取前几位（默认 7）")
    args = ap.parse_args(argv)

    if args.mock:
        with open(args.mock, encoding="utf-8") as f:
            mock_data = json.load(f)
        mock_dict = None
        if args.dict_file or args.dict_prefix:      # 显式给了才演练字典命中
            from drug_dict import DrugDict
            mock_dict = DrugDict(args.dict_file, args.dict_prefix)
        CLIENT = MockClient(mock_data, args.mock, mock_dict)
        print(f"mock 模式：使用 {args.mock}，不会访问「码上放心」", flush=True)
    else:
        dictionary = None
        if not args.no_dict:
            from drug_dict import DrugDict
            dictionary = DrugDict(args.dict_file, args.dict_prefix)
        CLIENT = TraceCodeClient(min_interval=args.min_interval, cache_ttl=args.cache_ttl,
                                 backend=args.backend, headed=args.headed,
                                 auto_verify=args.auto_verify, verify_wait=args.verify_wait,
                                 verify_timeout=args.verify_timeout,
                                 dictionary=dictionary)

    loopback = args.host in ("127.0.0.1", "localhost", "::1", "[::1]")
    if not loopback and not API_KEY:
        print(f"警告：{args.host} 不是回环地址且没有设置 MSFX_API_KEY，同网段的机器都能直接查。"
              "只给本机 App 用就保持默认的 127.0.0.1。", file=sys.stderr, flush=True)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"trace-api 已启动： http://{args.host}:{args.port}/", flush=True)
    print(f"  只接受本机请求 = {'是' if loopback else '否（已对外监听）'}", flush=True)
    print(f"  backend = {'mock' if args.mock else args.backend}", flush=True)
    print(f"  鉴权 = {'开（需 X-API-Key 或 Bearer）' if API_KEY else '关闭（本机使用，不需要任何密钥）'}",
          flush=True)
    dictionary = getattr(CLIENT, "dictionary", None)
    if dictionary is not None:
        info = dictionary.stats()
        print(f"  药品字典 = {info['entries']} 条（前 {info['prefix_len']} 位标识码）"
              f" {info['file']}", flush=True)
    if not args.mock:
        print(f"  自动弹窗验证 = {'开' if args.auto_verify else '关'}"
              f"（本次请求最多等 {args.verify_wait:g}s）", flush=True)
    print(f"  示例： curl \"http://{args.host}:{args.port}/api/trace/medcollect?code=81123456789012345678\"",
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。", flush=True)
    finally:
        CLIENT.close()
        dictionary = getattr(CLIENT, "dictionary", None)
        if dictionary is not None:
            dictionary.close()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
