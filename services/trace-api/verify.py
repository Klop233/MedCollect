# -*- coding: utf-8 -*-
"""
verify.py — 需要真人过滑块时，自动弹出一个可见窗口并等待。

阿里风控拦下取数接口时会返回一个 punish 页地址；那页上的 NC 滑块只能人拖。
本模块把它做成可复用的两步：

    open_slider(punish_url, ...)   开可见窗口 → 人拖 → 检测到 x5sec → 存 cookies.json → 关窗口
    SliderVerifier                 后台线程 + 冷却 + 状态，给 server.py 用

窗口开在服务所在的这台机器上，所以验证必须由坐在机器前的人完成。
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Optional

Opener = Callable[..., Dict[str, Any]]


def open_slider(punish_url: str, *, profile_dir: str, timeout: float = 180.0,
                poll: float = 1.5, port: int = 9222) -> Dict[str, Any]:
    """在可见窗口里打开滑块页，等人拖完；成功后把 cookie 写进 cookies.json。"""
    from browser import Browser, WebSocket
    from msfx_client import load_cookie_jar, save_cookie_jar

    browser = Browser(profile_dir=profile_dir, port=port, headed=True)
    browser.start()
    target = browser._new_target("about:blank")
    ws = WebSocket(target["webSocketDebuggerUrl"], timeout=60).connect()
    try:
        browser._call(ws, "Page.enable", timeout=10)
        browser._call(ws, "Network.enable", timeout=10)
        browser._call(ws, "Page.navigate", {"url": punish_url}, timeout=15)
        try:
            browser._call(ws, "Page.bringToFront", timeout=5)
        except Exception:
            pass                                    # 窗口置顶失败不影响拖动

        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(poll)
            try:
                result = browser._call(ws, "Network.getAllCookies", {}, timeout=15)
            except Exception:
                continue
            cookies = result.get("cookies") or []
            if not any(c.get("name") == "x5sec" for c in cookies):
                continue
            jar = load_cookie_jar()
            saved = 0
            for cookie in cookies:
                domain = (cookie.get("domain") or "").lower()
                if "mashangfangxin.com" not in domain:
                    continue
                jar.setdefault(domain, {})[cookie["name"]] = cookie["value"]
                saved += 1
            save_cookie_jar(jar)
            return {"ok": True, "saved": saved}
        return {"ok": False, "message": "等待超时，滑块可能没有拖过"}
    finally:
        ws.close()
        browser._close_target(target.get("id"))
        browser.stop()


class SliderVerifier:
    """同一时间只开一个验证窗口；失败后冷却一段时间，避免窗口反复弹出。"""

    def __init__(self, profile_dir: str, *, timeout: float = 180.0, cooldown: float = 45.0,
                 port: int = 9222, opener: Optional[Opener] = None):
        self.profile_dir = profile_dir
        self.timeout = timeout
        self.cooldown = cooldown
        self.port = port
        self._opener = opener or open_slider
        self._lock = threading.Lock()
        self._done = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._last_started = 0.0
        self._attempts = 0
        self._state: Dict[str, Any] = {
            "active": False, "ok": None, "attempts": 0,
            "url": "", "message": "尚未触发", "started_at": None, "finished_at": None,
        }

    # -- 状态
    @property
    def active(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    def state(self) -> Dict[str, Any]:
        with self._lock:
            snapshot = dict(self._state)
        snapshot["active"] = self.active
        return snapshot

    def can_start(self) -> bool:
        if self.active:
            return False
        return time.time() - self._last_started >= self.cooldown

    # -- 控制
    def start(self, punish_url: str) -> bool:
        """开一个验证窗口；已经在验证或还在冷却时返回 False。"""
        if not punish_url or not self.can_start():
            return False
        with self._lock:
            self._last_started = time.time()
            self._attempts += 1
            self._done.clear()
            self._state.update(active=True, ok=None, attempts=self._attempts,
                               url=punish_url[:300], message="等待拖动滑块",
                               started_at=time.time(), finished_at=None)
            self._thread = threading.Thread(target=self._run, args=(punish_url,),
                                            name="slider-verify", daemon=True)
            self._thread.start()
        return True

    def wait(self, timeout: float) -> bool:
        """等验证结束；返回是否验证成功（没在跑就返回上一次结果）。"""
        if not self.active:
            return self.state().get("ok") is True
        self._done.wait(timeout)
        return self.state().get("ok") is True

    # -- 线程体
    def _run(self, punish_url: str) -> None:
        outcome: Dict[str, Any] = {}
        try:
            outcome = self._opener(punish_url, profile_dir=self.profile_dir,
                                   timeout=self.timeout, port=self.port) or {}
        except Exception as exc:                       # 浏览器起不来、窗口被关掉等
            outcome = {"ok": False, "message": f"打开验证窗口失败：{exc}"}
        finally:
            ok = outcome.get("ok") is True
            with self._lock:
                self._state.update(active=False, ok=ok, finished_at=time.time(),
                                   message="验证通过" if ok else outcome.get("message") or "未通过")
            self._done.set()
