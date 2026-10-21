'use strict';

/**
 * 索引入库编排层。
 *
 * 职责：
 *   1. 扫描 knowledge/（种子资料）与 data/uploads/（用户上传）两个目录
 *   2. 解析 -> 切分 -> 写入索引
 *   3. 若配置了向量模型，则为片段补齐向量；未配置则跳过（自动降级为纯关键词检索）
 */

const fs = require('fs');
const path = require('path');

const { config, ensureDirs } = require('./config');
const store = require('./store');
const loaders = require('./loaders');
const llm = require('./llm');
const guard = require('./ingest-guard');

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'untitled'));
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'untitled';
}

/** 递归列出目录下受支持的文件 */
function scanDirectory(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && loaders.isSupported(entry.name)) {
        results.push(full);
      }
    }
  };

  walk(dir);
  return results;
}

/** 从磁盘文件构建文档记录并写入索引 */
async function ingestFile(filePath, { source = 'file' } = {}) {
  const originalName = path.basename(filePath);
  const text = await loaders.extractFromFile(filePath);
  if (!text || !text.trim()) {
    return { ok: false, file: originalName, reason: '未能从文件中提取到文本内容（可能是扫描件或空文件）' };
  }

  // 体检：抓到的如果只是页眉/水印，宁可入库失败，也不要污染知识库
  const check = guard.inspectExtractedText(text);
  if (check.scanned) {
    return { ok: false, file: originalName, reason: `未提取到有效正文：${check.reason}`, suggestion: check.suggestion };
  }

  const title = loaders.inferTitle(text, originalName.replace(/\.[^.]+$/, ''));
  const docId = loaders.makeDocId(originalName, text);

  const chunkCount = store.upsertDocument(
    {
      id: docId,
      title,
      source: originalName,
      type: loaders.extOf(originalName).replace('.', '') || 'text',
      bytes: fs.statSync(filePath).size
    },
    text
  );

  return { ok: true, docId, title, source: originalName, chunks: chunkCount, chars: text.length, origin: source };
}

/* ------------------------------------------------------------------ */
/* 向量化                                                             */
/* ------------------------------------------------------------------ */

/**
 * 为索引中所有片段计算向量。未配置向量模型时返回 skipped。
 * @param {(done:number,total:number)=>void} [onProgress]
 */
async function buildVectors(onProgress) {
  if (!llm.isEmbedConfigured()) {
    return { ok: false, skipped: true, reason: '未配置向量模型，已跳过向量化（检索退化为关键词模式）' };
  }

  const chunks = store.state.chunks;
  if (chunks.length === 0) {
    store.setVectors(null, 0, '');
    return { ok: true, embedded: 0, dim: 0 };
  }

  const batchSize = Math.max(1, config.embed.batchSize);
  const perRequest = Math.max(batchSize, 32); // 一次交给 embedTexts 的数量，内部仍会按 batchSize 分包
  const buffers = [];
  let dim = 0;
  let model = config.embed.model;

  for (let start = 0; start < chunks.length; start += perRequest) {
    const slice = chunks.slice(start, start + perRequest);
    const { vectors, dim: d, model: m } = await llm.embedTexts(slice.map((c) => c.text));
    if (!dim) dim = d;
    model = m || model;
    for (const vec of vectors) buffers.push(vec);
    if (typeof onProgress === 'function') {
      onProgress(Math.min(start + slice.length, chunks.length), chunks.length);
    }
  }

  if (buffers.length !== chunks.length) {
    throw new Error(`向量数量与片段数量不一致：${buffers.length} vs ${chunks.length}`);
  }

  const flat = new Float32Array(chunks.length * dim);
  for (let i = 0; i < buffers.length; i++) {
    flat.set(buffers[i].subarray(0, dim), i * dim);
  }

  store.setVectors(flat, dim, model);
  return { ok: true, embedded: chunks.length, dim, model };
}

/* ------------------------------------------------------------------ */
/* 对外操作                                                           */
/* ------------------------------------------------------------------ */

/**
 * 全量重建索引：以磁盘上的文件为准，丢弃内存中所有内容。
 * @param {{withVectors?: boolean, onProgress?: Function}} [opts]
 */
async function reindexAll(opts = {}) {
  const { withVectors = true, onProgress } = opts;
  ensureDirs();

  const files = [
    ...scanDirectory(config.paths.kb).map((f) => ({ file: f, source: 'seed' })),
    ...scanDirectory(config.paths.uploads).map((f) => ({ file: f, source: 'upload' }))
  ];

  const docs = [];
  const chunks = [];
  const failures = [];
  const skipped = [];

  for (const item of files) {
    try {
      const originalName = path.basename(item.file);
      const text = await loaders.extractFromFile(item.file);
      if (!text || !text.trim()) {
        failures.push({ file: originalName, reason: '未提取到文本' });
        continue;
      }

      // 扫描件/页眉噪声：跳过而不是入库，避免把噪声切成一堆重复片段
      const check = guard.inspectExtractedText(text);
      if (check.scanned) {
        skipped.push({ file: originalName, reason: check.reason, suggestion: check.suggestion });
        continue;
      }

      const title = loaders.inferTitle(text, originalName.replace(/\.[^.]+$/, ''));
      const docId = loaders.makeDocId(originalName, text);

      const { chunkDocument } = require('./chunker');
      const parts = chunkDocument({ docId, docTitle: title, text });

      const now = new Date().toISOString();
      docs.push({
        id: docId,
        title,
        source: originalName,
        type: loaders.extOf(originalName).replace('.', '') || 'text',
        origin: item.source,
        bytes: fs.statSync(item.file).size,
        charCount: text.length,
        addedAt: now,
        updatedAt: now,
        chunkCount: parts.length
      });

      for (const part of parts) {
        chunks.push({
          id: `${docId}#${part.ordinal}`,
          docId,
          docTitle: title,
          source: originalName,
          section: part.section,
          ordinal: part.ordinal,
          text: part.text,
          charCount: part.charCount
        });
      }
    } catch (err) {
      failures.push({ file: path.basename(item.file), reason: err.message });
    }
  }

  store.replaceAll(docs, chunks);
  store.rebuildStats();

  let vector = { ok: false, skipped: true, reason: '未启用' };
  if (withVectors && llm.isEmbedConfigured() && chunks.length > 0) {
    try {
      vector = await buildVectors(onProgress);
    } catch (err) {
      vector = { ok: false, error: err.message };
      console.warn('[indexer] 向量化失败，已降级为关键词检索：', err.message);
    }
  }

  store.save();

  return {
    documents: docs.length,
    chunks: chunks.length,
    failures,
    skipped,
    vector,
    stats: store.stats()
  };
}

/** 上传文件入库（先落盘再解析，便于事后重建索引） */
async function ingestUpload(buffer, originalName, { title } = {}) {
  ensureDirs();

  const safeName = sanitizeFilename(originalName);
  if (!loaders.isSupported(safeName)) {
    const supported = Array.from(loaders.SUPPORTED_EXT).join(', ');
    return { ok: false, file: safeName, reason: `不支持的文件类型。支持的扩展名：${supported}` };
  }

  const text = await loaders.extractFromBuffer(buffer, safeName);
  if (!text || !text.trim()) {
    return { ok: false, file: safeName, reason: '未能从文件中提取到文本内容（可能是扫描件或空文件）' };
  }

  // 体检：抓到的如果只是页眉/水印，宁可入库失败，也不要污染知识库
  const check = guard.inspectExtractedText(text);
  if (check.scanned) {
    return {
      ok: false,
      file: safeName,
      reason: `未提取到有效正文：${check.reason}`,
      suggestion: check.suggestion
    };
  }

  const docId = loaders.makeDocId(safeName, text);

  // 落盘，文件名前缀 docId 以避免重名覆盖
  const storedPath = path.join(config.paths.uploads, `${docId}__${safeName}`);
  const previous = fs.existsSync(config.paths.uploads)
    ? fs.readdirSync(config.paths.uploads).filter((f) => f.startsWith(`${docId}__`))
    : [];
  for (const old of previous) {
    if (old !== path.basename(storedPath)) {
      try { fs.unlinkSync(path.join(config.paths.uploads, old)); } catch { /* ignore */ }
    }
  }
  fs.writeFileSync(storedPath, buffer);

  const finalTitle = (title && String(title).trim()) || loaders.inferTitle(text, safeName.replace(/\.[^.]+$/, ''));

  const chunkCount = store.upsertDocument(
    { id: docId, title: finalTitle, source: safeName, type: loaders.extOf(safeName).replace('.', '') || 'text', bytes: buffer.length },
    text
  );

  store.rebuildStats();
  store.save();

  const vector = await tryRebuildVectorsQuietly();

  return {
    ok: true,
    docId,
    title: finalTitle,
    source: safeName,
    chunks: chunkCount,
    chars: text.length,
    vector,
    stats: store.stats()
  };
}

/** 直接粘贴文本入库 */
async function ingestText({ title, text }) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, reason: '文本内容为空' };

  const finalTitle = (title && String(title).trim()) || loaders.inferTitle(clean, '未命名资料');
  const docId = loaders.makeDocId(finalTitle, clean);

  const storedPath = path.join(config.paths.uploads, `${docId}__${sanitizeFilename(finalTitle)}.md`);
  ensureDirs();
  fs.writeFileSync(storedPath, clean, 'utf8');

  const chunkCount = store.upsertDocument(
    { id: docId, title: finalTitle, source: `${finalTitle}.md`, type: 'md', bytes: Buffer.byteLength(clean, 'utf8') },
    clean
  );

  store.rebuildStats();
  store.save();

  const vector = await tryRebuildVectorsQuietly();

  return { ok: true, docId, title: finalTitle, source: `${finalTitle}.md`, chunks: chunkCount, chars: clean.length, vector, stats: store.stats() };
}

/** 删除文档（索引 + 磁盘文件） */
function deleteDocument(docId) {
  const doc = store.getDocument(docId);
  if (!doc) return { ok: false, reason: '未找到该文档' };

  store.removeDocument(docId);

  if (fs.existsSync(config.paths.uploads)) {
    for (const file of fs.readdirSync(config.paths.uploads)) {
      if (file.startsWith(`${docId}__`)) {
        try { fs.unlinkSync(path.join(config.paths.uploads, file)); } catch { /* ignore */ }
      }
    }
  }

  store.save();
  return { ok: true, docId, title: doc.title, stats: store.stats() };
}

/** 向量化失败不应阻断入库主流程 */
async function tryRebuildVectorsQuietly() {
  if (!llm.isEmbedConfigured()) {
    return { ok: false, skipped: true, reason: '未配置向量模型' };
  }
  try {
    return await buildVectors();
  } catch (err) {
    console.warn('[indexer] 增量向量化失败：', err.message);
    return { ok: false, error: err.message };
  }
}

/** 启动时调用：索引为空则自动做一次全量入库 */
async function bootstrapIfEmpty() {
  store.load();
  if (store.state.chunks.length > 0) {
    return { loaded: true, stats: store.stats() };
  }

  const files = [...scanDirectory(config.paths.kb), ...scanDirectory(config.paths.uploads)];
  if (files.length === 0) {
    return { loaded: true, empty: true, stats: store.stats() };
  }

  const result = await reindexAll({ withVectors: true });
  return { loaded: true, indexed: result, stats: store.stats() };
}

module.exports = {
  scanDirectory,
  ingestFile,
  ingestUpload,
  ingestText,
  reindexAll,
  buildVectors,
  deleteDocument,
  bootstrapIfEmpty,
  sanitizeFilename
};
