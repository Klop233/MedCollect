import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { lookupTrace } from "../src/lib/trace";

/**
 * 真正启动 services/trace-api（Python，--mock 模式，不访问「码上放心」），
 * 验证「服务端返回的 JSON」和「MedCollect 的 TRACE_API_* 适配器」对得上。
 * 没有 Python 3 时跳过，不让本机环境决定测试是否通过。
 */
const python = [["py", ["-3"]], ["python3", []], ["python", []], ...(process.env.MS_TRACE_PYTHON ? [[process.env.MS_TRACE_PYTHON, []]] : [])]
  .find(([cmd, args]) => spawnSync(cmd as string, [...(args as string[]), "-c", "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)"], { stdio: "ignore", windowsHide: true }).status === 0);

const code = "81123456789012345678";
const apiKey = "integration-test-key";
const envNames = ["NODE_ENV", "TRACE_API_URL", "TRACE_API_CODE_PARAM", "TRACE_API_TOKEN", "TRACE_API_HEADERS_JSON", "TRACE_API_PARAMS_JSON", "TRACE_API_RESPONSE_PATH", "TRACE_API_FIELD_MAP_JSON"];
const savedEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));

function restore() { for (const key of envNames) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } }

test("MedCollect 的默认字段映射能直接吃 trace-api 的 /api/trace/medcollect", { skip: python ? false : "没有可用的 Python 3" }, async (t) => {
  const [cmd, args] = python as [string, string[]];
  const port = 18100 + Math.floor(Math.random() * 400);
  const child = spawn(cmd, [...args, "services/trace-api/server.py", "--port", String(port), "--mock", "services/trace-api/mock-sample.json"], {
    stdio: "ignore", windowsHide: true, env: { ...process.env, MSFX_API_KEY: apiKey },
  });
  t.after(() => { child.kill(); restore(); });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`${base}/health`)).ok; } catch { await delay(100); }
  }
  assert.equal(ready, true, "trace-api 未能启动");

  Object.assign(process.env, {
    NODE_ENV: "test",
    TRACE_API_URL: `${base}/api/trace/medcollect`,
    TRACE_API_TOKEN: apiKey,
  });
  delete process.env.TRACE_API_CODE_PARAM;
  const found = await lookupTrace(code);
  assert.equal(found.status, "found", found.message);
  assert.deepEqual(JSON.parse(JSON.stringify(found.candidate)), {
    genericName: "示例阿莫西林胶囊",
    manufacturer: "示例制药有限公司",
    specification: "0.25g×24粒/盒",
    batchNumber: "B2408001",
    expiresAt: "2028-07-31",
  });

  // 服务端设了 MSFX_API_KEY 时，不带令牌会被 401 拒绝，不能静默当作成功。
  delete process.env.TRACE_API_TOKEN;
  assert.equal((await lookupTrace(code)).status, "forbidden");

  // 追溯码格式由服务端把关：非 20 位码返回 400，MedCollect 如实报失败而不是编数据。
  Object.assign(process.env, { TRACE_API_TOKEN: apiKey });
  const invalid = await lookupTrace("8112345678901234");
  assert.ok(invalid.status === "failed" || invalid.status === "unsupported", invalid.status);
});
