'use strict';

/**
 * 知识库索引存储层。
 *
 * 持久化分两部分：
 *   data/kb-index.json   —— 文档元数据 + 片段正文（人可读、可版本管理）
 *   data/kb-vectors.bin  —— 片段向量（Float32Array 二进制，按 index 顺序排列）
 *
 * 片段正文落盘时不存词频，进程启动时重新分词构建 BM25 统计量：
 * 避免 JSON 体积膨胀，且统计口径永远与分词器版本一致。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { config, ensureDirs } = require('./config');
const { tokenize, uniqueTerms, termFrequency } = require('./tokenizer');
const { chunkDocument } = require('./chunker');

const INDEX_VERSION = 3;

/**
 * 标题（section）词频的计入权重。
 *
 * 起因：片段正文里往往没有提问用的那些词，而标题里有。
 * 实测「3.2.1 总监理工程师应履行下列职责：」这个片段，正文是纯列表项
 * （"确定项目监理机构人员及其岗位职责。"），**一个"履行"字都没有**；
 * 而提问「总监理工程师应履行哪些职责」的核心动词正是"履行"。
 * 结果该片段 BM25 近乎零分，排到 20 名开外，被 3.2.3（正文里恰好含
 * "总监理工程师"和"履行"）顶掉，模型据此回答"资料未收录"。
 *
 * 修法：把 section 的分词结果按此权重并入该片段的词频。
 * 取 0.5 而非 1.0 的理由：标题是"标注"而非"内容"，不该与正文等权；
 * 实测 0.5 足以把 3.2.1 送进 topK，同时不给标题党片段过高的加成。
 */
const SECTION_TF_WEIGHT = 0.5;

/**
 * section 词频计入的 token 数上限。
 *
 * 为什么需要封顶：BM25 的公式里带长度归一化项 `b * len / avgdl`。
 * 对正文很短的片段（实测有个片段正文只有 8 个 token），
 * 若把标题的 40 来个 token 按 0.5 权重全额计入，len 会被撑到正文的数倍，
 * 长度归一化项随之被高估，反而把它的得分压下去 —— 与"帮标题说话"的初衷相反。
 *
 * 取 24 是按实测定的：真实标题「… › 3.2.1 总监理工程师应履行下列职责：」
 * 去掉文档名前缀后还剩 24 个长词，「履行」正好落在第 18 位（见下面的双字优先规则）。
 * 上限若压到 16 会把「履行」挤出去，3.2.1 立刻重新掉出 topK。
 */
const SECTION_TF_MAX_TOKENS = 24;

/**
 * 从标题的词表里挑出值得计入词频的部分：长词优先，单字垫底。
 *
 * 为什么不能直接取"前 N 个"：分词器对中文段是先输出单字、再输出相邻双字
 * （「总监理工程师」→ 总 监 理 工 程 师 总监 监理 理工 工程 程师），
 * 前 N 个几乎全是单字，而真正有区分力的「履行」要到 30 名开外，
 * 取前 N 个会把关键双字整批丢掉。
 *
 * 次级规则：按"从后往前"取。
 * section 形如「文档标题 › 章节标题」，用户的提问几乎总是复述**章节标题**，
 * 所以尾部信息量高于头部；文档名再长也不会把章节标题挤掉。
 */
function pickSectionTokens(tokens, limit) {
  const long = [];
  const single = [];
  for (const t of tokens) {
    (Array.from(t).length >= 2 ? long : single).push(t);
  }
  return long.concat(single).slice(0, limit);
}

/**
 * 去掉 section 开头的文档名，只留真正的章节路径。
 *
 * 例：`建设工程监理规范 GB/T 50319-2013 › 3.2.1 总监理工程师应履行下列职责：`
 *  →  `3.2.1 总监理工程师应履行下列职责：`
 *
 * 理由：文档名会占掉十几个 token 的配额，而且它对"这段在讲什么"毫无信息量
 * ——所有片段都带同一个文档名，反而是最没有区分度的部分。
 */
function stripDocTitlePrefix(section, docTitle) {
  let s = String(section || '');
  const t = String(docTitle || '').trim();
  if (!t) return s;
  // section 由 headingStack 用 ' › ' 连接，首段即文档名（可能带后缀）
  const idx = s.indexOf('›');
  if (idx === -1) return s;
  const head = s.slice(0, idx).trim();
  // 只在首段确实与文档名相关时才切，避免误伤"首段就是标题"的文档
  if (t && (head === t || head.startsWith(t) || t.startsWith(head))) {
    return s.slice(idx + 1).trim();
  }
  return s;
}

/** section 路径里的层级分隔符，分词前替换成空格以免粘连出噪声 bigram */
const SECTION_SEPARATOR_RE = /[›>»→/|]+/g;

const state = {
  loaded: false,
  version: INDEX_VERSION,
  updatedAt: null,
  embedModel: '',
  docs: [],
  chunks: [],
  // 派生数据（内存态）
  chunkTf: [],
  df: new Map(),
  avgdl: 1,
  vectors: null,
  vectorDim: 0
};

/* ------------------------------------------------------------------ */
/* 派生统计量                                                          */
/* ------------------------------------------------------------------ */

function rebuildStats(opts = {}) {
  // 标题权重默认就是上面的 SECTION_TF_WEIGHT，但允许调用方覆盖一次。
  //
  // 为什么留这个口子：这个常量是"实测出来的"，而实测要能被别人重跑。
  // python-rag/reference/gen-reference.js 就是靠它把权重依次设成
  // 0 / 0.25 / 0.5 / 1.0，用**同一份真实代码**扫出四组排名，
  // 从而验证「0.5 是把 3.2.1 送进 topK 的最小可用值」这句话。
  // 没有这个口子，那句注释就只能被人相信，无法被人检验。
  //
  // 所有生产调用点都是无参调用，行为与改动前完全一致。
  const sectionTfWeight = Number.isFinite(opts.sectionTfWeight)
    ? opts.sectionTfWeight
    : SECTION_TF_WEIGHT;

  state.df = new Map();
  state.chunkTf = new Array(state.chunks.length);

  let totalLen = 0;
  for (let i = 0; i < state.chunks.length; i++) {
    const chunk = state.chunks[i];
    const tokens = tokenize(chunk.text);
    const { tf, len } = termFrequency(tokens);
    let chunkLen = len || 1;

    // 标题（section 路径）按较低权重并入词频。
    // 详见 SECTION_TF_WEIGHT / pickSectionTokens / stripDocTitlePrefix 的注释。
    const sectionText = stripDocTitlePrefix(chunk.section, chunk.docTitle)
      .replace(SECTION_SEPARATOR_RE, ' ');
    const sectionTokens = sectionText
      ? pickSectionTokens(tokenize(sectionText), SECTION_TF_MAX_TOKENS)
      : [];
    for (const token of sectionTokens) {
      tf[token] = (tf[token] || 0) + sectionTfWeight;
    }
    chunkLen += sectionTokens.length * sectionTfWeight;

    state.chunkTf[i] = { tf, len: chunkLen };
    totalLen += chunkLen;

    for (const token of Object.keys(tf)) {
      state.df.set(token, (state.df.get(token) || 0) + 1);
    }
  }

  state.avgdl = state.chunks.length > 0 ? totalLen / state.chunks.length : 1;
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function loadVectors() {
  state.vectors = null;
  state.vectorDim = 0;

  if (!state.embedModel) return;

  try {
    if (!fs.existsSync(config.paths.vectorsFile)) return;
    const buffer = fs.readFileSync(config.paths.vectorsFile);
    const floats = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      Math.floor(buffer.byteLength / 4)
    );
    if (state.chunks.length > 0 && floats.length % state.chunks.length === 0) {
      state.vectorDim = floats.length / state.chunks.length;
      state.vectors = floats;
    }
  } catch (err) {
    console.warn('[store] 向量文件读取失败，已忽略并回退为关键词检索：', err.message);
    state.vectors = null;
    state.vectorDim = 0;
  }
}

function save() {
  ensureDirs();
  state.updatedAt = new Date().toISOString();
  state.version = INDEX_VERSION;

  const payload = {
    version: state.version,
    updatedAt: state.updatedAt,
    embedModel: state.embedModel,
    vectorDim: state.vectorDim,
    docs: state.docs,
    chunks: state.chunks
  };
  atomicWrite(config.paths.indexFile, JSON.stringify(payload, null, 2));

  if (state.vectors && state.vectorDim > 0) {
    const raw = Buffer.from(
      state.vectors.buffer,
      state.vectors.byteOffset,
      state.vectors.byteLength
    );
    atomicWrite(config.paths.vectorsFile, raw);
  } else if (fs.existsSync(config.paths.vectorsFile)) {
    fs.unlinkSync(config.paths.vectorsFile);
  }
}

function load() {
  ensureDirs();

  if (fs.existsSync(config.paths.indexFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(config.paths.indexFile, 'utf8'));
      state.version = parsed.version || 1;
      state.updatedAt = parsed.updatedAt || null;
      state.embedModel = parsed.embedModel || '';
      state.docs = Array.isArray(parsed.docs) ? parsed.docs : [];
      state.chunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
    } catch (err) {
      console.warn('[store] 索引文件损坏，已从空白索引重建：', err.message);
      state.docs = [];
      state.chunks = [];
      state.embedModel = '';
    }
  }

  rebuildStats();
  loadVectors();
  state.loaded = true;
  return state;
}

/* ------------------------------------------------------------------ */
/* 文档操作                                                            */
/* ------------------------------------------------------------------ */

/** 用一段纯文本替换/新增一份文档（同 docId 覆盖）。返回新增片段数。 */
function upsertDocument(meta, text) {
  const docId = meta.id;
  const maxLen = config.retrieval.chunkSize;
  const overlap = config.retrieval.chunkOverlap;

  const parts = chunkDocument({
    docId,
    docTitle: meta.title,
    text,
    maxLen,
    overlap
  });

  // 先移除旧版本
  removeDocument(docId, { persist: false });

  const now = new Date().toISOString();
  const doc = {
    id: docId,
    title: meta.title,
    source: meta.source || meta.title,
    type: meta.type || 'text',
    bytes: meta.bytes || Buffer.byteLength(text, 'utf8'),
    charCount: text.length,
    addedAt: meta.addedAt || now,
    updatedAt: now,
    chunkCount: parts.length
  };

  state.docs.push(doc);

  for (const part of parts) {
    state.chunks.push({
      id: `${docId}#${part.ordinal}`,
      docId,
      docTitle: doc.title,
      source: doc.source,
      section: part.section,
      ordinal: part.ordinal,
      text: part.text,
      charCount: part.charCount
    });
  }

  // 片段数组顺序已变化，原有向量不再与之一一对应，直接作废；
  // 由上层（indexer）在有 Embedding 能力时重新计算。
  invalidateVectors();

  return parts.length;
}

/** 作废现有向量（片段增删后必须调用） */
function invalidateVectors() {
  state.vectors = null;
  state.vectorDim = 0;
  state.embedModel = '';
}

/** 覆盖式重建整份索引 */
function replaceAll(docs, chunks) {
  state.docs = docs;
  state.chunks = chunks;
  state.vectors = null;
  state.vectorDim = 0;
}

function removeDocument(docId, opts = {}) {
  const { persist = true } = opts;
  const before = state.chunks.length;

  state.docs = state.docs.filter((d) => d.id !== docId);
  state.chunks = state.chunks.filter((c) => c.docId !== docId);

  const removedDoc = before !== state.chunks.length;

  if (removedDoc) {
    // 片段数组顺序变了，向量必须作废
    invalidateVectors();
  }

  if (persist) {
    rebuildStats();
    save();
  }
  return removedDoc;
}

function getDocument(docId) {
  return state.docs.find((d) => d.id === docId) || null;
}

/* ------------------------------------------------------------------ */
/* 向量                                                               */
/* ------------------------------------------------------------------ */

function setVectors(vectors, dim, model) {
  state.vectors = vectors;
  state.vectorDim = dim;
  state.embedModel = model || '';
}

function hasVectors() {
  return Boolean(state.vectors && state.vectorDim > 0 && state.vectors.length === state.chunks.length * state.vectorDim);
}

/* ------------------------------------------------------------------ */
/* 对外快照                                                            */
/* ------------------------------------------------------------------ */

/** 关键词摘要：从文档标题与高频词中提取，用于兜底话术里"知识库覆盖范围"的展示 */
function topKeywords(limit = 12) {
  const counter = new Map();
  for (const doc of state.docs) {
    for (const term of uniqueTerms(doc.title)) {
      // 只保留长度 >= 2 的整词，避免单字噪声
      if (term.length < 2) continue;
      counter.set(term, (counter.get(term) || 0) + 2);
    }
  }
  for (const [token, df] of state.df.entries()) {
    if (token.length < 2) continue;
    counter.set(token, (counter.get(token) || 0) + df);
  }
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

function stats() {
  const totalChars = state.chunks.reduce((sum, c) => sum + (c.charCount || 0), 0);
  return {
    documents: state.docs.length,
    chunks: state.chunks.length,
    characters: totalChars,
    vocabulary: state.df.size,
    avgChunkLength: Math.round(state.avgdl),
    vectorEnabled: hasVectors(),
    embedModel: state.embedModel || null,
    updatedAt: state.updatedAt,
    indexVersion: state.version
  };
}

function listDocuments() {
  return state.docs
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

module.exports = {
  state,
  load,
  save,
  rebuildStats,
  upsertDocument,
  removeDocument,
  getDocument,
  replaceAll,
  invalidateVectors,
  setVectors,
  hasVectors,
  stats,
  listDocuments,
  topKeywords,
  atomicWrite,
  newDocId: () => crypto.randomBytes(8).toString('hex')
};
