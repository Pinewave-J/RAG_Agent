"""
实验三：换一种分词器，排名就变了 —— "换语言"时最容易踩的坑。

很多人移植项目时会想："中文分词嘛，Python 里有 jieba，用它不就完了？"
这个实验会让你看见，这一步换掉之后，检索结果**确实**会变，
而且变的方向不一定是你想要的那个。

跑法：
    python experiments/exp3_tokenizer_compare.py
    （需要 jieba：pip install jieba）
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bm25_index import KnowledgeIndex                          # noqa: E402
from config import CONFIG, RETRIEVAL                            # noqa: E402
from retriever import search_bm25, select_gate_terms            # noqa: E402
from tokenizer import tokenize, tokenize_jieba                  # noqa: E402

SAMPLES = [
    '总监理工程师应履行哪些职责',
    '投标保证金什么时候退还',
    '如何申请营业执照',
    '监理投标文件由哪几部分组成',
]
QUESTION = '总监理工程师应履行哪些职责'


def main():
    print('')
    print('=' * 76)
    print('实验三：bigram 分词 vs jieba 分词')
    print('=' * 76)

    # ---- 第一步：同一个句子，两种切法 ----
    print('')
    print('一、切出来的东西根本不一样')
    print('-' * 76)
    for q in SAMPLES:
        a = tokenize(q)
        try:
            b = tokenize_jieba(q)
        except ImportError as exc:
            print(f'！{exc}')
            print('  跳过这个实验。')
            return 1
        print(f'问题：{q}')
        print(f'  bigram（项目用）  {len(a):>3} 个：{" ".join(a)}')
        print(f'  jieba（Python 常用）{len(b):>3} 个：{" ".join(b)}')
        print('')

    print('观察两点：')
    print('  1) bigram 会切出「程师」「师应」「应履」这种**不是词的词**。')
    print('     它们的存在不是 bug，而是"零依赖分词"必须付的代价 ——')
    print('     也正因为有「应履」「履行」，用户问"应履行哪些职责"时才能命中标题。')
    print('  2) jieba 的结果更像"人话"，但它只保留词典里的词。')
    print('     一旦你的资料里有大量专业术语、编号、公司简称（词典里没有），')
    print('     jieba 会切得比 bigram 更碎、甚至更差。')
    print('')

    # ---- 第二步：换分词器，排名怎么变 ----
    print('=' * 76)
    print('二、同一份资料、同一个问题，只换分词器，看排名怎么变')
    print('=' * 76)
    print('')

    corpus_chunks = _get_chunks()
    idx_bigram = KnowledgeIndex().build(corpus_chunks)
    idx_jieba = KnowledgeIndex().build(corpus_chunks, tokenizer_fn=tokenize_jieba)

    print(f'语料片段数：两个索引相同（{len(idx_bigram.chunks)}），'
          f'差别只在"每个片段被切成了什么词"')
    print(f'词表规模  ：bigram {len(idx_bigram.df)} 个词   '
          f'jieba {len(idx_jieba.df)} 个词')
    print(f'平均片段长：bigram {idx_bigram.avgdl:.1f} token   '
          f'jieba {idx_jieba.avgdl:.1f} token')
    print('')

    targets = [
        ('3.2.1 总监理', '3.2.1 总监理工程师'),
        ('3.2.3 专业监理', '3.2.3 专业监理工程师'),
    ]

    def ranks(idx, tokenizer_fn):
        ranked = search_bm25(idx, tokenizer_fn(QUESTION), 10 ** 6)
        return {item['index']: pos + 1 for pos, item in enumerate(ranked)}, idx

    r_bigram, _ = ranks(idx_bigram, tokenize)
    r_jieba, _ = ranks(idx_jieba, tokenize_jieba)

    print(f'问题：{QUESTION}')
    print('')
    print(f'{"片段":<22}{"bigram 排名":>14}{"jieba 排名":>14}')
    print('-' * 52)
    for label, key in targets:
        ids = [i for i, c in enumerate(corpus_chunks) if key in (c.get('section') or '')]
        for i in ids:
            print(f'{label + " (idx " + str(i) + ")":<22}{r_bigram.get(i, 0):>14}{r_jieba.get(i, 0):>14}')
    print('')

    gate_bigram = select_gate_terms(idx_bigram, list(dict.fromkeys(tokenize(QUESTION))))
    gate_jieba = select_gate_terms(idx_jieba, list(dict.fromkeys(tokenize_jieba(QUESTION))))
    print(f'闸门词  bigram：{gate_bigram}')
    print(f'闸门词  jieba ：{gate_jieba}')
    print('')

    # ---- 结论 ----
    print('=' * 76)
    print('结论：换分词器 = 换了一套"什么算一个词"的世界观')
    print('=' * 76)
    print('')
    print('  这不是"Python 不如 JS"或反过来 —— 两者都能用，只是取舍不同：')
    print('')
    print('  bigram 的优势：零依赖、结果完全可预测、不会有"词典里没这个词"的问题。')
    print('                 对 RAG 这种"资料里全是专业术语"的场景反而更稳。')
    print('  jieba  的优势：切出来更像人话，可读性好；')
    print('                 如果你要做关键词提取、给用户看命中词，它更友好。')
    print('')
    print('  ── 一个必须说清的诚实结论 ──')
    print('  在上面这份 94 片段的小语料里，换分词器**并没有让排名翻天覆地**：')
    print('  3.2.3 仍然是第 1 名，3.2.1 也仍然进得了前 5 名。')
    print('  但两个量已经差得很远，而且它们**直接进入 BM25 公式**：')
    print(f'      词表规模    {len(idx_bigram.df)}  vs  {len(idx_jieba.df)}   （约 4 倍）')
    print(f'      平均片段长  {idx_bigram.avgdl:.0f}  vs  {idx_jieba.avgdl:.0f} token（约 4 倍）')
    print('  长度归一化项 b*len/avgdl 就在公式里，语料一大，这点差异会被放大。')
    print('  所以结论不是"哪个更好"，而是：')
    print('      **换分词器是一个需要重新评估检索质量的改动，不是一次无害的替换。**')
    print('')
    print('  ⚠️ 但有一条铁律：**换分词器就必须重建索引。**')
    print('     索引里存的 df / 词频都是"按旧分词器算出来的"，')
    print('     换了分词器却不重建，等于拿一份过期的统计表去查新词 ——')
    print('     不会报错，只会慢慢答不准。')
    print('')
    print('     这正是项目里那句设计说明的由来：')
    print('     "片段正文落盘时不存词频，进程启动时重新分词构建统计量" ——')
    print('     所以统计口径永远与当前分词器版本一致，不可能错位。')
    print('')
    return 0


def _get_chunks():
    """按与 build() 相同的方式取片段列表（这里只要片段，不要索引）。"""
    import build_index
    index, _ = build_index.build(CONFIG['kb_dir'], verbose=False)
    return index.chunks


if __name__ == '__main__':
    sys.exit(main())
