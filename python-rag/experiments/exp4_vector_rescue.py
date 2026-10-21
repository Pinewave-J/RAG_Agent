"""
实验四：向量通道到底救回了什么？

这个实验回答一个很实际的问题：既然 BM25 已经够用，为什么还要花钱做向量化？

做法：同一份索引、同一个问题，跑两遍检索 ——
    第一遍：只用关键词通道（BM25）
    第二遍：关键词 + 语义（BM25 与向量余弦做 RRF 融合）
然后对比同一个片段的排名。

前提：索引里必须有向量。
      python build_index.py --embed

跑法：
    python experiments/exp4_vector_rescue.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from build_index import INDEX_PATH, VECTORS_PATH
from bm25_index import KnowledgeIndex
from config import RETRIEVAL, embed_configured
from retriever import search

SEP = '=' * 76
SUB = '-' * 76


def load():
    if not os.path.exists(INDEX_PATH):
        print('还没有索引。先执行：python build_index.py --embed')
        return None
    index = KnowledgeIndex().load(INDEX_PATH, VECTORS_PATH)
    if not index.has_vectors():
        print('索引里没有向量，这个实验跑不了。')
        print('请先执行：python build_index.py --embed')
        return None
    return index


def embed_query(question, index):
    from llm import LLMError, embed_texts
    try:
        vecs, dim = embed_texts([question])
    except LLMError as exc:
        print(f'向量化失败：{exc}')
        return None
    if not vecs or dim != index.vector_dim:
        print(f'向量维度不匹配（{dim} vs 索引的 {index.vector_dim}）')
        return None
    return vecs[0]


def rank_of(result, index, predicate):
    """在结果里找第一个满足条件的片段，返回 (名次, 片段)。名次从 1 开始。"""
    for rank, r in enumerate(result['results'], 1):
        if predicate(r):
            return rank, r
    return None, None


def compare(index, question, targets):
    print('')
    print(SEP)
    print(f'问题：{question}')
    print(SEP)

    query_vector = embed_query(question, index)
    if query_vector is None:
        return

    kw = search(index, question, top_k=RETRIEVAL['top_k'],
                candidates=RETRIEVAL['candidates'], rrf_k=RETRIEVAL['rrf_k'])
    hy = search(index, question, top_k=RETRIEVAL['top_k'],
                candidates=RETRIEVAL['candidates'], rrf_k=RETRIEVAL['rrf_k'],
                query_vector=query_vector)

    print(f"关键词模式：{kw['mode']}    混合模式：{hy['mode']}")
    print('')

    print(f"{'片段':<34}{'关键词排名':>10}{'混合排名':>10}   变化")
    print(SUB)
    for label, pred in targets:
        k_rank, k_item = rank_of(kw, index, pred)
        h_rank, h_item = rank_of(hy, index, pred)

        def fmt(r, item):
            if r is None:
                return '—'
            return f'第 {r} 名'

        mark = ''
        if k_rank is not None and h_rank is not None:
            if h_rank < k_rank:
                mark = f'↑ 前进 {k_rank - h_rank} 名'
            elif h_rank > k_rank:
                mark = f'↓ 后退 {k_rank - h_rank} 名'
            else:
                mark = '持平'
        elif k_rank is None and h_rank is not None:
            mark = '↑ 进入 top5'
        elif k_rank is not None and h_rank is None:
            mark = '↓ 掉出 top5'
        elif k_rank is None and h_rank is None:
            mark = '两者都没进'

        print(f'{label:<34}{fmt(k_rank, k_item):>10}{fmt(h_rank, h_item):>10}   {mark}')

    print('')
    print('混合模式下送进模型的 5 条资料：')
    for rank, r in enumerate(hy['results'], 1):
        tag = ''
        for label, pred in targets:
            if pred(r):
                tag = f'  ← {label}'
                break
        print(f"  [{rank}] 融合分={r['score']:<8} BM25={r['bm25']:<9}"
              f" 余弦={r['vectorSim']:<8} 覆盖={r['coverage']}{tag}")
        print(f"       {r['section']}")


def is_321(r):
    return (r.get('section') or '').find('3.2.1') >= 0


def is_323(r):
    return (r.get('section') or '').find('3.2.3') >= 0


def main():
    index = load()
    if index is None:
        return 1

    if not embed_configured():
        print('未配置 EMBED_BASE_URL / EMBED_API_KEY，无法做这个对比。')
        return 1

    print('')
    print(SEP)
    print('实验四：向量通道到底救回了什么？')
    print(SEP)
    print(f"语料：{len(index.chunks)} 个片段，维度 {index.vector_dim}，"
          f"向量模型 {index.embed_model}")
    print(f"RRF k = {RETRIEVAL['rrf_k']}，候选 {RETRIEVAL['candidates']} 条，topK = {RETRIEVAL['top_k']}")

    # 这一问是"关键词能搜到、但排序不对"的典型（标题参与打分修的就是它）
    compare(index, '总监理工程师应履行哪些职责', [
        ('3.2.1 总监理工程师（主片段）', lambda r: is_321(r) and len(r['text']) > 100),
        ('3.2.1 总监理工程师（短片段）', lambda r: is_321(r) and len(r['text']) <= 100),
        ('3.2.3 专业监理工程师', is_323),
    ])

    # 这一问是"关键词会找到字面相同、意思不同的资料"的典型（第 06 章那个例子）
    compare(index, '如何申请营业执照', [
        ('含"营业执照"的资料', lambda r: '营业执照' in (r['text'] or '')),
    ])

    print('')
    print(SEP)
    print('该怎么读这些数字')
    print(SEP)
    print("""
  1) 关键词通道修的是"字面命中"，向量通道修的是"意思接近"。
     两者做 RRF 融合，不是"谁替代谁"，而是"谁各有各的盲区"。

  2) 看"前进 X 名"那一列：如果某个片段在混合模式下明显上升，
     说明它和问题的**语义**很接近，但用词不够重合 ——
     这正是纯关键词检索会漏掉的那一类。

  3) 看"余弦"那一列：向量通道给出的分数永远在 0~1 之间，
     而 BM25 可以是 30 分也可以是 0.6 分。
     **两者量纲完全不同，所以只能融排名、不能融分数** —— 这就是 RRF 存在的理由。

  4) 也要接受一个现实：融合不总是"只升不降"。
     某条资料可能因为语义上不够像而被挤下去。
     所以"开了向量就一定更好"是错的 —— 正确说法是
     "多了一路独立的判断，整体更稳，个别情况会变"。
     真正该做的，是像这个实验一样**把两种模式的排名并排打出来看**。
""")
    return 0


if __name__ == '__main__':
    sys.exit(main())
