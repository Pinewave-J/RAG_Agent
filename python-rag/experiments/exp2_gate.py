"""
实验二：闸门 —— 看清"该拒的有没有拒"。

闸门是 RAG 里最容易被写坏、又最难发现坏掉的一环。
它会以两种方式失效，而**只有一种会暴露**：

  · 太严 -> 该答的答不出来   -> 用户立刻会抱怨
  · 太松 -> 该拒的没拒       -> 没人发现，直到模型编出一个像模像样的答案

这个脚本把闸门的每一个判断都摊开给你看，并亲手复现那个曾经让闸门
**整体静默失效**的缺陷。

跑法：
    python experiments/exp2_gate.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bm25_index import KnowledgeIndex                      # noqa: E402
from build_index import build                              # noqa: E402
from config import CONFIG, RETRIEVAL                       # noqa: E402
from retriever import coverage_of, idf, search_bm25        # noqa: E402
from tokenizer import STOPWORDS, tokenize                  # noqa: E402

QUESTIONS = [
    '总监理工程师应履行哪些职责',
    '投标保证金什么时候退还',
    '如何申请营业执照',
    '锟鹏锴钺钉是什么',            # 生造词：知识库里绝无此物
    '今天上海的天气怎么样',        # 完全无关
]


def explain_gate(index, question):
    """逐步解释：每个查询词为什么被留下或被丢掉。"""
    n = len(index.chunks)
    tokens = tokenize(question)
    query_terms = list(dict.fromkeys(tokens))

    kept = []
    dropped = []
    for term in query_terms:
        if len(term) < 2:
            dropped.append((term, '长度 < 2（中文单字噪声太大）'))
            continue
        if term in STOPWORDS:
            dropped.append((term, '是停用词（疑问词/虚词，遍布语料，会让闸门失效）'))
            continue
        df = index.df.get(term, 0)
        if df <= 0:
            dropped.append((term, '语料里不存在 (df=0) —— bigram 切出的跨词边界噪声'))
            continue
        if n > 1 and df >= n:
            dropped.append((term, f'出现在每一个片段里 (df={df}=N)，只会把分数拉平'))
            continue
        kept.append((term, df, idf(df, n)))

    return tokens, query_terms, kept, dropped


def gate_coverage(index, gate_terms, question):
    """返回 (最佳覆盖率, 最佳片段下标)。"""
    ranked = search_bm25(index, tokenize(question), 1)
    if not ranked:
        return 0.0, None
    best = ranked[0]['index']
    return coverage_of(index, gate_terms, best), best


def select_gate_terms_buggy(index, query_terms):
    """复现那个"曾经让闸门整体失效"的版本：**没有过滤停用词**。

    只有这一行差别。后果请见脚本输出。
    """
    n = len(index.chunks)
    out = []
    for term in query_terms:
        if len(term) < 2:
            continue
        freq = index.df.get(term, 0)
        if freq <= 0:
            continue
        if n > 1 and freq >= n:
            continue
        out.append(term)
    return out


def main():
    print('')
    print('=' * 72)
    print('实验二：检索闸门 —— 判断"知识库到底覆没覆盖这个问题"')
    print('=' * 72)

    index, _ = build(CONFIG['kb_dir'], verbose=False)
    n = len(index.chunks)
    print(f'语料：{n} 个片段，词表 {len(index.df)} 个词，阈值 {RETRIEVAL["min_coverage"]}')
    print('')

    for question in QUESTIONS:
        tokens, query_terms, kept, dropped = explain_gate(index, question)

        print('=' * 72)
        print(f'问题：{question}')
        print(f'  tokenize 产出 {len(tokens)} 个 token，去重后 {len(query_terms)} 个')
        print('-' * 72)

        print(f'  ✔ 成为闸门词（{len(kept)} 个）：      ← 越罕见的词 idf 越大，越"值钱"')
        for term, df, term_idf in kept:
            print(f'      {term:<10} df={df:<5} idf={term_idf:.3f}')
        if not kept:
            print('      （一个都没有 —— 这是"未覆盖"最强有力的信号）')

        print(f'  ✘ 被丢弃（{len(dropped)} 个）：')
        for term, why in dropped:
            print(f'      {term:<10} {why}')

        gate_terms = [t for t, _, _ in kept]
        coverage, best_idx = gate_coverage(index, gate_terms, question)
        # 没有闸门词时，覆盖率按 0 处理
        if not gate_terms:
            coverage = 0.0

        gate_ok = bool(gate_terms) and coverage >= RETRIEVAL['min_coverage']
        print('')
        print(f'  最佳片段 idx={best_idx}  覆盖率 = {coverage:.4f}   '
              f'阈值 = {RETRIEVAL["min_coverage"]}')
        if gate_ok:
            print('  -> 闸门放行，调用模型')
        else:
            print('  -> 闸门拦截：直接兜底，**不调用模型**（零成本 + 零编造）')

    # ------------------------------------------------------------------
    print('')
    print('=' * 72)
    print('对照：如果闸门忘了过滤停用词，会发生什么？')
    print('=' * 72)
    print('')
    print('这是一个真实存在过的缺陷。差别只有一行代码：')
    print('  select_gate_terms() 里有 `if term in STOPWORDS: continue`，')
    print('  而当年那个版本没有这一行。')
    print('')

    question = '锟鹏锴钺钉是什么'
    tokens = tokenize(question)
    query_terms = list(dict.fromkeys(tokens))

    good = [t for t, _, _ in explain_gate(index, question)[2]]
    bad = select_gate_terms_buggy(index, query_terms)

    cov_good, _ = gate_coverage(index, good, question)
    cov_bad, _ = gate_coverage(index, bad, question)
    if not good:
        cov_good = 0.0

    print(f'问题：{question}（生造词，知识库里绝对没有这个东西）')
    print('')
    print(f'  修复后：闸门词 = {good if good else "（空）"}')
    print(f'          覆盖率 = {cov_good:.4f}  -> uncovered = {not (good and cov_good >= RETRIEVAL["min_coverage"])}')
    print(f'  缺陷版：闸门词 = {bad}')
    print(f'          覆盖率 = {cov_bad:.4f}  -> uncovered = {not (bad and cov_bad >= RETRIEVAL["min_coverage"])}')
    print('')
    print('  看到了吗 —— 缺陷版里，闸门词退化到只剩「什么」，')
    print('  而任何片段都能命中「什么」，于是覆盖率恒为 1.0，闸门等于不存在。')
    print('')
    print('  为什么这个 bug 能潜伏很久？因为它让闸门**更宽松**：')
    print('  表面上"该答的都能答"，只有"该拒的没拒"才会暴露，')
    print('  而且还得恰好问到边缘案例才看得出来。')
    print('')
    print('  根因在分词的实现细节上：tokenize() 对中文段分两轮输出，')
    print('  先单字（查停用词表）、后相邻双字（**不查**）。')
    print('  于是「什么」以双字形态溜进来，躲过了第一道过滤。')
    print('  所以停用词表必须在闸门这一层**再滤一次**。')
    print('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
