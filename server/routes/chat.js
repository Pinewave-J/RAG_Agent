'use strict';

/**
 * 问答接口。
 * 采用 SSE（Server-Sent Events）逐字推送，前端用 fetch + ReadableStream 消费
 * ——（EventSource 不支持 POST，因此不能用原生 EventSource）。
 */

const express = require('express');
const answer = require('../answer');
const store = require('../store');

const router = express.Router();

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

router.post('/chat', async (req, res) => {
  const { question, history } = req.body || {};

  if (typeof question !== 'string' || !question.trim()) {
    res.status(400).json({ ok: false, error: 'question 不能为空' });
    return;
  }
  if (question.length > 2000) {
    res.status(413).json({ ok: false, error: '问题过长，请控制在 2000 字以内' });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  let clientGone = false;

  // 注意：这里必须监听 res 而不是 req。
  // 现代 Node 中 req 的 'close' 在请求体被读取完毕时就会触发（express.json 解析完之后），
  // 用它判断"客户端断开"会导致响应永远不会 end，浏览器一直转圈。
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  });

  // 心跳，防止反向代理因空闲断开长连接
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  try {
    for await (const event of answer.generate({ question: question.trim(), history, signal: controller.signal })) {
      if (res.writableEnded) break;
      const { type, ...payload } = event;
      sseWrite(res, type, payload);
    }
  } catch (err) {
    if (!res.writableEnded) sseWrite(res, 'error', { message: `服务端异常：${err.message}` });
  } finally {
    clearInterval(heartbeat);
    // 无论客户端是否已断开，只要响应还没结束就收尾
    if (!res.writableEnded) {
      if (clientGone) res.destroy();
      else res.end();
    }
  }
});

/** 轻量预览接口：只返回检索结果，不调用模型，便于排查"为什么答不准" */
router.post('/search', (req, res) => {
  const { question, topK } = req.body || {};
  if (typeof question !== 'string' || !question.trim()) {
    res.status(400).json({ ok: false, error: 'question 不能为空' });
    return;
  }

  const retriever = require('../retriever');
  const result = retriever.search(question.trim(), {
    topK: Number.isFinite(Number(topK)) ? Math.min(Number(topK), 20) : undefined
  });

  res.json({
    ok: true,
    mode: result.mode,
    uncovered: result.uncovered,
    coverage: result.coverage,
    threshold: result.threshold,
    tookMs: result.tookMs,
    stats: result.stats,
    results: result.results.map((r) => ({
      id: r.id,
      title: r.docTitle,
      source: r.source,
      section: r.section,
      score: r.score,
      coverage: r.coverage,
      snippet: r.text.slice(0, 200)
    })),
    kbStats: store.stats()
  });
});

module.exports = router;
