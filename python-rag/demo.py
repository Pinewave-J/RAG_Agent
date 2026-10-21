"""
一键演示 —— 把整条链路跑一遍，全程不调用大模型（不花钱、不联网）。

跑法：
    python demo.py
    （或在 Windows 上直接双击 run-demo.cmd）

为什么要有这个文件：
  1. run-demo.cmd 必须保持纯 ASCII（cmd.exe 用系统 ANSI 代码页解码 .cmd，
     中文注释会变乱码并把脚本解析崩掉），所以中文问题没法写在 .cmd 里 ——
     放进这个 .py 里就完全没这个问题（Python 源码默认 UTF-8）。
  2. 四步演示都用同一个进程内的函数调用，不走 subprocess，输出也更整齐。

它会依次做四件事：
    1. 从 knowledge/ 建索引（对应 RAG 的加载 / 切分 / 索引三个阶段）
    2. 问一个知识库能回答的问题，看闸门放行
    3. 问一个知识库完全没收录的问题，看闸门拦下（**不调用模型**）
    4. 跑一次标题权重实验，看排名翻转
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from bm25_index import KnowledgeIndex                    # noqa: E402
from build_index import INDEX_PATH, VECTORS_PATH, build   # noqa: E402
from config import CONFIG, RETRIEVAL, chat_configured, embed_configured  # noqa: E402
from retriever import search                              # noqa: E402

SEP = '=' * 74
SUB = '-' * 74

Q_ANSWERABLE = '总监理工程师应履行哪些职责'
Q_MISSING = '锟鹏锴钺钉是什么'


def head(title):
    print('')
    print(SEP)
    print(title)
    print(SEP)


def step1_build():
    head('[1/4] 建索引：扫描 -> 加载 -> 体检 -> 切分 -> 统计')
    print(f'资料目录：{CONFIG["kb_dir"]}')
    print('')
    index, report = build(CONFIG['kb_dir'])
    if index is None:
        return None

    print('')
    print(SUB)
    stats = index.stats()
    print(f'片段总数      {stats["chunks"]}')
    print(f'词表规模      {stats["vocabulary"]}')
    print(f'正文总字数    {stats["characters"]}')
    print(f'平均片段长    {stats["avgdl"]} token  ← BM25 公式里用的长度，不是字符数')
    print(f'向量          {"有" if stats["vectorEnabled"] else "无（本次没算向量，检索走关键词模式，功能完整）"}')
    index.save(INDEX_PATH, VECTORS_PATH)
    print(f'索引已写入    {INDEX_PATH}')
    return index


def step2_answerable(index):
    head('[2/4] 问一个知识库能回答的问题 —— 看闸门放行')
    print(f'问题：{Q_ANSWERABLE}')
    print('')
    result = search(index, Q_ANSWERABLE, top_k=RETRIEVAL['top_k'])
    print(f"检索模式   {result['mode']}")
    print(f"查询词     {result['stats']['queryTerms']} 个"
          f"   →  闸门词 {result['stats']['gateTerms']} 个")
    print(f"闸门词     {' / '.join(result['gateTerms']) or '（空）'}")
    print(f"覆盖率     {result['coverage']:.4f}   （阈值 {result['threshold']}）")
    print('')
    print(SUB)
    for rank, r in enumerate(result['results'], 1):
        print(f"[{rank}] BM25={r['bm25']:<9} 覆盖率={r['coverage']:<7} {r['section']}")
    print(SUB)
    print('')
    print('注意上面这 5 条里，同时出现了「3.2.3 专业监理工程师」和「3.2.1 总监理工程师」。')
    print('如果只看到前者，模型就会抱着一堆"专业监理工程师"的职责去回答"总监理工程师"——')
    print('第 4 步会演示这个故障是怎么发生的。')


def step3_missing(index):
    head('[3/4] 问一个知识库完全没收录的问题 —— 看闸门拦下')
    print(f'问题：{Q_MISSING}（生造词，资料里绝对没有）')
    print('')
    result = search(index, Q_MISSING, top_k=RETRIEVAL['top_k'])
    print(f"闸门词     {' / '.join(result['gateTerms']) or '（一个都没有）'}")
    print(f"覆盖率     {result['coverage']:.4f}   （阈值 {result['threshold']}）")
    print(f"闸门判定   {'未覆盖 -> 直接兜底，不调用模型' if result['uncovered'] else '放行'}")
    print('')
    print('闸门词为空 = 这个问题里的多字词，知识库一个都不认识。')
    print('这是"未覆盖"最强有力的信号，所以连模型都不用叫 —— 零成本、零编造。')


def step4_experiment(index):
    head('[4/4] 标题权重实验：同一个问题，权重 0 与 0.5 的完整排名对比')
    from bm25_index import SECTION_TF_WEIGHT

    n = len(index.chunks)

    def targets(idx):
        out = []
        for i, c in enumerate(idx.chunks):
            sec = c.get('section') or ''
            if '3.2.1' in sec:
                kind = '主片段' if c['charCount'] > 100 else '短片段'
                out.append((i, f'3.2.1 总监理工程师({kind}, {c["charCount"]} 字)'))
            elif '3.2.3' in sec:
                out.append((i, '3.2.3 专业监理工程师'))
        return out

    # 这里故意把 top_k / candidates 开到全部片段：
    # 项目运行时只取前 5 名，但要**看清故障**，必须知道它究竟掉到了第几名。
    # 只看 "有没有进前 5" 是看不出 16 名和 77 名的差别的。
    rows = []
    targets_cache = None
    for weight in (0.0, SECTION_TF_WEIGHT):
        idx = KnowledgeIndex().build(index.chunks, title_weight=weight)
        res = search(idx, Q_ANSWERABLE, top_k=n, candidates=n)
        rank_by_index = {r['index']: (i, r) for i, r in enumerate(res['results'], 1)}
        if targets_cache is None:
            targets_cache = targets(idx)
        rows.append((weight, res, rank_by_index))

    print(f'{"片段":<40}{"权重 0":>17}{"权重 0.5":>17}')
    print(SUB)
    for i, label in targets_cache:
        cells = []
        for weight, res, rank_by_index in rows:
            if i in rank_by_index:
                pos, r = rank_by_index[i]
                cells.append(f'第 {pos} 名/{r["bm25"]:.1f} 分')
            else:
                cells.append('（不在候选内）')
        print(f'{label:<40}{cells[0]:>17}{cells[1]:>17}')
    print(SUB)
    print(f'（共 {n} 个片段参与排序，topK = {RETRIEVAL["top_k"]}）')

    print('')
    print('看 3.2.1 那两行：权重 0 时它们排在第 16 名和第 77 名 ——')
    print('而只有前 5 名会被送进模型，所以模型完全看不到"总监理工程师"的职责，')
    print('只能抱着第 1 名的"专业监理工程师"职责去回答，最后说出"资料未收录"。')
    print('')
    print('请注意三点：')
    print('  · 接口不报错；')
    print('  · 覆盖率也不低（第 1 名那条高达 0.84，远高于 0.34 的阈值）；')
    print('  · 修复后 3.2.1 也只是升到第 5 / 第 7 名 —— 它解决的是"能不能被看见"，')
    print('    不是"能不能排第一"。这正是 topK 不能随便调小的原因。')
    print('')
    print('想看到逐片段的分数与覆盖率，跑：python experiments/exp1_title_weight.py')


def main():
    print('')
    print(SEP)
    print('Python 版 RAG 演示（全程不调用大模型）')
    print(SEP)
    print(f'Python 解释器  {sys.version.split()[0]}')
    print(f'配置文件       {CONFIG["kb_dir"]}')
    print(f'对话模型       {"已配置" if chat_configured() else "未配置（不影响本演示）"}')
    print(f'向量模型       {"已配置" if embed_configured() else "未配置（检索为关键词模式）"}')

    index = step1_build()
    if index is None:
        print('没有可用资料，演示结束。')
        return 1

    step2_answerable(index)
    step3_missing(index)
    step4_experiment(index)

    print('')
    print(SEP)
    print('演示结束 —— 以上全部没有调用大模型，不花一分钱。')
    print(SEP)
    print('')
    print('想拿到真正写出来的答案（这一步会调用模型、会花钱）：')
    print('    python ask.py "监理投标文件由哪几部分组成"')
    print('')
    print('想看其它实验：')
    print('    python experiments/exp1_title_weight.py      标题权重如何改变排名')
    print('    python experiments/exp2_gate.py              闸门逐词解释 + 缺陷版复现')
    print('    python experiments/exp3_tokenizer_compare.py bigram vs jieba')
    print('    python experiments/exp4_vector_rescue.py     向量通道救回了什么（需先 --embed）')
    print('')
    print('想确认这份 Python 版和 Node 原版行为一致：')
    print('    python check_parity.py                       226 项逐位对账')
    print('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
