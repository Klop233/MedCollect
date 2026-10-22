#!/usr/bin/env node
/**
 * 用本机 Python 运行 services/trace-api 下的脚本。
 *
 *   node services/trace-api/launch.mjs server.py --port 8787
 *   node services/trace-api/launch.mjs test_shape.py
 *
 * Windows 上 `python` 常常是应用商店的占位程序（执行会失败），所以这里按
 * MS_TRACE_PYTHON -> py -3 -> python3 -> python 的顺序找一个真能用的解释器。
 * 标准输入输出直接继承，不做管道捕获。
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
const [script, ...rest] = process.argv.slice(2);

if (!script) {
  console.error('用法: node services/trace-api/launch.mjs <server.py|solve.py|cli.py|test_shape.py> [参数...]');
  process.exit(2);
}

const candidates = [];
if (process.env.MS_TRACE_PYTHON) candidates.push([process.env.MS_TRACE_PYTHON, []]);
candidates.push(['py', ['-3']], ['python3', []], ['python', []]);

const python = candidates.find(([cmd, args]) => {
  const probe = spawnSync(cmd, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'], { stdio: 'ignore', windowsHide: true });
  return probe.status === 0;
});

if (!python) {
  console.error('找不到可用的 Python 3。请安装 Python 3，或设置 MS_TRACE_PYTHON 指向 python.exe。');
  process.exit(2);
}

const [cmd, args] = python;
const child = spawn(cmd, [...args, path.join(here, script), ...rest], { stdio: 'inherit', windowsHide: false });
child.on('error', (error) => { console.error(`无法启动 Python: ${error.message}`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
