#!/usr/bin/env node
'use strict';

/**
 * HTTP 冒烟测试：不依赖浏览器，直接打接口，验证全部链路是否通畅。
 *
 *   node scripts/smoke.js                          # 默认读 .env 的 PORT（当前 8899）
 *   node scripts/smoke.js http://127.0.0.1:8791    # 指定地址
 *   ADMIN_TOKEN=xxx node scripts/smoke.js          # 带管理口令测写接口
 *
 * 会临时导入一份资料并在结束时删除，不会污染知识库。
 */

const { config } = require('../server/config');
const BASE = (
  process.argv[2] ||
  process.env.SMOKE_BASE ||
  `http://127.0.0.1:${config.server.port}`
).replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = '') {
  passed++;
  console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
}

function bad(name, detail = '') {
  failed++;
  failures.push(`${name}：${detail}`);
  console.log(`  ✗ ${name}  ${detail}`);
}

function headers(extra = {}) {
  const h = Object.assign({}, extra);
  if (ADMIN_TOKEN) h['x-admin-token'] = ADMIN_TOKEN;
  return h;
}

/* ------------------------------------------------------------------ */

async function testHealth() {
  const res = await fetch(`${BASE}/api/health`);
  const data = await res.json();
  if (!res.ok || !data.ok) return bad('GET /api/health', `HTTP ${res.status}`);
  ok('GET /api/health', `模型=${data.config.llmConfigured ? '已配置' : '未配置'} 检索=${data.config.vectorEnabled ? '混合' : '关键词'} 资料=${data.kb.documents} 片段=${data.kb.chunks}`);
}

async function testStatic() {
  const targets = [
    ['/', 'text/html', '<!DOCTYPE html>'],
    ['/styles.css', 'text/css', '--accent'],
    ['/app.js', 'javascript', 'renderMarkdown']
  ];

  for (const [path, expectedType, needle] of targets) {
    const res = await fetch(`${BASE}${path}`);
    const text = await res.text();
    const type = res.headers.get('content-type') || '';
    if (!res.ok) { bad(`GET ${path}`, `HTTP ${res.status}`); continue; }
    if (!type.includes(expectedType)) { bad(`GET ${path}`, `Content-Type=${type}`); continue; }
    if (!text.includes(needle)) { bad(`GET ${path}`, `未找到预期内容 ${needle}`); continue; }
    ok(`GET ${path}`, `${(text.length / 1024).toFixed(1)} KB`);
  }
}

async function testSearch() {
  const cases = [
    { q: '监理投标文件由哪几部分组成', expectHit: true },
    { q: '投标保证金什么时候退还', expectHit: true },
    { q: '红烧肉怎么做才好吃', expectHit: false }
  ];

  for (const item of cases) {
    const res = await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: item.q })
    });
    if (!res.ok) { bad(`POST /api/search 「${item.q}」`, `HTTP ${res.status}`); continue; }
    const data = await res.json();
    const hit = !data.uncovered;
    if (hit !== item.expectHit) {
      bad(`POST /api/search 「${item.q}」`, `期望${item.expectHit ? '命中' : '兜底'}，实际${hit ? '命中' : '兜底'}（覆盖率 ${data.coverage}）`);
      continue;
    }
    ok(`POST /api/search 「${item.q}」`, `覆盖率 ${(data.coverage * 100).toFixed(0)}%，模式 ${data.mode}，候选 ${data.results.length} 条，${data.tookMs}ms`);
  }
}

/** 消费一次 SSE，返回收到的事件列表 */
async function collectSse(body) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    throw new Error(`Content-Type 不是 text/event-stream：${res.headers.get('content-type')}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      if (raw.startsWith(':')) continue;
      let name = 'message';
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) {
        try { events.push({ name, data: JSON.parse(dataLines.join('\n')) }); } catch { /* ignore */ }
      }
    }
  }
  return events;
}

async function testChatFallback() {
  // 无关问题：应走兜底，且不依赖模型是否配置
  const events = await collectSse({ question: '红烧肉怎么做才好吃' });
  const names = events.map((e) => e.name);
  const fallback = events.find((e) => e.name === 'fallback');

  if (!names.includes('meta')) { bad('POST /api/chat 兜底路径', `缺少 meta 事件，收到 ${names.join(',') || '（空）'}`); return; }
  if (!fallback) { bad('POST /api/chat 兜底路径', `未收到 fallback 事件，收到 ${names.join(',')}`); return; }
  if (!names.includes('done')) { bad('POST /api/chat 兜底路径', '缺少 done 事件'); return; }

  ok('POST /api/chat 兜底路径', `reason=${fallback.data.reason}，覆盖率 ${(fallback.data.coverage * 100).toFixed(0)}%，未调用模型`);
}

async function testChatAnswer(health) {
  if (!health.config.llmConfigured) {
    // 未配置密钥时，命中闸门后应返回明确的配置错误，而不是静默失败
    const events = await collectSse({ question: '投标保证金什么时候退还' });
    const error = events.find((e) => e.name === 'error');
    if (error) ok('POST /api/chat 命中路径', `未配置密钥时正确返回错误：${error.data.message.slice(0, 40)}…`);
    else bad('POST /api/chat 命中路径', '未配置密钥却没有返回 error 事件');
    return;
  }

  const events = await collectSse({ question: '投标保证金什么时候退还' });
  const text = events.filter((e) => e.name === 'delta').map((e) => e.data.text).join('');
  const meta = events.find((e) => e.name === 'meta');
  const done = events.find((e) => e.name === 'done');

  if (!meta) { bad('POST /api/chat 命中路径', '缺少 meta 事件'); return; }
  if (!done) { bad('POST /api/chat 命中路径', '缺少 done 事件'); return; }
  if (!text.trim()) {
    // 这一项依赖知识库里存在"投标保证金"主题的资料。资料被替换后走兜底属正常，
    // 但错误信息必须说清楚，否则会被误读成接口故障。
    const fb = events.find((e) => e.name === 'fallback');
    if (fb) {
      bad('POST /api/chat 命中路径',
        `未产生正文，走的是兜底（reason=${fb.data.reason}，覆盖率 ${(fb.data.coverage * 100).toFixed(0)}%）。` +
        '本用例问的是「投标保证金什么时候退还」，若知识库已不含该主题的资料，此项失败属正常');
    } else {
      bad('POST /api/chat 命中路径', `未收到任何正文，收到的事件：${events.map((e) => e.name).join(',') || '（空）'}`);
    }
    return;
  }

  ok('POST /api/chat 命中路径', `${text.length} 字，来源 ${(meta.data.citations || []).length} 条，${done.data.elapsedMs || 0}ms`);
  console.log(`      回答首句：${text.split('\n').find((l) => l.trim()).slice(0, 70)}`);

  if (events.some((e) => e.name === 'fallback')) {
    bad('POST /api/chat 命中路径', '命中闸门却走了兜底');
  }
}

async function testKbRoundTrip() {
  const title = `冒烟测试资料-${Date.now()}`;
  // 标记词**必须是无意义的生造词**，这是刻意的。
  //
  // 曾经用的是「云杉松涛」，删除后断言"检索不到"却失败了 —— 不是功能有问题，
  // 而是这个词的构件（"云""杉""松""涛"）多多少少散落在其它资料里，
  // 更关键的是"删除后应检索不到"这条断言问的是「云杉松涛是什么」，
  // 而知识库里那份《知识库使用说明与收录范围》通篇在讲"什么收录、什么不收录"，
  // 词面高度沾边，覆盖率能到 1.0，于是闸门放行 —— 断言的前提不成立。
  //
  // 教训：**验证"删除生效"的探针词，必须是删除后在任何其它资料里都不存在的词。**
  // 否则测试会因为无关资料的词面巧合而假红。
  const marker = '锟鹏锴钺钉';
  const text = `# ${title}\n\n这是一份用于自动化测试的临时资料，内容包含一个独特词：冒烟测试专用标记词「${marker}」。\n\n导入后应当能检索到。`;
  const probeQuestion = marker + '是什么';

  // 中途任何一步失败都要把测试资料删掉，否则会残留在用户的知识库里
  let docId = null;

  try {
    // 导入
    const res = await fetch(`${BASE}/api/kb/text`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title, text })
    });

    if (res.status === 401) {
      console.log('  ℹ 写接口已开启鉴权（未提供正确的 ADMIN_TOKEN），跳过导入/删除测试。');
      return;
    }
    if (!res.ok) { bad('POST /api/kb/text', `HTTP ${res.status} ${await res.text()}`); return; }

    const imported = await res.json();
    if (!imported.ok) { bad('POST /api/kb/text', JSON.stringify(imported)); return; }
    if (!imported.stats) {
      bad('POST /api/kb/text', `响应缺少 stats 字段（顶层字段：${Object.keys(imported).join('、')}）`);
      return;
    }
    ok('POST /api/kb/text', `片段 ${imported.result.chunks} 个，当前共 ${imported.stats.documents} 份资料`);

    docId = imported.result.docId;

    // 检索验证
    const searchRes = await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: probeQuestion })
    });
    const searchData = await searchRes.json();
    if (searchData.uncovered) bad('导入后立即检索', `未命中，覆盖率 ${searchData.coverage}`);
    else ok('导入后立即检索', `命中《${searchData.results[0].title}》，覆盖率 ${(searchData.coverage * 100).toFixed(0)}%`);

    // 幂等性：重复导入同内容不应产生新片段
    const before = imported.stats.chunks;
    const againRes = await fetch(`${BASE}/api/kb/text`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title, text })
    });
    const againText = await againRes.text();

    let again = null;
    try { again = JSON.parse(againText); } catch { /* 非 JSON 响应 */ }

    if (!again || !again.stats) {
      // 直接打印原始响应。以前这里只报 "reading 'chunks'"，完全无从定位
      bad('重复导入幂等', `HTTP ${againRes.status}，响应中没有 stats 字段。原始响应：${againText.slice(0, 200)}`);
    } else if (again.stats.chunks === before) {
      ok('重复导入幂等', `片段数仍为 ${before}`);
    } else {
      bad('重复导入幂等', `片段数从 ${before} 变为 ${again.stats.chunks}`);
    }

    // 删除
    const delRes = await fetch(`${BASE}/api/kb/docs/${encodeURIComponent(docId)}`, {
      method: 'DELETE',
      headers: headers()
    });
    if (!delRes.ok) {
      bad('DELETE /api/kb/docs/:id', `HTTP ${delRes.status} ${(await delRes.text()).slice(0, 160)}`);
      return;
    }

    const after = await delRes.json();
    ok('DELETE /api/kb/docs/:id', `剩余 ${after.stats ? after.stats.documents : '?'} 份资料`);
    docId = null; // 已正常删除，finally 里不必再清理

    // 删除后应检索不到
    const afterSearch = await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: probeQuestion })
    }).then((r) => r.json());

    if (afterSearch.uncovered) ok('删除后退出检索', '已正确兜底');
    else bad('删除后退出检索', '仍能检索到已删除的资料');
  } finally {
    if (docId) {
      try {
        const cleanup = await fetch(`${BASE}/api/kb/docs/${encodeURIComponent(docId)}`, {
          method: 'DELETE',
          headers: headers()
        });
        console.log(`  ℹ 测试中途失败，已自动清理残留的测试资料（HTTP ${cleanup.status}）`);
      } catch {
        console.log(`  ⚠ 测试中途失败，自动清理也未成功。请到页面手动删除《${title}》`);
      }
    }
  }
}

async function testRateLimitHeaders() {
  const res = await fetch(`${BASE}/api/health`);
  const security = ['x-content-type-options', 'x-frame-options', 'referrer-policy'];
  const missing = security.filter((h) => !res.headers.get(h));
  if (missing.length) bad('安全响应头', `缺少 ${missing.join(', ')}`);
  else ok('安全响应头', 'X-Content-Type-Options / X-Frame-Options / Referrer-Policy 齐备');
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('='.repeat(66));
  console.log(` 知识问答 Agent —— HTTP 冒烟测试`);
  console.log(` 目标：${BASE}${ADMIN_TOKEN ? '（带管理口令）' : ''}`);
  console.log('='.repeat(66));
  console.log('');

  let health = { config: {} };
  try {
    const res = await fetch(`${BASE}/api/health`);
    health = await res.json();
  } catch (err) {
    console.error(`\n❌ 无法连接 ${BASE}，请先启动服务：npm start\n   错误：${err.message}\n`);
    process.exit(1);
  }

  const groups = [
    ['健康检查与安全头', async () => { await testHealth(); await testRateLimitHeaders(); }],
    ['静态资源', testStatic],
    ['检索接口', testSearch],
    ['问答接口', async () => { await testChatFallback(); await testChatAnswer(health); }],
    ['知识库增删', testKbRoundTrip]
  ];

  for (const [name, fn] of groups) {
    console.log(`\n── ${name} ──`);
    try {
      await fn();
    } catch (err) {
      bad(name, err.message);
    }
  }

  console.log('\n' + '='.repeat(66));
  console.log(` 通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log(' 失败明细：');
    for (const f of failures) console.log(`   · ${f}`);
  }
  console.log('='.repeat(66) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试异常：', err);
  process.exit(1);
});
