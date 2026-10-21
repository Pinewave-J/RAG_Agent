'use strict';

/**
 * 对账基准生成器 —— 用**项目真实的 JS 代码**跑出一份 reference.json。
 *
 * 为什么这个文件必须存在？
 * ------------------------------------------------------------------
 * python-rag/check_parity.py 会把 Python 版的输出和 reference.json 逐位比对。
 * 但基准如果是"我照着手算出来的"，那它只能证明"我的理解和我的实现一致"，
 * 属于自说自话 —— 我把同一处误解同时写进 Python 和基准，比对就一定全绿。
 *
 * 所以基准必须由**被测对象的另一套实现**（即本项目真实的 Node 代码）产出来。
 * 两边独立实现，最后给出同一组数字，这才叫对账。
 *
 * 它用到的是真模块，不是复制品：
 *   server/chunker.js    —— 真的切分器（chunkDocument）
 *   server/store.js      —— 真的统计量构建（replaceAll + rebuildStats）
 *   server/retriever.js  —— 真的 BM25 / RRF / 闸门 / 覆盖率
 *   server/tokenizer.js  —— 真的中文 bigram 分词器
 *   server/loaders.js    —— 真的 docId 指纹算法（makeDocId）
 * 输入就是 knowledge/ 目录里那 4 份 .md。
 *
 * 用法：
 *   node python-rag/reference/gen-reference.js          # 重新生成
 *   node python-rag/reference/gen-reference.js --check  # 只校验，不写盘
 *
 * 跑完之后再执行
 *   python python-rag/check_parity.py
 * 应当 226 项全绿。
 *
 * --check 模式解决一个很实际的疑虑：基准文件躺在磁盘上，谁都可能顺手改一个
 * 数字，让对账"变绿"。所以每隔一段时间（或改了 server/ 下任何检索相关代码后）
 * 应该跑一次 --check —— 它会用当前代码重算一遍，和盘上的文件逐字节比。
 * 不一致就退出码 1，说明**基准已经不再代表真实代码**，此时的对账绿是假的。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* 环境与依赖                                                          */
/* ------------------------------------------------------------------ */

const REF_DIR = __dirname;
const ROOT = path.resolve(REF_DIR, '..', '..');
const OUT_PATH = path.join(REF_DIR, 'reference.json');
const KB_DIR = path.join(ROOT, 'knowledge');

const { config } = require(path.join(ROOT, 'server', 'config'));
const store = require(path.join(ROOT, 'server', 'store'));
const retriever = require(path.join(ROOT, 'server', 'retriever'));
const { chunkDocument } = require(path.join(ROOT, 'server', 'chunker'));
const { tokenize } = require(path.join(ROOT, 'server', 'tokenizer'));
const { makeDocId } = require(path.join(ROOT, 'server', 'loaders'));

/**
 * 基准里固定下来的查询清单。
 *
 * 顺序是有意义的：JSON 对象的键按插入顺序序列化，
 * 保持和 Python 侧读取时的顺序一致，diff 时才不会产生无意义的错位。
 */
const TOKEN_SAMPLE_QUERIES = [
  '总监理工程师应履行哪些职责',            // 主体：标题里有、正文里没有的那个动词「履行」
  '投标保证金什么时候退还',                // 疑问词「什么时候」会在双字轮溜进 token 列表
  '如何申请营业执照',                      // bigram 的跨词噪声：「何申」「请营」「业执」
  '锟鹏锴钺钉是什么',                      // 生造词，应当被闸门拦下
  '监理投标文件由哪几部分组成',
  'GBT50319 与 GB/T 50319-2013 的关系',    // 拉丁字母 + 数字 + 斜杠，分词器另一条分支
  '这个保证金要多少钱'
];

/** 需要固化完整检索结果的查询（模式 / 覆盖率 / 闸门词 / top5） */
const SEARCH_QUERIES = [
  '总监理工程师应履行哪些职责',
  '投标保证金什么时候退还',
  '监理投标文件由哪几部分组成',
  '如何申请营业执照',
  '锟鹏锴钺钉是什么',
  '专业监理工程师应履行哪些职责'
];

/** 标题词频权重的扫描点（见下面 buildWeightSweep 的说明） */
const SWEEP_WEIGHTS = [0, 0.25, 0.5, 1];

/* ------------------------------------------------------------------ */
/* ① 语料：切分                                                        */
/* ------------------------------------------------------------------ */

/**
 * 读 knowledge/ 下的 .md，用真实 chunker 切分。
 *
 * 这里有三个细节必须和 Python 侧完全对齐，否则后面全崩：
 *
 * 1) 文件必须用 utf8 原样读，**不能做换行归一**。
 *    Node 的 fs.readFileSync(p, 'utf8') 天然保留 \r\n；
 *    而 Python 文本模式默认开启「通用换行」，会把 \r\n 改成 \n。
 *    我们这份 03 号资料里有 1327 处 \r\n，不关掉转换的话字符数会从
 *    29388 变成 28061，docId 也跟着变。Python 侧靠 newline='' 解决。
 *
 * 2) docId = sha1(原始文件名小写 + '\x00' + 全文) 前 16 位。
 *    中间那个 \x00 是分隔符：没有它，"ab" + "c" 和 "a" + "bc" 会撞同一个 ID。
 *
 * 3) checksum 是对所有片段正文用 '\x01' 连接后再 sha1 前 16 位。
 *    它比"片段数 + 各片长度"更强：长度对得上但内容错位的情况也能抓到。
 */
function buildCorpus() {
  const files = fs.readdirSync(KB_DIR).filter((f) => f.endsWith('.md')).sort();
  const chunks = [];
  const docs = [];
  const chunking = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(KB_DIR, file), 'utf8');
    const docTitle = file.replace(/\.md$/, '');
    const docId = makeDocId(file, raw);

    const parts = chunkDocument({ docId, docTitle, text: raw });

    for (const p of parts) {
      chunks.push({
        id: `${docId}#${p.ordinal}`,
        docId,
        docTitle,
        source: docTitle,
        section: p.section,
        ordinal: p.ordinal,
        text: p.text,
        charCount: p.charCount
      });
    }

    docs.push({ id: docId, title: docTitle, source: docTitle, file, chars: raw.length });

    const checksum = crypto
      .createHash('sha1')
      .update(parts.map((p) => p.text).join('\u0001'))
      .digest('hex')
      .slice(0, 16);

    chunking.push({
      file,
      docId,
      chars: raw.length,
      chunks: parts.length,
      lens: parts.map((p) => p.charCount),
      sections: parts.map((p) => p.section),
      checksum,
      // 前 3 段正文。片段数对得上但"切歪了"的情况，靠它一眼看出来。
      firstTexts: parts.slice(0, 3).map((p) => p.text)
    });
  }

  return { files, docs, chunks, chunking };
}

/** 把语料灌进真实的 store，并重建 BM25 统计量 */
function installCorpus(docs, chunks, sectionTfWeight) {
  store.replaceAll(docs, chunks);
  store.rebuildStats(
    sectionTfWeight === undefined ? {} : { sectionTfWeight }
  );
}

/* ------------------------------------------------------------------ */
/* ② 分词样本                                                          */
/* ------------------------------------------------------------------ */

function buildTokenSamples() {
  return TOKEN_SAMPLE_QUERIES.map((q) => ({ q, tokens: tokenize(q) }));
}

/* ------------------------------------------------------------------ */
/* ③ 检索结果                                                          */
/* ------------------------------------------------------------------ */

/**
 * 固化每个查询的完整检索结论。
 *
 * 注意 `top` 里存的是**舍入后**的值（bm25 / score / coverage 都是 4 位小数），
 * 因为 `search()` 返回值里就是这么舍的。但闸门词和 top 索引必须逐个精确相同 ——
 * 它们才是"排序有没有错位"的证据；分数只做容差比对，用来发现公式抄错。
 */
function buildSearches() {
  const out = {};

  for (const query of SEARCH_QUERIES) {
    const r = retriever.search(query, {
      topK: config.retrieval.topK,
      candidates: config.retrieval.candidates
    });

    out[query] = {
      mode: r.mode,
      uncovered: r.uncovered,
      coverage: r.coverage,
      threshold: r.threshold,
      gateTerms: r.gateTerms,
      // search() 内部的 queryTerms 是去重后的，这里照样去重
      queryTerms: Array.from(new Set(tokenize(query))),
      stats: r.stats,
      top: r.results.map((item, i) => ({
        rank: i + 1,
        index: item.index,
        section: item.section,
        bm25: item.bm25,
        score: item.score,
        coverage: item.coverage
      }))
    };
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* ④ 标题权重扫描                                                      */
/* ------------------------------------------------------------------ */

/**
 * 这是整份基准里最有价值的一块。
 *
 * store.js 里 SECTION_TF_WEIGHT = 0.5 这个数字，注释写了 20 行来辩护：
 * "0.5 而非 1.0 是因为标题是标注不是内容""0.5 足以把 3.2.1 送进 topK"。
 * 但注释是**主张**，不是**证据**。要检验它，只能真把权重换掉重跑一遍。
 *
 * 所以我们依次用 0 / 0.25 / 0.5 / 1.0 重建统计量，记录：
 *   · 3.2.1 的两个片段（主片段 611 字 / 短尾巴 21 字）各自排到第几名
 *   · 对照组 3.2.3（正文里恰好含"总监理工程师"和"履行"的那个）排第几名
 *   · top5 里到底是谁
 *
 * 结论（见 tutorial 第 05 章）：
 *   w=0    → 主片段第 16 名、短片段第 77 名；top5 被 3.2.3 和一堆泛泛相关的片段占满
 *   w=0.25 → 主片段第 8 名、短片段第 16 名
 *   w=0.5  → 主片段第 7 名、**短片段第 5 名**（挤进 top5 的是那个 21 字的短尾巴）
 *   w=1.0  → 主片段第 5 名、短片段第 3 名
 *
 * 也就是说：0.5 站在"刚好够用"的边界上，而且它救回来的是短片段而非主片段。
 * 这件事光看代码注释是绝对看不出来的，必须扫出来。
 */
function buildWeightSweep(docs, chunks, query) {
  const sweep = [];

  for (const weight of SWEEP_WEIGHTS) {
    installCorpus(docs, chunks, weight);

    const tokens = tokenize(query);
    const queryTerms = Array.from(new Set(tokens));

    // limit 开到远超片段总数，才能看到第 16 名 / 第 77 名这类"落榜生"。
    // 只取 topK 的话，看到的永远只是赢家，无法解释"为什么输"。
    const ranked = retriever.searchBM25(tokens, 10 ** 6);
    const rankOf = new Map();
    const scoreOf = new Map();
    ranked.forEach((item, i) => {
      rankOf.set(item.index, i + 1);
      scoreOf.set(item.index, item.score);
    });

    const gateTerms = retriever.selectGateTerms(queryTerms);

    // 3.2.1 与 3.2.3 的片段索引按语料顺序固定，这里直接钉住
    const OF_321 = [39, 40];
    const OF_323 = [41];

    const describe = (index) => ({
      index,
      rank: rankOf.get(index) || 0,
      score: scoreOf.get(index) || 0,
      coverage: retriever.coverageOf(gateTerms, index)
    });

    sweep.push({
      weight,
      // 拿到非零分数的片段数：体现"标题词被并入后，有多少片段被激活了"
      candidates: ranked.length,
      avgdl: store.state.avgdl,
      gateTerms: gateTerms.length,
      of321: OF_321.map(describe),
      of323: OF_323.map(describe),
      top5: ranked.slice(0, 5).map((item, i) => ({
        rank: i + 1,
        index: item.index,
        section: store.state.chunks[item.index].section,
        score: item.score,
        coverage: retriever.coverageOf(gateTerms, item.index)
      }))
    });
  }

  // 扫描会改动全局统计量，收尾时恢复成默认权重，
  // 免得后续步骤（或调用方）拿到一个 w=1.0 的索引还以为是真的。
  installCorpus(docs, chunks);
  return sweep;
}

/* ------------------------------------------------------------------ */
/* ⑤ 人造夹具                                                          */
/* ------------------------------------------------------------------ */

/**
 * RRF 融合的纯函数夹具。
 *
 * 为什么不直接拿真实检索结果比对？因为真实结果里 BM25 分数和 RRF 是耦合的，
 * 一旦对不上，你分不清是"RRF 抄错了"还是"BM25 抄错了"。
 * 用"人造排名"去撞 fuseRRF，变量只剩一个，故障定位立刻变得简单。
 *
 * 三组场景各自针对一类错误：
 *   两路一致 —— 最平凡的情况，验证 1/(k+rank+1) 和归一化分母。
 *              注意 score 最大值被归一化成 1，容易误以为是"分数本来就是 1"。
 *   两路分歧 —— 同一片段在两路里名次不同（1/4 与 4/1），
 *              验证是"两路相加"而不是"取最好的一路"。
 *   单路独有 —— 某个片段只出现在一路里，验证它不会被丢弃，
 *              也验证归一化分母用的是"列表条数"(2) 而不是"出现过的片段数"。
 */
function buildRrfFixtures() {
  const cases = [
    { name: '两路一致', lists: [[0, 1, 2, 3], [0, 1, 2, 3]] },
    { name: '两路分歧', lists: [[0, 1, 2, 3], [3, 2, 1, 0]] },
    { name: '单路独有', lists: [[0, 1, 2], [7, 8]] }
  ];
  const k = config.retrieval.rrfK;

  return cases.map((c) => {
    // fuseRRF 吃的是 [{index, score}]，这里人造数据只需要 index
    const fused = retriever.fuseRRF(c.lists.map((lst) => lst.map((index) => ({ index }))), k);
    return {
      name: c.name,
      k,
      lists: c.lists,
      result: fused.map((item) => ({
        index: item.index,
        rrf: item.rrf,
        ranks: item.ranks,
        score: item.score
      }))
    };
  });
}

/**
 * 余弦相似度夹具，重点是那个**零向量**。
 *
 * 零向量的模是 0，公式里要做分母 —— 直接除会得到 NaN 或抛异常。
 * 正确做法是返回 null（"这个片段没有可比较的方向"），而不是 0。
 * 区别在于：0 意味着"方向完全垂直，有可比但不相关"，
 * null 意味着"根本没有方向"。前端展示和阈值判断都会因此不同。
 *
 * 另外 [0.5,0,0.25,0] 与查询同向（模长不同），结果应当是 1 而不是 0.5 ——
 * 余弦只关心方向。这一条专门用来抓"忘了除以模长"。
 */
function buildCosineFixtures() {
  const query = [1, 0, 0.5, 0];
  const vecs = [
    [1, 0, 0.5, 0],       // 与查询同向同长        -> 1
    [0, 1, 0, 0],         // 完全正交              -> 0
    [0.5, 0, 0.25, 0],    // 同向、长度只有一半    -> 仍是 1
    [0, 0, 0, 0],         // 零向量，没有方向      -> null
    [0.2, 0.2, 0.1, 0.9]  // 一个普通的不相似向量
  ];

  const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

  return {
    query,
    docs: vecs.map((vec) => {
      const na = norm(vec);
      const nb = norm(query);
      let cosine = null;
      if (na !== 0 && nb !== 0) {
        const dot = vec.reduce((s, x, i) => s + x * query[i], 0);
        cosine = Number((dot / (na * nb)).toFixed(10));
      }
      return { vec, cosine };
    })
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  const { files, docs, chunks, chunking } = buildCorpus();

  installCorpus(docs, chunks);

  const reference = {
    meta: {
      generatedFrom: `knowledge/ ${files.length} 份 .md，调用项目真实 chunker + store.rebuildStats`,
      chunkSize: config.retrieval.chunkSize,
      chunkOverlap: config.retrieval.chunkOverlap,
      topK: config.retrieval.topK,
      candidates: config.retrieval.candidates,
      minCoverage: config.retrieval.minCoverage,
      rrfK: config.retrieval.rrfK,
      chunks: chunks.length,
      avgdl: store.state.avgdl,
      vocabulary: store.state.df.size
    },
    chunking,
    tokenSamples: buildTokenSamples(),
    searches: buildSearches(),
    weightSweep: buildWeightSweep(docs, chunks, TOKEN_SAMPLE_QUERIES[0]),
    fixtures: {
      rrf: buildRrfFixtures(),
      cosine: buildCosineFixtures()
    }
  };

  // indent=1：与既有文件的格式保持一致（Python 侧 json.dump 的 indent=1 同款），
  // 这样重新生成后 git diff 里只会出现真正的数值差异，而不是满屏缩进变化。
  const json = JSON.stringify(reference, null, 1);
  const rel = path.relative(ROOT, OUT_PATH);

  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error('❌ 找不到 ' + rel + '，无法比对');
      process.exit(1);
    }
    if (fs.readFileSync(OUT_PATH, 'utf8') === json) {
      console.log('✅ ' + rel + ' 与当前真实代码逐字节一致（' + Buffer.byteLength(json, 'utf8') + ' 字节）');
      process.exit(0);
    }
    console.error('❌ ' + rel + ' 与当前真实代码不一致。');
    console.error('');
    console.error('   可能的原因有两个，危害完全不同，先分清再动手：');
    console.error('   1) 项目检索相关的代码被改过了 —— 这是**要紧事**。');
    console.error('      基准一旦过时，check_parity.py 就是在拿旧标尺量新东西，');
    console.error('      它报的红可能是真 bug，也可能是基准本身错了。');
    console.error('      这种情况下应当重新生成基准，并检查那些变化的数字是否合理。');
    console.error('   2) 基准文件被人手工改过 —— 这是**更坏的事**。');
    console.error('      手改基准去迁就错误的实现，对账就成了自我欺骗。');
    console.error('      这种情况必须先查清是谁改的、为什么改。');
    console.error('');
    console.error('   不带参数重新执行本脚本会覆盖 ' + rel + '。');
    process.exit(1);
  }

  fs.writeFileSync(OUT_PATH, json, 'utf8');

  console.log('已生成 ' + rel);
  console.log('');
  console.log('  语料          : ' + files.length + ' 份文档 -> ' + chunks.length + ' 个片段');
  console.log('  avgdl         : ' + store.state.avgdl);
  console.log('  词表规模      : ' + store.state.df.size);
  console.log('  分词样本      : ' + reference.tokenSamples.length + ' 条');
  console.log('  检索固化      : ' + Object.keys(reference.searches).length + ' 个查询');
  console.log('  权重扫描      : ' + reference.weightSweep.length + ' 档（'
    + SWEEP_WEIGHTS.join(' / ') + '）');
  console.log('  RRF 夹具      : ' + reference.fixtures.rrf.length + ' 组');
  console.log('  余弦夹具      : ' + reference.fixtures.cosine.docs.length + ' 条');
  console.log('');
  console.log('下一步：python python-rag/check_parity.py');
}

main();
