"""
混合检索层 —— 项目 retriever.js 的 Python 移植版。

两条通道：
    关键词通道：BM25（k1=1.5, b=0.75），词条来自中文 bigram 分词器
    语义通道  ：向量余弦相似度（需要向量服务，可选）
融合：
    RRF（Reciprocal Rank Fusion）—— 对两路排名做倒数求和。
    为什么不把两个分数加权相加？因为 BM25 的分数可以是 30 分也可以是 3 分，
    而余弦相似度永远在 0~1 之间。两个量纲不同的东西直接相加，
    等于让 BM25 单方面决定排序。RRF 只关心"排第几"，天然免疫这个问题。

兜底判定（本文件的第二个重点）：
    单独用一个可解释的「查询词加权覆盖率」做闸门 ——
    覆盖率 = 最佳片段命中的查询词 idf 之和 / 全部查询词 idf 之和。
    低于阈值即判定"知识库没覆盖这个问题"，直接兜底，**不调用大模型**。
    既省钱，又从根上杜绝模型"强行作答"。
"""

import math

from bm25_index import KnowledgeIndex
from tokenizer import STOPWORDS, tokenize

BM25_K1 = 1.5
BM25_B = 0.75


def idf(df, n):
    """标准 BM25 的 idf，加 0.5 平滑。

    为什么要加 0.5：一个词出现在所有片段里时（df == N），
    原始公式会算出负数，导致"命中它反而扣分"这种荒谬结果。
    平滑之后 idf 恒为正。

    idf 的直觉：越罕见的词越值钱。「监理」这种词在监理资料里到处都是，
    区分度低；「保证金」只在少数片段出现，一命中就说明找对地方了。
    """
    return math.log(1 + (n - df + 0.5) / (df + 0.5))


def search_bm25(index: KnowledgeIndex, tokens, limit):
    """关键词通道检索，返回按分数降序的 [{index, score}]。"""
    chunks = index.chunks
    n = len(chunks)
    if n == 0:
        return []

    # 查询词去重并统计查询内词频（问题里重复出现的词权重更高）
    query_tf = {}
    for t in tokens:
        query_tf[t] = query_tf.get(t, 0) + 1

    scored = []
    for i in range(n):
        tf = index.chunk_tf[i]
        length = index.chunk_len[i]
        score = 0.0

        for token, q_count in query_tf.items():
            f = tf.get(token)
            if not f:
                continue

            term_idf = idf(index.df.get(token, 0), n)
            # 查询词自身的重复做了对数压缩，避免问句里重复某个词就把排序带偏
            q_weight = 1 + math.log(q_count)

            denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * length) / index.avgdl)
            score += term_idf * ((f * (BM25_K1 + 1)) / denom) * q_weight

        if score > 0:
            scored.append({'index': i, 'score': score})

    scored.sort(key=lambda x: -x['score'])
    return scored[:limit]


def search_vector(index: KnowledgeIndex, query_vector, limit):
    """向量通道检索（余弦相似度）。纯内存浮点运算，没有 I/O。

    ⚠️ 项目里这里有一个真实事故值得记住：
    JS 版的这个函数一度被写成 async（异步）。它的调用方 search() 却是**同步**的。
    于是只要传入了查询向量，调用方拿到的就是 Promise 而不是数组，
    紧接着的 .map() 直接抛 "vectorList.map is not a function"。
    最恶劣的是：**它只在"已生成向量"之后才触发** —— 关键词模式一直正常，
    一开混合检索，所有问答立刻报"服务端异常"。

    教训：给同步函数加检索通道时，新函数也必须是同步的。
    在 Python 里没有 async/await 滥用的问题（写 async 就得 await，编译期能看出来），
    但"只在开启某个可选功能后才出现的 bug"这个坑，语言无关。
    """
    if not index.has_vectors():
        return []

    dim = index.vector_dim
    n = len(index.chunks)
    vectors = index.vectors

    query_norm = 0.0
    for d in range(dim):
        query_norm += query_vector[d] * query_vector[d]
    query_norm = math.sqrt(query_norm)
    if query_norm == 0:
        return []

    scored = []
    for i in range(n):
        base = i * dim
        dot = 0.0
        norm = 0.0
        for d in range(dim):
            v = vectors[base + d]
            dot += v * query_vector[d]
            norm += v * v
        if norm == 0:
            continue
        scored.append({'index': i, 'score': dot / (math.sqrt(norm) * query_norm)})

    scored.sort(key=lambda x: -x['score'])
    return scored[:limit]


def fuse_rrf(lists, k):
    """RRF 融合：score = Σ 1 / (k + rank)，rank 从 1 开始。

    k 的作用是"削峰"：k 很小时第 1 名和第 2 名的差距巨大，k 很大时差距变小。
    标准取值 60，出自 2009 年那篇提出 RRF 的论文，一直沿用到今天。

    注意这里**只用排名，不用分数**。所以哪怕 BM25 的分数量纲和余弦完全不同，
    融合结果依然稳健 —— 这是 RRF 最聪明的地方。
    """
    merged = {}

    for lst in lists:
        for rank, item in enumerate(lst):
            entry = merged.setdefault(item['index'], {'index': item['index'], 'rrf': 0.0, 'ranks': []})
            entry['rrf'] += 1 / (k + rank + 1)
            entry['ranks'].append(rank + 1)

    # 归一化到 0~1：理论最大值是"每一路都排第 1"
    max_rrf = len(lists) / (k + 1)
    out = []
    for entry in merged.values():
        entry = dict(entry)
        entry['score'] = entry['rrf'] / max_rrf if max_rrf > 0 else 0
        out.append(entry)

    out.sort(key=lambda x: -x['rrf'])
    return out


def select_gate_terms(index: KnowledgeIndex, query_terms):
    """挑出用于计算覆盖率的「闸门词」。本文件的重点，务必读完。

    为什么不能直接用全部查询词？
      中文 bigram 分词必然产生跨词边界的噪声词：「如何申请营业执照」会切出
      「何申」「请营」「业执」。这些词在语料里根本不存在（df = 0），
      如果计入覆盖率的分母，分母会被稀释掉，分数随之失去区分度。

    因此四个筛选条件，每一条都有原因：
      1) 长度 >= 2      —— 中文单字噪声太大（"上""的""天"），几乎没有区分力；
      2) 不是停用词      —— 见下面那段，这条曾经缺失，导致闸门整体静默失效；
      3) df > 0         —— 语料里根本不存在的词不该进分母；
      4) df < 片段总数   —— 出现在**每一个**片段里的词只会把所有人的分数一起拉平。

    若一条都不剩，说明查询里的多字词知识库一个都不认识 ——
    这是"未覆盖"最强有力的信号，覆盖率按 0 处理（所以在 search 里直接兜底）。

    ── 第 2 条为什么曾经缺失，以及后果 ──
    tokenize() 对中文段分两轮输出：先单字（查停用词表）、后相邻双字（**当时没查**）。
    于是「什么」「怎么」「哪些」这类疑问词会以**双字**形态溜进查询词表，
    而它们又广泛存在于语料中 -> 轻松满足 df>0 且 df<N -> 全部通过筛选。

    后果是灾难性的：一句「XXX是什么」的闸门词会退化到只剩「什么」，
    任何片段都能命中它，覆盖率恒为 1.0 —— **闸门等于不存在**。
    实测（问一个生造词「锟鹏锴钺钉是什么」，知识库里绝无此物）：
        修复前：uncovered=false, coverage=1.00   <- 闸门完全失效
        修复后：uncovered=true， coverage=0      <- 正确拦下

    这个缺陷之所以长期潜伏，是因为它让闸门**更宽松**：表面上"该答的都能答"，
    只有"该拒的没拒"才会暴露，而且还得恰好问到边缘案例。
    """
    n = len(index.chunks)
    out = []
    for term in query_terms:
        if len(term) < 2:
            continue
        if term in STOPWORDS:
            continue
        freq = index.df.get(term, 0)
        if freq <= 0:
            continue
        if n > 1 and freq >= n:
            continue
        out.append(term)
    return out


def coverage_of(index: KnowledgeIndex, gate_terms, chunk_index):
    """查询词加权覆盖率：衡量某个片段对问题的覆盖程度，取值 0~1。

    注意这里直接复用 chunk_tf —— 它**已经包含按 0.5 权重并入的 section 词频**。
    这是刻意的，不是偷懒：
      闸门的功能是判断"这个片段到底有没有在讲用户问的事"，
      而标题恰恰是最能说明"这段在讲什么"的一句话。
    如果覆盖率只看正文，就会出现"打分认了标题、闸门却不认"的口径分裂 ——
    同一份片段在两个环节得到互相矛盾的结论，排查起来极其痛苦。
    """
    n = len(index.chunks)
    tf = index.chunk_tf[chunk_index]

    total = 0.0
    hit = 0.0
    for term in gate_terms:
        weight = idf(index.df.get(term, 0), n)
        total += weight
        if tf.get(term):
            hit += weight
    return hit / total if total > 0 else 0.0


def search(index: KnowledgeIndex, query, top_k=5, candidates=20, min_coverage=0.34,
           rrf_k=60, query_vector=None):
    """主检索入口。返回一个 dict，字段与 JS 版一一对应，方便对账。"""
    tokens = tokenize(query)
    query_terms = list(dict.fromkeys(tokens))     # 去重但保持顺序

    empty = {
        'mode': 'empty', 'hit': False, 'uncovered': True, 'coverage': 0.0,
        'threshold': min_coverage, 'gateTerms': [], 'results': [],
        'stats': {'chunks': len(index.chunks), 'queryTerms': len(query_terms), 'gateTerms': 0},
    }

    if len(index.chunks) == 0:
        return empty
    if not query_terms:
        return dict(empty, mode='no-terms')

    keyword_list = search_bm25(index, tokens, candidates)
    vector_list = search_vector(index, query_vector, candidates) if query_vector is not None else []
    has_vector_channel = len(vector_list) > 0

    if has_vector_channel:
        fused = fuse_rrf([keyword_list, vector_list], rrf_k)
    else:
        # 只有一路时不需要真融合，但仍要造出同样的结构（score 退化为名次分）
        fused = [
            {'index': item['index'], 'rrf': item['score'], 'ranks': [rank + 1],
             'score': 1.0 if rank == 0 else 1 / (rank + 1)}
            for rank, item in enumerate(keyword_list)
        ]

    gate_terms = select_gate_terms(index, query_terms)

    keyword_score = {item['index']: item['score'] for item in keyword_list}
    vector_score = {item['index']: item['score'] for item in vector_list}

    ranked = []
    for item in fused[:max(top_k, 8)]:
        chunk = index.chunks[item['index']]
        ranked.append({
            'index': item['index'],
            'id': chunk.get('id'),
            'docId': chunk.get('docId'),
            'docTitle': chunk.get('docTitle'),
            'source': chunk.get('source'),
            'section': chunk.get('section'),
            'text': chunk.get('text'),
            'score': round(item['score'], 4),
            'bm25': round(keyword_score.get(item['index'], 0.0), 4),
            'vectorSim': round(vector_score.get(item['index'], 0.0), 4),
            'coverage': round(coverage_of(index, gate_terms, item['index']), 4),
        })

    best_coverage = max([r['coverage'] for r in ranked], default=0.0)
    uncovered = (not ranked) or (not gate_terms) or (best_coverage < min_coverage)

    return {
        'mode': 'hybrid' if has_vector_channel else 'keyword',
        'hit': bool(ranked) and not uncovered,
        'uncovered': uncovered,
        'coverage': round(best_coverage, 4),
        'threshold': min_coverage,
        'gateTerms': gate_terms,
        'results': ranked[:top_k],
        'stats': {
            'chunks': len(index.chunks),
            'queryTerms': len(query_terms),
            'gateTerms': len(gate_terms),
            'keywordHits': len(keyword_list),
            'vectorHits': len(vector_list),
        },
    }
