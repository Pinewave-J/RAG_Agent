'use strict';

/**
 * 知识库管理接口：导入、更新、删除、重建索引。
 *
 * 鉴权策略：ADMIN_TOKEN 非空时，写操作必须携带 `x-admin-token` 请求头
 * （或 `?token=` 查询参数）。读操作（统计、列表）保持开放，便于前端展示。
 */

const express = require('express');
const multer = require('multer');

const { config, envStale } = require('../config');
const store = require('../store');
const indexer = require('../indexer');
const loaders = require('../loaders');
const llm = require('../llm');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.maxUploadBytes, files: 20 }
});

/** 写操作鉴权 */
function requireAdmin(req, res, next) {
  if (!config.server.adminToken) {
    // 未设置口令 => 不鉴权，但服务启动日志中已给出警告
    return next();
  }
  const provided = req.get('x-admin-token') || req.query.token || '';
  if (provided && provided === config.server.adminToken) return next();

  res.status(401).json({
    ok: false,
    error: '管理口令不正确或未提供。请在页面「知识库管理」中填写管理口令。'
  });
}

/* ---------------------------- 读取 ---------------------------- */

router.get('/kb/stats', (req, res) => {
  res.json({
    ok: true,
    stats: store.stats(),
    documents: store.listDocuments(),
    keywords: store.topKeywords(16),
    capabilities: {
      vector: llm.isEmbedConfigured(),
      chat: llm.isChatConfigured(),
      adminProtected: Boolean(config.server.adminToken),
      // .env 在服务启动后被改过 => 页面需要提示用户重启，否则改了也不生效
      envStale: envStale()
    },
    limits: {
      maxUploadMB: Math.round(config.limits.maxUploadBytes / 1024 / 1024),
      formats: Array.from(loaders.SUPPORTED_EXT)
    }
  });
});

/* ---------------------------- 导入 ---------------------------- */

/** 多文件上传导入；单文件失败不影响其余文件 */
router.post('/kb/upload', requireAdmin, (req, res) => {
  upload.array('files', 20)(req, res, async (uploadErr) => {
    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? `单个文件超过上限（${Math.round(config.limits.maxUploadBytes / 1024 / 1024)} MB）`
        : `上传失败：${uploadErr.message}`;
      res.status(400).json({ ok: false, error: message });
      return;
    }

    const files = req.files || [];
    if (files.length === 0) {
      res.status(400).json({ ok: false, error: '未收到文件，请确认表单字段名为 files' });
      return;
    }

    const results = [];
    for (const file of files) {
      try {
        // multer 以 latin1 解码 originalname，中文名需要转回 utf8
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const result = await indexer.ingestUpload(file.buffer, originalName);
        results.push(result);
      } catch (err) {
        results.push({ ok: false, file: file.originalname, reason: err.message });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    res.json({
      ok: succeeded > 0,
      succeeded,
      failed: results.length - succeeded,
      results,
      stats: store.stats()
    });
  });
});

/** 直接粘贴文本导入 */
router.post('/kb/text', requireAdmin, async (req, res) => {
  const { title, text } = req.body || {};
  try {
    const result = await indexer.ingestText({ title, text });
    res.json({ ok: result.ok, result, stats: store.stats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------------------------- 更新与删除 ---------------------------- */

router.delete('/kb/docs/:docId', requireAdmin, (req, res) => {
  const result = indexer.deleteDocument(req.params.docId);
  if (!result.ok) {
    res.status(404).json(result);
    return;
  }
  res.json({ ok: true, ...result });
});

/** 全量重建索引（重新扫描 knowledge/ 与 data/uploads/） */
router.post('/kb/reindex', requireAdmin, async (req, res) => {
  const withVectors = req.body?.withVectors !== false;
  try {
    const result = await indexer.reindexAll({ withVectors });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** 单独为现有片段补齐向量（不重建索引） */
router.post('/kb/vectors', requireAdmin, async (req, res) => {
  if (!llm.isEmbedConfigured()) {
    res.status(400).json({
      ok: false,
      error: '未配置向量模型（EMBED_BASE_URL / EMBED_API_KEY），无法生成向量。当前使用本地 BM25 关键词检索。'
    });
    return;
  }
  try {
    const result = await indexer.buildVectors();
    store.save();
    res.json({ ok: true, result, stats: store.stats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** 校验管理口令是否正确，供前端"测试连接"使用 */
router.post('/kb/auth-check', (req, res) => {
  if (!config.server.adminToken) {
    res.json({ ok: true, protected: false, message: '服务端未设置管理口令，所有操作已开放。' });
    return;
  }
  const provided = req.get('x-admin-token') || req.body?.token || '';
  const valid = provided === config.server.adminToken;
  res.status(valid ? 200 : 401).json({
    ok: valid,
    protected: true,
    message: valid ? '口令正确。' : '口令不正确。'
  });
});

module.exports = router;
