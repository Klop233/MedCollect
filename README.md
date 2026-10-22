# MedCollect · Cloudflare Workers 药品收藏图鉴

中文、手机优先的药品收藏 Web App。当前主运行版本是 **Cloudflare Workers / workerd + D1 + 私有 R2**，通过 vinext 保留现有 Next.js App Router 页面；不再依赖常驻 Node 服务器或本地 SQLite 文件提供在线服务。

**仅记录已有药盒收藏，不提供用药建议、药效换算或药品验真，不建议为成就额外购药。**

## 功能

- 相机扫码、相册本机识别、手输；通用 HTTP 查药接口可选，未配置时可手工补全。
- 同一通用药名归并，不分厂家/规格；唯一追溯码按账号去重，克数以十进制字符串精确累计。
- 每种药独立达到 0.01 / 0.1 / 1 / 10 / 100g 时解锁成就，待补质量不计入，修改/删除会重算。
- 每药最多8个标签；支持标签、厂家、待补质量与药名的组合筛选。
- 连续录入模式：每盒确认后准备下一盒，显示本页新增记录并可撤销；不会自动跳过确认或重复累计。
- 收藏统计：近6个月记录、活跃日期、标签数、待补数量、各药独立质量；月份按上海时区计算。
- 私有封面：浏览器缩小图片，服务端再次移除隐藏元数据；JPEG/PNG、每张≤5MB、尺寸≤4096，私有 R2 对象必须经当前账号鉴权读取。
- 本机生成 PNG 分享卡：只放药名、克数、等级与封面，不含追溯码、邮箱、批次，不创建公开分享链接。封面图像中肉眼可见的隐私仍需自己裁切。
- 邮箱验证、登录退出、重发、改密、找回；D1.batch 原子重置密码、撤销全部会话和消费一次性令牌。
- JSON 个人导出（含标签和记录，不包含密码或封面图片文件）。

## 本地启动（不创建任何云资源）

需要 Node.js 22.13+（本机使用24）和 npm。首次克隆后：

```powershell
npm ci
npm run setup:local
npm run db:local
```

setup:local 只在不存在时创建忽略的 .dev.vars 并生成随机会话密钥，不会覆盖已有配置。首次克隆后请执行上述命令，创建本地配置并应用 D1 迁移；私人配置和数据库不会随仓库分发。

两个终端分别运行：

```powershell
# 终端1：只绑定本机的 HTTP 测试收件箱，不向互联网发邮件
npm run mail:dev
```

```powershell
# 终端2：在真正 workerd 运行时中启动应用及 D1/R2 本机模拟存储
npm run dev
```

- App：http://localhost:5173 （务必与 BETTER_AUTH_URL 一致，不要混用127.0.0.1）。
- 开发收件箱：http://127.0.0.1:8026 ，手动刷新并点击验证/重置链接。测试邮件只留在进程内存，重启收件箱会清空。
- 本地 D1 和 R2 保存于忽略的 .wrangler/state，不会自动上传到云端；它们不是旧 data/medcollect.db。
- `preview_database_id` 中的全零值只用于保留旧版本地模拟数据库的身份，不是生产数据库 ID；远程发布按 `database_name` 创建／复用，勿将该值配合 `--preview` 用于远程数据库。
- 本地开发使用 .dev.vars；旧 .env.local 仅供历史 SQLite 导出/Node 测试工具使用，不会自动成为 Workers 生产 Secrets。
- 手机相机需要可信 HTTPS；电脑 localhost 可开发测试，但普通局域网 HTTP 不是可靠的手机相机环境。

## Workers 构建和部署

```powershell
npm run build
# 只打包验证，不创建/发布 Worker（可在无 Cloudflare 账号登录时执行）
npx wrangler deploy --dry-run --config dist/server/wrangler.json --outdir .tools/worker-dry-run
# 本地产物预览，先停掉 npm run dev，避免5173端口冲突
npm run preview
```

Wrangler 源配置是 wrangler.jsonc；构建产物是 dist/server 和 dist/client。不要上传 .next，不要上传 .dev.vars/.env.local，也不要将 dist/server 当作公开静态目录。兼容日期固定为已验证的2026-07-01，升级 workerd 后再有意调整。

### 从 GitHub 导入 Cloudflare Workers

在 Cloudflare 的 **Workers & Pages → medcollect → 设置 → 构建** 中使用：

| 设置 | 值 |
| --- | --- |
| Git 仓库 | `Klop233/MedCollect` |
| 生产分支 | `main` |
| 根目录 | 仓库根目录 `/` |
| 构建命令 | `npm run build` |
| 部署命令 | `npm run deploy:worker` |

`deploy:worker` 使用生成的 `dist/server/wrangler.json` 上传应用及静态资源，自动创建／复用名为 `medcollect` 的 D1 和私有 R2 桶，然后应用 `drizzle/` 中尚未执行的 SQL 迁移。Wrangler 4.151.3 支持无 ID 时按数据库名称查询，所以 CI 不依赖把账号专属 ID 写回 Git。部署身份需要相应的 Workers、D1 和 R2 权限。

**不要再填全零 `database_id`**：非空的占位 ID 会使 Wrangler 跳过自动创建，随后报 `10181 database not found`，旧的 Hello World 版本会继续在线。无需为了这个错误重建已创建成功的 R2 桶。

首次自动创建时，会先激活 Worker、再迁移数据库；迁移完成前存在短暂的无表窗口。迁移失败会让构建显示失败，但不代表刚上传的 Worker 自动回滚。需要严格无窗口或已有正式数据时，请预先创建数据库、填写真实 ID、备份并先执行迁移，再上传应用；不要依赖部署后迁移进行破坏性的 schema 变更。

`deploy:worker` 带 `--keep-vars` 保留面板中未在配置声明的普通运行变量；Wrangler 配置内已声明的变量仍以配置为准，Secrets 不写进 Git。当前域名配置为 `https://med.miolab.ink`，请将自定义域名绑定到 **medcollect** 这个 Worker；自部署到其他域名时同步修改 `BETTER_AUTH_URL` 和 SEO 站点地址。

### 生产账号与邮件设置（部署成功前准备）

在 Worker 的 **设置 → 变量和机密** 中配置，而不是只填“构建变量”：

- `BETTER_AUTH_SECRET`：至少32字符的随机机密；只能设为 Secret，不要提交到 Git 或发送到聊天。
- `MAIL_MODE=http`、`MAIL_API_URL`、`MAIL_FROM`：正式 HTTP 发信服务的运行变量。
- `MAIL_API_TOKEN`：发信凭据，设为 Secret（服务确实不需鉴权时可省略）。
- `TRACE_API_*`：按需配置；不配置查药服务仍可手填收藏。

没有邮件配置时发信会明确失败，**不会跳过邮箱验证**。不要把本机 `127.0.0.1:8026` 测试收件箱配置用于公网 Worker。

### 通过本机 CLI 发布到自己的 Cloudflare 账号

1. 执行 `npx wrangler login`，由你本人登录。
2. 在 `wrangler.jsonc` 设置自己的真实 HTTPS `BETTER_AUTH_URL`，保持 `ENVIRONMENT=production`；域名、回调和 Origin 必须一致。D1 可省略 ID 自动创建；要复用其他名字的现有数据库，请明确填写名称及真实 ID。
3. 不要开启 R2 的公开 URL／公网桶访问。
4. 设置 HTTP 邮件服务（见下节）和必需 Secrets：

```powershell
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put MAIL_API_TOKEN
# 查药接口有鉴权时再添加对应配置，仍使用通用 TRACE_API_* 变量
npx wrangler secret put TRACE_API_TOKEN
```

5. 执行 `npm run deploy` 构建、发布并应用迁移。需要先迁移的正式环境，请先确认目标及备份，执行 `npm run db:remote`，再按你的发布流程上传。命令会改变真实云资源，本机构建／dry-run 不代表云端已发布。
6. 发布后用真实邮箱和手机 HTTPS 验证：注册、验证、双设备登录、重置失效、重复扫码、封面权限，以及 iOS/Android/微信相机。

生产密钥只在 Workers Secrets 设置。创建的数据库、R2和邮件服务受各自账户权限、额度及计费约束；没有承诺无限免费。

## HTTP 邮件配置

Workers 版本不调用 Nodemailer 或本机 Mailpit。支持通用 HTTP JSON 发信接口（Resend兼容结构）：

```dotenv
ENVIRONMENT=production
BETTER_AUTH_URL=https://你的真实应用域名
MAIL_MODE=http
MAIL_API_URL=https://你的邮件服务发送端点
MAIL_FROM=MedCollect <noreply@你的已验证域名>
# 在 Workers Secrets 中设置 MAIL_API_TOKEN；服务无需鉴权时可空
```

请求为 POST JSON {from,to:[收件邮箱],subject,text}，Token 非空时带 Authorization: Bearer。接口必须2xx接受投递；10秒超时、不跟随重定向，不把服务商诊断或令牌写入日志。HTTP测试端点仅在 ENVIRONMENT=development 且地址为回环时允许；生产必须 HTTPS。MAIL_MODE=disabled 或缺配置会明确拒绝发信，不假报已发送，不绕过邮箱验证。

新账号user/account同一个 D1 batch 创建，投递失败只补偿本请求创建且仍未验证的账号。密码重置使用条件 SQL 将密码更新、所有会话撤销、一次性token消费放同批提交；任何SQL失败整体回滚。普通改密保留当前会话、原子撤销其余设备。客户端不能决定收藏所有者，所有读写都按真实会话隔离，写请求校验本站Origin，私人响应no-store。

## 社交媒体分享与 SEO

- 公开站点地址集中于 `src/lib/site.ts`，当前为 `https://med.miolab.ink`。换域名时同步修改该地址和 `wrangler.jsonc` 的 `BETTER_AUTH_URL`。
- 首页使用独立的 canonical 和 Open Graph URL；全站提供中文标题、简介、OG website / `zh_CN`、Twitter `summary_large_image` 和绝对图片地址，适用于读取这些标签的平台。
- 分享封面为公开静态 `public/social-card.png`（1200×630），只展示品牌介绍，不包含药名记录、追溯码、邮箱或私人封面。另有 PNG favicon、Apple touch icon。
- `robots.txt` 提供站点地图并禁止 API 抓取；`sitemap.xml` 只列公开首页。账号、认证、扫码、图鉴详情、统计和成就页通过页面级 `noindex, nofollow` 避免收录，且不继承首页 canonical。爬虫仍可读取这些页面的 noindex；robots 指示不能替代服务端鉴权。
- 修改 `scripts/assets/social-card.svg` 后，可在有中文字体的开发机执行 `node scripts/generate-social-assets.mjs` 更新 PNG。图片已提交，Workers 构建不需要运行 Sharp 或安装字体。
- 分享效果以站点实际部署成功、爬虫能访问图片及平台缓存更新为前提；这不保证搜索排名，也不保证所有平台（例如需要额外 JS SDK 的自定义卡片场景）均采用 OG 标签。

## 通用药品查询接口（可选）

查询不绑定任何药品平台。你可以使用自己有权访问、通过追溯码返回药品资料的 **HTTP JSON API**，在服务器的 `.dev.vars` 中配置地址、请求方式、鉴权、码字段和响应字段映射。`TRACE_API_URL` 留空时不发起网络查询，直接允许手动补全。修改配置后重启 App。

### 开箱可用：仓库内的 services/trace-api

`services/trace-api` 是按上面的通用契约实现的现成后端（Python 3 标准库，查询「码上放心」追溯数据）：

```powershell
npm run trace:solve   # 首次：过一次人工验证（滑块），把 x5sec 存下来
npm run trace:api     # 之后：http://127.0.0.1:8787
```

如需接入此本地服务，在自己的 `.dev.vars` 中配置 `TRACE_API_URL=http://127.0.0.1:8787/api/trace/medcollect`；服务返回默认字段名，不需要写 `TRACE_API_FIELD_MAP_JSON`。不配置查询服务也可手动录入收藏。协议细节、风控边界和公网部署见 `services/trace-api/README.md`。

- 只有本地开发能用 `http://127.0.0.1`；部署到 Cloudflare 时必须把服务放到 HTTPS 上，并把它的 `MSFX_API_KEY` 写进 `TRACE_API_TOKEN`。
- 服务没启动时扫码会提示查询失败，仍可手动补全，不影响收藏。
- 阿里风控要求真人在浏览器里拖一次滑块，脚本过不了：被拦时**验证窗口会自动弹出**，拖完窗口自关，
  App 提示「拖完滑块后重新查询」；`x5sec` 过期后会再弹一次。不想自动弹窗用 `--no-auto-verify`。
- 数据版权归阿里健康，仅供个人记录，不作为验真依据；查不到时不推断质量，由用户按药盒填写。

### 最简接入：GET + Bearer Token

```dotenv
# 替换为你的真实接口地址；不是可直接使用的内置查询服务。
TRACE_API_URL=https://your-api.example/drugs/lookup
TRACE_API_METHOD=GET
TRACE_API_CODE_PARAM=code
TRACE_API_TOKEN=你的Token
```

服务器会发送 `GET /drugs/lookup?code=扫码得到的字符串`，并在设置 Token 时附带 `Authorization: Bearer ...`。接口无需鉴权时把 Token 留空；使用 API Key、自定义请求头或 Basic 等其他鉴权时通过 `TRACE_API_HEADERS_JSON` 配置，不要同时设置两种 Authorization。

### 配置项

| 变量 | 默认值与说明 |
| --- | --- |
| `TRACE_API_URL` | 空；查询地址，仅由服务器管理员配置 |
| `TRACE_API_METHOD` | `GET` 或 `POST`，默认 `GET` |
| `TRACE_API_BODY_TYPE` | POST 请求使用 `json`（默认）或 `form`；GET 使用 URL 查询参数 |
| `TRACE_API_CODE_PARAM` | 追溯码参数名，默认 `code`；始终按字符串传输 |
| `TRACE_API_PARAMS_JSON` | 额外静态参数，默认 `'{}'`，例如 `'{"appId":"your-app-id","locale":"zh-CN"}'` |
| `TRACE_API_TOKEN` | 可选 Bearer Token，空则不自动添加 Authorization |
| `TRACE_API_HEADERS_JSON` | 可选请求头，默认 `'{}'`，例如 `'{"X-API-Key":"your-api-key"}'` |
| `TRACE_API_RESPONSE_PATH` | 响应中药品对象或数组的点路径，例如 `data`、`data.items`；空表示根对象 |
| `TRACE_API_FIELD_MAP_JSON` | 对下列默认字段映射的部分覆盖，路径相对于选中的药品对象 |

额外参数不是代码或字符串模板；追溯码由程序单独放到配置的字段中，覆盖该同名静态参数。GET / 表单的静态参数值只支持字符串、有限数值和布尔值；POST JSON 可包含嵌套静态对象。响应路径支持点分字段和数字数组索引，不执行表达式，不读取原型链。

默认可以直接识别以下响应：

```json
{
  "traceCode": "00000000000000000001",
  "genericName": "药品通用名",
  "manufacturer": "生产企业",
  "specification": "250mg × 24片",
  "batchNumber": "批次标识",
  "expiresAt": "2028-10-20",
  "suggestedMass": {
    "value": "250",
    "unit": "mg",
    "quantity": "24",
    "basis": "接口标注每片有效成分250mg，共24片，请按实物核对"
  }
}
```

只需药名即可提供候选，其余字段可省略。质量建议也可整体省略，由用户手动填写；不会从任意规格文字猜测克数。质量值和追溯码建议都以字符串返回，尤其不要把20位长码返回为 JSON number。

### 适配常见返回字段

例如你的 API 返回 `{ "data": { "name": "药名", "factory": "厂家", "spec": "规格", "batch": "批次", "expiry": "2028-10-20" } }`：

```dotenv
TRACE_API_RESPONSE_PATH=data
TRACE_API_FIELD_MAP_JSON='{"genericName":"name","manufacturer":"factory","specification":"spec","batchNumber":"batch","expiresAt":"expiry"}'
```

可映射的键为 `genericName`、`manufacturer`、`specification`、`batchNumber`、`expiresAt`、`traceCode`、`massValue`、`massUnit`、`massQuantity`、`massBasis`。后四项的默认路径分别为 `suggestedMass.value`、`suggestedMass.unit`、`suggestedMass.quantity`、`suggestedMass.basis`。映射路径相对于 `TRACE_API_RESPONSE_PATH` 选出的对象；它不是 JSONPath，不支持 `$`、通配符或执行脚本。

### POST JSON / 表单与 API Key

```dotenv
TRACE_API_URL=https://your-api.example/drugs/lookup
TRACE_API_METHOD=POST
TRACE_API_BODY_TYPE=json
TRACE_API_CODE_PARAM=traceCode
TRACE_API_PARAMS_JSON='{"locale":"zh-CN"}'
TRACE_API_TOKEN=
TRACE_API_HEADERS_JSON='{"X-API-Key":"your-api-key"}'
TRACE_API_RESPONSE_PATH=data
```

这会提交 JSON `{ "locale": "zh-CN", "traceCode": "扫码得到的字符串" }`。对接 `application/x-www-form-urlencoded` 时把 `TRACE_API_BODY_TYPE` 改为 `form`。

### 查询边界与安全

- 接口 URL、鉴权头及静态参数只在服务端配置，扫描内容和浏览器不能指定请求地址；未知二维码网址不会被当作查询地址。
- 默认使用 HTTPS；只为本地开发/测试允许 HTTP 回环地址，生产环境要求 HTTPS。禁止 URL 用户名密码、片段、动态地址模板及 HTTP 重定向；10秒超时和1MB响应上限。不要将凭据放在 `NEXT_PUBLIC_*`、前端或聊天中。
- 不再限制追溯码必须以8开头或固定20位；仍拒绝商品条码作为单盒唯一标识。
- HTTP 401/403 显示无权限，404 或空结果显示未找到，其他网络/JSON/配置问题明确报失败并可转手动填写。API 返回多条记录时，只有能按返回的字符串追溯码唯一匹配才采用；不默取第一条。
- 返回字段必须能提供药名，其他字段和质量建议均需用户确认，不能用接口结果宣传验真。数据来源统一记录为“接口候选，经用户确认”；兼容已有收藏记录，不重置收藏或克数。
- 当前配置覆盖常规 GET、POST JSON/表单、Bearer 与自定义请求头。需要动态 HMAC 签名、OAuth 换票、多步查询、嵌套请求码字段或其他私有协议的 API，仍需另加小型适配器，不能通过执行配置中的脚本解决。

旧平台专用的 `TRACE_APP_KEY` 等环境变量不再读取；从旧版本升级时删除旧查询配置，按当前 `.env.example` 添加 `TRACE_API_*`。**没有内置免费查药数据，也没有默认外部服务；改成通用配置不代表任何第三方接口都无需授权。**

## 数据迁移、备份和测试

旧版 data/medcollect.db 保留原样，不会因为切换 Workers 自动删除或上传。若你已有真实收藏，需要主动迁移到**空的** D1：

```powershell
# 先停止旧Node服务，只导出本地数据，不修改原库；目标文件必须不存在
npm run db:export-legacy -- --output .tools/legacy-export.sql
# 先对目标D1执行项目迁移，再导入。不要对已有用户的目标使用replace/覆盖导入。
npx wrangler d1 execute DB --remote --file .tools/legacy-export.sql
```

导出含账号密码hash、药名、追溯码等隐私，不能入Git/公网上传，使用后妥善保管或清除。一次性令牌和旧会话刻意不迁移，迁移后重新登录。封面二进制需要单独备份R2；JSON个人导出和D1备份均不包含R2照片文件。

修改schema后 npm run db:generate 追加迁移，再执行 npm run db:local / db:remote。已应用迁移不要重写。D1备份使用官方D1导出/Time Travel，R2另行备份。不要把临时内存/全局JS锁当作Workers持久化或跨实例事务。

```powershell
npm run typecheck
# 优先运行受影响的Workers迁移及隐私集成测试
npm run test:workers
# 通用查询适配测试
node --import tsx --test tests/trace.test.ts
# 与 services/trace-api 的接线测试（启动 Python 后端，--mock 模式，不访问阿里；没有 Python 3 时自动跳过）
node --import tsx --test tests/trace-api-integration.test.ts
# 后端自身形状自测（离线）
npm run trace:test
npm run build
```

测试遵循项目测试价值门：Workers测试使用真实本机workerd D1/R2，保护并发去重、batch回滚、单次密码重置、用户隔离、标签统计和图片隐私；不为静态文案、CSS或图标写断言。旧Node测试仅作为历史组件参考，不是Workers兼容性证明。测试数据在独立临时实例中，不修改真实D1或R2。

当前未提供真实查药凭据、真实邮件接口密钥或Cloudflare部署授权；没有声称已联调任意外部查药平台、真实邮箱投递或真机相机。浏览器开发预览与本机构建/打包成功不等于已经公开上线。

### 本次验收记录

- Workers/D1/R2 与通用接口相关定向测试16项通过，另有11项原收藏/质量回归通过，类型检查通过。
- Workers生产构建、Wrangler部署dry-run以及实际生产产物的本机workerd预览均通过；静态JS/CSS、会话API、D1读取和私有封面已在产物预览中验证。
- 浏览器走通HTTP测试邮件注册/验证、登录、密码重置后的旧会话失效、连续录入两份、标签/厂家/待补筛选、统计、撤销、私有封面上传和PNG分享卡下载。
- 390px手机视口未出现横向溢出；分享卡已检查不含邮箱、追溯码、批次。截图使用合成验收记录，不是真实药品查询结果；本次验收账号、记录和封面已清理。
- vinext仍在演进，构建可能出现上游source-map或路由静态分类提示；这不替代真实Cloudflare账号下的发布验收、真实邮件投递和手机摄像头测试。
