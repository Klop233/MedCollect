# -*- coding: utf-8 -*-
"""离线自测：本机药品字典 + 查询链路里的字典命中。不访问网络。

    python test_dict.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from drug_dict import DrugDict, product_from_summary, summary_from_product  # noqa: E402
from msfx_client import (TraceCodeClient, medcollect_candidate,  # noqa: E402
                         shape_result)

HERE = os.path.dirname(os.path.abspath(__file__))
# 同前缀（前 7 位 8112345）、不同序列号的两盒药
CODE_A = "81123456789012345678"
CODE_B = "81123450000000000001"
CODE_OTHER = "81123456789012345699"

PRODUCT = {"genericName": "示例阿莫西林胶囊", "manufacturer": "示例制药有限公司",
           "specification": "0.25g×24粒/盒", "approvalNumber": "国药准字H00000001"}


def sample():
    with open(os.path.join(HERE, "mock-sample.json"), encoding="utf-8") as f:
        return json.load(f)


class TempDict(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="drug-dict-")
        self.path = os.path.join(self.dir, "drug_dict.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def open(self, **kwargs):
        return DrugDict(self.path, **kwargs)


class DrugDictTest(TempDict):
    def test_remembers_once_and_answers_other_boxes_of_same_product(self):
        dictionary = self.open()
        self.assertEqual(dictionary.remember(CODE_A, PRODUCT), "new")
        hit = dictionary.lookup(CODE_B)                 # 另一盒，从没查过
        self.assertIsNotNone(hit)
        self.assertEqual(hit["prefix"], "8112345")
        self.assertEqual(hit["product"]["genericName"], "示例阿莫西林胶囊")
        self.assertEqual(hit["samples"], 1)
        self.assertIsNone(dictionary.lookup("99999999999999999999"))

    def test_never_caches_per_box_fields(self):
        dictionary = self.open()
        summary = {
            "drug_name": "示例阿莫西林胶囊", "manufacturer": "示例制药有限公司",
            "batch_no": "B2408001", "expiry_date": "2028-07-31",
            "production_date": "2024-08-01", "scan_count": 3, "code_status": "1",
        }
        product = product_from_summary(summary)
        self.assertEqual(set(product), {"genericName", "manufacturer"})
        dictionary.remember(CODE_A, product)
        for field in ("batchNumber", "batchNo", "expiryDate", "expiresAt",
                      "productionDate", "scanCount", "codeStatus"):
            self.assertNotIn(field, dictionary.lookup(CODE_B)["product"])

    def test_same_prefix_different_drug_stops_hitting(self):
        dictionary = self.open()
        dictionary.remember(CODE_A, PRODUCT)
        clash = dict(PRODUCT, genericName="别的药片")
        self.assertEqual(dictionary.remember(CODE_OTHER, clash), "conflict")
        self.assertIsNone(dictionary.lookup(CODE_B))    # 宁可少缓存，也不给错药名
        self.assertEqual(dictionary.stats()["ambiguous"], 1)

    def test_counts_repeat_samples_without_conflict(self):
        dictionary = self.open()
        dictionary.remember(CODE_A, PRODUCT)
        self.assertEqual(dictionary.remember(CODE_B, PRODUCT), "unchanged")
        self.assertEqual(dictionary.lookup(CODE_A)["samples"], 2)

    def test_survives_restart(self):
        first = self.open()
        first.remember(CODE_A, PRODUCT)
        first.close()
        second = self.open()
        self.assertEqual(second.lookup(CODE_B)["product"]["genericName"], "示例阿莫西林胶囊")

    def test_prefix_length_is_configurable(self):
        dictionary = self.open(prefix_len=10)
        dictionary.remember(CODE_A, PRODUCT)
        self.assertIsNone(dictionary.lookup(CODE_B))    # 前 10 位不同，不算同款
        self.assertIsNotNone(dictionary.lookup(CODE_A))

    def test_disabled_dictionary_learns_and_answers_nothing(self):
        dictionary = DrugDict(self.path, enabled=False)
        self.assertEqual(dictionary.remember(CODE_A, PRODUCT), "skipped")
        self.assertIsNone(dictionary.lookup(CODE_A))

    def test_broken_file_is_quarantined_instead_of_crashing(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{ this is not json")
        dictionary = self.open()
        self.assertEqual(dictionary.stats()["entries"], 0)
        self.assertEqual(dictionary.stats()["load_errors"], 1)
        self.assertTrue(any(name.startswith("drug_dict.json.corrupt-")
                            for name in os.listdir(self.dir)))

    def test_summary_roundtrip_keeps_names(self):
        summary = summary_from_product(PRODUCT)
        self.assertEqual(summary["drug_name"], PRODUCT["genericName"])
        self.assertEqual(product_from_summary(summary), PRODUCT)

    def test_hand_edited_file_still_loads(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "prefix_len": "七位",
                       "entries": {"8112345": {"product": {"genericName": "手改的药"},
                                               "samples": "很多", "conflicts": None}}}, f)
        dictionary = self.open()
        info = dictionary.stats()
        self.assertEqual(info["entries"], 1)
        self.assertEqual(info["prefix_len"], 7)
        self.assertEqual(dictionary.lookup(CODE_A)["samples"], 1)


class ClientDictTest(TempDict):
    """查询链路：第二盒不应该再碰上游。"""

    def build(self):
        dictionary = self.open()

        class Counting(TraceCodeClient):
            calls = 0

            def _run(self, code):                      # 不联网：直接把样例当上游数据
                type(self).calls += 1
                return shape_result(code, "TOKEN", sample())

        return Counting(min_interval=0, dictionary=dictionary), dictionary

    def test_second_box_comes_from_dictionary(self):
        client, dictionary = self.build()
        first = client.query(CODE_A)
        self.assertNotIn("source", first)
        self.assertEqual(type(client).calls, 1)

        second = client.query(CODE_B)
        self.assertEqual(second["source"], "drug_dict")
        self.assertIs(second["batch_fields_known"], False)
        self.assertEqual(type(client).calls, 1)        # 没有第二次上游请求
        self.assertEqual(client.stats["dict_hits"], 1)

        candidate = medcollect_candidate(second)
        self.assertEqual(candidate["traceCode"], CODE_B)
        self.assertEqual(candidate["genericName"], "示例阿莫西林胶囊")
        self.assertEqual(candidate["specification"], "0.25g×24粒/盒")
        self.assertEqual(candidate["source"], "drug_dict")
        self.assertIs(candidate["batchKnown"], False)
        self.assertNotIn("batchNumber", candidate)     # 批号不属于产品，绝不猜
        self.assertNotIn("expiresAt", candidate)

    def test_fresh_query_still_reaches_upstream(self):
        client, dictionary = self.build()
        client.query(CODE_A)
        client.query(CODE_A, fresh=True)
        self.assertEqual(type(client).calls, 2)

    def test_dict_hit_is_not_cached_as_upstream_data(self):
        client, dictionary = self.build()
        client.query(CODE_A)
        hit = client.query(CODE_B)
        self.assertEqual(hit["source"], "drug_dict")
        # 再查 CODE_A 仍然是真结果（内存缓存里存的不是字典结果）
        again = client.query(CODE_A)
        self.assertNotIn("source", again)


if __name__ == "__main__":
    unittest.main(verbosity=2)
