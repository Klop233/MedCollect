# -*- coding: utf-8 -*-
"""离线自测：滑块验证的调度逻辑（不真的开浏览器）。

    python test_verify.py
"""
from __future__ import annotations

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from msfx_client import FloodControl, TraceCodeClient  # noqa: E402
from verify import SliderVerifier  # noqa: E402


class VerifierTest(unittest.TestCase):
    def test_只开一个窗口_成功后自动复位(self):
        release = threading.Event()

        def opener(url, **_kwargs):
            release.wait(5)
            return {"ok": True, "saved": 3}

        verifier = SliderVerifier(".", cooldown=0, opener=opener)
        self.assertTrue(verifier.start("https://example.test/punish"))
        self.assertTrue(verifier.active)
        self.assertFalse(verifier.start("https://example.test/punish"))   # 不叠第二个窗口
        release.set()
        self.assertTrue(verifier.wait(5))
        self.assertFalse(verifier.active)
        state = verifier.state()
        self.assertTrue(state["ok"])
        self.assertEqual(state["attempts"], 1)

    def test_失败时给出原因并进入冷却(self):
        verifier = SliderVerifier(".", cooldown=30,
                                  opener=lambda url, **_kw: {"ok": False, "message": "等待超时"})
        self.assertTrue(verifier.start("https://example.test/punish"))
        self.assertFalse(verifier.wait(5))
        self.assertEqual(verifier.state()["message"], "等待超时")
        self.assertFalse(verifier.start("https://example.test/punish"))   # 冷却中不再弹窗
        verifier._last_started = time.time() - 31
        self.assertTrue(verifier.start("https://example.test/punish"))

    def test_浏览器起不来也不会卡在活动状态(self):
        def boom(url, **_kwargs):
            raise RuntimeError("没有可用的浏览器")

        verifier = SliderVerifier(".", cooldown=0, opener=boom)
        self.assertTrue(verifier.start("https://example.test/punish"))
        self.assertFalse(verifier.wait(5))
        self.assertFalse(verifier.active)
        self.assertIn("没有可用的浏览器", verifier.state()["message"])

    def test_没有地址就不弹窗(self):
        verifier = SliderVerifier(".", cooldown=0, opener=lambda *a, **k: {"ok": True})
        self.assertFalse(verifier.start(""))


class Recorder:
    def __init__(self, succeed_after_wait: bool = False):
        self.urls = []
        self.active = False
        self.succeed_after_wait = succeed_after_wait

    def start(self, url: str) -> bool:
        self.urls.append(url)
        self.active = True
        return True

    def wait(self, timeout: float) -> bool:
        self.active = False
        return self.succeed_after_wait

    def state(self):
        return {"active": self.active}


class ClientGlueTest(unittest.TestCase):
    def test_被滑块拦住时自动弹窗(self):
        recorder = Recorder()
        client = TraceCodeClient(auto_verify=True, verify_wait=0, verifier=recorder)
        blocked = FloodControl("被拦", punish_url="https://punish.test/x")
        self.assertFalse(client._auto_verify_for(blocked))        # 不等 = 本次请求立刻返回
        self.assertEqual(recorder.urls, ["https://punish.test/x"])
        self.assertEqual(client.stats["verifications"], 1)

    def test_登录墙不弹滑块窗口(self):
        recorder = Recorder()
        client = TraceCodeClient(auto_verify=True, verify_wait=0, verifier=recorder)
        wall = FloodControl("登录墙", punish_url="https://login.taobao.com/x", login_required=True)
        self.assertFalse(client._auto_verify_for(wall))
        self.assertEqual(recorder.urls, [])

    def test_等人拖完就在本次请求里继续(self):
        recorder = Recorder(succeed_after_wait=True)
        client = TraceCodeClient(auto_verify=True, verify_wait=5, verifier=recorder)
        blocked = FloodControl("被拦", punish_url="https://punish.test/x")
        self.assertTrue(client._auto_verify_for(blocked))

    def test_关掉自动验证就完全不弹窗(self):
        recorder = Recorder()
        client = TraceCodeClient(auto_verify=False, verify_wait=5, verifier=recorder)
        blocked = FloodControl("被拦", punish_url="https://punish.test/x")
        self.assertFalse(client._auto_verify_for(blocked))
        self.assertEqual(recorder.urls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
