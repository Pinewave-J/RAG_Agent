#!/usr/bin/env node
'use strict';

/**
 * Windows 启停脚本的辅助工具（供 启动服务.cmd / 停止服务.cmd 调用）。
 *
 * 为什么要有这个文件：
 *   批处理解析 netstat 输出非常脆——
 *     · 列宽一变 tokens=5 就取错列；
 *     · findstr ":8899" 是**子串**匹配，会误中 18899 / 88990；
 *     · IPv6 的 [::]:8899 在 findstr /r 里还要转义方括号，各版本行为不一致。
 *   这些坑全部下沉到 Node，批处理只负责"调用它、看退出码、显示一句话"。
 *
 * 用法（只读，无副作用）：
 *   node scripts/service.js port     输出当前生效端口（读 .env 的 PORT）
 *   node scripts/service.js status   输出监听该端口的进程 PID（每行一个，无则空输出）
 *
 * 退出码：0 成功；1 参数错误。
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

/**
 * 取当前生效端口。
 *
 * 这里刻意**不 require('../server/config')**：
 * 启停脚本要在服务未启动时也能跑，而 config.js 会连带加载 dotenv、
 * 记录 .env mtime 等一整套启动期逻辑，启动开销与副作用都多余。
 * 启停脚本只关心一个整数端口，直接解析 .env 更轻也更稳。
 *
 * 优先级：环境变量 PORT > .env 的 PORT= > 兜底 8899。
 * 这与 server/config.js 的 `num(process.env.PORT, 8899)` 口径一致。
 */
function currentPort() {
  const FALLBACK = 8899;

  const valid = (v) => {
    const n = Number(String(v).trim());
    return Number.isInteger(n) && n > 0 && n < 65536;
  };

  if (valid(process.env.PORT)) return Number(String(process.env.PORT).trim());

  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*PORT\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      // 去掉行内注释与首尾引号
      const value = m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
      if (valid(value)) return Number(value);
    }
  } catch {
    // .env 不存在或不可读：用兜底值，不报错（首次部署时 .env 可能还没建）
  }

  return FALLBACK;
}

/**
 * 查监听指定端口的进程 PID。
 *
 * 判定要点：
 *   1. 只认 LISTENING 行，排除 ESTABLISHED / TIME_WAIT；
 *   2. 本地地址列必须**以 `:端口` 结尾** —— 这就是防子串误判的关键，
 *      `127.0.0.1:18899` 不以 `:8899` 结尾，自然被排除；
 *   3. 跳过 PID 0（系统空闲进程）与非法 PID。
 */
function listeningPids(port) {
  let raw = '';
  try {
    raw = execFileSync('netstat', ['-ano'], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch {
    // netstat 不可用（非 Windows 等）：当作"无进程"，让调用方走"未运行"分支
    return [];
  }

  const pids = new Set();
  const suffix = ':' + port;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;

    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;

    const local = cols[1];                    // 本地地址：0.0.0.0:8899 / [::]:8899
    const pid = cols[cols.length - 1];        // 末列即 PID

    if (!local.endsWith(suffix)) continue;    // 完整端口匹配，杜绝子串误判
    if (!/^\d+$/.test(pid)) continue;
    if (pid === '0') continue;

    pids.add(pid);
  }

  return [...pids];
}

function main() {
  const cmd = (process.argv[2] || '').toLowerCase();

  if (cmd === 'port') {
    process.stdout.write(String(currentPort()));
    return 0;
  }

  if (cmd === 'status') {
    const pids = listeningPids(currentPort());
    if (pids.length) process.stdout.write(pids.join('\n') + '\n');
    return 0;
  }

  process.stderr.write('usage: node scripts/service.js <port|status>\n');
  return 1;
}

process.exitCode = main();
