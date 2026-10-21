"""
实验一：标题权重 —— 亲眼看着排名翻转。

这是整个项目里最值钱的一个实验。它会让你看到：
**一个"看起来只是个元数据"的字段，如何决定系统是答对还是答错。**

跑法：
    python experiments/exp1_title_weight.py
    python experiments/exp1_title_weight.py "专业监理工程师应履行哪些职责"

背景（一句话版）：
    「3.2.1 总监理工程师应履行下列职责：」这一段的正文里，
    **一个"履行"字都没有** —— 那个词只出现在标题里。
    而用户问的恰恰是"应履行哪些职责"。
    如果标题不参与打分，这一段的 BM25 分数几乎为零，直接掉出送进模型的前 5 条。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from build_index import build                                   # noqa: E402
from config import CONFIG, RETRIEVAL                            # noqa: E402
from retriever import coverage_of, search_bm25, select_gate_terms  # noqa: E402
from tokenizer import tokenize                                  # noqa: E402

DEFAULT_QUESTION = '总监理工程师应履行哪些职责'


def find_chunks(index, keyword):
    """找出 section 里含某个关键词的片段下标。"""
    return [i for i, c in enumerate(index.chunks) if keyword in (c.get('section') or '')]


def main():
    question = ' '.join(sys.argv[1:]).strip() or DEFAULT_QUESTION

    print('')
    print('=' * 72)
    print('实验一：标题（section）参与打分的权重，如何影响排名')
    print('=' * 72)
    print(f'问题：{question}')
    print(f'topK = {RETRIEVAL["top_k"]}（只有排进前 {RETRIEVAL["top_k"]} 名的片段才会被送进模型）')
    print('')

    tokens = tokenize(question)
    query_terms = list(dict.fromkeys(tokens))
    print(f'查询被切成 {len(tokens)} 个 token，去重后 {len(query_terms)} 个：')
    print(f'  {" ".join(query_terms)}')
    print('')

    # 只看标题里有没有这些词，就能理解后面会发生什么
    print('这些词里，哪些只在标题里出现？')
    print('-' * 72)

    weights = [0, 0.25, 0.5, 1.0]
    rows = []

    for w in weights:
        index, _ = build(CONFIG['kb_dir'], title_weight=w, verbose=False)

        if w == 0:
            i321 = find_chunks(index, '3.2.1 总监理工程师')
            i323 = find_chunks(index, '3.2.3 专业监理工程师')
            probe = i321[0] if i321 else None
            if probe is not None:
                body_tokens = set(tokenize(index.chunks[probe]['text']))
                in_title_only = [t for t in query_terms if t not in body_tokens]
                print(f'以片段 idx={probe}（3.2.1 的第一片）为例，')
                print(f'它的**正文**里找不到这些查询词：{" ".join(in_title_only) if in_title_only else "（没有）"}')
                print('    -> 这些词全部只存在于标题里，标题不参与打分，它们就等于不存在')
                print('-' * 72)

        ranked = search_bm25(index, tokens, 10 ** 6)
        rank_of = {item['index']: pos + 1 for pos, item in enumerate(ranked)}
        gate = select_gate_terms(index, query_terms)

        row = {'weight': w, 'avgdl': index.avgdl, 'gate': len(gate), 'items': []}
        for label, key in (('3.2.1 总监理', '3.2.1 总监理工程师'), ('3.2.3 专业监理', '3.2.3 专业监理工程师')):
            for i in find_chunks(index, key):
                row['items'].append({
                    'label': label,
                    'index': i,
                    'rank': rank_of.get(i, 0),
                    'coverage': coverage_of(index, gate, i),
                    'len': len(index.chunks[i]['text']),
                })
        rows.append(row)

    # ---- 打印对比表 ----
    print('')
    print('权重    平均片段长    片段                排名       覆盖率   结果')
    print('-' * 78)
    for row in rows:
        first = True
        for item in row['items']:
            rank = item['rank']
            in_topk = rank != 0 and rank <= RETRIEVAL['top_k']
            verdict = '送进模型' if in_topk else f"没进前 {RETRIEVAL['top_k']} 名，模型看不到"
            head = f"{row['weight']:<6} {row['avgdl']:>10.1f}    " if first else ' ' * 19
            print(f"{head}{item['label']:<18} 第 {rank:>3} 名   {item['coverage']:.3f}    {verdict}")
            first = False
        print('')

    # ---- 结论 ----
    w0 = rows[0]
    w5 = rows[2]
    print('=' * 72)
    print('结论')
    print('=' * 72)

    def pick(row, label):
        return [x for x in row['items'] if x['label'] == label]

    for label in ('3.2.1 总监理', '3.2.3 专业监理'):
        a = pick(w0, label)
        b = pick(w5, label)
        if a and b:
            # 一个章节可能被切成多个片段，决定"能不能被送进模型"的是其中最好的名次
            best_a = min(x['rank'] for x in a) or 999
            best_b = min(x['rank'] for x in b if x['rank']) or 999
            in_a = '能' if best_a <= RETRIEVAL['top_k'] else '不能'
            in_b = '能' if best_b <= RETRIEVAL['top_k'] else '不能'
            print(f'  {label}（共 {len(a)} 个片段）：')
            print(f'      权重 0    -> 最好名次 第 {best_a} 名，{in_a}进前 {RETRIEVAL["top_k"]}')
            print(f'      权重 0.5  -> 最好名次 第 {best_b} 名，{in_b}进前 {RETRIEVAL["top_k"]}')
    print('')
    print('  注意两件事：')
    print('  1) 权重为 0 时，"3.2.1"排不进前 5 名 —— 模型根本看不到它，')
    print('      于是抱着一堆"专业监理工程师"的职责去回答"总监理工程师"，')
    print('      最后说出"资料未收录"。而接口不报错、覆盖率也不低。')
    print('  2) 把权重调到 0.5 之后，3.2.1 挤进了前 5 名 —— 但**并不保证排第 1**。')
    print('      3.2.3 的正文里同时含"总监理工程师"和"履行"，它的 BM25 天然更高。')
    print('      所以标题权重解决的是"正确答案能否进入视野"，不是"让它排第一"。')
    print('')
    print('  这就是为什么这一段代码值得写几十行注释：')
    print('  它是"资料明明有、模型却说没有"这类问题的根因，')
    print('  而且它不报错、不告警，只有读答案内容才发现。')
    print('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
