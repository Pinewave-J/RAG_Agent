"""
索引层 —— 项目 store.js（的统计部分）的 Python 移植版。

它把「一堆文本片段」变成「一个可以打分的数学结构」：
    chunk_tf  每个片段的词频（哪个词出现了几次）
    df        每个词出现在多少个片段里（Document Frequency）
    avgdl     所有片段的平均长度

BM25 打分只需要这三样东西，不需要把原文反复扫一遍。

⚠️ 这个文件里藏着整个项目最值钱的一段经验：SECTION_TF_WEIGHT（标题参与打分）。
   改动它之前，请先读 bm25_index.py 里那段注释。
"""

import array
import json
import os
import re

from tokenizer import tokenize, term_frequency

INDEX_VERSION = 3

# ---------------------------------------------------------------------------
# 标题（section）词频的计入权重。0.5，不是 1.0，也不是 0。
#
# 【起因】一条真实故障：
#   片段「3.2.1 总监理工程师应履行下列职责：」的正文是纯列表项
#   （"确定项目监理机构人员及其岗位职责。组织编制监理规划…"），
#   **一个"履行"字都没有**；而用户问的正是「总监理工程师应履行哪些职责」，
#   核心动词"履行"只存在于标题里。
#
#   结果：这个片段 BM25 近乎零分，在 94 个片段里排到第 16 名，
#   而 topK = 5，它根本进不了送给模型的那 5 条资料。
#   排第 1 的反而是「3.2.3 专业监理工程师应履行下列职责：」——
#   因为它的正文里恰好同时含"总监理工程师"和"履行"。
#   于是模型抱着一堆**专业**监理工程师的职责，回答
#   "总监理工程师的职责资料未收录"。
#
#   这个故障最难缠的地方：接口不报错、覆盖率也正常（3.2.3 的覆盖率高达 0.84，
#   远高于 0.34 的阈值），只有连上模型看回答内容才发现是错的。
#
# 【修法】把 section 的分词结果按 0.5 权重并入该片段的词频。
#   为什么是 0.5 而不是 1.0：标题是"标注"不是"内容"，不该与正文等权。
#   为什么不能是 0：那正是上面那个故障。
# ---------------------------------------------------------------------------
SECTION_TF_WEIGHT = 0.5

# section 词频计入的 token 数上限。
#
# 为什么需要封顶：BM25 公式里有长度归一化项 b*len/avgdl。对正文极短的片段
# （实测有个片段正文只有 21 个字），如果把标题的 40 来个 token 全额计入，
# len 会被撑到正文的数倍，长度归一化项随之被高估，反而把它的得分压下去 ——
# 与"帮标题说话"的初衷正好相反。
#
# 为什么是 24：按实测定的。真实标题「建设工程监理规范 GB/T 50319-2013 ›
# 3.2.1 总监理工程师应履行下列职责：」剥掉文档名前缀后还剩 24 个 token，
# 「履行」正好落在第 18 位。上限压到 16 就会把「履行」挤出去，3.2.1 立刻掉出 topK。
SECTION_TF_MAX_TOKENS = 24

# section 路径里的层级分隔符：分词前替换成空格，免得「理规范›3.2.1」粘连出噪声 bigram
SECTION_SEPARATOR_RE = re.compile(r'[›>»→/|]+')


def strip_doc_title_prefix(section, doc_title):
    """去掉 section 开头的文档名，只留真正的章节路径。

    例：'建设工程监理规范 GB/T 50319-2013 › 3.2.1 总监理工程师应履行下列职责：'
     →  '3.2.1 总监理工程师应履行下列职责：'

    理由：文档名会占掉十几个 token 的配额，而且它对"这段在讲什么"毫无信息量
    —— 所有片段都带同一个文档名，它恰恰是最没有区分度的部分。
    """
    s = str(section or '')
    t = str(doc_title or '').strip()
    if not t:
        return s
    idx = s.find('›')
    if idx == -1:
        return s
    head = s[:idx].strip()
    # 只在首段确实与文档名相关时才切，避免误伤"首段就是标题"的文档
    if head == t or head.startswith(t) or t.startswith(head):
        return s[idx + 1:].strip()
    return s


def pick_section_tokens(tokens, limit):
    """从标题的词表里挑出值得计入词频的部分：长词优先，单字垫底。

    为什么不能直接取"前 N 个"：
      分词器对中文段是【先单字、后相邻双字】两轮输出
      （「总监理工程师」→ 总 监 理 工 程 师 + 总监 监理 理工 工程 程师），
      前 N 个几乎全是单字，而真正有区分力的「履行」要到 30 名开外。
      直接取前 N 个，会把关键双字整批丢掉。

    次级规则：长词内部仍保持原顺序，于是『文档标题 › 章节标题』这个结构里，
      排在前面的长词是文档名部分的；但因为文档名已被 strip 掉，剩下的就是章节标题，
      用户的提问几乎总是复述章节标题 —— 这正是我们要的。
    """
    long_tokens = []
    single_tokens = []
    for t in tokens:
        (long_tokens if len(t) >= 2 else single_tokens).append(t)
    return (long_tokens + single_tokens)[:limit]


class KnowledgeIndex:
    """知识库索引：片段 + BM25 统计量（+ 可选向量）。"""

    def __init__(self):
        self.chunks = []
        self.chunk_tf = []        # [{token: 频次}, ...]
        self.chunk_len = []       # 每个片段的加权长度
        self.df = {}              # token -> 出现在几个片段里
        self.avgdl = 1.0
        self.vectors = None       # array('f')，按片段顺序平铺
        self.vector_dim = 0
        self.embed_model = ''

    # ------------------------------------------------------------------
    # 建索引
    # ------------------------------------------------------------------
    def build(self, chunks, title_weight=SECTION_TF_WEIGHT, tokenizer_fn=None):
        """重建全部统计量。改 title_weight=0 就能复现那个"答错人"的故障。

        两个参数都不是为了"灵活"，而是为了**做实验**：
          · title_weight  —— exp1_title_weight.py 靠它把排名翻转跑给你看；
          · tokenizer_fn  —— exp3_tokenizer_compare.py 靠它换成 jieba 分词，
                             让你亲眼看到"换一种分词器，排名就变了"。

        平时调用直接 build(chunks) 即可，两个参数都取默认值。
        """
        tk = tokenizer_fn or tokenize
        self.chunks = list(chunks)
        self.chunk_tf = []
        self.chunk_len = []
        self.df = {}

        total_len = 0
        for chunk in self.chunks:
            tf, length = term_frequency(tk(chunk['text']))
            chunk_len = length or 1

            # ---- 标题按较低权重并入词频（本文件的重点） ----
            section_text = SECTION_SEPARATOR_RE.sub(
                ' ', strip_doc_title_prefix(chunk.get('section'), chunk.get('docTitle'))
            )
            section_tokens = (
                pick_section_tokens(tk(section_text), SECTION_TF_MAX_TOKENS)
                if section_text else []
            )
            for token in section_tokens:
                tf[token] = tf.get(token, 0) + title_weight
            chunk_len += len(section_tokens) * title_weight

            self.chunk_tf.append(tf)
            self.chunk_len.append(chunk_len)
            total_len += chunk_len

            for token in tf:
                self.df[token] = self.df.get(token, 0) + 1

        self.avgdl = total_len / len(self.chunks) if self.chunks else 1.0
        return self

    # ------------------------------------------------------------------
    # 存取
    # ------------------------------------------------------------------
    def save(self, index_path, vectors_path=None):
        """落盘。JSON 存正文（人可读），向量另存二进制（省空间）。

        和项目一样：**不存词频**。词频每次启动重新分词算一遍，
        好处是统计口径永远与分词器版本一致 —— 改了分词器，索引自动跟着变，
        不会出现"索引里是老分词的统计、代码是新分词的规则"这种错位。
        """
        os.makedirs(os.path.dirname(os.path.abspath(index_path)), exist_ok=True)
        payload = {
            'version': INDEX_VERSION,
            'embedModel': self.embed_model,
            'vectorDim': self.vector_dim,
            'chunks': self.chunks,
        }
        with open(index_path, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)

        if vectors_path and self.vectors is not None and self.vector_dim > 0:
            buf = array.array('f', self.vectors)
            with open(vectors_path, 'wb') as fh:
                fh.write(buf.tobytes())
        return index_path

    def load(self, index_path, vectors_path=None):
        with open(index_path, 'r', encoding='utf-8') as fh:
            payload = json.load(fh)
        self.chunks = payload.get('chunks', [])
        self.embed_model = payload.get('embedModel', '')
        self.build(self.chunks)

        self.vectors = None
        self.vector_dim = 0
        if vectors_path and os.path.exists(vectors_path) and self.chunks:
            buf = array.array('f')
            with open(vectors_path, 'rb') as fh:
                buf.frombytes(fh.read())
            # 能整除才认，否则说明向量与片段已经错位，宁可丢弃也不能错配
            if buf and len(buf) % len(self.chunks) == 0:
                self.vectors = buf
                self.vector_dim = len(buf) // len(self.chunks)
        return self

    def has_vectors(self):
        return bool(
            self.vectors is not None
            and self.vector_dim > 0
            and len(self.vectors) == len(self.chunks) * self.vector_dim
        )

    def stats(self):
        return {
            'chunks': len(self.chunks),
            'vocabulary': len(self.df),
            'avgdl': round(self.avgdl, 3),
            'characters': sum(c.get('charCount', 0) for c in self.chunks),
            'vectorEnabled': self.has_vectors(),
        }
