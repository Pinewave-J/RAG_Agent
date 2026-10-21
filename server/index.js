'use strict';

/**
 * 知识问答 Agent —— 服务入口。
 *
 * 单进程同时承担 API 与前端静态资源，部署时只需暴露一个端口。
 */

const path = require('path');
const express = require('express');

const { config, ensureDirs, diagnose } = require('./config');
const store = require('./store');
const indexer = require('./indexer');
const chatRoutes = require('./routes/chat');
const kbRoutes = require('./routes/kb');

const app = express();

/* ------------------------------------------------------------------ */
/* 基础中间件                                                          */
/* ------------------------------------------------------------------ */

app.disable('x-powered-by');
app.set('trust proxy', 1);

// 请求体上限：粘贴导入大段文本时可能较大
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// 基础安全响应头（不引入 helmet，避免额外依赖）
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  next();
});

// 极简访问日志
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    const startedAt = Date.now();
    res.on('finish', () => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
  }
  next();
});

/* ------------------------------------------------------------------ */
/* 简易限流（按 IP 滑动窗口，防止公开部署后被刷爆 API 额度）              */
/* ------------------------------------------------------------------ */

const buckets = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_PER_MIN || 30);

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (buckets.get(ip) || []).filter((t) => now - t < WINDOW_MS);

  if (hits.length >= MAX_REQUESTS) {
    res.status(429).json({
      ok: false,
      error: `请求过于频繁，请稍后再试（每分钟上限 ${MAX_REQUESTS} 次）。`
    });
    return;
  }

  hits.push(now);
  buckets.set(ip, hits);

  // 顺手清理过期桶，避免内存无限增长
  if (buckets.size > 5000) {
    for (const [key, value] of buckets.entries()) {
      if (!value.some((t) => now - t < WINDOW_MS)) buckets.delete(key);
    }
  }
  next();
}

/* ------------------------------------------------------------------ */
/* 业务路由                                                            */
/* ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  const diag = diagnose();
  res.json({
    ok: true,
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    config: diag,
    kb: store.stats()
  });
});

app.use('/api', rateLimit, chatRoutes);
app.use('/api', kbRoutes);

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const publicDir = path.join(config.root, 'public');

app.use(express.static(publicDir, {
  index: 'index.html',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    // HTML 不缓存，保证发版后用户能立刻拿到新前端
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// API 之外的未知路径统一交给前端（便于将来加前端路由）
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// 统一的错误兜底
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: err.message || '服务端内部错误' });
});

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

async function start() {
  ensureDirs();

  const diag = diagnose();
  console.log('==============================================');
  console.log(' 知识问答 Agent 启动中…');
  console.log('==============================================');
  console.log(`  知识库目录 : ${config.paths.kb}`);
  console.log(`  数据目录   : ${config.paths.data}`);
  console.log(`  对话模型   : ${config.llm.model} @ ${config.llm.baseUrl}`);
  console.log(`  检索模式   : ${diag.vectorEnabled ? `混合检索（BM25 + 向量 ${config.embed.model}）` : 'BM25 关键词检索（未配置向量模型）'}`);
  console.log(`  兜底阈值   : 覆盖率 < ${config.retrieval.minCoverage}`);
  console.log(`  管理鉴权   : ${diag.adminProtected ? '已开启' : '未开启（请勿暴露到公网）'}`);

  for (const issue of diag.issues) console.warn(`  [警告] ${issue}`);
  for (const note of diag.notes) console.log(`  [提示] ${note}`);

  const boot = await indexer.bootstrapIfEmpty();
  const stats = store.stats();
  console.log(`  索引状态   : ${stats.documents} 份资料 / ${stats.chunks} 个片段 / ${stats.characters} 字`);
  if (boot.empty) {
    console.log('  [提示] 知识库为空，请通过页面「知识库管理」导入资料。');
  }
  console.log('==============================================');

  const server = app.listen(config.server.port, config.server.host, () => {
    const shown = config.server.host === '0.0.0.0' ? 'localhost' : config.server.host;
    console.log(`  ✅ 服务已就绪：http://${shown}:${config.server.port}`);
    console.log('==============================================');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ 端口 ${config.server.port} 已被占用。请修改 .env 中的 PORT，或关闭占用该端口的程序。\n`);
    } else {
      console.error('\n❌ 服务启动失败：', err.message, '\n');
    }
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在关闭服务…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('启动失败：', err);
    process.exit(1);
  });
}

module.exports = { app, start };
