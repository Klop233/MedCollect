# -*- coding: utf-8 -*-
"""离线自测：只验证「④ 的 data -> 对外 JSON」这一段的形状，不访问网络。

    python test_shape.py
"""
from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from msfx_client import (InvalidCode, NotFound, TraceCodeClient,  # noqa: E402
                         medcollect_candidate, normalize_date, shape_result)

HERE = os.path.dirname(os.path.abspath(__file__))
CODE = "81123456789012345678"


def sample():
    with open(os.path.join(HERE, "mock-sample.json"), encoding="utf-8") as f:
        return json.load(f)


class ShapeTest(unittest.TestCase):
    def test_full_result_keeps_raw_data_and_summary(self):
        data = sample()
        out = shape_result(CODE, "TOKEN", data)
        self.assertTrue(out["ok"])
        self.assertEqual(out["code"], CODE)
        self.assertIs(out["data"], data)
        self.assertEqual(out["summary"]["drug_name"], "示例阿莫西林胶囊")
        self.assertEqual(out["summary"]["manufacturer"], "示例制药有限公司")

    def test_medcollect_shape_matches_default_field_map(self):
        out = medcollect_candidate(shape_result(CODE, "TOKEN", sample()))
        self.assertEqual(out, {
            "traceCode": CODE,
            "genericName": "示例阿莫西林胶囊",
            "manufacturer": "示例制药有限公司",
            "specification": "0.25g×24粒/盒",
            "batchNumber": "B2408001",
            "expiresAt": "2028-07-31",
        })
        # MedCollect 的适配器要求 traceCode 是字符串且与请求一致
        self.assertIsInstance(out["traceCode"], str)

    def test_business_states_become_not_found(self):
        for data in (
            {"retCode": "2"},
            {"retCode": "1", "subRetCode": "11"},
            {"retCode": "1", "subRetCode": "12"},
            {"retCode": "1", "subRetCode": "13"},
        ):
            with self.assertRaises(NotFound):
                shape_result(CODE, "TOKEN", data)

    def test_medcollect_shape_omits_unknown_fields_instead_of_guessing(self):
        out = medcollect_candidate(shape_result(CODE, "TOKEN", {"retCode": "0", "drugName": "只有药名"}))
        self.assertEqual(out, {"traceCode": CODE, "genericName": "只有药名"})

    def test_dates_normalize_only_when_recognizable(self):
        cases = {
            "2028-07-31": "2028-07-31", "20280731": "2028-07-31",
            "20280731000000": "2028-07-31", "2028-07-31 00:00:00": "2028-07-31",
            "": None, "长期": None, None: None, "2028-13-01": None,
        }
        for raw, expected in cases.items():
            self.assertEqual(normalize_date(raw), expected, raw)

    def test_code_validation_is_unchanged(self):
        TraceCodeClient.validate(CODE)
        for bad in ("", "12345", "8112345678901234567", "abcdefghij0123456789"):
            with self.assertRaises(InvalidCode):
                TraceCodeClient.validate(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
