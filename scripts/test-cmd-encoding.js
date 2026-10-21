'use strict';
/**
 * 变异测试：确认 check-cmd-encoding.js 真的会报警，而不是永远绿灯。
 *
 * 做法：把两个 .cmd **复制到临时沙箱**，在副本里注入两种污染
 * （UTF-8 中文 / UTF-8 BOM），跑校验，每一种都必须 FAIL；
 * 沙箱里未经污染的副本必须 PASS。
 *
 * ⚠️ 为什么不直接改真实的 .cmd 再还原（早期版本就是这么干的）：
 *    那条路径没有任何"原子性"可言。中间任何一次崩溃（Ctrl+C、断电、
 *    杀进程）都会把松涛的启停脚本留在"3 行垃圾内容"的状态上 ——
 *    而且他不会知道，直到某天双击启动服务发现窗口一闪而过。
 *    校验脚本的变异测试，绝不该以损坏被校验对象为代价。
 *
 * 另外加一条硬断言：跑完之后，**真实的两个 .cmd 必须一字节未变**
 *    （比对内容 hash + mtime）。这条断言就是对上面那个隐患的回归测试。
 *
 * 不用 shell 的 cp/rm（本机 Git Bash coreutils 不可用），全走 Node fs。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REAL_TARGETS = ['启动服务.cmd', '停止服务.cmd'];
const CHECKER = path.join(__dirname, 'check-cmd-encoding.js');

const SANDBOX = path.join(os.tmpdir(), 'cmd-encoding-sandbox-' + process.pid);

let failed = 0;

function ok(msg) { console.log('  OK   ' + msg); }
function no(msg) { failed++; console.log('  FAIL ' + msg); }

/** 记录真实文件的"指纹"，最后用来证明我们没碰过它们 */
function fingerprints() {
  const out = {};
  for (const name of REAL_TARGETS) {
    const p = path.join(ROOT, name);
    const st = fs.statSync(p);
    out[name] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')
      + '|' + st.mtimeMs;
  }
  return out;
}

/** 在沙箱里跑校验脚本，返回 {code, out} */
function runChecker() {
  try {
    const out = execFileSync(process.execPath, [CHECKER], {
      encoding: 'utf8',
      env: { ...process.env, CMD_CHECK_ROOT: SANDBOX }
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
  }
}

/* ------------------------------------------------------------------ */

const before = fingerprints();

try {
  // 搭沙箱：两个 .cmd 的干净副本 + 一个 service.js 占位
  fs.mkdirSync(path.join(SANDBOX, 'scripts'), { recursive: true });
  for (const name of REAL_TARGETS) {
    fs.copyFileSync(path.join(ROOT, name), path.join(SANDBOX, name));
  }
  fs.copyFileSync(path.join(ROOT, 'scripts', 'service.js'),
    path.join(SANDBOX, 'scripts', 'service.js'));

  /* ---- 0) 干净副本必须 PASS（先证明沙箱本身不会误报）---- */
  {
    const { code, out } = runChecker();
    if (code === 0 && out.includes('ALL ASCII CHECKS PASSED')) {
      ok('clean sandbox copy passes (no false alarm)');
    } else {
      no('clean sandbox copy does NOT pass — the harness itself is broken');
      console.log(indent(out));
    }
  }

  /* ---- 1) 注入 UTF-8 中文，必须 FAIL 并指出 non-ASCII byte ---- */
  {
    fs.writeFileSync(path.join(SANDBOX, REAL_TARGETS[1]),
      '@echo off\r\nrem \u6d4b\u8bd5\u4e2d\u6587\r\n', 'utf8');
    const { code, out } = runChecker();
    if (code !== 0 && out.includes('FAIL') && out.includes('non-ASCII byte')) {
      ok('mutation 1 (UTF-8 Chinese) detected — checker reported FAIL');
    } else {
      no('mutation 1 NOT detected — the checker is a no-op!');
      console.log('       exit code was ' + code);
      console.log(indent(out));
    }
  }

  /* ---- 2) 注入 UTF-8 BOM，必须 FAIL 并点名 BOM ---- */
  {
    fs.writeFileSync(path.join(SANDBOX, REAL_TARGETS[1]),
      '\ufeff@echo off\r\n', 'utf8');
    const { code, out } = runChecker();
    if (code !== 0 && out.includes('BOM')) {
      ok('mutation 2 (UTF-8 BOM) detected — checker named the BOM');
    } else {
      no('mutation 2 NOT detected — BOM 会导致 cmd.exe 把首行吃掉却没人发现');
      console.log('       exit code was ' + code);
      console.log(indent(out));
    }
  }

  /* ---- 3) 还原沙箱副本后必须重新 PASS ---- */
  {
    for (const name of REAL_TARGETS) {
      fs.copyFileSync(path.join(ROOT, name), path.join(SANDBOX, name));
    }
    const { code, out } = runChecker();
    if (code === 0 && out.includes('ALL ASCII CHECKS PASSED')) {
      ok('sandbox restored — passes again');
    } else {
      no('sandbox copy still fails after restore');
      console.log(indent(out));
    }
  }
} finally {
  // 清理沙箱。删除失败不算测试失败（临时目录会自己过期），但要报出来。
  try {
    for (const name of REAL_TARGETS) fs.unlinkSync(path.join(SANDBOX, name));
    fs.unlinkSync(path.join(SANDBOX, 'scripts', 'service.js'));
    fs.rmdirSync(path.join(SANDBOX, 'scripts'));
    fs.rmdirSync(SANDBOX);
  } catch (e) {
    console.log('  note sandbox cleanup incomplete: ' + SANDBOX + ' (' + e.code + ')');
  }
}

/* ---- 4) 关键回归：真实文件必须一字节未变 ---- */
{
  const after = fingerprints();
  let changed = [];
  for (const name of REAL_TARGETS) {
    if (before[name] !== after[name]) changed.push(name);
  }
  if (changed.length === 0) {
    ok('real .cmd files untouched (content + mtime identical)');
  } else {
    no('real .cmd files were modified: ' + changed.join(', '));
    console.log('       ↑ 变异测试不该碰真实文件。早期版本直接改真实文件再还原，');
    console.log('         中途崩溃就会把用户的启停脚本留在垃圾内容上。');
  }
}

function indent(s) {
  return String(s).split('\n').map((l) => '       ' + l).join('\n');
}

console.log('');
console.log(failed === 0 ? 'MUTATION TEST PASSED' : 'MUTATION TEST FAILED');
process.exitCode = failed === 0 ? 0 : 1;
