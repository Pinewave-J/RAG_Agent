'use strict';
/**
 * 用真实索引（含向量）+ 真实 embedding 服务，验证混合检索全链路。
 * 复刻 answer.js 的调用序列，确认不再抛 vectorList.map is not a function。
 */
const { config } = require('../server/config');
const store = require('../server/store');
const retriever = require('../server/retriever');
const llm = require('../server/llm');

(async () => {
  console.log('向量配置 enabled :', llm.isEmbedConfigured());
  console.log('EMBED_BASE_URL   :', config.embed.baseUrl);
  console.log('EMBED_MODEL      :', config.embed.model);
  console.log('');

  store.load();
  console.log('索引 :', store.state.chunks.length, '片段');
  console.log('向量 :', store.hasVectors(), '| 维度', store.state.vectorDim);
  console.log('');

  const cases = [
    '投标保证金什么时候退还',
    '监理投标文件由哪几部分组成',
    '技术标的编制要注意什么',
    '今天上海的天气怎么样'
  ];

  let hybridCount = 0;
  for (const q of cases) {
    // 完全复刻 answer.js 的序列
    let queryVector = null;
    if (llm.isEmbedConfigured() && store.hasVectors()) {
      const { vectors, dim } = await llm.embedTexts([q]);
      if (vectors[0] && dim === store.state.vectorDim) queryVector = vectors[0];
    }

    const r = retriever.search(q, { queryVector });
    if (r.mode === 'hybrid') hybridCount++;

    const top = r.results[0];
    console.log(`Q: ${q}`);
    console.log(`   mode=${r.mode} | uncovered=${r.uncovered} | coverage=${r.coverage} | 命中=${r.results.length} | vectorHits=${r.stats.vectorHits}`);
    if (top) {
      console.log(`   首选: 《${top.docTitle}》 › ${top.section}`);
      console.log(`   bm25=${top.bm25} vectorSim=${top.vectorSim}`);
    }
  }

  console.log('');
  console.log(`混合模式生效的查询：${hybridCount}/${cases.length}`);
  if (hybridCount === 0) {
    console.log('⚠ 没有一条走混合模式 —— 说明 queryVector 未生效，检查 embedding 服务。');
    process.exit(1);
  } else {
    console.log('✅ 混合检索链路正常，未出现 vectorList.map 异常。');
  }
})().catch((e) => {
  console.error('!! 失败:', e.message);
  process.exit(1);
});
