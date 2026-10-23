# -*- coding: utf-8 -*-
"""
msfx_client — 码上放心（阿里健康 / mashangfangxin.com）追溯码查询客户端。

平台前端的真实链路（逆向自 www.mashangfangxin.com 的前端 bundle）：

    1. mtop.alihealth.drug.ent.service   {serviceName: verificationImageService}   -> 图形验证码
    2. mtop.alijk.code.search.checkCode  {code, token}                             -> 校验验证码
    3. mtop.alijk.code.search.getshowurl {code}                                    -> 返回带 token 的查询地址
    4. mtop.alijk.code.search.getdrugresource.forweb
                                         {code, token, queryAppName, imageCode, imageToken} -> 药品追溯数据

（1）（2）只是前端挡在查询框前的人机闸门，服务端在（3）（4）上并不校验它，
所以不需要识别图形验证码，直接走（3）→（4）。

两个接口都在阿里 MTOP H5 网关（api2 / api3.mashangfangxin.com）上：

    * 签名  sign = md5(_m_h5_tk + "&" + t + "&" + appKey + "&" + data)，appKey = 12574478
    * 首次请求没有 _m_h5_tk cookie 时返回 TOKEN_EMPTY，网关同时下发 cookie，重签重试即可
    * 请求过密 / 客户端不像浏览器时触发风控：
        FAIL_SYS_USER_VALIDATE + RGV587_ERROR，响应里带一个 punish URL（NC 滑块验证页）

风控这一关没有纯 HTTP 的过法：punish 页是阿里 NC 滑块，必须由真人拖一次。
拖完会下发 x5sec cookie；本模块会把它连同其余 cookie 从 cookies.json 里复用，
之后就能纯 HTTP 查询了（见 solve.py）。

仅依赖 Python 标准库。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from drug_dict import DrugDict, product_from_summary, summary_from_product

APP_KEY = "12574478"
JSV = "2.7.0"

GATEWAY_WEB = "https://api2.mashangfangxin.com/h5/{api}/1.0/"    # getshowurl
GATEWAY_DATA = "https://api3.mashangfangxin.com/h5/{api}/1.0/"   # getdrugresource*

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0")

API_SHOW_URL = "mtop.alijk.code.search.getshowurl"
API_DRUG = "mtop.alijk.code.search.getdrugresource.forweb"

CODE_RE = re.compile(r"^(?:[58]\d{19}|9(?:2\d|[3-9]\d)\d{17})$")

HERE = os.path.dirname(os.path.abspath(__file__))
COOKIE_FILE = os.environ.get("MSFX_COOKIES", os.path.join(HERE, "cookies.json"))


# --------------------------------------------------------------------------- 异常
class MsfxError(Exception):
    code = "error"
    http_status = 502

    def __init__(self, message: str, **extra: Any):
        super().__init__(message)
        self.message = message
        self.extra = extra

    def to_dict(self) -> Dict[str, Any]:
        d = {"ok": False, "error": self.code, "message": self.message}
        d.update(self.extra)
        return d


class InvalidCode(MsfxError):
    code = "invalid_code"
    http_status = 400


class NotFound(MsfxError):
    code = "not_found"
    http_status = 404


class UpstreamError(MsfxError):
    code = "upstream_error"


class SessionError(MsfxError):
    code = "session_error"


class FloodControl(UpstreamError):
    """被阿里风控拦下（RGV587 / 滑块）。"""

    code = "rate_limited"
    http_status = 429


class NeedsHuman(FloodControl):
    """需要真人拖一次滑块（punish 页）。"""

    code = "needs_human"
    http_status = 428


# --------------------------------------------------------------------------- cookie
def load_cookie_jar(path: str = COOKIE_FILE) -> Dict[str, Dict[str, str]]:
    """cookies.json 形如 {domain: {name: value}}；也兼容扁平的 {name: value}。"""
    try:
        with open(path, encoding="utf-8") as f:
            obj = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(obj, dict):
        return {}
    if "cookies" in obj and isinstance(obj["cookies"], dict):
        obj = obj["cookies"]
    if obj and all(isinstance(v, str) for v in obj.values()):
        return {"*": dict(obj)}
    out: Dict[str, Dict[str, str]] = {}
    for domain, jar in obj.items():
        if isinstance(jar, dict):
            out[str(domain).lower()] = {str(k): str(v) for k, v in jar.items()}
    return out


def cookies_for(jar: Dict[str, Dict[str, str]], host: str) -> Dict[str, str]:
    """挑出适用于某个 host 的 cookie（含 .父域）。"""
    host = host.lower()
    merged: Dict[str, str] = dict(jar.get("*", {}))
    parts = host.split(".")
    for i in range(len(parts) - 1):
        merged.update(jar.get("." + ".".join(parts[i:]), {}))
    merged.update(jar.get(host, {}))
    return merged


def save_cookie_jar(jar: Dict[str, Dict[str, str]], path: str = COOKIE_FILE) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"saved_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "cookies": jar},
                  f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- 会话
class MtopSession:
    """一个 MTOP H5 会话：cookie、签名、token 握手、风控识别。"""

    def __init__(self, gateway: str, timeout: float = 20.0,
                 seed_cookies: Optional[Dict[str, str]] = None):
        self.gateway = gateway
        self.timeout = timeout
        self.host = (urllib.parse.urlparse(gateway).hostname or "").lower()
        self.cookies: Dict[str, str] = dict(seed_cookies) if seed_cookies is not None \
            else cookies_for(load_cookie_jar(), self.host)
        self.last_call = 0.0

    def _absorb(self, resp) -> None:
        for line in resp.headers.get_all("Set-Cookie") or []:
            pair = line.split(";", 1)[0]
            if "=" in pair:
                k, v = pair.split("=", 1)
                self.cookies[k.strip()] = v.strip()

    def _tk(self) -> str:
        return self.cookies.get("_m_h5_tk", "").split("_")[0]

    def call(self, api: str, data: Dict[str, Any], *, min_interval: float = 1.2,
             max_attempts: int = 3) -> Dict[str, Any]:
        payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        last: Optional[Exception] = None

        for _ in range(max_attempts):
            gap = time.time() - self.last_call
            if gap < min_interval:
                time.sleep(min_interval - gap)

            ts = str(int(time.time() * 1000))
            sign = hashlib.md5(f"{self._tk()}&{ts}&{APP_KEY}&{payload}".encode()).hexdigest()
            query = {
                "jsv": JSV, "appKey": APP_KEY, "t": ts, "sign": sign,
                "api": api, "v": "1.0", "type": "originaljson", "dataType": "json",
                "data": payload,
            }
            url = self.gateway.format(api=api.lower()) + "?" + urllib.parse.urlencode(query)
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Referer": "https://www.mashangfangxin.com/",
                "Origin": "https://www.mashangfangxin.com",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Accept-Language": "zh-CN,zh;q=0.9",
            })
            if self.cookies:
                req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))

            self.last_call = time.time()
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    body = resp.read().decode("utf-8", "replace")
                    self._absorb(resp)
            except (urllib.error.URLError, OSError) as exc:
                last = UpstreamError(f"网络请求失败：{exc}")
                time.sleep(0.6)
                continue

            try:
                obj = json.loads(body)
            except ValueError:
                last = UpstreamError("网关返回了非 JSON 内容", body=body[:300])
                continue

            ret_list = obj.get("ret") or []
            ret = ",".join(ret_list) if isinstance(ret_list, list) else str(ret_list)
            obj["_ret"] = ret

            if any(k in ret for k in ("TOKEN_EMPTY", "TOKEN_EXOIRED", "TOKEN_EXPIRED")):
                last = SessionError("MTOP token 握手未完成")
                continue
            if "RGV587" in ret or "FAIL_SYS_USER_VALIDATE" in ret:
                punish = (obj.get("data") or {}).get("url", "")
                if "login.taobao.com" in punish:
                    raise FloodControl(
                        "风控升级为「需登录淘宝账号」，过一段时间或换网络再试",
                        punish_url=punish, retry_after=600, login_required=True)
                raise FloodControl("被阿里风控拦下（RGV587），需要过滑块验证",
                                   punish_url=punish, retry_after=60)
            if "FAIL_SYS_SESSION_EXPIRED" in ret:
                self.cookies = cookies_for(load_cookie_jar(), self.host)
                last = SessionError("上游会话过期")
                continue
            if "SUCCESS" not in ret:
                raise UpstreamError(f"上游返回失败：{ret}", ret=ret, payload=obj.get("data"))
            return obj

        raise last or UpstreamError("上游请求失败")


# --------------------------------------------------------------------------- 客户端
class DictAware:
    """查询前先问本机药品字典，查到了就直接回答，查完再记回去（见 drug_dict.py）。

    子类只要准备 self.dictionary（DrugDict 或 None）和 self.stats 就能用。
    """

    dictionary = None

    def _dict_lookup(self, code: str) -> Optional[Dict[str, Any]]:
        """同款药以前查过：直接给产品级信息，不打上游。没有就返回 None。"""
        if self.dictionary is None:
            return None
        hit = self.dictionary.lookup(code)
        if not hit:
            return None
        summary = summary_from_product(hit["product"])
        if not summary.get("drug_name"):
            return None
        self.stats["dict_hits"] = self.stats.get("dict_hits", 0) + 1
        return {
            "ok": True,
            "code": code,
            "queried_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "token": None,
            "summary": summary,
            "data": {},
            "cached": True,
            "cache_age": 0,
            "source": "drug_dict",
            "dict": {
                "prefix": hit["prefix"],
                "prefix_len": hit["prefix_len"],
                "samples": hit["samples"],
                "last_seen": hit["last_seen"],
            },
            # 字典只回答「这是什么药」，批次信息必须按药盒核对
            "batch_fields_known": False,
            "note": "来自本机药品字典（产品级信息）；批号和有效期请按药盒补全。",
        }

    def _remember(self, code: str, result: Dict[str, Any]) -> None:
        if self.dictionary is None or result.get("source"):
            return
        try:
            self.dictionary.remember(code, product_from_summary(result.get("summary") or {}))
        except Exception as exc:                                  # 记不上不能影响查询
            sys.stderr.write(f"[trace-api] 药品字典写入失败：{exc!r}\n")


class TraceCodeClient(DictAware):
    """把一个 20 位追溯码变成结构化药品信息。

    backend:
        "http"    纯 HTTP（快；需要 cookies.json 里有可用的 x5sec）
        "browser" 用本机 Edge 真实渲染结果页并从网络层取 JSON（浏览器 profile 里要有 x5sec）
        "auto"    先 http，遇到风控再降级到 browser

    auto_verify:
        被风控拦下时自动弹出一个可见窗口等人拖滑块（见 verify.py）；
        verify_wait 是本次请求愿意等多久（秒），0 表示立刻返回 428，窗口留在那里给人拖。
    """

    def __init__(self, *, min_interval: float = 1.5, cache_ttl: float = 600.0,
                 timeout: float = 20.0, backend: str = "auto",
                 browser_profile: Optional[str] = None, headed: bool = False,
                 auto_verify: bool = False, verify_wait: float = 0.0,
                 verify_timeout: float = 180.0, verifier=None,
                 dictionary=None, use_dict: bool = True):
        self.min_interval = min_interval
        self.cache_ttl = cache_ttl
        self.timeout = timeout
        self.backend = backend
        self.browser_profile = browser_profile or os.path.join(HERE, ".browser-profile")
        self.headed = headed
        self.auto_verify = auto_verify
        self.verify_wait = max(0.0, verify_wait)
        if verifier is None and auto_verify:
            from verify import SliderVerifier
            verifier = SliderVerifier(self.browser_profile, timeout=verify_timeout)
        self.verifier = verifier
        # 本机药品字典：同款药的其他盒不用再问上游（见 drug_dict.py）
        if dictionary is None and use_dict:
            dictionary = DrugDict()
        self.dictionary = dictionary
        self._lock = threading.Lock()
        self._cache: Dict[str, tuple] = {}
        self._browser = None
        self.stats = {"queries": 0, "cache_hits": 0, "errors": 0,
                      "browser_fallbacks": 0, "verifications": 0, "dict_hits": 0}

    # -- 工具
    @staticmethod
    def normalize_code(raw: str) -> str:
        return re.sub(r"[^\dA-Za-z()\x1d]", "", (raw or "").strip())

    @staticmethod
    def validate(code: str) -> None:
        if not code:
            raise InvalidCode("追溯码不能为空")
        if not CODE_RE.match(code):
            raise InvalidCode(
                "追溯码格式不正确：应为 20 位数字（5/8 开头为药品，92-99 开头为其他行业）",
                code=code, expected=CODE_RE.pattern)

    # -- 主流程
    def query(self, raw_code: str, *, fresh: bool = False) -> Dict[str, Any]:
        code = self.normalize_code(raw_code)
        self.validate(code)

        if not fresh:
            hit = self._cache.get(code)
            if hit and time.time() - hit[0] < self.cache_ttl:
                self.stats["cache_hits"] += 1
                out = dict(hit[1])
                out.update(cached=True, cache_age=round(time.time() - hit[0], 1))
                return out
            known = self._dict_lookup(code)
            if known is not None:
                return known

        with self._lock:
            if not fresh:
                hit = self._cache.get(code)
                if hit and time.time() - hit[0] < self.cache_ttl:
                    self.stats["cache_hits"] += 1
                    out = dict(hit[1])
                    out.update(cached=True, cache_age=round(time.time() - hit[0], 1))
                    return out
            try:
                result = self._run(code)
            except MsfxError:
                self.stats["errors"] += 1
                raise
            self.stats["queries"] += 1
            self._cache[code] = (time.time(), result)
            self._remember(code, result)
            return dict(result)

    def _run(self, code: str) -> Dict[str, Any]:
        token = self._get_token(code)
        flood: Optional[FloodControl] = None

        if self.backend in ("http", "auto"):
            try:
                return self._shape(code, token, self._data_via_http(code, token))
            except FloodControl as exc:
                flood = exc
                # 先试着弹窗把滑块解决掉；成功就当场重查，失败再按 backend 决定下一步
                if self._auto_verify_for(exc):
                    token = self._get_token(code)
                    try:
                        return self._shape(code, token, self._data_via_http(code, token))
                    except FloodControl as again:
                        flood = again
                if self.verifier is not None and self.verifier.active:
                    # 窗口开着但这次没等到人拖完：按「需要人工验证」如实回报
                    flood = NeedsHuman("需要人工验证：验证窗口已经打开，拖完滑块后重试",
                                       punish_url=flood.extra.get("punish_url", ""),
                                       retry_after=10)
                if self.backend == "http":
                    raise flood

        if self.verifier is not None and self.verifier.active:
            # 验证窗口正开着，别再去开第二个浏览器；把「等人拖」如实告诉调用方
            raise NeedsHuman("需要人工验证：验证窗口已经打开，拖完滑块后重试",
                             punish_url=(flood.extra.get("punish_url", "") if flood else ""),
                             retry_after=10)
        if flood is not None and flood.extra.get("login_required"):
            raise flood
        self.stats["browser_fallbacks"] += 1
        data = self._data_via_browser(code, token)
        return self._shape(code, token, data)

    def _auto_verify_for(self, exc: FloodControl) -> bool:
        """被滑块挡住时自动弹窗；返回「本次请求内是否已经验证成功」。"""
        if not self.auto_verify or self.verifier is None:
            return False
        punish_url = exc.extra.get("punish_url") or ""
        if exc.extra.get("login_required") or not punish_url:
            return False
        self._close_browser()                             # 验证窗口要独占 profile
        if not self.verifier.start(punish_url):
            return False                                  # 已经在验证 / 冷却中
        self.stats["verifications"] += 1
        if self.verify_wait <= 0:
            return False
        return self.verifier.wait(self.verify_wait)

    def _close_browser(self) -> None:
        if self._browser is not None:
            self._browser.stop()
            self._browser = None

    # -- ① 取 token
    def _get_token(self, code: str) -> str:
        sess = MtopSession(GATEWAY_WEB, self.timeout)
        obj = sess.call(API_SHOW_URL, {"code": code}, min_interval=self.min_interval)
        show_url = (obj.get("data") or {}).get("result") or ""
        if "token=" not in show_url:
            raise UpstreamError("未能从 getshowurl 拿到查询 token", payload=obj.get("data"))
        return show_url.split("token=")[1].split("&")[0]

    # -- ② 纯 HTTP 取数
    def _data_via_http(self, code: str, token: str) -> Dict[str, Any]:
        sess = MtopSession(GATEWAY_DATA, self.timeout)
        obj = sess.call(API_DRUG, {"code": code, "token": token, "queryAppName": "web",
                                   "imageCode": "", "imageToken": ""},
                        min_interval=self.min_interval)
        return obj.get("data") or {}

    # -- ③ 浏览器取数
    def _data_via_browser(self, code: str, token: str) -> Dict[str, Any]:
        try:
            from browser import Browser
        except ImportError as exc:
            raise UpstreamError("浏览器后端不可用（缺少 browser.py）") from exc

        if self._browser is None:
            self._browser = Browser(profile_dir=self.browser_profile, headed=self.headed)
        try:
            self._browser.start()
        except Exception as exc:
            raise UpstreamError(f"浏览器启动失败：{exc}") from exc

        url = (f"https://www.mashangfangxin.com/drugQueryResult?code={urllib.parse.quote(code)}"
               f"&token={token}&imageToken=&imageCode=")
        out = self._browser.fetch(url, want="getdrugresource", timeout=self.timeout + 20)
        for resp in out["responses"]:
            if "getdrugresource" not in resp["api"]:
                continue
            text = resp["body"].strip()
            obj = parse_jsonp(text)
            if obj is None:
                if text.lstrip().startswith("<!DOCTYPE") or "punish" in resp["url"]:
                    raise NeedsHuman("风控要滑块验证，需要真人拖一次（运行 python solve.py）",
                                     punish_url=out.get("final_url") or resp["url"], retry_after=60)
                continue
            ret = ",".join(obj.get("ret") or [])
            if "RGV587" in ret or "FAIL_SYS_USER_VALIDATE" in ret:
                raise NeedsHuman("风控要滑块验证，需要真人拖一次（运行 python solve.py）",
                                 punish_url=(obj.get("data") or {}).get("url", ""), retry_after=60)
            if "SUCCESS" not in ret:
                raise UpstreamError(f"上游返回失败：{ret}", ret=ret)
            return obj.get("data") or {}
        raise UpstreamError("浏览器里没有抓到 getdrugresource 响应",
                            page_text=out.get("page_text", "")[:300])

    # -- ④ 业务状态 + 归一化
    def _shape(self, code: str, token: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return shape_result(code, token, data)

    def close(self) -> None:
        if self._browser is not None:
            self._browser.stop()
            self._browser = None


# --------------------------------------------------------------------------- 结果形状
def shape_result(code: str, token: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """④ 的 data → 对外结果；业务上的「查无此码」按 404 处理。"""
    ret_code = str(data.get("retCode", ""))
    sub_code = str(data.get("subRetCode", ""))

    if ret_code == "2":
        raise NotFound("该码已被注销", code=code, ret_code=ret_code, sub_ret_code=sub_code)
    if ret_code == "1" and sub_code in ("11", "12"):
        raise NotFound("该药品未入驻“码上放心”，系统查无此码",
                       code=code, ret_code=ret_code, sub_ret_code=sub_code)
    if ret_code == "1" and sub_code == "13":
        raise NotFound("生产企业未将生产批号、生产日期及有效期至等信息上传到“码上放心”，无法显示追溯信息",
                       code=code, ret_code=ret_code, sub_ret_code=sub_code, data=data)

    return {
        "ok": True,
        "code": code,
        "queried_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "token": token,
        "summary": summarize(data),
        "data": data,
        "cached": False,
    }


def parse_jsonp(body: str) -> Optional[Dict[str, Any]]:
    """mtopjsonp1({...}) -> dict"""
    body = body.strip()
    start = body.find("(")
    end = body.rfind(")")
    if start == -1 or end <= start:
        return None
    try:
        obj = json.loads(body[start + 1:end])
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


# --------------------------------------------------------------------------- 归一化
_SUMMARY_FIELDS = [
    ("drug_name", ["drugName", "physicName", "prodName"]),
    ("approval_no", ["approvalNo"]),
    ("spec", ["pkgSpec", "prepnSpec"]),
    ("dosage_form", ["prepnType", "prepnTypeDesc"]),
    ("manufacturer", ["produceEntName", "entName"]),
    ("batch_no", ["productionBatch", "batchNo"]),
    ("production_date", ["productionDate", "originalProduceDate"]),
    ("expiry_date", ["expiryDate", "originalExprieDate"]),
    ("code_status", ["codeStatus"]),
    ("scan_count", ["scancount"]),
    ("registration_class", ["drugRegistrationClassficationStr"]),
    ("controlled_type", ["controlledDrugManagementTypeStr"]),
]


def summarize(data: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, candidates in _SUMMARY_FIELDS:
        for cand in candidates:
            val = data.get(cand)
            if val not in (None, "", [], {}):
                out[key] = val
                break
    material = data.get("materialList")
    if isinstance(material, list) and material:
        out["material_trace_count"] = len(material)
    return out


# --------------------------------------------------------------------------- MedCollect 形状
_DATE_RE = re.compile(r"^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})(?:[ T].*|\d{6})?$")


def normalize_date(value: Any) -> Optional[str]:
    """上游日期 -> YYYY-MM-DD；认不出就返回 None（绝不猜）。"""
    if not isinstance(value, str):
        return None
    m = _DATE_RE.match(value.strip())
    if not m:
        return None
    year, month, day = m.group(1), m.group(2), m.group(3)
    try:
        if not (1900 <= int(year) <= 2200 and 1 <= int(month) <= 12 and 1 <= int(day) <= 31):
            return None
    except ValueError:
        return None
    return f"{year}-{month}-{day}"


def medcollect_candidate(result: Dict[str, Any]) -> Dict[str, Any]:
    """把查询结果压成 MedCollect 的 TRACE_API_* 默认字段名。

    只输出确定能从上游拿到的字段；不做规格里程/质量的推断
    （MedCollect 明确要求质量由用户核对后手填）。
    """
    summary = result.get("summary") or {}
    candidate: Dict[str, Any] = {"traceCode": str(result.get("code") or "")}
    mapping = (
        ("genericName", "drug_name"),
        ("manufacturer", "manufacturer"),
        ("specification", "spec"),
        ("batchNumber", "batch_no"),
    )
    for target, source in mapping:
        value = summary.get(source)
        if isinstance(value, str) and value.strip():
            candidate[target] = value.strip()
    expires = normalize_date(summary.get("expiry_date"))
    if expires:
        candidate["expiresAt"] = expires
    # 命中本机药品字典时标明来源：只有产品级信息，批号/有效期仍需按药盒补全
    source = result.get("source")
    if isinstance(source, str) and source:
        candidate["source"] = source
    if result.get("batch_fields_known") is False:
        candidate["batchKnown"] = False
    return candidate
