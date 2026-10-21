"""
中文分词器 —— 项目 tokenizer.js 的 Python 移植版。

这个文件是整个 RAG 的地基：所有检索、打分、闸门判断都建立在"文本被切成了哪些词"
这件事上。切错了，后面全错。

设计取舍（和 JS 版一致，别改）：
    不引入 jieba 这类需要词典的分词器，改用「CJK 单字 + 相邻双字（bigram）」的组合切分。
    原因是：中文里绝大多数双字词都能被 bigram 覆盖，配合 BM25 的 idf 抑制单字噪声，
    召回效果足够支撑知识库问答，而且零依赖、跨平台、结果完全可预测。

    代价是会产生大量跨词边界的"噪声词"（「如何申请营业执照」会切出「何申」「请营」「业执」），
    这个代价在闸门那一层被专门处理 —— 见 retriever.py 的 select_gate_terms。
"""

import re

# ---------------------------------------------------------------------------
# 停用词表：和 JS 版逐字一致。
#
# ⚠️ 这张表在项目里有一个"血泪史"：它的过滤只发生在【单字】那一轮，
#    双字轮不查表。于是「什么」「哪些」这类疑问词会以双字形态溜进查询词，
#    导致闸门（判断"知识库到底覆没覆盖这个问题"）整体失效 —— 详见 retriever.py。
# ---------------------------------------------------------------------------
STOPWORDS = frozenset([
    # 虚词、助词、语气词
    '的', '了', '是', '在', '和', '与', '及', '或', '而', '并', '且', '也', '都', '就',
    '等', '之', '其', '被', '把', '让', '给', '从', '到', '由', '对', '为', '以', '于',
    '上', '下', '中', '内', '外', '前', '后', '个', '些', '有', '无', '不', '没', '很',
    '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '着', '过', '地', '得', '要', '会', '能',
    '可', '应', '该', '请', '我', '你', '他', '她', '它', '们', '这', '那', '哪',
    # 疑问句式高频词（保留会稀释检索信号）
    '什么', '怎么', '如何', '哪些', '哪个', '为什么', '是否', '多少', '请问', '一下',
    '一个', '一种', '一些', '以及', '同时', '因此', '所以', '但是', '然而', '如果',
    '那么', '这个', '那个', '我们', '你们', '他们', '可以', '需要', '进行', '关于',
    # 英文停用词
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'of', 'to', 'in', 'on', 'for',
    'and', 'or', 'not', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'how',
    'what', 'why', 'which', 'can', 'do', 'does'
])

# 中日韩表意字符：基本区 + 扩展A + 兼容表意文字
CJK_RE = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]')

# 切分规则：一段连续汉字，或者一个"以字母数字开头"的英文/数字/版本号片段
TOKEN_RE = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+|[a-z0-9][a-z0-9._+#-]*')


def normalize(text):
    """全角转半角 + 转小写 + 压缩空白。

    为什么要做这一步：用户从 Word / 微信里复制来的问题常常夹着全角字符
    （ＡＢＣ、ＧＢ／Ｔ）和多余空格。如果不归一化，同一个词会变成两个不同的 token，
    检索时互相匹配不上 —— 这类问题极难排查，因为表面看"字明明一样"。
    """
    if not text:
        return ''
    s = str(text)
    # 全角 ASCII（！到～）转半角：与半角相差 0xfee0
    s = re.sub(r'[\uff01-\uff5e]', lambda m: chr(ord(m.group(0)) - 0xfee0), s)
    s = s.replace('\u3000', ' ')          # 全角空格
    s = s.lower()
    s = re.sub(r'[\r\n\t]+', ' ', s)
    s = re.sub(r'\s{2,}', ' ', s)
    return s.strip()


def is_cjk(ch):
    """判断单个字符是不是中日韩表意文字。"""
    return bool(CJK_RE.match(ch))


def tokenize(text):
    """把文本切成检索用的 token 列表（保留重复，因为后面要统计词频）。

    这是全项目最关键的函数之一。以「总监理工程师应履行哪些职责」为例，
    输出是 21 个 token：

        单字轮：总 监 理 工 程 师 履 行 职 责     <- 「应」被停用词表吃掉了
        双字轮：总监 监理 理工 工程 程师 师应 应履 履行 行哪 些职 职责

    注意「师应」「应履」「履行」这三个：它们不是真正的词，是 bigram 的产物。
    但正因为有它们，用户问"应履行哪些职责"时才能命中标题里的"应履行下列职责"。
    """
    norm = normalize(text)
    if not norm:
        return []

    tokens = []
    for seg in TOKEN_RE.findall(norm):
        if is_cjk(seg[0]):
            chars = list(seg)

            # 第一轮：单字（过滤虚词）
            for ch in chars:
                if ch not in STOPWORDS:
                    tokens.append(ch)

            # 第二轮：相邻双字 bigram —— 中文双字词的主要来源
            for i in range(len(chars) - 1):
                # 两个字都是虚词的组合没有信息量，跳过
                if chars[i] in STOPWORDS and chars[i + 1] in STOPWORDS:
                    continue
                tokens.append(chars[i] + chars[i + 1])
        else:
            # 英文 / 数字 / 版本号：长度为 1 的会带来大量噪声，直接丢弃
            if len(seg) >= 2 and seg not in STOPWORDS:
                tokens.append(seg)

    return tokens


def unique_terms(text, keep_stopwords=False):
    """切成去重后的词组，按首次出现顺序排列。

    用途：覆盖率计算、界面上的"命中词"展示。顺序很重要 ——
    去重后仍要能看出"哪个词先出现"，调试时很有用。
    """
    seen = set()
    out = []
    for t in tokenize(text):
        if not keep_stopwords and t in STOPWORDS:
            continue
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def term_frequency(tokens):
    """统计词频。返回 (词频字典, token 总数)。

    token 总数（len）会进入 BM25 的长度归一化项：片段越长，单个词命中越"不值钱"，
    防止长片段因为"碰巧词多"而霸榜。
    """
    tf = {}
    for t in tokens:
        tf[t] = tf.get(t, 0) + 1
    return tf, len(tokens)


# ---------------------------------------------------------------------------
# 第二种分词：jieba（对照用，不是主流程）
#
# 之所以要把两种都写出来，是因为这是"换语言"时最容易踩的坑：
# jieba 是词典分词，会把「总监理工程师」切成「总监理/工程师」这样的真词；
# 而项目用的是 bigram，「程师」「师应」这种"不是词的词"也会进索引。
# 两者切出来的东西完全不同 -> BM25 分数完全不同 -> 排名也会变。
#
# 运行方式：python experiments/exp3_tokenizer_compare.py
# ---------------------------------------------------------------------------

def tokenize_jieba(text):
    """用 jieba 分词（需 pip install jieba）。仅用于对照实验。

    注意还有两个过滤动作，否则 jieba 的结果没法公平比较：
      1. 滤掉停用词；     2. 滤掉长度 1 的片段（噪声太大）。
    """
    try:
        import jieba
        import logging
        jieba.setLogLevel(logging.ERROR)   # 压掉启动时那几行 "Building prefix dict..."
    except ImportError as exc:  # pragma: no cover - 只在没装 jieba 时触发
        raise ImportError(
            '缺少 jieba。请执行：pip install jieba\n'
            '（这一步只是对照实验用的，主流程不需要它）'
        ) from exc

    norm = normalize(text)
    if not norm:
        return []

    tokens = []
    for w in jieba.cut(norm):
        w = w.strip()
        if not w:
            continue
        if w in STOPWORDS:
            continue
        if len(w) < 2:
            continue
        tokens.append(w)
    return tokens
