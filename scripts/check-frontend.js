'use strict';

/**
 * 前端静态交叉校验。
 *
 * 解决的问题：public/app.js 里用 $('#xxx') 取元素，一旦 id 拼错或 HTML 里删了元素，
 * 页面会静默报错、功能失灵，而且只有打开浏览器控制台才看得到。
 * 本脚本在不开浏览器的情况下做一次全量比对。
 *
 * 校验项：
 *   1. app.js 中所有 $('#id') 引用的元素，必须在 index.html 中存在；
 *   2. app.js 中所有 el.xxx 引用的键，必须在 el 对象里定义过；
 *   3. index.html 中 <link>/<script> 引用的本地文件必须真实存在；
 *   4. index.html 中带 hidden 属性的元素，其样式不能被 display 声明盖掉。
 *
 * 用法：npm run check:frontend
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const htmlPath = path.join(ROOT, 'public', 'index.html');
const jsPath = path.join(ROOT, 'public', 'app.js');
const cssPath = path.join(ROOT, 'public', 'styles.css');

const html = fs.readFileSync(htmlPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');
const cssRaw = fs.readFileSync(cssPath, 'utf8');

// 剥离 CSS 注释后再解析：否则被注释掉的规则会被当成生效规则，检查结果失真。
// 用等量空格替换（保留换行），这样报错时的行号仍然准确。
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

let pass = 0;
const problems = [];

/* ---------- 1. $('#id') 引用的元素必须存在于 HTML ---------- */

// HTML 中出现的所有 id
const htmlIds = new Set();
for (const m of html.matchAll(/\bid=["']([^"']+)["']/g)) htmlIds.add(m[1]);

// JS 中所有 $('#xxx') 字面量引用
const jsIds = new Set();
for (const m of js.matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g)) jsIds.add(m[1]);

for (const id of jsIds) {
  if (htmlIds.has(id)) pass++;
  else problems.push(`app.js 引用了 #${id}，但 index.html 中不存在该元素`);
}

/* ---------- 2. el.xxx 引用的键必须在 el 对象中定义 ---------- */

// 先排查变量遮蔽：函数内若也叫 el，会让下面的检查出现假阳性，
// 而且本身就是隐患（模块级 el 引用表被局部 DOM 节点盖住）。
for (const m of js.matchAll(/(?:const|let|var)\s+el\s*=/g)) {
  const snippet = js.slice(m.index, m.index + 16);
  if (snippet.startsWith('const el = {') || snippet.startsWith('let el = {')) continue;
  const line = js.slice(0, m.index).split('\n').length;
  problems.push(`app.js 第 ${line} 行有局部变量 el，遮蔽了模块级元素引用表 el，请改名`);
}

const elBlock = js.match(/const el = \{([\s\S]*?)\n\s*\};/);
if (!elBlock) {
  problems.push('未能定位 public/app.js 中的 `const el = { ... }` 定义块');
} else {
  const defined = new Set();
  for (const m of elBlock[1].matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)) defined.add(m[1]);

  const used = new Set();
  for (const m of js.matchAll(/\bel\.([A-Za-z0-9_]+)/g)) used.add(m[1]);

  for (const key of used) {
    if (defined.has(key)) pass++;
    else problems.push(`app.js 使用了 el.${key}，但 el 对象中没有定义该键`);
  }
}

/* ---------- 3. HTML 引用的本地静态文件必须存在 ---------- */

for (const m of html.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
  const ref = m[1];
  if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue;
  const file = path.join(ROOT, 'public', ref.replace(/^\//, '').split('?')[0]);
  if (fs.existsSync(file)) pass++;
  else problems.push(`index.html 引用了 ${ref}，但文件不存在`);
}

/* ---------- 4. hidden 元素的 display 不能被作者样式盖掉 ---------- */

// 浏览器默认样式表里的 [hidden] { display: none } 特异性极低，
// 作者样式里任何 `display: flex` 之类都会把它覆盖掉，
// 结果是「用 JS 设了 hidden 却关不掉」。这类 bug 完全静默，只能在浏览器里肉眼发现。
// 因此这里做静态排查：要么有全局兜底，要么逐个元素确认没有冲突声明。

// 独立 hidden 属性（排除 aria-hidden）
const hiddenEls = [];
for (const m of html.matchAll(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
  const attrs = m[2] || '';
  if (!/(?:^|\s)hidden(?=[\s/>]|$)/.test(attrs)) continue;
  const id = (attrs.match(/\bid=["']([^"']+)["']/) || [])[1] || '';
  const cls = (attrs.match(/\bclass=["']([^"']+)["']/) || [])[1] || '';
  hiddenEls.push({ tag: m[1], id, cls: cls.split(/\s+/).filter(Boolean) });
}

// 全局兜底：形如 `[hidden] { ... display: none !important; ... }`
const globalGuard = /\[hidden\][^{}]*\{[^{}]*display\s*:\s*none\s*!important[^{}]*\}/.test(css);

if (hiddenEls.length === 0) {
  pass++;
} else if (globalGuard) {
  // 有兜底则全部安全
  pass += hiddenEls.length;
} else {
  // 解析所有「选择器 { 声明 }」，挑出把 display 设为非 none 的
  const displayRules = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const decls = m[2];
    if (!/display\s*:/.test(decls)) continue;
    if (/display\s*:\s*none/.test(decls)) continue;
    if (selector.startsWith('@') || selector.startsWith('from') || selector.startsWith('to')) continue;
    displayRules.push({ selector, line: css.slice(0, m.index).split('\n').length });
  }

  for (const el of hiddenEls) {
    const label = el.id ? `#${el.id}` : el.cls.length ? `.${el.cls[0]}` : `<${el.tag}>`;
    const hit = displayRules.find((r) => {
      if (el.id && r.selector.includes(`#${el.id}`)) return true;
      return el.cls.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(r.selector));
    });
    if (hit) {
      problems.push(
        `${label} 带 hidden 属性，但 CSS 第 ${hit.line} 行的规则「${hit.selector}」给它设了 display，` +
        '会盖掉 [hidden] 的隐藏效果。请在样式表顶部加 `[hidden] { display: none !important; }`'
      );
    } else {
      pass++;
    }
  }
}

/* ---------- 输出 ---------- */

console.log('='.repeat(66));
console.log(' 前端静态交叉校验');
console.log('='.repeat(66));
console.log(`  HTML 中定义 id     : ${htmlIds.size} 个`);
console.log(`  app.js 引用 id     : ${jsIds.size} 个`);
console.log(`  带 hidden 的元素   : ${hiddenEls.length} 个${globalGuard ? '（已有全局 [hidden] 兜底）' : ''}`);
console.log('');

if (problems.length === 0) {
  console.log(`  ✅ 通过 ${pass} 项，未发现问题`);
  console.log('='.repeat(66));
  process.exit(0);
}

console.log(`  ❌ 通过 ${pass} 项，发现 ${problems.length} 个问题：`);
console.log('');
for (const p of problems) console.log(`     · ${p}`);
console.log('='.repeat(66));
process.exit(1);
