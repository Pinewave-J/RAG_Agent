'use strict';

/**
 * 答案生成层：把检索结果组装成提示词，驱动大模型流式作答，并处理兜底。
 *
 * 三层防编造：
 *   第一层 检索闸门 —— 覆盖率不足直接兜底，根本不调用模型；
 *   第二层 提示词约束 —— 强制"只用资料回答"，并要求输出 [[KB_MISS]] 标记；
 *   第三层 输出后处理 —— 剔除越界引用编号，剥掉内部标记。
 */

const { config } = require('./config');
const store = require('./store');
const retriever = require('./retriever');
const llm = require('./llm');

/** 模型判定资料不足时要求输出的哨兵标记 */
const NO_ANSWER_MARKER = '[[KB_MISS]]';

const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 1500;

/* ------------------------------------------------------------------ */
/* 寒暄 / 能力询问的快速通道（不消耗检索，也不调用模型）                  */
/* ------------------------------------------------------------------ */

const GREETING_RE = /^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|在么|早上好|下午好|晚上好|早|谢谢|感谢|多谢|thx|thanks)[啊呀吗呢!！。.~～\s]*$/i;
const CAPABILITY_RE = /(你是谁|你叫什么|你能做什么|你会什么|你能干什么|你的能力|介绍一下你自己|who are you|what can you do)/i;

function quickReply(question) {
  const q = String(question || '').trim();

  if (GREETING_RE.test(q)) {
    return [
      '你好，我是知识问答助手。',
      '',
      '我只会依据已导入知识库的资料回答问题，不会凭记忆编造内容。',
      '直接把你的问题发给我就行，例如：**"监理投标文件的组成有哪些？"**'
    ].join('\n');
  }

  if (CAPABILITY_RE.test(q)) {
    const s = store.stats();
    return [
      '我是这套知识库的问答助手，工作方式如下：',
      '',
      '1. 你在下方输入问题；',
      '2. 我在知识库中检索最相关的若干条资料；',
      '3. 只依据检索到的资料作答，并在句末标注来源编号，如 `[1]`、`[2]`；',
      '4. 如果知识库确实没有覆盖，我会明确告诉你，不会编造。',
      '',
      `当前知识库收录 **${s.documents}** 份资料、共 **${s.chunks}** 个知识片段。`
    ].join('\n');
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 兜底话术                                                            */
/* ------------------------------------------------------------------ */

function buildFallback({ reason, coverage, threshold, scopeHint }) {
  const s = store.stats();
  const keywords = scopeHint && scopeHint.length ? scopeHint : store.topKeywords(10);
  const docs = store.listDocuments().slice(0, 6).map((d) => `「${d.title}」`);

  // 兜底原因不同，说明文字必须不同：
  // - low-coverage：检索闸门就没放行，此时覆盖率确实低于阈值，报出这组数字是准确的；
  // - model-declined：覆盖率是达标的（否则不会调用模型），是模型读完资料后判定答不了。
  //   这条路径下绝不能再引用阈值，否则会出现"覆盖率 100%，低于 34%"这种自相矛盾的表述。
  const explain = reason === 'model-declined'
    ? '我已经在知识库中检索到相关性较高的资料，但它们只涉及该问题的一部分，不足以支撑一个完整、可靠的回答。'
    : `检索结果显示，你问题中的关键词与现有资料匹配度偏低（覆盖率 ${(coverage * 100).toFixed(0)}%，低于 ${(threshold * 100).toFixed(0)}% 的最低要求）。`;

  const lines = [
    '抱歉，**当前知识库中没有找到足以回答这个问题的内容**，因此我不做推测性回答。',
    '',
    explain,
    '',
    '**建议你这样尝试：**',
    '',
    '1. 换用资料里更可能出现的说法，例如把口语表述换成书面术语；',
    '2. 把大问题拆成具体的小问题，逐个提问；',
    '3. 如果这确实是需要收录的内容，请通过左下角「知识库管理」导入相关资料后再问。'
  ];

  if (docs.length) {
    lines.push('', `**当前已收录（部分）：**${docs.join('、')}${s.documents > docs.length ? ` 等 ${s.documents} 份` : ''}`);
  }
  if (keywords.length) {
    lines.push('', `**资料中的高频主题词：**${keywords.slice(0, 10).join(' · ')}`);
  }

  return lines.join('\n');
}

function buildEmptyKbMessage() {
  return [
    '知识库目前是空的，我暂时无法回答任何问题。',
    '',
    '请点击左下角「知识库管理」，上传资料文件（支持 `.md` / `.txt` / `.pdf` / `.docx` / `.html` / `.csv` / `.json`），或者直接粘贴文本导入。',
    '导入完成后即可开始提问。'
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

function buildSystemPrompt() {
  return [
    '你是一名严谨的「知识库问答助手」，服务于一个企业内部资料库。',
    '',
    '你必须严格遵守以下规则：',
    '',
    '1. **只依据【参考资料】作答。** 不得使用参考资料之外的知识、常识、数字、标准编号、公司名称或人名。即使你确信自己知道答案，只要资料里没有，就不能写。',
    '2. **每个要点都要标注来源编号**，格式为 `[1]`、`[2]`，编号必须与参考资料前的编号严格对应。一句话综合了多条资料时，写成 `[1][3]`。',
    '3. **资料不足时必须明确说明。** 如果【参考资料】完全无法回答问题，你回复的第一行必须原样是 `' + NO_ANSWER_MARKER + '`，随后用一句话说明知识库缺少哪方面的信息。如果资料只能部分回答，就先如实说明"资料仅涉及其中某部分"，再作答已覆盖的部分，绝不补齐未覆盖的部分。',
    '4. **不做任何推断性拔高。** 不写"通常""一般来说""业内常见做法"这类超出资料范围的表述。',
    '5. **语气自然。** 不要说"根据提供的参考资料""在上下文中"这类暴露系统实现的话；直接给出答案即可，来源用编号标注。',
    '6. 使用简体中文，条理清晰。较长回答可用小标题和列表，但不要堆砌格式。',
    '',
    '再次强调：宁可回答"知识库未收录"，也不要编造。'
  ].join('\n');
}

function buildUserPrompt(question, results) {
  const blocks = results.map((r, i) => {
    const header = `[${i + 1}] 来源：《${r.docTitle}》${r.section ? ` › ${r.section}` : ''}（文件：${r.source}）`;
    return `${header}\n${r.text}`;
  });

  return [
    '【参考资料】',
    '',
    blocks.join('\n\n---\n\n'),
    '',
    '【用户问题】',
    question
  ].join('\n\n');
}

/** 历史消息清洗：限制条数与长度，防止上下文被灌爆 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_HISTORY_CHARS)
    }));
}

/** 剔除引用了不存在编号的标注，例如只有 3 条资料却写了 [7] */
function sanitizeCitations(text, maxIndex) {
  return String(text).replace(/\[(\d{1,2})\](?!\()/g, (match, num) => {
    const n = Number(num);
    return n >= 1 && n <= maxIndex ? match : '';
  });
}

function stripMarker(text) {
  return String(text).replace(new RegExp(NO_ANSWER_MARKER.replace(/[[\]]/g, '\\$&'), 'g'), '').trim();
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成答案事件流。
 * @param {object} params
 * @param {string} params.question
 * @param {Array} [params.history]
 * @param {AbortSignal} [params.signal]
 * @yields {{type:string, [k:string]:any}}
 */
async function* generate({ question, history, signal }) {
  const q = String(question || '').trim();
  if (!q) {
    yield { type: 'error', message: '问题不能为空。' };
    return;
  }

  // 0) 寒暄 / 能力询问
  const quick = quickReply(q);
  if (quick) {
    yield { type: 'meta', citations: [], coverage: 1, mode: 'direct', retrievalMs: 0 };
    yield { type: 'delta', text: quick };
    yield { type: 'done', answered: true, source: 'direct' };
    return;
  }

  // 1) 知识库为空
  if (store.state.chunks.length === 0) {
    yield { type: 'meta', citations: [], coverage: 0, mode: 'empty', retrievalMs: 0 };
    yield { type: 'fallback', reason: 'empty-kb', message: buildEmptyKbMessage() };
    yield { type: 'done', answered: false, source: 'fallback' };
    return;
  }

  // 2) 向量化查询（失败不阻断，降级为关键词检索）
  let queryVector = null;
  if (llm.isEmbedConfigured() && store.hasVectors()) {
    try {
      const { vectors, dim } = await llm.embedTexts([q], { signal });
      if (vectors[0] && dim === store.state.vectorDim) {
        queryVector = vectors[0];
      }
    } catch (err) {
      console.warn('[answer] 查询向量化失败，降级为关键词检索：', err.message);
    }
  }

  // 3) 检索 + 闸门
  const retrieval = retriever.search(q, { queryVector });

  const citations = retrieval.results.map((r, i) => ({
    index: i + 1,
    id: r.id,
    docId: r.docId,
    title: r.docTitle,
    source: r.source,
    section: r.section,
    score: r.score,
    coverage: r.coverage,
    snippet: r.text.slice(0, 220)
  }));

  yield {
    type: 'meta',
    citations: retrieval.uncovered ? [] : citations,
    coverage: retrieval.coverage,
    threshold: retrieval.threshold,
    mode: retrieval.mode,
    retrievalMs: retrieval.tookMs,
    retrievalStats: retrieval.stats,
    verbose: { citations }
  };

  // 4) 闸门未通过 -> 兜底，不调用模型
  if (retrieval.uncovered) {
    yield {
      type: 'fallback',
      reason: 'low-coverage',
      coverage: retrieval.coverage,
      threshold: retrieval.threshold,
      message: buildFallback({
        reason: 'low-coverage',
        coverage: retrieval.coverage,
        threshold: retrieval.threshold,
        scopeHint: store.topKeywords(10)
      })
    };
    yield { type: 'done', answered: false, source: 'fallback' };
    return;
  }

  if (!llm.isChatConfigured()) {
    yield {
      type: 'error',
      message: '服务端未配置 LLM_API_KEY，无法生成回答。请在 .env 中填写 DeepSeek 密钥后重启服务。'
    };
    return;
  }

  // 5) 调用模型，流式输出
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...sanitizeHistory(history),
    { role: 'user', content: buildUserPrompt(q, retrieval.results) }
  ];

  let probe = '';
  let probing = true;
  let missed = false;
  let emitted = '';
  const startedAt = Date.now();

  try {
    for await (const delta of llm.streamChat({ messages, signal })) {
      if (!probing) {
        emitted += delta;
        yield { type: 'delta', text: delta };
        continue;
      }

      // 探测窗口：判断回答是否以哨兵标记开头。
      // 窗口内不做输出，避免把 [[KB_MISS]] 泄漏给前端。
      probe += delta;
      const trimmed = probe.replace(/^\s+/, '');

      if (trimmed.length <= NO_ANSWER_MARKER.length && NO_ANSWER_MARKER.startsWith(trimmed)) {
        continue; // 仍可能是标记的前缀，继续攒
      }

      probing = false;

      if (trimmed.startsWith(NO_ANSWER_MARKER)) {
        missed = true;
        probe = '';
        break;
      }

      emitted += probe;
      yield { type: 'delta', text: probe };
      probe = '';
    }

    if (!missed && probing) {
      // 流已结束但一直停留在探测窗口内：要么只回了标记，要么只回了一两个字符
      const trimmed = probe.replace(/^\s+/, '');
      if (trimmed.startsWith(NO_ANSWER_MARKER)) {
        missed = true;
      } else if (trimmed) {
        emitted += probe;
        yield { type: 'delta', text: probe };
      }
      probe = '';
    }

    if (missed) {
      yield {
        type: 'fallback',
        reason: 'model-declined',
        coverage: retrieval.coverage,
        threshold: retrieval.threshold,
        message: buildFallback({
          reason: 'model-declined',
          coverage: retrieval.coverage,
          threshold: retrieval.threshold,
          scopeHint: store.topKeywords(10)
        })
      };
      yield { type: 'done', answered: false, source: 'fallback' };
      return;
    }

    if (!emitted.trim()) {
      yield { type: 'error', message: '模型返回了空回答，请稍后重试。' };
      return;
    }

    yield { type: 'done', answered: true, source: 'kb', elapsedMs: Date.now() - startedAt };
  } catch (err) {
    if (signal && signal.aborted) {
      yield { type: 'done', answered: Boolean(emitted.trim()), aborted: true };
      return;
    }
    yield {
      type: 'error',
      message: err instanceof llm.LLMError ? err.message : `生成回答时发生异常：${err.message}`
    };
  }
}

/**
 * 非流式便捷接口（供脚本或未来 API 复用），内部消费 generate 事件流。
 */
async function answerOnce(question, history = []) {
  let text = '';
  let citations = [];
  let fallback = null;
  let error = null;

  for await (const event of generate({ question, history })) {
    if (event.type === 'meta') citations = event.verbose ? event.verbose.citations : event.citations;
    else if (event.type === 'delta') text += event.text;
    else if (event.type === 'fallback') fallback = event.message;
    else if (event.type === 'error') error = event.message;
  }

  if (error) return { ok: false, error };
  if (fallback) return { ok: true, answered: false, answer: fallback, citations: [] };

  const maxIndex = citations.length;
  return {
    ok: true,
    answered: true,
    answer: stripMarker(sanitizeCitations(text, maxIndex)),
    citations
  };
}

module.exports = {
  generate,
  answerOnce,
  buildFallback,
  buildSystemPrompt,
  NO_ANSWER_MARKER,
  quickReply
};
