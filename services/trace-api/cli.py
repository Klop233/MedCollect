# -*- coding: utf-8 -*-
"""命令行用法：python cli.py <追溯码> [--fresh] [--data] [--backend auto|http|browser]"""
from __future__ import annotations

import argparse
import json
import sys

from msfx_client import FloodControl, MsfxError, NeedsHuman, TraceCodeClient

try:
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="查询一个「码上放心」追溯码")
    ap.add_argument("code", help="20 位追溯码")
    ap.add_argument("--fresh", action="store_true", help="跳过缓存")
    ap.add_argument("--data", action="store_true", help="只打印原始 data 字段")
    ap.add_argument("--min-interval", type=float, default=1.5)
    ap.add_argument("--backend", default="auto", choices=["auto", "http", "browser"])
    ap.add_argument("--headed", action="store_true", help="浏览器后端显示窗口")
    args = ap.parse_args(argv)

    client = TraceCodeClient(min_interval=args.min_interval, backend=args.backend,
                             headed=args.headed)
    result = None
    try:
        result = client.query(args.code, fresh=args.fresh)
    except NeedsHuman as exc:
        print("需要先过一次滑块验证： python solve.py", file=sys.stderr)
        print(f"  punish_url: {exc.extra.get('punish_url', '')[:160]}", file=sys.stderr)
        return 4
    except FloodControl as exc:
        print(f"被风控拦下：{exc.message}", file=sys.stderr)
        print(f"  punish_url: {exc.extra.get('punish_url', '')[:160]}", file=sys.stderr)
        return 3
    except MsfxError as exc:
        print(json.dumps(exc.to_dict(), ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    finally:
        client.close()

    if args.data:
        print(json.dumps(result["data"], ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
