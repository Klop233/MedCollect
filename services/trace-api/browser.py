# -*- coding: utf-8 -*-
"""
browser.py — 用本机 Edge/Chrome（CDP 协议）真实渲染页面，并在网络层抓取 mtop 响应。

只在「纯 HTTP 被风控挡住」时才会用到。因为页面里的 mtop 请求走的是浏览器自己的
TLS 指纹和 cookie（含 x5sec），比 Python 直接发请求更容易过阿里的风控。

纯标准库实现：一个够用的 WebSocket 客户端 + 一个够用的 CDP 客户端。
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.request
import urllib.parse
from typing import Any, Dict, List, Optional

# --------------------------------------------------------------------------- WebSocket
class WebSocket:
    """最小可用的 RFC6455 客户端（文本帧 + 分片 + ping/pong）。"""

    def __init__(self, url: str, timeout: float = 30.0):
        u = urllib.parse.urlparse(url)
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or 80
        self.path = u.path or "/"
        if u.query:
            self.path += "?" + u.query
        self.timeout = timeout
        self.sock: Optional[socket.socket] = None

    def connect(self) -> "WebSocket":
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.sock.settimeout(self.timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket 握手期间连接被关闭")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError("WebSocket 握手失败：" + head.split(b"\r\n")[0].decode("latin-1"))
        self._buf = rest
        return self

    # -- 底层读写
    def _read_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("WebSocket 连接已断开")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray()
        header.append(0x80 | opcode)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def recv_text(self) -> str:
        chunks: List[bytes] = []
        while True:
            b1, b2 = self._read_exact(2)
            fin = b1 & 0x80
            opcode = b1 & 0x0F
            masked = b2 & 0x80
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length) if length else b""
            if masked:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))

            if opcode == 0x8:                       # close
                raise ConnectionError("WebSocket 被对端关闭")
            if opcode == 0x9:                       # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:                       # pong
                continue
            chunks.append(payload)
            if fin:
                return b"".join(chunks).decode("utf-8", "replace")

    def close(self) -> None:
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- 浏览器
BROWSER_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def find_browser() -> Optional[str]:
    env = os.environ.get("MSFX_BROWSER")
    if env and os.path.exists(env):
        return env
    for p in BROWSER_CANDIDATES:
        if os.path.exists(p):
            return p
    for name in ("msedge", "chrome", "chromium"):
        p = shutil.which(name)
        if p:
            return p
    return None


class Browser:
    """一个带持久 profile 的受控浏览器实例。"""

    def __init__(self, *, profile_dir: str = ".browser-profile", port: int = 9222,
                 headed: bool = False, executable: Optional[str] = None):
        self.profile_dir = os.path.abspath(profile_dir)
        self.port = port
        self.headed = headed
        self.executable = executable or find_browser()
        self.proc: Optional[subprocess.Popen] = None

    # -- 生命周期
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def running(self) -> bool:
        try:
            with urllib.request.urlopen(self.base() + "/json/version", timeout=2) as r:
                return r.status == 200
        except Exception:
            return False

    def start(self, wait: float = 20.0) -> None:
        if self.running():
            return                                    # 复用已经开着的调试端口
        if not self.executable:
            raise RuntimeError("没找到 Edge/Chrome，可设置 MSFX_BROWSER 指向浏览器可执行文件")
        os.makedirs(self.profile_dir, exist_ok=True)
        args = [
            self.executable,
            f"--remote-debugging-port={self.port}",
            f"--user-data-dir={self.profile_dir}",
            "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--disable-sync",
            "--disable-features=Translate,MediaRouter",
            "--window-size=1280,900",
        ]
        if not self.headed:
            args += ["--headless=new", "--disable-gpu"]
        args.append("about:blank")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        deadline = time.time() + wait
        while time.time() < deadline:
            if self.running():
                return
            time.sleep(0.3)
        raise RuntimeError("浏览器调试端口没有起来")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=8)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        self.proc = None

    # -- 抓页面
    def fetch(self, url: str, *, api_filter: str = "/h5/mtop.", timeout: float = 30.0,
              settle: float = 1.5, want: Optional[str] = None) -> Dict[str, Any]:
        """打开 url，抓取所有 mtop 响应体，返回 {responses, page_text, final_url}。

        want: 指定「必须等到」的接口片段（如 getdrugresource），等到后再等 settle 秒收尾。
        """
        target = self._new_target("about:blank")
        ws = WebSocket(target["webSocketDebuggerUrl"], timeout=timeout).connect()
        responses: List[Dict[str, Any]] = []
        try:
            self._call(ws, "Network.enable", timeout=10)
            self._call(ws, "Page.enable", timeout=10)
            self._call(ws, "Page.navigate", {"url": url}, timeout=10)

            reqs: Dict[str, Dict[str, Any]] = {}
            deadline = time.time() + timeout
            last_body_at = 0.0
            while time.time() < deadline:
                try:
                    raw = ws.recv_text()
                except socket.timeout:
                    break
                msg = json.loads(raw)
                if "id" in msg:
                    continue                                  # 命令回执
                method = msg.get("method")
                p = msg.get("params") or {}
                if method == "Network.responseReceived":
                    resp = p.get("response") or {}
                    u = resp.get("url", "")
                    if api_filter in u:
                        reqs[p["requestId"]] = {"url": u, "status": resp.get("status")}
                elif method == "Network.loadingFinished":
                    info = reqs.pop(p.get("requestId"), None)
                    if info:
                        body = self._call(ws, "Network.getResponseBody",
                                          {"requestId": p["requestId"]}, timeout=15)
                        text = body.get("body", "")
                        if body.get("base64Encoded"):
                            text = base64.b64decode(text).decode("utf-8", "replace")
                        responses.append({"api": _api_name(info["url"]),
                                          "url": info["url"], "body": text})
                        last_body_at = time.time()
                if last_body_at and time.time() - last_body_at > settle:
                    if want is None or any(want in r["api"] for r in responses):
                        break                                 # 想要的接口已回来
            page_text, final_url = "", ""
            try:
                page_text = self._eval(ws, "document.body ? document.body.innerText.slice(0,4000) : ''")
                final_url = self._eval(ws, "location.href")
            except (TimeoutError, ConnectionError):
                pass
            return {"responses": responses, "page_text": page_text, "final_url": final_url}
        finally:
            ws.close()
            self._close_target(target.get("id"))

    def _eval(self, ws: WebSocket, expression: str) -> str:
        res = self._call(ws, "Runtime.evaluate",
                         {"expression": expression, "returnByValue": True}, timeout=10)
        return (res.get("result") or {}).get("value") or ""


    # -- CDP 辅助
    _cdp_id = 0

    def _call(self, ws: WebSocket, method: str, params: Optional[Dict[str, Any]] = None,
              timeout: float = 20.0) -> Dict[str, Any]:
        Browser._cdp_id += 1
        rid = Browser._cdp_id
        ws.send_text(json.dumps({"id": rid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(ws.recv_text())
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method} 失败：{msg['error']}")
                return msg.get("result") or {}
        raise TimeoutError(f"CDP 调用超时：{method}")

    def _new_target(self, url: str) -> Dict[str, Any]:
        req = urllib.request.Request(
            self.base() + "/json/new?" + urllib.parse.quote(url, safe=""), method="PUT")
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    def _close_target(self, target_id: Optional[str]) -> None:
        if not target_id:
            return
        try:
            urllib.request.urlopen(self.base() + "/json/close/" + target_id, timeout=5).read()
        except Exception:
            pass

    def cookies(self) -> List[Dict[str, Any]]:
        """通过浏览器自身的 HTTP 接口拿不到 cookie，这里开一个临时 target 用 CDP 取。"""
        target = self._new_target("about:blank")
        ws = WebSocket(target["webSocketDebuggerUrl"], timeout=15).connect()
        try:
            ws.send_text(json.dumps({"id": 1, "method": "Network.getAllCookies", "params": {}}))
            while True:
                msg = json.loads(ws.recv_text())
                if msg.get("id") == 1:
                    return (msg.get("result") or {}).get("cookies", [])
        finally:
            ws.close()
            self._close_target(target.get("id"))


def _api_name(url: str) -> str:
    import re
    m = re.search(r"/h5/(mtop\.[a-z0-9_.]+)/", url, re.I)
    return m.group(1) if m else url[:80]


if __name__ == "__main__":
    b = Browser(headed="--headed" in sys.argv)
    b.start()
    try:
        url = sys.argv[1]
        out = b.fetch(url)
        for r in out["responses"]:
            print("---", r["api"], len(r["body"]))
            print(r["body"][:800])
        print("final:", out["final_url"])
        print("text:", out["page_text"][:500])
    finally:
        b.stop()
