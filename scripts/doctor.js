#!/usr/bin/env node
'use strict';

/**
 * 自检脚本：正式对外之前跑一遍。
 *
 *   npm run doctor            # 检查配置、索引、检索闸门、模型连通性
 *   npm run doctor -- --full  # 额外跑一遍端到端问答（会真实调用大模型，消耗额度）
 *
 * 关于「检索闸门」的能力边界，检查结果里会区分两类用例：
 *   · answer 类 —— 知识库确实能回答的问题，**必须**通过闸门，否则会误伤；
 *   · refuse 类 —— 知识库答不了的问题，理想情况被闸门拦下；
 *                 若闸门放行（因为问题里恰好含有资料中出现过的词），
 *                 则由第二层（模型依据严格提示词返回拒答标记）兜住。
 * 词面检索无法区分"资料里出现过这个词"与"资料解释了这件事"，
 * 因此 refuse 类出现 ⚠ 是预期行为，不代表系统会编造答案。
 */

const { config, ensureDirs, diagnose } = require('../server/config');
const store = require('../server/store');
const indexer = require('../server/indexer');
const retriever = require('../server/retriever');
const llm = require('../server/llm');
const answer = require('../server/answer');

/** 知识库确实能回答的问题 —— 必须通过闸门 */
const ANSWER_CASES = [
  '监理投标文件由哪几部分组成',
  '技术标的编制要注意什么',
  '投标保证金的上限是多少',
  '投标保证金什么时候退还',
  '什么样的情形会导致废标',
  '串通投标怎么认定'
];

/** 知识库答不了的问题 —— 期望被拦下或由模型拒答 */
const REFUSE_CASES = [
  '今天上海的天气怎么样',
  '如何申请营业执照',
  '红烧肉怎么做才好吃',
  '推荐几支值得买的股票'
];

const line = (char = '─', n = 66) => char.repeat(n);

async function main() {
  ensureDirs();
  const full = process.argv.includes('--full');

  console.log(line('='));
  console.log(' 知识问答 Agent —— 环境自检');
  console.log(line('='));

  /* ---------- 1. 配置 ---------- */
  console.log('\n[1/5] 配置检查');
  const diag = diagnose();

  console.log(`  对话模型  ：${config.llm.model} @ ${config.llm.baseUrl}`);
  console.log(`  密钥状态  ：${diag.llmConfigured ? '已配置' : '未配置 ✗'}`);
  console.log(`  检索模式  ：${diag.vectorEnabled ? `混合检索（${config.embed.model}）` : '关键词检索（BM25）'}`);
  console.log(`  管理鉴权  ：${diag.adminProtected ? '已开启' : '未开启'}`);
  console.log(`  兜底阈值  ：覆盖率 < ${config.retrieval.minCoverage}`);
  console.log(`  端口      ：${config.server.port}`);

  for (const issue of diag.issues) console.log(`  [警告] ${issue}`);
  for (const note of diag.notes) console.log(`  [提示] ${note}`);

  /* ---------- 2. 索引 ---------- */
  console.log('\n[2/5] 索引检查');
  await indexer.bootstrapIfEmpty();
  const stats = store.stats();

  console.log(`  资料数    ：${stats.documents}`);
  console.log(`  片段数    ：${stats.chunks}`);
  console.log(`  总字数    ：${stats.characters}`);
  console.log(`  词表规模  ：${stats.vocabulary}`);
  console.log(`  平均片段长：${stats.avgChunkLength} 字`);
  console.log(`  向量      ：${stats.vectorEnabled ? `已生成（${stats.embedModel}）` : '未生成'}`);

  if (stats.chunks === 0) {
    console.log('  [提示] 知识库为空，请先导入资料（页面「知识库管理」或 npm run reindex）。');
  }

  /* ---------- 3. 检索闸门 ---------- */
  console.log('\n[3/5] 检索闸门验证（第一层）');

  let answerPass = 0;
  let refusedByGate = 0;
  let deferred = 0;

  if (stats.chunks === 0) {
    console.log('  跳过：知识库为空。');
  } else {
    console.log(`  ── answer 类（必须命中） ──`);
    for (const q of ANSWER_CASES) {
      const r = retriever.search(q);
      const ok = !r.uncovered;
      if (ok) answerPass++;
      const top = r.results[0];
      console.log(`  ${ok ? '✓' : '✗'} ${q}`);
      console.log(`      覆盖率 ${(r.coverage * 100).toFixed(0)}%` +
        ` | 闸门词 ${r.stats.gateTerms} 个` +
        (top ? ` | 命中《${top.docTitle}》:${top.section}（bm25 ${top.bm25}）` : ''));
    }

    console.log(`  ── refuse 类（应拦截，或交由模型层判定） ──`);
    for (const q of REFUSE_CASES) {
      const r = retriever.search(q);
      if (r.uncovered) {
        refusedByGate++;
        console.log(`  ✓ ${q}`);
        console.log(`      闸门拦截 | 覆盖率 ${(r.coverage * 100).toFixed(0)}% | 闸门词 ${r.stats.gateTerms} 个`);
      } else {
        deferred++;
        const top = r.results[0];
        console.log(`  ⚠ ${q}`);
        console.log(`      闸门放行（覆盖率 ${(r.coverage * 100).toFixed(0)}%，命中词为资料中出现过的词）`);
        console.log(`      → 交由第二层：模型阅读《${top ? top.docTitle : ''}》后应返回拒答标记`);
      }
    }

    console.log(`  ${line('-', 44)}`);
    console.log(`  answer 类通过：${answerPass}/${ANSWER_CASES.length}（关键指标，低于满分会误伤可答问题）`);
    console.log(`  refuse 类：闸门拦截 ${refusedByGate} 条，交第二层 ${deferred} 条`);
  }

  /* ---------- 4. 模型连通性 ---------- */
  console.log('\n[4/5] 模型连通性');
  if (!diag.llmConfigured) {
    console.log('  跳过：未配置 LLM_API_KEY。');
  } else {
    try {
      const startedAt = Date.now();
      const reply = await llm.chatComplete({
        messages: [{ role: 'user', content: '请只回复两个字：正常' }],
        maxTokens: 16,
        temperature: 0
      });
      console.log(`  ✓ 调用成功（${Date.now() - startedAt} ms）：${String(reply).trim().slice(0, 40)}`);
    } catch (err) {
      console.log(`  ✗ 调用失败：${err.message}`);
    }
  }

  /* ---------- 5. 端到端（可选） ---------- */
  console.log('\n[5/5] 端到端问答验证');
  if (!full) {
    console.log('  跳过：加 --full 参数可实测（会真实调用大模型）。');
    console.log('  用法：npm run doctor -- --full');
  } else if (!diag.llmConfigured) {
    console.log('  跳过：未配置 LLM_API_KEY。');
  } else if (stats.chunks === 0) {
    console.log('  跳过：知识库为空。');
  } else {
    let ok = 0;
    let total = 0;

    for (const q of ANSWER_CASES) {
      total++;
      const r = await answer.answerOnce(q);
      const good = r.ok && r.answered;
      if (good) ok++;
      console.log(`  ${good ? '✓' : '✗'} [应作答] ${q}`);
      console.log(`      ${r.ok ? (r.answered ? `已作答，引用 ${r.citations.length} 条来源` : '返回了兜底') : `错误：${r.error}`}`);
      if (good) console.log(`      首句：${String(r.answer).split('\n')[0].slice(0, 60)}`);
    }

    console.log('');
    for (const q of REFUSE_CASES) {
      total++;
      const r = await answer.answerOnce(q);
      const good = r.ok && !r.answered;
      if (good) ok++;
      console.log(`  ${good ? '✓' : '✗'} [应拒答] ${q}`);
      console.log(`      ${r.ok ? (r.answered ? '⚠ 给出了基于资料的作答（请人工确认是否属编造）' : '已明确拒答') : `错误：${r.error}`}`);
      if (good) console.log(`      回复：${String(r.answer).split('\n')[0].slice(0, 60)}`);
    }

    console.log(`  ${line('-', 44)}`);
    console.log(`  端到端通过：${ok}/${total}`);
  }

  if (diag.vectorEnabled && stats.chunks > 0 && !stats.vectorEnabled) {
    console.log('\n[可选] 已配置向量模型但尚未生成向量，执行：npm run reindex');
  }

  console.log('\n' + line('='));
  console.log(' 自检结束');
  console.log(line('=') + '\n');
}

main().catch((err) => {
  console.error('自检异常：', err);
  process.exit(1);
});
