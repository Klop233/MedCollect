# -*- coding: utf-8 -*-
"""
dict_cli — 维护本机药品字典（services/trace-api/drug_dict.json）。

    # 看统计（默认）
    node services/trace-api/launch.mjs dict_cli.py

    # 灌种子：JSON / CSV 都行，字段名会自动认
    node services/trace-api/launch.mjs dict_cli.py --import boxes.json
    node services/trace-api/launch.mjs dict_cli.py --import boxes.csv

    # 看某一条
    node services/trace-api/launch.mjs dict_cli.py --show 8123456
    # 删一条 / 清理 180 天没再遇到的
    node services/trace-api/launch.mjs dict_cli.py --drop 8123456
    node services/trace-api/launch.mjs dict_cli.py --prune 180

JSON 可以直接喂 wrangler 的导出：

    npx wrangler d1 execute medcollect --remote --json \\
      --command "select trace_code, generic_name, manufacturer, specification from ..." \\
      > boxes.json

导入只用到「码 + 产品级字段」，批号和有效期会被丢掉（它们属于每一盒，不属于产品）。
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from typing import Any, Dict, Iterable, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from drug_dict import DrugDict  # noqa: E402
from msfx_client import CODE_RE, TraceCodeClient  # noqa: E402

# 导入时认这些字段名（前面的优先）。驼峰、下划线、中文都接受
ALIASES = {
    "genericName": ("genericName", "generic_name", "drugName", "drug_name", "name",
                    "药名", "药品名称", "通用名"),
    "specification": ("specification", "spec", "pkgSpec", "pkg_spec", "规格", "包装规格"),
    "manufacturer": ("manufacturer", "produceEntName", "entName", "生产企业", "厂家", "生产厂家"),
    "approvalNumber": ("approvalNumber", "approval_number", "approvalNo", "approval_no", "批准文号"),
    "dosageForm": ("dosageForm", "dosage_form", "prepnType", "剂型"),
    "registrationClass": ("registrationClass", "registration_class", "注册分类"),
    "controlledType": ("controlledType", "controlled_type", "特殊管理药品分类"),
}
CODE_KEYS = ("traceCode", "trace_code", "code", "追溯码", "药品追溯码", "码")


def pick(record: Dict[str, Any], keys: Iterable[str]) -> str:
    lowered = {str(k).strip().lower(): v for k, v in record.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def flatten(obj: Any) -> List[Dict[str, Any]]:
    """把各种 JSON 形状摊平成一串记录。"""
    if isinstance(obj, dict):
        for key in ("results", "rows", "data", "records"):
            if isinstance(obj.get(key), list):
                return flatten(obj[key])
        return [obj]
    if isinstance(obj, list):
        out: List[Dict[str, Any]] = []
        for item in obj:
            out.extend(flatten(item))
        return out
    return []


def read_records(path: str) -> List[Dict[str, Any]]:
    ext = os.path.splitext(path)[1].lower()
    with open(path, encoding="utf-8-sig", newline="") as f:
        if ext in (".csv", ".tsv"):
            delimiter = "\t" if ext == ".tsv" else ","
            return [dict(row) for row in csv.DictReader(f, delimiter=delimiter)]
        return flatten(json.load(f))


def import_file(dictionary: DrugDict, path: str, *, dry_run: bool = False) -> Dict[str, int]:
    records = read_records(path)
    tally = {"rows": len(records), "imported": 0, "skipped": 0, "invalid": 0, "conflict": 0}
    for record in records:
        if not isinstance(record, dict):
            tally["skipped"] += 1
            continue
        code = TraceCodeClient.normalize_code(pick(record, CODE_KEYS))
        if not CODE_RE.match(code):
            tally["invalid"] += 1
            continue
        product = {field: pick(record, aliases) for field, aliases in ALIASES.items()}
        product = {k: v for k, v in product.items() if v}
        if not product.get("genericName"):
            tally["skipped"] += 1
            continue
        if dry_run:
            tally["imported"] += 1
            continue
        status = dictionary.remember(code, product)
        if status == "conflict":
            tally["conflict"] += 1
        elif status == "skipped":
            tally["skipped"] += 1
        else:
            tally["imported"] += 1
    return tally


def show(dictionary: DrugDict, prefix: Optional[str], as_json: bool) -> None:
    entries = dictionary.entries()
    if prefix:
        entries = [e for e in entries if str(e.get("prefix", "")).startswith(prefix)]
    entries.sort(key=lambda e: e.get("last_seen") or "", reverse=True)
    if as_json:
        print(json.dumps(entries, ensure_ascii=False, indent=2))
        return
    if not entries:
        print("（没有条目）")
        return
    print(f"{'标识码':<10} {'药名':<24} {'规格':<18} {'企业':<22} {'次数':>4}  备注")
    for entry in entries:
        product = entry.get("product") or {}
        note = "已停用（同前缀出现不同药品）" if entry.get("ambiguous") else ""
        print(f"{entry.get('prefix',''):<10} {product.get('genericName','')[:24]:<24} "
              f"{product.get('specification','')[:18]:<18} {product.get('manufacturer','')[:22]:<22} "
              f"{entry.get('samples',0):>4}  {note}")


def print_stats(dictionary: DrugDict, as_json: bool) -> None:
    info = dictionary.stats()
    if as_json:
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return
    print(f"字典文件    {info['file']}")
    print(f"标识码位数  {info['prefix_len']}")
    print(f"条目        {info['entries']}（其中停用 {info['ambiguous']}）")
    print(f"累计样本    {info['samples']}")
    print(f"本次命中    {info['hits']}   新学到 {info['learned']}   冲突 {info['conflicts']}")
    if info.get("save_errors") or info.get("load_errors"):
        print(f"读写错误    写 {info['save_errors']} 次 / 读 {info['load_errors']} 次")
    if not info["entries"]:
        print("\n提示：字典还是空的。正常查一次药就会自动记一条；"
              "也可以用 --import 从导出文件灌种子。")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="维护本机药品字典")
    ap.add_argument("--file", help="字典文件（默认 services/trace-api/drug_dict.json）")
    ap.add_argument("--prefix", type=int, help="标识码取前几位（默认 7）")
    ap.add_argument("--import", dest="import_path", metavar="FILE", help="导入 JSON / CSV")
    ap.add_argument("--dry-run", action="store_true", help="配合 --import：只统计不写盘")
    ap.add_argument("--show", nargs="?", const="", metavar="PREFIX", help="列出条目，可只列某个前缀")
    ap.add_argument("--drop", metavar="PREFIX", help="删掉一条")
    ap.add_argument("--prune", type=float, metavar="DAYS", help="删掉 N 天没再遇到的条目")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    args = ap.parse_args(argv)

    dictionary = DrugDict(args.file, args.prefix)
    code = 0

    if args.import_path:
        if not os.path.exists(args.import_path):
            print(f"找不到文件：{args.import_path}", file=sys.stderr)
            return 2
        tally = import_file(dictionary, args.import_path, dry_run=args.dry_run)
        verb = "可导入" if args.dry_run else "已导入"
        print(f"{verb} {tally['imported']} 条（共 {tally['rows']} 行；"
              f"缺药名跳过 {tally['skipped']}，码格式不对 {tally['invalid']}，"
              f"前缀冲突 {tally['conflict']}）")
        if tally["conflict"]:
            print("出现冲突说明这些码的前几位并不唯一：调大 --prefix 再导入。", file=sys.stderr)
            code = 1

    if args.drop is not None:
        print("已删除" if dictionary.drop(args.drop.strip()) else "没有这条")

    if args.prune:
        print(f"清理了 {dictionary.prune(args.prune)} 条")

    if args.show is not None:
        show(dictionary, args.show.strip() or None, args.json)
    elif not (args.import_path or args.drop is not None or args.prune):
        print_stats(dictionary, args.json)

    dictionary.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
