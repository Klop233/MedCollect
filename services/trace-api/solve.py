# -*- coding: utf-8 -*-
"""
solve.py — 一次性人机验证。

阿里的风控会给「取数」接口下发 NC 滑块（punish 页），滑块只能真人拖。
本脚本会：

    1. 先用纯 HTTP 打一次，看是否真的被风控拦住（没拦就直接结束）；
    2. 被拦就把 punish 页在**可见的** Edge/Chrome 窗口里打开；
    3. 你在窗口里把滑块拖到最右边；
    4. 脚本检测到 x5sec cookie 后，把 mashangfangxin.com 的 cookie 存进 cookies.json；
    5. 之后 server.py / cli.py 就能用这批 cookie 纯 HTTP 查询了。

用法：
    python solve.py                 # 打开可见浏览器，等你拖滑块
    python solve.py --code 8112...  # 拖完之后顺手查一个码，验证是否真的通了
"""
from __future__ import annotations

import argparse
import sys
import time

from msfx_client import (FloodControl, MtopSession, GATEWAY_DATA, GATEWAY_WEB,
                         API_DRUG, API_SHOW_URL, cookies_for, load_cookie_jar,
                         save_cookie_jar)


def _get_token(code: str) -> str:
    sess = MtopSession(GATEWAY_WEB)
    obj = sess.call(API_SHOW_URL, {"code": code}, min_interval=0.5)
    url = (obj.get("data") or {}).get("result", "")
    if "token=" not in url:
        raise SystemExit("拿不到查询 token，上游异常：" + str(obj.get("ret")))
    return url.split("token=")[1].split("&")[0]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="码上放心：一次性滑块验证，缓存 x5sec cookie")
    ap.add_argument("--code", default="81123456789012345678", help="用来触发的追溯码（任意 20 位）")
    ap.add_argument("--timeout", type=int, default=300, help="等待拖滑块的最长秒数")
    ap.add_argument("--profile", default=None, help="浏览器 profile 目录")
    args = ap.parse_args(argv)

    print("① 先测一下纯 HTTP 是否已经被风控拦住 ...")
    token = _get_token(args.code)
    probe = MtopSession(GATEWAY_DATA)
    try:
        probe.call(API_DRUG, {"code": args.code, "token": token, "queryAppName": "web",
                              "imageCode": "", "imageToken": ""}, min_interval=0.5)
        print("   没有被拦：纯 HTTP 直接可用，不需要做滑块验证。")
        return 0
    except FloodControl as exc:
        punish = exc.extra.get("punish_url") or ""
        if exc.extra.get("login_required") or not punish:
            print("   风控升级为登录墙，暂时没法用滑块过。请换网络/等一段时间再来。")
            print("   punish_url:", punish[:160])
            return 4
        print("   被风控拦下了（RGV587），需要过一次滑块。")

    from browser import Browser

    profile = args.profile or None
    b = Browser(profile_dir=profile) if profile else Browser()
    if not b.headed:
        b.headed = True                      # 必须是可见窗口，人要能拖
    print("② 正在打开浏览器窗口 ...")
    b.start()

    target = b._new_target("about:blank")
    import browser as B
    ws = B.WebSocket(target["webSocketDebuggerUrl"], timeout=60).connect()
    try:
        b._call(ws, "Page.enable", timeout=10)
        b._call(ws, "Network.enable", timeout=10)
        b._call(ws, "Page.navigate", {"url": punish}, timeout=10)
        try:
            b._call(ws, "Page.bringToFront", timeout=5)
        except Exception:
            pass

        print(f"③ 请在弹出的窗口里把滑块拖到最右边（最多等 {args.timeout} 秒）...")
        deadline = time.time() + args.timeout
        got = None
        while time.time() < deadline:
            time.sleep(2)
            try:
                res = b._call(ws, "Network.getAllCookies", {}, timeout=15)
            except Exception:
                continue
            for c in res.get("cookies", []):
                if c.get("name") == "x5sec":
                    got = c
                    break
            if got:
                break
            url_now = b._eval(ws, "location.href")
            if url_now and "punish" not in url_now:
                time.sleep(1)

        if not got:
            print("   超时没检测到 x5sec，滑块可能没拖过。可以重跑本脚本再试。")
            return 3

        print(f"   ✓ 已通过：x5sec @ {got.get('domain')}")

        # 把 mashangfangxin.com 相关 cookie 全部存下来
        jar = load_cookie_jar()
        res = b._call(ws, "Network.getAllCookies", {}, timeout=15)
        saved = 0
        for c in res.get("cookies", []):
            domain = (c.get("domain") or "").lower()
            if "mashangfangxin.com" not in domain:
                continue
            jar.setdefault(domain, {})[c["name"]] = c["value"]
            saved += 1
        save_cookie_jar(jar)
        print(f"   ✓ 已写入 cookies.json（{saved} 条 mashangfangxin.com cookie）")
    finally:
        ws.close()
        b._close_target(target.get("id"))
        b.stop()

    if args.code:
        print("④ 用新 cookie 复测一次查询 ...")
        from msfx_client import TraceCodeClient, MsfxError
        client = TraceCodeClient(backend="http")
        try:
            out = client.query(args.code, fresh=True)
            print("   ✓ 通了。返回字段：", list(out.get("summary", {}).keys())[:6], "...")
        except MsfxError as exc:
            print("   ✗ 仍然失败：", exc.code, exc.message)
            return 5
    print("\n完成。现在可以启动 API： python server.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
