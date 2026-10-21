"""
答案生成层 —— 项目 answer.js 的 Python 移植版。

这是 RAG 的最后一步：把检索到的片段组装成提示词，让模型"只依据资料作答"。

三层防编造（这个设计值得抄走）：
    第一层 检索闸门   —— 覆盖率不足直接兜底，**根本不调用模型**（零成本 + 零编造）
    第二层 提示词约束 —— 强制"只用资料回答"，并要求资料不足时输出哨兵标记
    第三层 输出后处理 —— 剔除越界引用编号、剥掉内部标记

为什么不只靠提示词？因为提示词是"请求"不是"保证"。模型可能不听话。
所以真正的工程做法是：在调用模型之前先拦一道，在输出之后再清洗一道。
"""

import re

from config import RETRIEVAL
from llm import NO_ANSWER_MARKER, LLMError, embed_texts, stream_chat
from retriever import search

MAX_HISTORY_TURNS = 6
MAX_HISTORY_CHARS = 1500

# ---------------------------------------------------------------------------
# 寒暄 / 能力询问的快速通道：不消耗检索，也不调用模型
#
# 为什么值得专门做：用户会问"你好"，如果没有这条通道，这句话会被丢进检索，
# 覆盖率当然是 0，于是返回一大段"知识库未收录"的兜底话术 —— 体验很怪。
# 一行正则就能解决，而且省一次模型调用。
# ---------------------------------------------------------------------------
GREETING_RE = re.compile(
    r'^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|在么|早上好|下午好|晚上好|早|谢谢|感谢|多谢|thx|thanks)[啊呀吗呢!！。.~～\s]*$',
    re.IGNORECASE,
)
CAPABILITY_RE = re.compile(
    r'(你是谁|你叫什么|你能做什么|你会什么|你能干什么|你的能力|介绍一下你自己|who are you|what can you do)',
    re.IGNORECASE,
)


def quick_reply(question, index=None):
    q = str(question or '').strip()

    if GREETING_RE.match(q):
        return ('你好，我是知识问答助手。\n\n'
                '我只会依据已导入知识库的资料回答问题，不会凭记忆编造内容。\n'
                '直接把你的问题发给我就行，例如：**"监理投标文件的组成有哪些？"**')

    if CAPABILITY_RE.search(q):
        stats = index.stats() if index else {'chunks': 0, 'characters': 0}
        return ('我是这套知识库的问答助手，工作方式如下：\n\n'
                '1. 你输入问题；\n'
                '2. 我在知识库中检索最相关的若干条资料；\n'
                '3. 只依据检索到的资料作答，并在句末标注来源编号，如 `[1]`、`[2]`；\n'
                '4. 如果知识库确实没有覆盖，我会明确告诉你，不会编造。\n\n'
                f"当前知识库收录 **{stats['chunks']}** 个知识片段。")

    return None


# ---------------------------------------------------------------------------
# 兜底话术
# ---------------------------------------------------------------------------

def build_fallback(index, reason, coverage=0.0, threshold=0.34):
    """生成兜底回复。

    ⚠️ 这里有一个真实修过的 bug，很值得记住：
    `reason` 有两种取值，说明文字**必须不同**：
      · low-coverage   —— 检索闸门就没放行，此时覆盖率确实低于阈值，
                          报出「覆盖率 X%，低于 Y%」这组数字是准确的；
      · model-declined —— 闸门放行了（覆盖率是**达标**的），
                          是模型读完资料后判定答不了。
                          这条路径下绝不能再引用阈值，
                          否则会出现"覆盖率 100%，低于 34%"这种自相矛盾的提示。

    这正是那种"看代码觉得没问题、只有跑起来读输出才发现荒谬"的缺陷。
    """
    keywords = index_top_keywords(index, 10)
    # 按文档标题去重，取前 6 个
    seen = []
    for c in index.chunks:
        t = c.get('docTitle')
        if t and t not in seen:
            seen.append(t)
    docs = [f'「{t}」' for t in seen[:6]]

    if reason == 'model-declined':
        explain = ('我已经在知识库中检索到相关性较高的资料，'
                   '但它们只涉及该问题的一部分，不足以支撑一个完整、可靠的回答。')
    else:
        explain = (f'检索结果显示，你问题中的关键词与现有资料匹配度偏低'
                   f'（覆盖率 {coverage * 100:.0f}%，低于 {threshold * 100:.0f}% 的最低要求）。')

    lines = [
        '抱歉，**当前知识库中没有找到足以回答这个问题的内容**，因此我不做推测性回答。',
        '',
        explain,
        '',
        '**建议你这样尝试：**',
        '',
        '1. 换用资料里更可能出现的说法，例如把口语表述换成书面术语；',
        '2. 把大问题拆成具体的小问题，逐个提问；',
        '3. 如果这确实是需要收录的内容，请把资料放进 knowledge/ 目录后重建索引再问。',
    ]
    if docs:
        lines += ['', f"**当前已收录（部分）：**{'、'.join(docs)}"]
    if keywords:
        lines += ['', f"**资料中的高频主题词：**{' · '.join(keywords[:10])}"]
    return '\n'.join(lines)


def index_top_keywords(index, limit=12):
    """从文档标题与高频词里提取"知识库覆盖了什么"，用于兜底话术。

    这个小功能很有用：兜底时告诉用户"我这儿有什么"，比只说"没有"友好得多 ——
    用户能据此换个问法，而不是直接放弃。
    """
    counter = {}
    for chunk in index.chunks:
        for term in set(_terms(chunk.get('docTitle') or '')):
            if len(term) < 2:
                continue
            counter[term] = counter.get(term, 0) + 2
    for term, df in index.df.items():
        if len(term) < 2:
            continue
        counter[term] = counter.get(term, 0) + df
    ordered = sorted(counter.items(), key=lambda kv: -kv[1])
    return [term for term, _ in ordered[:limit]]


def _terms(text):
    from tokenizer import unique_terms
    return unique_terms(text)


def build_empty_kb_message():
    return ('知识库目前是空的，我暂时无法回答任何问题。\n\n'
            '请先把资料文件放进 knowledge/ 目录，然后运行：\n'
            '    python build_index.py\n'
            '导入完成后即可开始提问。')


# ---------------------------------------------------------------------------
# 提示词
# ---------------------------------------------------------------------------

def build_system_prompt():
    """system 提示词：整个"防编造"体系的核心约束。

    三条规则最重要，逐条理解：
      规则 1（只依据资料）—— 这是 RAG 存在的全部理由。没有这条，
                              RAG 就退化成一个"带搜索的聊天机器人"。
      规则 3（资料不足必须说明）—— 给模型一条"认输"的合法出路。
                              这一点反直觉但极其重要：如果你不告诉模型
                              "可以回答不知道"，它就会倾向于猜一个听起来合理的答案。
                             许多"RAG 幻觉"的根源不是模型不行，而是提示词没给它退路。
      规则 5（语气自然）—— 不许说"根据提供的参考资料"这类暴露系统实现的话。
    """
    return '\n'.join([
        '你是一名严谨的「知识库问答助手」，服务于一个企业内部资料库。',
        '',
        '你必须严格遵守以下规则：',
        '',
        '1. **只依据【参考资料】作答。** 不得使用参考资料之外的知识、常识、数字、'
        '标准编号、公司名称或人名。即使你确信自己知道答案，只要资料里没有，就不能写。',
        '2. **每个要点都要标注来源编号**，格式为 `[1]`、`[2]`，编号必须与参考资料前的编号严格对应。'
        '一句话综合了多条资料时，写成 `[1][3]`。',
        f'3. **资料不足时必须明确说明。** 如果【参考资料】完全无法回答问题，'
        f'你回复的第一行必须原样是 `{NO_ANSWER_MARKER}`，随后用一句话说明知识库缺少哪方面的信息。'
        '如果资料只能部分回答，就先如实说明"资料仅涉及其中某部分"，再作答已覆盖的部分，'
        '绝不补齐未覆盖的部分。',
        '4. **不做任何推断性拔高。** 不写"通常""一般来说""业内常见做法"这类超出资料范围的表述。',
        '5. **语气自然。** 不要说"根据提供的参考资料""在上下文中"这类暴露系统实现的话；'
        '直接给出答案即可，来源用编号标注。',
        '6. 使用简体中文，条理清晰。较长回答可用小标题和列表，但不要堆砌格式。',
        '',
        '再次强调：宁可回答"知识库未收录"，也不要编造。',
    ])


def build_user_prompt(question, results):
    """user 提示词：把检索结果拼成"带编号的资料清单 + 问题"。

    每段资料前面加 `[1] 来源：《文档名》 › 章节路径`，
    这个编号就是让模型写 `[1]` 时能对上号的依据，
    也是前端角标点击跳转的入口。
    """
    blocks = []
    for i, r in enumerate(results):
        section = f" › {r['section']}" if r.get('section') else ''
        header = f"[{i + 1}] 来源：《{r.get('docTitle')}》{section}（文件：{r.get('source')}）"
        blocks.append(f"{header}\n{r.get('text')}")

    return '\n\n'.join([
        '【参考资料】',
        '',
        '\n\n---\n\n'.join(blocks),
        '',
        '【用户问题】',
        question,
    ])


def sanitize_citations(text, max_index):
    """剔除引用了不存在编号的标注，例如只有 3 条资料却写了 [7]。

    这是第三道防线。模型偶尔会"顺手"写出一个不存在的编号，
    前端一点跳转就发现没有对应卡片 —— 与其在前端做兜底，
    不如在服务端直接删掉。(?!\\() 是为了不动 Markdown 链接 `[1](url)`。
    """
    def repl(match):
        n = int(match.group(1))
        return match.group(0) if 1 <= n <= max_index else ''

    return re.sub(r'\[(\d{1,2})\](?!\()', repl, str(text))


def strip_marker(text):
    return str(text).replace(NO_ANSWER_MARKER, '').strip()


def sanitize_history(history):
    """历史消息清洗：限制条数与长度，防止上下文被灌爆。"""
    if not history:
        return []
    out = []
    for m in history[-MAX_HISTORY_TURNS:]:
        if not m or m.get('role') not in ('user', 'assistant'):
            continue
        if not isinstance(m.get('content'), str):
            continue
        out.append({'role': m['role'], 'content': m['content'][:MAX_HISTORY_CHARS]})
    return out


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def generate(index, question, history=None, top_k=None, query_vector=None,
             min_coverage=None):
    """生成答案事件流。逐个 yield 事件字典。

    事件类型和项目完全一致，方便对照：
        {'type': 'meta',     'citations': [...], 'coverage': .., 'mode': ..}
        {'type': 'delta',    'text': '...'}
        {'type': 'fallback', 'reason': 'low-coverage' | 'model-declined', 'message': '...'}
        {'type': 'done',     'answered': bool}
        {'type': 'error',    'message': '...'}
    """
    q = str(question or '').strip()
    if not q:
        yield {'type': 'error', 'message': '问题不能为空。'}
        return

    top_k = top_k or RETRIEVAL['top_k']
    threshold = RETRIEVAL['min_coverage'] if min_coverage is None else min_coverage

    # 0) 寒暄 / 能力询问
    quick = quick_reply(q, index)
    if quick:
        yield {'type': 'meta', 'citations': [], 'coverage': 1.0, 'mode': 'direct'}
        yield {'type': 'delta', 'text': quick}
        yield {'type': 'done', 'answered': True, 'source': 'direct'}
        return

    # 1) 知识库为空
    if not index.chunks:
        yield {'type': 'meta', 'citations': [], 'coverage': 0.0, 'mode': 'empty'}
        yield {'type': 'fallback', 'reason': 'empty-kb', 'message': build_empty_kb_message()}
        yield {'type': 'done', 'answered': False, 'source': 'fallback'}
        return

    # 2) 把问题也转成向量（失败不阻断，降级为关键词检索）
    if query_vector is None and index.has_vectors():
        try:
            vecs, dim = embed_texts([q])
            if vecs and dim == index.vector_dim:
                query_vector = vecs[0]
        except LLMError as exc:
            print(f'[answer] 查询向量化失败，降级为关键词检索：{exc}')

    # 3) 检索 + 闸门
    retrieval = search(index, q, top_k=top_k, candidates=RETRIEVAL['candidates'],
                       min_coverage=threshold, rrf_k=RETRIEVAL['rrf_k'],
                       query_vector=query_vector)

    citations = [{
        'index': i + 1,
        'title': r.get('docTitle'),
        'source': r.get('source'),
        'section': r.get('section'),
        'score': r.get('score'),
        'coverage': r.get('coverage'),
        'snippet': (r.get('text') or '')[:220],
    } for i, r in enumerate(retrieval['results'])]

    yield {
        'type': 'meta',
        # 闸门拦截时清空 citations（不向前端暴露无关来源），
        # 但 verbose 里保留完整候选，供调试用 —— 和项目一致。
        'citations': [] if retrieval['uncovered'] else citations,
        'verbose': {'citations': citations},
        'coverage': retrieval['coverage'],
        'threshold': retrieval['threshold'],
        'mode': retrieval['mode'],
        'stats': retrieval['stats'],
    }

    # 4) 闸门未通过 -> 兜底，不调用模型
    if retrieval['uncovered']:
        yield {
            'type': 'fallback',
            'reason': 'low-coverage',
            'coverage': retrieval['coverage'],
            'threshold': retrieval['threshold'],
            'message': build_fallback(index, 'low-coverage',
                                      retrieval['coverage'], retrieval['threshold']),
        }
        yield {'type': 'done', 'answered': False, 'source': 'fallback'}
        return

    # 5) 调用模型，流式输出
    messages = [
        {'role': 'system', 'content': build_system_prompt()},
        *sanitize_history(history),
        {'role': 'user', 'content': build_user_prompt(q, retrieval['results'])},
    ]

    # 探测窗口：先攒一小段，判断回答是不是以 [[KB_MISS]] 开头。
    # 如果在窗口内就往外发，用户会看到一串莫名其妙的 [[KB_MISS]] 一闪而过。
    probe = ''
    probing = True
    missed = False
    emitted = ''

    try:
        for delta in stream_chat(messages):
            if not probing:
                emitted += delta
                yield {'type': 'delta', 'text': delta}
                continue

            probe += delta
            trimmed = probe.lstrip()

            if len(trimmed) <= len(NO_ANSWER_MARKER) and NO_ANSWER_MARKER.startswith(trimmed):
                continue      # 仍可能是标记的前缀，继续攒

            probing = False

            if trimmed.startswith(NO_ANSWER_MARKER):
                missed = True
                probe = ''
                break

            emitted += probe
            yield {'type': 'delta', 'text': probe}
            probe = ''

        if not missed and probing:
            # 流结束了却一直待在探测窗口内：要么只回了标记，要么只回了一两个字
            trimmed = probe.lstrip()
            if trimmed.startswith(NO_ANSWER_MARKER):
                missed = True
            elif trimmed:
                emitted += probe
                yield {'type': 'delta', 'text': probe}
            probe = ''

        if missed:
            yield {
                'type': 'fallback',
                'reason': 'model-declined',
                'coverage': retrieval['coverage'],
                'threshold': retrieval['threshold'],
                'message': build_fallback(index, 'model-declined',
                                          retrieval['coverage'], retrieval['threshold']),
            }
            yield {'type': 'done', 'answered': False, 'source': 'fallback'}
            return

        if not emitted.strip():
            yield {'type': 'error', 'message': '模型返回了空回答，请稍后重试。'}
            return

        yield {'type': 'done', 'answered': True, 'source': 'kb'}

    except LLMError as exc:
        yield {'type': 'error', 'message': str(exc)}


def answer_once(index, question, history=None, top_k=None):
    """非流式便捷接口：把事件流攒成一个完整结果，方便在脚本里用。"""
    text = ''
    citations = []
    fallback = None
    error = None

    for event in generate(index, question, history=history, top_k=top_k):
        if event['type'] == 'meta':
            citations = event.get('verbose', {}).get('citations', event.get('citations', []))
        elif event['type'] == 'delta':
            text += event['text']
        elif event['type'] == 'fallback':
            fallback = event['message']
        elif event['type'] == 'error':
            error = event['message']

    if error:
        return {'ok': False, 'error': error}
    if fallback:
        return {'ok': True, 'answered': False, 'answer': fallback, 'citations': []}

    return {
        'ok': True,
        'answered': True,
        'answer': strip_marker(sanitize_citations(text, len(citations))),
        'citations': citations,
    }
