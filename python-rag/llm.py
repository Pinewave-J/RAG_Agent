"""
大模型客户端 —— 项目 llm.js 的 Python 移植版。

统一走 OpenAI 兼容协议，所以 DeepSeek 官方端点、阿里云百炼、智谱、OpenAI、
本地 vLLM / Ollama 都能用，换服务商只改 .env 里的三个变量，代码一行不用动。
这就是"用 OpenAI 兼容协议"的最大好处：它事实上成了行业通用插头。

依赖只有 requests。如果你只想用检索功能（不调模型），可以不装它 ——
"用到才导入"的设计让缺依赖不等于整个程序起不来（和项目里的 requireOptional 一个思路）。
"""

import json

from config import LLM, EMBED, embed_configured, chat_configured, resolve_thinking

# 模型判定"资料不足"时要求输出的哨兵标记。
# 为什么需要一个标记？因为"模型说资料不够"这句话本身也是自然语言，
# 用关键词去猜"它是不是在拒答"非常不可靠。让模型输出一个固定字符串，
# 后端一眼就能认出，这是工程上更稳的做法。
NO_ANSWER_MARKER = '[[KB_MISS]]'


class LLMError(Exception):
    """把上游返回的各种错误整理成一句人话。"""

    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


def _requests():
    """延迟导入 requests。缺依赖时给出可执行的提示，而不是一句 ImportError。"""
    try:
        import requests
    except ImportError as exc:
        raise LLMError(
            '缺少依赖 requests，无法调用模型服务。请执行：pip install requests'
        ) from exc
    return requests


def _describe_http_error(status, body_text):
    """把 HTTP 错误码翻译成人能看懂的原因。

    这一步看着琐碎，但它决定了排查问题要花 5 分钟还是 5 小时。
    比如 402（余额不足）和 401（密钥无效）在日志里都只是一个数字，
    但对应的动作完全不同。
    """
    detail = body_text or ''
    try:
        parsed = json.loads(body_text)
        detail = (parsed.get('error') or {}).get('message') or parsed.get('message') or detail
    except (ValueError, AttributeError):
        pass

    known = {
        401: 'API Key 无效或已过期（401）',
        402: '账户余额不足（402）',
        403: '该 Key 无权访问此模型（403）',
        404: '模型名或接口路径不存在（404）',
        429: '请求过于频繁，已被限流（429）',
        500: '上游服务异常（500）',
        503: '上游服务暂时不可用（503）',
    }
    prefix = known.get(status, f'上游返回 HTTP {status}')
    return f'{prefix}：{detail}' if detail else prefix


def _headers(api_key):
    return {'Content-Type': 'application/json', 'Authorization': f'Bearer {api_key}'}


def stream_chat(messages, temperature=None, max_tokens=None):
    """流式对话。逐个 yield 出来的文本增量。

    ⚠️ 关于推理模型（这段别删）：
    deepseek-flash / deepseek-v4-pro 这类是**推理模型**，一次响应包含两段：
        1. delta.reasoning_content —— 思维链
        2. delta.content          —— 正式回答
    **两段共享同一个 max_tokens 预算。** 实测思维链稳定占 3000~3400 字，
    与预算设置无关。于是 max_tokens=1600 时，全部预算被思维链吃光，
    finish_reason 直接变成 'length'，正式回答一个字都没轮到 ——
    用户看到的只是"回答为空"或"被截断"，而接口本身没有任何报错。

    因此这里必须：思维链单独计数、**不向下游输出**（前端只要正文），
    并在截断时给出说得通的提示（见 answer.py 的 build_truncation_note）。
    """
    if not chat_configured():
        raise LLMError('未配置 LLM_API_KEY，无法调用大模型。请在 .env 中填写后重启。')

    requests = _requests()
    url = f"{LLM['base_url']}/chat/completions"
    body = {
        'model': LLM['model'],
        'messages': messages,
        'stream': True,
        'temperature': LLM['temperature'] if temperature is None else temperature,
        'max_tokens': LLM['max_tokens'] if max_tokens is None else max_tokens,
    }

    # 主动关闭思维链。关掉后 content 与 reasoning 不再争抢 max_tokens，
    # 正文预算变充裕；实测首字延迟下降约 25%，而回答完整度不变。
    disabled, why = resolve_thinking()
    if disabled:
        body['thinking'] = {'type': 'disabled'}

    try:
        resp = requests.post(url, headers=_headers(LLM['api_key']), json=body,
                             stream=True, timeout=LLM['timeout'])
    except Exception as exc:      # noqa: BLE001 - 网络层异常统一转成可读信息
        raise LLMError(f'连接模型服务失败：{exc}。请检查网络与 LLM_BASE_URL 是否正确。') from exc

    if resp.status_code != 200:
        text = resp.text
        raise LLMError(_describe_http_error(resp.status_code, text),
                       status=resp.status_code, body=text)

    content_chars = 0
    reasoning_chars = 0
    finish_reason = None

    # SSE 协议：每个事件一行 "data: {...}"，事件之间用空行分隔，最后一行是 data: [DONE]。
    # 用 iter_lines() 而不是自己切缓冲区 —— 网络分片可能把一行切成两半，
    # requests 已经帮我们处理了这种"半个 JSON"的情况。
    for raw_line in resp.iter_lines(decode_unicode=True):
        if not raw_line:
            continue
        line = raw_line.strip()
        if not line.startswith('data:'):
            continue
        payload = line[5:].strip()
        if not payload or payload == '[DONE]':
            continue

        try:
            chunk = json.loads(payload)
        except ValueError:
            # 心跳行、注释行，忽略即可
            continue

        choices = chunk.get('choices') or [{}]
        choice = choices[0]
        delta = choice.get('delta') or {}

        # 思维链：只计数，不输出给下游
        if delta.get('reasoning_content'):
            reasoning_chars += len(delta['reasoning_content'])

        if delta.get('content'):
            content_chars += len(delta['content'])
            yield delta['content']

        if choice.get('finish_reason'):
            finish_reason = choice['finish_reason']

    if finish_reason == 'length':
        yield build_truncation_note(content_chars, reasoning_chars)


def build_truncation_note(content_chars, reasoning_chars):
    """生成"被截断"的提示。

    必须按"截断发生在哪一段"分支措辞：
      · 思维链吃光预算（正文几乎是空的）-> 用户根本没看到回答，
        提示应该说明"模型思考过程占满了输出预算"，并给出调大 LLM_MAX_TOKENS 的建议；
      · 正文写到一半被切断 -> 才是"缩小提问范围"能解决的情况。
    两种情况共用一句话的话，前者会输出"回答被截断"，而用户根本没看到回答 —— 令人困惑。
    """
    if content_chars < 60 and reasoning_chars > 0:
        return ('\n\n> ⚠️ 模型未能给出回答：输出预算被"思考过程"占满'
                f'（思考 {reasoning_chars} 字 / 正文 {content_chars} 字）。'
                '当前 LLM_MAX_TOKENS 偏小，建议调大该值，或改用非推理模型（如 deepseek-chat）。')
    return '\n\n> ⚠️ 回答因长度上限被截断，如需完整内容请缩小提问范围。'


def embed_texts(texts):
    """把文本批量转成向量。返回 (向量列表, 维度)。

    向量就是"把一句话变成一串数字"。语义相近的句子，数字串也相近 ——
    这样"申请营业执照"和"投标要交营业执照"虽然用词不同，也能靠语义匹配上。
    关键词检索做不到这一点（见教程第 06 章）。
    """
    if not embed_configured():
        raise LLMError('未配置向量模型（EMBED_BASE_URL / EMBED_API_KEY），无法向量化。')
    if not texts:
        return [], 0

    requests = _requests()
    url = f"{EMBED['base_url']}/embeddings"
    batch_size = max(1, EMBED['batch_size'])
    out = []
    dim = 0

    for start in range(0, len(texts), batch_size):
        batch = texts[start:start + batch_size]
        resp = requests.post(
            url, headers=_headers(EMBED['api_key']),
            json={'model': EMBED['model'], 'input': batch, 'encoding_format': 'float'},
            timeout=LLM['timeout'],
        )
        if resp.status_code != 200:
            raise LLMError(f'向量化失败：{_describe_http_error(resp.status_code, resp.text)}')

        data = resp.json().get('data') or []
        # 部分厂商不保证返回顺序，按 index 归位（这是一个真实踩过的坑：
        # 一批 10 条结果顺序打乱，向量就会和片段错配，而且不会报错，只是答得莫名其妙）
        by_index = {}
        for pos, item in enumerate(data):
            by_index[item.get('index', pos)] = item
        for i in range(len(batch)):
            item = by_index.get(i) or (data[i] if i < len(data) else None)
            vec = (item or {}).get('embedding')
            if not vec:
                raise LLMError('向量服务返回结构异常，缺少 embedding 字段。')
            if not dim:
                dim = len(vec)
            out.append(vec)

    return out, dim
