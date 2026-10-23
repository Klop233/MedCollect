# -*- coding: utf-8 -*-
"""
drug_dict — 本机「药品字典」：按追溯码前缀（药品标识码）记住产品级信息。

为什么需要
    同一款药的所有盒共用一个「药品标识码」，只有后面的序列号不同。查过一次以后，
    同款药的其他盒完全可以离线回答——不用再打上游，也就不会再撞风控。

记什么、不记什么
    记：药名、规格、生产企业、批准文号、剂型、注册分类、特殊管理药品分类
    不记：批号、生产日期、有效期、扫码次数、码状态
        这些是「每一盒」自己的信息，按产品缓存会张冠李戴。
        （MedCollect 本来就要求用户按药盒核对后手填这些字段。）

前缀多长
    默认取前 7 位，可用 MSFX_DICT_PREFIX / --dict-prefix 改。
    平台没有公开说明标识码的确切位数，所以这里带一个保险：同一个前缀后来出现了
    不同的药品时，这条前缀会被标成 ambiguous 并停止命中。宁可少缓存，
    也不会把 A 药的资料安到 B 药头上。

存储
    services/trace-api/drug_dict.json，原子写入（tmp + os.replace）。
    结构见 DrugDict.empty()。
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from typing import Any, Dict, Iterable, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PATH = os.path.join(HERE, "drug_dict.json")

DEFAULT_PREFIX_LEN = 7
MIN_PREFIX_LEN = 4
MAX_PREFIX_LEN = 20
MAX_ENTRIES = 20000
MAX_TEXT = 200

# 上游 summary 字段名 <-> 字典字段名。只有「产品级」的字段在这张表里。
SUMMARY_TO_PRODUCT = {
    "drug_name": "genericName",
    "spec": "specification",
    "manufacturer": "manufacturer",
    "approval_no": "approvalNumber",
    "dosage_form": "dosageForm",
    "registration_class": "registrationClass",
    "controlled_type": "controlledType",
}
PRODUCT_TO_SUMMARY = {v: k for k, v in SUMMARY_TO_PRODUCT.items()}
PRODUCT_FIELDS = tuple(SUMMARY_TO_PRODUCT.values())

# 明确不属于产品、永远不进字典的字段（写在这里是为了让人一眼看见边界）
BOX_LEVEL_FIELDS = ("batch_no", "production_date", "expiry_date", "scan_count", "code_status")


def clean_text(value: Any) -> Optional[str]:
    """压掉多余空白并截断；空串当没有。"""
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not text:
        return None
    return text[:MAX_TEXT]


def product_from_summary(summary: Dict[str, Any]) -> Dict[str, str]:
    """上游 summary -> 可缓存的产品信息（批号/日期一律丢掉）。"""
    product: Dict[str, str] = {}
    for source, target in SUMMARY_TO_PRODUCT.items():
        value = clean_text(summary.get(source))
        if value:
            product[target] = value
    return product


def summary_from_product(product: Dict[str, Any]) -> Dict[str, str]:
    """字典里的产品信息 -> 上游 summary 的键名，好让下游形状一致。"""
    summary: Dict[str, str] = {}
    for source, target in PRODUCT_TO_SUMMARY.items():
        value = clean_text(product.get(source))
        if value:
            summary[target] = value
    return summary


def product_key(product: Dict[str, Any]) -> str:
    """判断「是不是同一个产品」用的指纹：药名 + 规格 + 企业，忽略大小写和空白。"""
    def norm(name: str) -> str:
        return "".join(str(product.get(name) or "").split()).lower()

    return "|".join(norm(field) for field in ("genericName", "specification", "manufacturer"))


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _as_int(value: Any, default: int, minimum: int = 0) -> int:
    """手改过的 JSON 里什么都可能有，转不动就当默认值。"""
    try:
        return max(minimum, int(value))
    except (TypeError, ValueError):
        return default


class DrugDict:
    """线程安全的本机药品字典。没有命中就返回 None，绝不猜。"""

    def __init__(self, path: Optional[str] = None, prefix_len: Optional[int] = None,
                 enabled: bool = True, save: bool = True):
        self.path = path or os.environ.get("MSFX_DICT_FILE") or DEFAULT_PATH
        self.enabled = bool(enabled)
        self._save_enabled = bool(save)
        self._lock = threading.RLock()
        self._data = self.empty()
        self.counters = {"hits": 0, "learned": 0, "conflicts": 0,
                         "save_errors": 0, "load_errors": 0, "skipped": 0}
        self._load()
        self.prefix_len = self._resolve_prefix_len(prefix_len)

    # ------------------------------------------------------------------ 结构
    @staticmethod
    def empty() -> Dict[str, Any]:
        return {"version": 1, "prefix_len": DEFAULT_PREFIX_LEN,
                "updated_at": None, "entries": {}}

    def _resolve_prefix_len(self, explicit: Optional[int]) -> int:
        raw = explicit
        if raw is None:
            env = os.environ.get("MSFX_DICT_PREFIX", "").strip()
            if env:
                raw = int(env) if env.isdigit() else None
        if raw is None:
            raw = _as_int(self._data.get("prefix_len"), DEFAULT_PREFIX_LEN, 1)
        return max(MIN_PREFIX_LEN, min(MAX_PREFIX_LEN, int(raw)))

    # ------------------------------------------------------------------ 读写
    def _load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as f:
                obj = json.load(f)
        except FileNotFoundError:
            return
        except (OSError, ValueError) as exc:
            self.counters["load_errors"] += 1
            self._quarantine(f"读不出来（{exc}）")
            return
        if not isinstance(obj, dict) or not isinstance(obj.get("entries"), dict):
            self.counters["load_errors"] += 1
            self._quarantine("结构不对")
            return
        entries: Dict[str, Dict[str, Any]] = {}
        for key, entry in obj["entries"].items():
            if not isinstance(key, str) or not isinstance(entry, dict):
                continue
            product = entry.get("product")
            if not isinstance(product, dict) or not clean_text(product.get("genericName")):
                continue
            entries[key] = {
                "product": {k: v for k, v in product.items() if clean_text(v)},
                "samples": _as_int(entry.get("samples"), 1, 1),
                "conflicts": _as_int(entry.get("conflicts"), 0, 0),
                "ambiguous": bool(entry.get("ambiguous")),
                "first_seen": entry.get("first_seen") or _now(),
                "last_seen": entry.get("last_seen") or _now(),
            }
        self._data = {"version": 1,
                      "prefix_len": _as_int(obj.get("prefix_len"), DEFAULT_PREFIX_LEN, 1),
                      "updated_at": obj.get("updated_at"),
                      "entries": entries}

    def _quarantine(self, why: str) -> None:
        """坏文件先挪开留证，再从空字典开始，别让查询起不来。"""
        try:
            target = f"{self.path}.corrupt-{time.strftime('%Y%m%d%H%M%S')}"
            os.replace(self.path, target)
            sys.stderr.write(f"[drug_dict] {why}，已改名为 {os.path.basename(target)}\n")
        except OSError:
            pass

    def _save(self) -> None:
        if not self._save_enabled:
            return
        payload = {"version": 1, "prefix_len": self.prefix_len,
                   "updated_at": _now(), "entries": self._data["entries"]}
        try:
            directory = os.path.dirname(os.path.abspath(self.path))
            os.makedirs(directory, exist_ok=True)
            tmp = f"{self.path}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
                f.write("\n")
            os.replace(tmp, self.path)
            self._data["updated_at"] = payload["updated_at"]
        except OSError as exc:
            self.counters["save_errors"] += 1
            sys.stderr.write(f"[drug_dict] 写盘失败：{exc}\n")

    # ------------------------------------------------------------------ 查询
    def prefix_of(self, code: str) -> str:
        return (code or "").strip()[: self.prefix_len]

    def lookup(self, code: str) -> Optional[Dict[str, Any]]:
        """按前缀取产品信息；没有、不确定、或已停用都返回 None。"""
        if not self.enabled or not code:
            return None
        key = self.prefix_of(code)
        if len(key) < MIN_PREFIX_LEN:
            return None
        with self._lock:
            entry = self._data["entries"].get(key)
            if not entry or entry.get("ambiguous"):
                return None
            product = dict(entry.get("product") or {})
            if not clean_text(product.get("genericName")):
                return None
            self.counters["hits"] += 1
            return {"product": product, "prefix": key, "prefix_len": self.prefix_len,
                    "samples": entry.get("samples", 1), "last_seen": entry.get("last_seen")}

    # ------------------------------------------------------------------ 学习
    def remember(self, code: str, product: Dict[str, Any]) -> str:
        """把一次真实查询的结果记进字典。

        返回 "new" / "updated" / "unchanged" / "conflict" / "ambiguous" / "skipped"。
        """
        if not self.enabled:
            return "skipped"
        name = clean_text((product or {}).get("genericName"))
        if not name:
            self.counters["skipped"] += 1
            return "skipped"
        key = self.prefix_of(code)
        if len(key) < MIN_PREFIX_LEN:
            self.counters["skipped"] += 1
            return "skipped"
        clean = {k: v for k, v in product.items() if k in PRODUCT_FIELDS and clean_text(v)}

        with self._lock:
            entries = self._data["entries"]
            entry = entries.get(key)
            now = _now()
            if entry is None:
                entries[key] = {"product": clean, "samples": 1, "conflicts": 0,
                                "ambiguous": False, "first_seen": now, "last_seen": now}
                self._trim()
                self.counters["learned"] += 1
                self._save()
                return "new"

            if entry.get("ambiguous"):
                return "ambiguous"

            if product_key(entry["product"]) != product_key(clean):
                entry["conflicts"] = int(entry.get("conflicts") or 0) + 1
                entry["ambiguous"] = True          # 一个前缀两种药：立即停用，宁可少缓存
                self.counters["conflicts"] += 1
                self._save()
                return "conflict"

            before = dict(entry["product"])
            entry["samples"] = int(entry.get("samples") or 1) + 1
            entry["last_seen"] = now
            for field, value in clean.items():     # 新查到的字段补上，不覆盖已有
                entry["product"].setdefault(field, value)
            if entry["product"] == before:         # 没有新字段，不用写盘
                return "unchanged"
            self.counters["learned"] += 1
            self._save()
            return "updated"

    def _trim(self) -> None:
        entries = self._data["entries"]
        if len(entries) <= MAX_ENTRIES:
            return
        over = len(entries) - MAX_ENTRIES
        oldest = sorted(entries, key=lambda k: entries[k].get("last_seen") or "")
        for key in oldest[:over]:
            entries.pop(key, None)

    # ------------------------------------------------------------------ 维护
    def drop(self, prefix: str) -> bool:
        with self._lock:
            if self._data["entries"].pop(prefix, None) is None:
                return False
            self._save()
            return True

    def clear(self) -> int:
        with self._lock:
            count = len(self._data["entries"])
            self._data["entries"] = {}
            self._save()
            return count

    def prune(self, max_age_days: float) -> int:
        """删掉太久没再遇到的条目。0 或负数表示只删从未成功过的脏数据。"""
        if max_age_days <= 0:
            return 0
        cutoff = time.time() - max_age_days * 86400
        removed = 0
        with self._lock:
            for key in list(self._data["entries"]):
                last = self._data["entries"][key].get("last_seen") or ""
                try:
                    stamp = time.mktime(time.strptime(last[:19], "%Y-%m-%dT%H:%M:%S"))
                except (ValueError, OverflowError):
                    continue
                if stamp < cutoff:
                    self._data["entries"].pop(key, None)
                    removed += 1
            if removed:
                self._save()
        return removed

    def entries(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(entry, prefix=key) for key, entry in self._data["entries"].items()]

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            entries = self._data["entries"]
            return {
                "enabled": self.enabled,
                "file": self.path,
                "prefix_len": self.prefix_len,
                "entries": len(entries),
                "ambiguous": sum(1 for e in entries.values() if e.get("ambiguous")),
                "samples": sum(int(e.get("samples") or 0) for e in entries.values()),
                "updated_at": self._data.get("updated_at"),
                **self.counters,
            }

    def close(self) -> None:
        with self._lock:
            self._save()
