'use strict';
/**
 * 校验两个 .cmd 脚本必须为纯 ASCII。
 *
 * 为什么必须纯 ASCII：cmd.exe 按**系统 ANSI 代码页**（中文 Windows = GBK）
 * 解码 .cmd 文件，与文件实际存储编码无关。中文注释若以 UTF-8 存 → 乱码 →
 * rem 失效、for /f 引号被撑破 → 整个脚本解析崩溃。chcp 65001 救不了。
 *
 * 扫描根目录默认是项目根，可用环境变量 CMD_CHECK_ROOT 改写 ——
 * 这是给变异测试（test-cmd-encoding.js）用的：它要在**临时沙箱**里
 * 污染一份副本来验证本脚本真的会报警，而不是去污染真实的 .cmd。
 * 早期版本直接改真实文件再还原，一旦中途崩了（Ctrl+C / 断电），
 * 用户的启停脚本就被留在垃圾内容上。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const ROOT = path.resolve(process.env.CMD_CHECK_ROOT || DEFAULT_ROOT);
const IS_SANDBOX = ROOT !== DEFAULT_ROOT;
const TARGETS = ['启动服务.cmd', '停止服务.cmd'];

let bad = 0;

if (IS_SANDBOX) {
  console.log(`  (sandbox mode, root = ${ROOT})`);
}

for (const name of TARGETS) {
  const p = path.join(ROOT, name);

  if (!fs.existsSync(p)) {
    bad++;
    console.log(`  FAIL ${name}  (not found)`);
    continue;
  }

  const buf = fs.readFileSync(p);
  const offenders = [];

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // 允许 TAB(9) LF(10) CR(13)，以及 0x20-0x7E
    if (b === 9 || b === 10 || b === 13) continue;
    if (b >= 0x20 && b <= 0x7e) continue;
    offenders.push({ offset: i, byte: '0x' + b.toString(16).padStart(2, '0') });
  }

  const crlf = buf.toString('utf8').split('\n').length - 1;
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

  if (offenders.length === 0 && !hasBom) {
    console.log(`  OK   ${name}  (${buf.length} bytes, ${crlf} lines, pure ASCII, no BOM)`);
  } else {
    bad++;
    console.log(`  FAIL ${name}`);
    if (hasBom) console.log('       has UTF-8 BOM (will break cmd.exe)');
    for (const o of offenders.slice(0, 10)) {
      console.log(`       non-ASCII byte ${o.byte} at offset ${o.offset}`);
    }
    if (offenders.length > 10) console.log(`       ... and ${offenders.length - 10} more`);
  }
}

// 额外：确认 service.js 存在且能给出端口
const svc = path.join(ROOT, 'scripts', 'service.js');
console.log(fs.existsSync(svc) ? '  OK   scripts/service.js exists' : '  FAIL scripts/service.js missing');
if (!fs.existsSync(svc)) bad++;

console.log('');
console.log(bad === 0 ? 'ALL ASCII CHECKS PASSED' : `${bad} CHECK(S) FAILED`);
process.exitCode = bad === 0 ? 0 : 1;
