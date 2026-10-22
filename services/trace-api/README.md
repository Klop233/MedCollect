# services/trace-api · 码上放心 追溯码查询

MedCollect 的可选查询后端：把一个 20 位药品追溯码（原中国药品电子监管码）变成药名、厂家、规格、批号、有效期。
它实现的是 MedCollect `TRACE_API_*` 那套通用 HTTP 契约，所以 App 侧只需要改环境变量，不用动业务代码。

数据来自 <https://www.mashangfangxin.com/> 首页的「追溯码查询」，本目录是对它的逆向实现。
只依赖 Python 3 标准库，不需要 `pip install`。

> **它不是内置免费查药数据，也不代表验真。** 数据版权归阿里健康，仅供个人查询/研究；
> 不要拿它做无鉴权的公网批量服务。结果到 App 后仍需用户按药盒核对。

## 在 MedCollect 里怎么用

```powershell
# 1) 启动后端（默认 http://127.0.0.1:8787），第一次被风控拦下时会自动弹出验证窗口
npm run trace:api

# 2) 另一个终端正常启动 App
npm run dev
```

第一次扫码时阿里的滑块会被拦下，**验证窗口会自动弹出**：把滑块拖到最右边，窗口自己关掉，
`x5sec` 写进 `cookies.json`；再扫一次就通了。不想让服务弹窗就加 `--no-auto-verify`，
或者手动跑一次 `npm run trace:solve`。

`.dev.vars` 里已有 `TRACE_API_URL=http://127.0.0.1:8787/api/trace/medcollect`，直接生效。
想关掉查询、回到手工补全：把该行留空并重启 App。

不接真上游也能验证接线（用合成样本，不访问阿里）：

```powershell
npm run trace:api:mock   # 端口 8787，返回 mock-sample.json
npm run trace:test       # 只测「上游 data -> 对外 JSON」的形状和弹窗调度，不联网
```

## 一、原站是怎么查的（逆向结论）

前端 bundle（`/public/home/home.js`、`/public/webQuery/drugQueryResult.js`）里的真实链路：

| 步骤 | 接口 | 说明 |
|---|---|---|
| ① | `mtop.alihealth.drug.ent.service` `{serviceName:"verificationImageService"}` | 取 4 位图形验证码 |
| ② | `mtop.alijk.code.search.checkCode` `{code, token}` | 校验图形验证码 |
| ③ | `mtop.alijk.code.search.getshowurl` `{code}` | 返回带一次性 token 的查询地址 |
| ④ | `mtop.alijk.code.search.getdrugresource.forweb` `{code, token, queryAppName:"web", …}` | **真正的药品追溯数据** |

- ① ② 只是前端挡在查询框前的人机闸门，服务端在 ③ ④ 上**并不校验**它，所以不需要识别图形验证码。
- ③ 走 `api2.mashangfangxin.com`，④ 走 `api3.mashangfangxin.com`，都是 MTOP H5 网关：
  `sign = md5(_m_h5_tk + "&" + t + "&" + appKey + "&" + data)`，`appKey = 12574478`。
- 首次请求没有 `_m_h5_tk` cookie 时网关返回 `TOKEN_EMPTY` 并下发 cookie，重签一次即可（已自动处理）。
- 结果页 `/drugQueryResult?code=&token=` 是空壳，数据全靠 ④ 在浏览器里异步拉。

## 二、风控：一道必须知道坎

④ 除了签名还挂了阿里风控。客户端「不像浏览器」（curl / requests / headless Edge）会收到：

```json
{"ret": ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],
 "data": {"url": "…/_____tmd_____/punish?x5secdata=…"}}
```

那个 `url` 是阿里 NC **滑块验证页**。它是 canvas + 轨迹风控，合成事件拖过去会返回 `验证失败(error:xxxxx)`；
请求过密还会升级成「需要登录淘宝账号」的登录墙。实测结论：

| 环节 | 能否自动 |
|---|---|
| 拿查询 token（③） | ✅ 纯 HTTP，不需要验证码 |
| 取追溯数据（④） | ⚠️ 签名可自动，风控拦截需要 `x5sec` |
| 首页 4 位图形验证码 | ✅ **根本不需要**（服务端不校验） |
| 阿里 NC 滑块 | ❌ 实测无法自动过 |

所以设计是：**一次人工拖拽，换后续几百次全自动**。

### 自动弹出验证窗口

被滑块拦下的那一刻，服务会把那个 punish 页在一个**可见的 Edge 窗口**里打开（`verify.py`）：

1. 请求返回 `428 needs_human`，响应里带 `verification` 状态，说明窗口已经弹出；
2. 你把滑块拖到最右边，服务检测到 `x5sec` 就立刻关掉窗口并写 `cookies.json`；
3. 那次请求内如果能等到（`--verify-wait`，默认 4 秒），它会自动重查并直接返回数据；
   等不到就按 428 返回，拖完再查一次即可。

约束和兜底：

- 同一时间只开一个窗口；没拖过时 45 秒冷却，避免窗口反复弹出。
- `--verify-timeout`（默认 180 秒）到了还不见 `x5sec`，窗口自动关闭并记录「等待超时」。
- 风控升级成「登录淘宝账号」的登录墙时**不弹窗**（弹了也没用），直接返回 429。
- 窗口开在**服务所在的机器**上，所以验证必须由坐在这台机器前的人完成。
- 不想让服务自己弹窗：加 `--no-auto-verify`，改用 `npm run trace:solve` 手动验证。
- 状态随时可以在 `GET /health` 的 `verify` 字段里看到。

`x5sec` 会过期（和 IP、UA 有绑定），过期后下一次查询会再次弹窗。

## 三、接口

### 给 MedCollect 用的形状（默认对接这个）

```
GET /api/trace/medcollect?code=81123456789012345678
```

```json
{
  "traceCode": "81123456789012345678",
  "genericName": "示例阿莫西林胶囊",
  "manufacturer": "示例制药有限公司",
  "specification": "0.25g×24粒/盒",
  "batchNumber": "B2408001",
  "expiresAt": "2028-07-31"
}
```

字段名正好是 MedCollect `TRACE_API_FIELD_MAP_JSON` 的默认值，所以不用配映射。
只输出上游确实给出的字段；**不推断质量**（`suggestedMass` 留给用户按药盒填）。

### 完整形状

```
GET  /api/trace?code=<码>[&fresh=1]        # 也可 &shape=medcollect
GET  /api/trace/<码>
POST /api/trace                            # {"code":"…"}
```

`200` 返回 `{ok, code, queried_at, token, summary, data, cached}`：`summary` 是常用字段，
`data` 是 ④ 的原始 `data`，各商品类型字段不同，两个都给。

### 错误

| HTTP | `error` | 含义 | 怎么办 |
|---|---|---|---|
| 400 | `invalid_code` | 码为空或格式不对 | 传 20 位数字（5/8 开头药品，92-99 其他行业） |
| 404 | `not_found` | 码合法但查无数据 | 见 `message`：未入驻 / 已注销 / 企业未上传批号 |
| 428 | `needs_human` | 风控要滑块，验证窗口已弹出（响应带 `verification`） | 拖完滑块后重查；窗口没弹就 `npm run trace:solve` |
| 429 | `rate_limited` | 被风控拦（含登录墙） | 等 `Retry-After`，或换网络 |
| 502 | `upstream_error` | 网关返回失败 | 看 `message` / `ret` |
| 500 | `internal_error` | 未预期异常 | — |

MedCollect 侧对 `401/403 → 无权限`、`404 → 未找到`、`428 → 需要人工验证`、`429 → 被限流` 都有明确文案。

## 四、参数与鉴权

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host` | `127.0.0.1` | 监听地址（对外提供服务必须加 `MSFX_API_KEY`） |
| `--port` | `8787` | 端口 |
| `--backend` | `auto` | `http` 纯 HTTP / `browser` 走浏览器 / `auto` 先 HTTP 再降级 |
| `--headed` | 关 | 浏览器后端显示窗口 |
| `--min-interval` | `1.5` | 两次上游请求的最小间隔（秒） |
| `--cache-ttl` | `600` | 结果缓存秒数 |
| `--auto-verify` / `--no-auto-verify` | 开 | 被风控拦下时自动弹出验证窗口 |
| `--verify-wait` | `4` | 弹窗后本次请求最多等多久（秒）；0=立刻返回 428（MedCollect 客户端 10 秒超时，别设太大） |
| `--verify-timeout` | `180` | 验证窗口最长存在多久（秒） |
| `--mock FILE` | — | 离线自测，把文件当 ④ 的 data，不访问上游 |

`GET /health` 里的 `verify` 字段会给出窗口状态：`active` / `ok` / `message` / `attempts`。

设置环境变量 `MSFX_API_KEY` 后，请求要带 `X-API-Key: <key>`、`?key=<key>` 或 `Authorization: Bearer <key>`。

**部署到公网时**：服务必须 HTTPS、加 `MSFX_API_KEY`，然后 MedCollect 侧配

```dotenv
TRACE_API_URL=https://your-host/api/trace/medcollect
TRACE_API_TOKEN=<MSFX_API_KEY>
```

`TRACE_API_TOKEN` 会变成 `Authorization: Bearer`，服务端认这个头。注意 Workers 生产环境不允许 http 回环地址。

## 五、文件

```
msfx_client.py    协议：MTOP 签名、token 握手、取数、风控识别、cookie 复用、结果归一化
browser.py        Edge + CDP（纯标准库 WebSocket），真实渲染页面并抓 mtop 响应
verify.py         自动弹窗验证：开可见窗口 → 人拖滑块 → 写 cookies.json（带冷却与状态）
solve.py          手动版一次性验证（不想让服务自动弹窗时用）
server.py         HTTP API（含 medcollect 形状与 mock 模式）
cli.py            命令行
launch.mjs        用本机 Python 跑上面的脚本（npm run trace:*）
test_shape.py     离线自测：上游 data -> 对外 JSON 的形状
test_verify.py    离线自测：弹窗调度、冷却、失败兜底
mock-sample.json  合成样本（不是真实药品数据）
cookies.json      verify.py / solve.py 写出（已忽略）
.browser-profile/ 浏览器 profile（已忽略）
```

## 六、已知限制

- **吞吐**：受风控约束，单机别超过 ~1 次/秒，不适合批量抓取。
- **x5sec 会过期**：过期后下一次查询会再次弹窗（或返回 428），拖一下就好。
- **字段未经真实样本验证**：`summary` 的字段名来自原站前端 bundle，成功路径还没用真实药品码跑通过
  （一直被滑块拦着），第一次真机验证时请对照页面确认。
- **GS1 / SSCC 码**：原站也支持 `(01)…` 形式和箱码，本实现只接受 20 位纯数字。
- **版权**：数据版权归阿里健康，仅个人查询/研究，勿对公网提供无鉴权批量服务。
