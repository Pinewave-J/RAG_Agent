'use strict';

/**
 * 混合检索层。
 *
 * 关键词通道：BM25（k1=1.5, b=0.75），词条来自中文 bigram 分词器。
 * 语义通道  ：向量余弦相似度（仅在配置了 Embedding 服务时启用）。
 * 融合      ：RRF（Reciprocal Rank Fusion），对两路排名做倒数求和，
 *             无需归一化不同量纲的分数，工程上比加权求和稳健得多。
 *
 * 兜底判定：单独用一个可解释的「查询词加权覆盖率」做闸门 ——
 * 覆盖率 = 最佳片段命中的查询词 idf 之和 / 查询词 idf 总和。
 * 低于阈值即判定知识库未覆盖，直接兜底，不调用大模型（既省钱又杜绝编造）。
 */

const { config } = require('./config');
const store = require('./store');
const { tokenize, STOPWORDS } = require('./tokenizer');

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** 标准 BM25 idf，加 0.5 平滑，恒为正 */
function idf(df, N) {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

/**
 * 关键词通道检索
 * @returns {Array<{index:number, score:number}>} 按分数降序
 */
function searchBM25(tokens, limit) {
  const { chunks, chunkTf, df } = store.state;
  const N = chunks.length;
  if (N === 0) return [];

  // 查询词去重并统计查询内词频（问题里重复出现的词权重更高）
  const queryTf = new Map();
  for (const token of tokens) queryTf.set(token, (queryTf.get(token) || 0) + 1);

  const scored = [];

  for (let i = 0; i < N; i++) {
    const { tf, len } = chunkTf[i];
    let score = 0;

    for (const [token, qCount] of queryTf.entries()) {
      const f = tf[token];
      if (!f) continue;

      const dfi = df.get(token) || 0;
      const termIdf = idf(dfi, N);
      // 查询词本身的重复对数似然加权，避免问句里重复词导致过度倾斜
      const qWeight = 1 + Math.log(qCount);

      const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * len) / store.state.avgdl);
      score += termIdf * ((f * (BM25_K1 + 1)) / denom) * qWeight;
    }

    if (score > 0) scored.push({ index: i, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * 向量通道检索。
 *
 * 注意：这里**必须是同步函数**。它全程只做内存里的浮点运算，没有任何 I/O，
 * 而它的唯一调用方 search() 是同步 API（被 answer / doctor / routes/chat 同步使用）。
 * 一旦改成 async，search() 拿到的就是 Promise 而不是数组，
 * 紧接着的 vectorList.map(...) 会抛 "vectorList.map is not a function"，
 * 且只在"已生成向量"时才会触发 —— 也就是说关键词模式一直正常，
 * 一开混合检索就崩。保持同步是刻意的选择，不要改成 async。
 */
function searchVector(queryVector, limit) {
  if (!store.hasVectors()) return [];

  const { vectors } = store.state;
  const dim = store.state.vectorDim;
  const N = store.state.chunks.length;

  let queryNorm = 0;
  for (let d = 0; d < dim; d++) queryNorm += queryVector[d] * queryVector[d];
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return [];

  const scored = [];
  for (let i = 0; i < N; i++) {
    const base = i * dim;
    let dot = 0;
    let norm = 0;
    for (let d = 0; d < dim; d++) {
      const v = vectors[base + d];
      dot += v * queryVector[d];
      norm += v * v;
    }
    if (norm === 0) continue;
    const sim = dot / (Math.sqrt(norm) * queryNorm);
    scored.push({ index: i, score: sim });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * RRF 融合：score = Σ 1 / (k + rank)
 * @param {Array<Array<{index:number}>>} lists
 */
function fuseRRF(lists, k) {
  const merged = new Map();

  lists.forEach((list) => {
    list.forEach((item, rank) => {
      const entry = merged.get(item.index) || { index: item.index, rrf: 0, ranks: [] };
      entry.rrf += 1 / (k + rank + 1);
      entry.ranks.push(rank + 1);
      merged.set(item.index, entry);
    });
  });

  const maxRrf = lists.length / (k + 1);
  const out = Array.from(merged.values()).map((entry) => ({
    ...entry,
    score: maxRrf > 0 ? entry.rrf / maxRrf : 0
  }));

  out.sort((a, b) => b.rrf - a.rrf);
  return out;
}

/**
 * 挑出用于计算覆盖率的「闸门词」。
 *
 * 为什么不能直接用全部查询词：
 *   中文 bigram 分词必然产生跨词边界的噪声词（如「如何申请营业执照」里的
 *   「何申」「请营」「业执」）。这些词在语料里 df = 0，若计入覆盖率分母，
 *   会把分母稀释掉，使分数失去区分度——实测正是如此。
 *
 * 因此规则是：
 *   1) 只用长度 >= 2 的词（单字噪声太大，且几乎没有区分力）；
 *   2) 只用语料中真实存在的词（df > 0）；
 *   3) 排除出现在每个片段里的词（df >= N），它们只会把所有人的分数拉平；
 *   4) 若一条都不剩，说明查询里的多字词知识库一个都不认识 —— 这就是
 *      "未覆盖"最强有力的信号，覆盖率按 0 处理。
 */
function selectGateTerms(queryTerms) {
  const { df, chunks } = store.state;
  const N = chunks.length;

  return queryTerms.filter((term) => {
    if (term.length < 2) return false;
    // 停用词必须在这里再滤一次。
    //
    // 坑：tokenize() 对中文段是"先单字、后相邻双字"两轮输出，
    // 双字轮**不查停用词表**，因此「什么」「怎么」「哪些」这类疑问词
    // 会以双字形态出现在 queryTerms 里（单字形态已被停用词表挡掉）。
    // 它们又恰好广泛存在于语料中 -> 轻易满足 df>0 且 df<N -> 全部通过筛选。
    //
    // 后果非常严重：一句"XX是什么"的闸门词会退化成只剩「什么」，
    // 而任何片段都能命中它，覆盖率恒为 1.0 —— 闸门等于失效，
    // 连"知识库里完全没有这个词"的问题都拦不住了。
    if (STOPWORDS.has(term)) return false;
    const freq = df.get(term) || 0;
    if (freq <= 0) return false;
    if (N > 1 && freq >= N) return false;
    return true;
  });
}

/**
 * 查询词加权覆盖率：衡量某个片段对问题的覆盖程度，取值 0~1。
 * 用 idf 加权，让「监理」「保证金」这类特征词比「项目」「工作」这类泛词更重要。
 *
 * 注意：这里直接复用 chunkTf —— 它**已包含按低权重并入的 section 词频**
 * （见 store.js 的 SECTION_TF_WEIGHT）。这是刻意的：
 * 闸门的功能是判断"这个片段到底有没有在讲用户问的事"，
 * 而标题恰恰是最能说明"这段在讲什么"的一句话。
 * 若覆盖率仍只看正文，就会出现"打分认了标题、闸门却不认"的口径分裂，
 * 同一份片段在两个环节得到互相矛盾的结论。
 *
 * @param {string[]} gateTerms 由 selectGateTerms 预先筛好的词表
 */
function coverageOf(gateTerms, chunkIndex) {
  const { chunkTf, df } = store.state;
  const N = store.state.chunks.length;
  const { tf } = chunkTf[chunkIndex];

  let total = 0;
  let hit = 0;

  for (const term of gateTerms) {
    const weight = idf(df.get(term) || 0, N);
    total += weight;
    if (tf[term]) hit += weight;
  }

  return total > 0 ? hit / total : 0;
}

/**
 * 主检索入口
 * @param {string} query
 * @param {{topK?:number, candidates?:number, queryVector?:Float32Array|null}} [options]
 */
function search(query, options = {}) {
  const startedAt = Date.now();
  const topK = options.topK || config.retrieval.topK;
  const candidates = options.candidates || config.retrieval.candidates;

  const tokens = tokenize(query);
  const queryTerms = Array.from(new Set(tokens));

  const empty = {
    mode: 'empty',
    hit: false,
    uncovered: true,
    coverage: 0,
    threshold: config.retrieval.minCoverage,
    gateTerms: [],
    results: [],
    tookMs: Date.now() - startedAt,
    stats: { chunks: store.state.chunks.length, queryTerms: queryTerms.length, gateTerms: 0 }
  };

  if (store.state.chunks.length === 0) return empty;
  if (queryTerms.length === 0) {
    return { ...empty, mode: 'no-terms' };
  }

  const keywordList = searchBM25(tokens, candidates);
  const vectorList = options.queryVector ? searchVector(options.queryVector, candidates) : [];
  const hasVectorChannel = vectorList.length > 0;
  const fused = hasVectorChannel
    ? fuseRRF([keywordList, vectorList], config.retrieval.rrfK)
    : keywordList.map((item, rank) => ({ index: item.index, rrf: item.score, score: rank === 0 ? 1 : 1 / (rank + 1), ranks: [rank + 1] }));

  const gateTerms = selectGateTerms(queryTerms);

  const keywordScoreByIndex = new Map(keywordList.map((item) => [item.index, item.score]));
  const vectorScoreByIndex = new Map(vectorList.map((item) => [item.index, item.score]));

  const ranked = fused.slice(0, Math.max(topK, 8)).map((item) => {
    const chunk = store.state.chunks[item.index];
    return {
      index: item.index,
      id: chunk.id,
      docId: chunk.docId,
      docTitle: chunk.docTitle,
      source: chunk.source,
      section: chunk.section,
      text: chunk.text,
      score: Number(item.score.toFixed(4)),
      bm25: Number((keywordScoreByIndex.get(item.index) || 0).toFixed(4)),
      vectorSim: Number((vectorScoreByIndex.get(item.index) || 0).toFixed(4)),
      coverage: Number(coverageOf(gateTerms, item.index).toFixed(4))
    };
  });

  const bestCoverage = ranked.reduce((max, r) => Math.max(max, r.coverage), 0);
  const uncovered = ranked.length === 0 || gateTerms.length === 0 || bestCoverage < config.retrieval.minCoverage;

  return {
    mode: hasVectorChannel ? 'hybrid' : 'keyword',
    hit: ranked.length > 0 && !uncovered,
    uncovered,
    coverage: Number(bestCoverage.toFixed(4)),
    threshold: config.retrieval.minCoverage,
    gateTerms,
    results: ranked.slice(0, topK),
    tookMs: Date.now() - startedAt,
    stats: {
      chunks: store.state.chunks.length,
      queryTerms: queryTerms.length,
      gateTerms: gateTerms.length,
      keywordHits: keywordList.length,
      vectorHits: vectorList.length
    }
  };
}

// fuseRRF 只被 search() 内部使用，但还是导出：python-rag 的对账基准要拿
// 几组"人造排名"去撞击这个函数，单独验证 1/(k+rank+1) 与归一化分母。
// 走 complete search() 是撞不准的 —— 那里还混着 BM25 打分和闸门。
module.exports = { search, searchVector, searchBM25, coverageOf, selectGateTerms, fuseRRF, idf, BM25_K1, BM25_B };
