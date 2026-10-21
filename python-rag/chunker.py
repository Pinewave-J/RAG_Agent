"""
文本切分器 —— 项目 chunker.js 的 Python 移植版。

为什么必须切分？两个硬约束：
  1. 模型的上下文有上限，不可能把整本书塞进提示词；
  2. 检索要的是"精准命中"。整本书作为一个单位，命中率极低 ——
     你问一个小问题，它把整本书还给你。

目标：切出来的每个片段既「语义完整」又「长度可控」。

策略（三步走）：
  第一步 按 Markdown 标题切成小节，并把标题路径保存下来（用于溯源展示）；
  第二步 小节内按段落贪心打包，尽量装满到目标长度；
  第三步 遇到超长段落，再按句子边界硬切，并保留一段重叠。
"""

import re

# 匹配 Markdown 标题：# 一级、## 二级……最多 6 级
HEADING_RE = re.compile(r'^(#{1,6})\s+(.+?)\s*#*\s*$')
# 代码块围栏：``` 或 ~~~
FENCE_RE = re.compile(r'^\s*(```|~~~)')


def split_sentences(text):
    """按句子边界切分长文本，尽量不把一句话拦腰截断。

    分隔依据：中文句末标点（。！？；）、英文句末标点（!?;）、以及换行。
    用的是「零宽断言」(?<=...)：意思是"这个位置的前面是句末标点"，
    但标点本身不会被吃掉 —— 否则切完每句话都会丢一个句号。
    """
    parts = re.split(r'(?<=[。！？；!?;])\s*|\n+', text)
    return [p.strip() for p in parts if p.strip()]


def hard_split(text, size, overlap):
    """对超长片段做硬切，带重叠。

    重叠（overlap）是这里最重要的概念：如果答案正好横跨两个片段的边界，
    没有重叠就会两边都只拿到半句话，谁也答不出来。
    留一段重叠，等于让边界处的信息在两个片段里各出现一次。

    实现是和项目完全一致的「贪心装箱」：
      · 逐句往缓冲区里塞；
      · 塞不下了就先把缓冲区输出，再把上一条的尾巴截一段作为新缓冲区的开头。
    """
    sentences = split_sentences(text)
    pieces = []
    buffer = ''

    def flush():
        nonlocal buffer
        if buffer.strip():
            pieces.append(buffer.strip())
        buffer = ''

    for sentence in sentences:
        if len(sentence) > size:
            # 单句就超长（例如没有标点的表格行），只能按字符数硬切
            flush()
            cursor = 0
            while cursor < len(sentence):
                pieces.append(sentence[cursor:cursor + size])
                step = size - overlap if size - overlap > 0 else size
                cursor += step
            continue

        if len(buffer + sentence) > size:
            flush()
            # 从上一条的尾巴取一点重叠
            if pieces and overlap > 0:
                prev = pieces[-1]
                buffer = prev[max(0, len(prev) - overlap):] + sentence
            else:
                buffer = sentence
        else:
            buffer += sentence

    flush()
    return pieces


def chunk_document(doc_id, doc_title, text, max_len=620, overlap=120):
    """把一份文档切成片段列表。

    返回的每个片段是一个 dict，字段和 JS 版一一对应：
        docId / docTitle / section / ordinal / text / charCount
    其中 section 是标题路径（用 › 连接），它是这个项目最容易被忽视、
    却最关键的一个字段 —— 后面 BM25 打分要靠它，见 bm25_index.py。
    """
    # 重叠不能超过半个片段长，否则相邻片段几乎完全重合，白白浪费索引
    overlap = min(overlap, max_len // 2)

    lines = str(text or '').replace('\r\n', '\n').replace('\r', '\n').split('\n')

    sections = []
    heading_stack = []          # 记录各级标题，用于拼出路径
    current = {'section': doc_title or '正文', 'body': ''}
    in_fence = False            # 是否正处在代码块内部

    def push_current():
        if current['body'].strip():
            sections.append(dict(current))

    for line in lines:
        if FENCE_RE.match(line):
            # 进出代码块。代码块内部的 # 不是标题，必须区分开 ——
            # 否则一段 shell 注释会被误当成章节标题，把片段切得七零八落
            in_fence = not in_fence
            current['body'] += line + '\n'
            continue

        heading = None if in_fence else HEADING_RE.match(line)
        if heading:
            push_current()
            level = len(heading.group(1))
            title = heading.group(2).strip()

            # 维护标题栈：遇到"三级标题"，就把它前面的栈截断到两级
            if len(heading_stack) > level - 1:
                del heading_stack[level - 1:]
            while len(heading_stack) < level:
                heading_stack.append(None)
            heading_stack[level - 1] = title

            path = ' › '.join([x for x in heading_stack if x])
            current = {'section': path or title, 'body': ''}
            continue

        current['body'] += line + '\n'

    push_current()

    if not sections:
        sections.append({'section': doc_title or '正文', 'body': str(text or '')})

    chunks = []
    ordinal = 0

    for section in sections:
        # 段落级打包：空行是段落分隔符
        paragraphs = [p.strip() for p in re.split(r'\n\s*\n', section['body']) if p.strip()]

        blocks = []
        buffer = ''

        def flush_buffer():
            nonlocal buffer
            if buffer.strip():
                blocks.append(buffer.strip())
            buffer = ''

        for para in paragraphs:
            if len(para) > max_len:
                flush_buffer()
                for piece in hard_split(para, max_len, overlap):
                    blocks.append(piece.strip())
                continue
            if len(buffer + '\n\n' + para) > max_len:
                flush_buffer()
                buffer = para
            else:
                buffer = buffer + '\n\n' + para if buffer else para
        flush_buffer()

        for block in blocks:
            if not block.strip():
                continue
            chunks.append({
                'docId': doc_id,
                'docTitle': doc_title,
                'section': section['section'],
                'ordinal': ordinal,
                'text': block,
                'charCount': len(block),
            })
            ordinal += 1

    return [c for c in chunks if c['text'].strip()]
