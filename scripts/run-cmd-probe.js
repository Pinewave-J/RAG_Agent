'use strict';
/**
 * 实跑 .cmd 脚本并捕获输出（本机 Git Bash coreutils 不可用，只能走 Node）。
 * 用 GBK 解码，模拟 cmd.exe 的真实行为；若脚本含 UTF-8 中文，输出会看到乱码。
 *
 *   node scripts/run-cmd-probe.js "停止服务.cmd"
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const script = process.argv[2];
if (!script) {
  console.error('usage: node scripts/run-cmd-probe.js <script.cmd>');
  process.exit(1);
}

const scriptPath = path.join(ROOT, script);

// 让 pause 立刻返回：往 stdin 塞一个换行
const res = spawnSync('cmd.exe', ['/c', scriptPath], {
  cwd: ROOT,
  input: Buffer.from('\r\n\r\n', 'utf8'),
  timeout: 60000,
  windowsHide: true
});

// cmd.exe 按系统 ANSI 代码页（中文 Windows = GBK）输出
function decode(buf) {
  if (!buf) return '';
  // Node 的 gbk 解码：用 TextDecoder（Node 18+ 已内置 gbk 支持）
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

const outPath = path.join(os.tmpdir(), 'cmd_probe_result.txt');
const lines = [];
lines.push('script : ' + script);
lines.push('status : ' + res.status);
lines.push('signal : ' + res.signal);
lines.push('error  : ' + (res.error ? res.error.message : 'none'));
lines.push('');
lines.push('--- stdout (decoded as GBK) ---');
lines.push(decode(res.stdout));
lines.push('--- stderr (decoded as GBK) ---');
lines.push(decode(res.stderr));

fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log('written to ' + outPath);
console.log(lines.join('\n'));
