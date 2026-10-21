'use strict';

/**
 * 检索层回归测试。
 *
 * 存在的理由（这是一个真实踩过的坑）：
 *   searchVector() 曾经被写成 async，但它的调用方 search() 是**同步** API，
 *   于是 options.queryVector 存在时，vectorList 拿到的是 Promise，
 *   紧接着的 vectorList.map(...) 抛出 "vectorList.map is not a function"。
 *
 *   这个 bug 的恶劣之处在于**只在生成向量之后才出现**：
 *   关键词模式下一切正常，一开启混合检索立即 500。
 *   因此必须有测试同时覆盖"有向量"和"无向量"两条路径。
 *
 * 用法：node scripts/test-retriever.js
 */

const retriever = require('../server/retriever');
const store = require('../server/store');
const { config } = require('../server/config');

let pass = 0;
const fails = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name} —— 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function checkTruthy(name, actual) {
  if (actual) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name} —— 期望为真，实际 ${JSON.stringify(actual)}`);
  }
}

console.log('检索层回归测试\n');
store.load();

const QUESTION = '投标保证金什么时候退还';

/* ---------- 1. searchVector 必须是同步的 ---------- */
// 这是决定性的断言：一旦有人把它改回 async，这里立刻红。
console.log('[1] searchVector 契约');
{
  const src = retriever.searchVector ? retriever.searchVector.toString() : '';
  checkTruthy('searchVector 已被导出（便于测试）', Boolean(retriever.searchVector));

  const fake = new Float32Array(store.state.vectorDim || 1024).fill(0.1);
  const out = retriever.searchVector(fake, 5);
  checkTruthy('searchVector 返回数组而非 Promise', Array.isArray(out));
}

/* ---------- 2. 无向量时：关键词模式 ---------- */
console.log('\n[2] 关键词模式（不传 queryVector）');
{
  const r = retriever.search(QUESTION);
  check('mode = keyword', r.mode, 'keyword');
  checkTruthy('返回了结果', r.results.length > 0);
  checkTruthy('每个结果都有 id', r.results.every((x) => typeof x.id === 'string'));
  checkTruthy('每个结果都有 coverage', r.results.every((x) => typeof x.coverage === 'number'));
}

/* ---------- 3. 有向量时：混合模式（曾经在这里崩） ---------- */
console.log('\n[3] 混合模式（传 queryVector）—— 曾经的崩溃点');
{
  const dim = store.state.vectorDim || 1024;
  const fake = new Float32Array(dim).fill(0.1);

  let r = null;
  let error = null;
  try {
    r = retriever.search(QUESTION, { queryVector: fake });
  } catch (err) {
    error = err;
  }

  check('不抛异常', error ? error.message : null, null);
  if (r) {
    checkTruthy('mode 为 hybrid 或 keyword', r.mode === 'hybrid' || r.mode === 'keyword');
    checkTruthy('返回了结果数组', Array.isArray(r.results));
    checkTruthy('vectorScoreByIndex 构建成功（结果带 vectorSim 字段）',
      r.results.every((x) => typeof x.vectorSim === 'number'));
    checkTruthy('stats.vectorHits 是数字', typeof r.stats.vectorHits === 'number');
  }
}

/* ---------- 4. 斜接：向量维度不匹配也不能崩 ---------- */
console.log('\n[4] 异常输入');
{
  let error = null;
  try {
    retriever.search(QUESTION, { queryVector: new Float32Array(8).fill(0.1) });
  } catch (err) {
    error = err;
  }
  check('维度不匹配时不崩溃', error ? error.message : null, null);
}

{
  let error = null;
  try {
    retriever.search('');
  } catch (err) {
    error = err;
  }
  check('空查询不崩溃', error ? error.message : null, null);
}

/* ---------- 5. 闸门行为 ---------- */
console.log('\n[5] 兜底闸门');
{
  const r = retriever.search(QUESTION);
  checkTruthy('知识库能答的问题 coverage >= 阈值', r.coverage >= config.retrieval.minCoverage);
  check('uncovered = false', r.uncovered, false);

  const off = retriever.search('红烧肉怎么做才好吃');
  checkTruthy('知识库答不了的问题被拦下或交由模型层',
    off.uncovered === true || off.coverage < 1);
}

/* ---------- 6. 标题（section）必须参与打分 ---------- */
/**
 * 这是第二个真实踩过的坑，比"同步契约"那个更隐蔽：
 *
 *   条文类资料的正文常常**不含**提问用的词，而标题里含。
 *   典型：「3.2.1 总监理工程师应履行下列职责：」这一节，
 *   正文全是列表项（"确定项目监理机构人员及其岗位职责。"），
 *   一个"履行"字都没有 —— 而用户提问的正是"总监理工程师应履行哪些职责"。
 *   标题被切分器放到 section 字段后就不参与 BM25 打分，
 *   于是该片段排到 20 名开外，被 3.2.3（正文里恰好含"总监理工程师"和"履行"）顶掉，
 *   模型据此回答"资料未收录"——资料明明就在库里。
 *
 *   这个 bug 的恶劣之处：**检索接口不报错、覆盖率也正常**（0.84 远高于阈值），
 *   只有连上模型看回答内容才发现是错的。所以必须用断言把它钉住。
 *
 * 修法：store.rebuildStats() 把 section 的分词结果按 SECTION_TF_WEIGHT 并入 chunkTf。
 * 下面用**合成语料**直接验证该机制，不依赖真实知识库里有没有某份资料
 * ——否则用户一换资料，测试就假红（这个教训在 smoke 里已经吃过一次）。
 */
console.log('\n[6] 标题（section）参与打分');
{
  const originals = store.state.chunks;
  const originalTf = store.state.chunkTf;
  const originalDf = store.state.df;
  const originalAvgdl = store.state.avgdl;

  try {
    // 构造两条"正文都各说各话、只有标题能区分"的片段，模拟 3.2.1 / 3.2.3
    store.state.chunks = [
      {
        id: 't#0',
        docId: 't',
        docTitle: '测试规范',
        section: '测试规范 › 3.2.1 总监理工程师应履行下列职责：',
        text: '确定项目监理机构人员及其岗位职责。组织编制监理规划，审批监理实施细则。'
      },
      {
        id: 't#1',
        docId: 't',
        docTitle: '测试规范',
        section: '测试规范 › 3.2.3 专业监理工程师应履行下列职责：',
        text: '参与编制监理规划，负责编制监理实施细则。审查施工单位提交的涉及本专业的报审文件。'
      }
    ];
    store.rebuildStats();

    // 关键断言：标题里的词必须真的出现在该片段的词频里
    const tf0 = store.state.chunkTf[0].tf;
    checkTruthy('标题独有的词进了该片段的词频（"履行"）', (tf0['履行'] || 0) > 0);
    checkTruthy('标题独有的词进了该片段的词频（"总监"）', (tf0['总监'] || 0) > 0);

    // 权重必须是"低权重"而非等权：0 < tf < 正文自身的词频
    checkTruthy('标题词频带权重（0 与 1 之间）', tf0['履行'] > 0 && tf0['履行'] < 1);

    // 端到端：问"总监理工程师…"时，3.2.1 必须排在 3.2.3 前面
    const r = retriever.search('总监理工程师应履行哪些职责', { topK: 5 });
    check('问「总监理工程师」时 3.2.1 排第一', r.results[0] && r.results[0].id, 't#0');

    const r2 = retriever.search('专业监理工程师应履行哪些职责', { topK: 5 });
    check('问「专业监理工程师」时 3.2.3 排第一', r2.results[0] && r2.results[0].id, 't#1');
  } finally {
    // 无论断言成功与否都要还原，否则会污染同进程后续用例
    store.state.chunks = originals;
    store.state.chunkTf = originalTf;
    store.state.df = originalDf;
    store.state.avgdl = originalAvgdl;
  }
}

/* ---------- 7. 停用词不得进入闸门词表 ---------- */
/**
 * 第三个真实踩过的坑，而且它的后果是**整个闸门静默失效**：
 *
 *   tokenize() 对中文段分两轮输出：先单字（查停用词表）、后相邻双字（**不查**）。
 *   于是「什么」「怎么」「哪些」这类疑问词会以**双字**形态进入 queryTerms，
 *   又因为它们广泛存在于语料里（df>0 且 df<片段总数），全部通过闸门词筛选。
 *
 *   后果：一句"XXX是什么"的闸门词退化到只剩「什么」，任何片段都能命中，
 *   覆盖率恒为 1.0 —— 闸门再也拦不住任何问题，包括知识库里完全不存在的词。
 *   实测证据：问生造词「锟鹏锴钺钉是什么」返回 uncovered=false, coverage=1。
 *
 * 这个 bug 之所以长期没被发现，是因为它**让闸门变得更宽松**：
 * 表面上是"该答的都能答"，只有"该拒的没拒"才会暴露，而且还得恰好问到边缘案例。
 */
console.log('\n[7] 闸门词表必须滤掉停用词');
{
  const { STOPWORDS } = require('../server/tokenizer');

  // 疑问词必须被挡掉。它们单字形态已在停用词表里，双字形态此前漏网
  const leaked = ['什么', '怎么', '哪些', '如何', '是否'].filter(
    (w) => STOPWORDS.has(w) && retriever.selectGateTerms([w]).length > 0
  );
  check('疑问词不会成为闸门词', leaked, []);

  // 端到端：生造词必须被拦下（此前 coverage 恒为 1.0，永远拦不住）
  const nonsense = retriever.search('锟鹏锴钺钉是什么', { topK: 5 });
  check('生造词被闸门拦下（uncovered）', nonsense.uncovered, true);
  check('生造词覆盖率为 0', nonsense.coverage, 0);

  // 反向断言：正常问题不能被误伤（否则闸门就"矫枉过正"了）
  const real = retriever.search('投标保证金什么时候退还', { topK: 5 });
  check('正常问题仍能通过闸门', real.uncovered, false);
  checkTruthy('正常问题的闸门词里不含疑问词',
    real.gateTerms.every((t) => !STOPWORDS.has(t)));
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
