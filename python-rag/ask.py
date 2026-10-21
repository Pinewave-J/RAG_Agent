"""
命令行问答入口 —— 用 Python 视角看完整的 RAG 流程。

跑法：
    python ask.py "监理投标文件由哪几部分组成"        # 检索 + 调模型回答
    python ask.py "投标保证金什么时候退还" --no-llm    # 只看检索，不花钱
    python ask.py "总监理工程师应履行哪些职责" --debug  # 打印打分明细

第一次用先跑 `python build_index.py` 建索引。
不填 LLM_API_KEY 也能用 —— 加 --no-llm 就只做检索，
你会看到"检索到了什么、覆盖率多少、闸门放没放行"，
这部分**完全不依赖大模型**，也是 RAG 里真正需要调优的部分。
"""

import argparse
import json
import os
import sys

from bm25_index import KnowledgeIndex
from build_index import INDEX_PATH, VECTORS_PATH
from config import RETRIEVAL, chat_configured, describe, embed_configured

SEP = '=' * 68


def load_index():
    if not os.path.exists(INDEX_PATH):
        print('还没有索引。先执行：python build_index.py')
        return None
    return KnowledgeIndex().load(INDEX_PATH, VECTORS_PATH)


def show_retrieval(result, debug=False):
    """把检索结果打印成人能看懂的样子。

    这一屏是排查"为什么答不准"的第一现场，比看模型回答有用得多：
      · 覆盖率低 -> 资料里可能真没有，或者你的问法和资料用词差太远
      · 覆盖率不低但答得不对 -> 资料检索对了，问题出在生成环节（提示词）
      · 闸门词只有一两个 -> 你的问题可能太短，或者里面的词资料里都没有
    """
    print('')
    print(f"检索模式：{result['mode']}    片段总数：{result['stats']['chunks']}")
    print(f"查询词：{result['stats']['queryTerms']} 个    "
          f"闸门词：{result['stats']['gateTerms']} 个    "
          f"覆盖率：{result['coverage']:.4f}（阈值 {result['threshold']}）")

    if result['gateTerms']:
        print(f"闸门词：{' / '.join(result['gateTerms'])}")
    else:
        print('闸门词：（一个都没有 —— 说明你问题里的多字词，资料里全都不认识，这是"未覆盖"最强的信号）')

    verdict = '未覆盖 -> 会直接兜底，不调用模型' if result['uncovered'] else '已覆盖 -> 交给模型作答'
    print(f"闸门判定：{verdict}")

    print('')
    print('-' * 68)
    print('送进模型的资料（top %d）：' % len(result['results']))
    print('-' * 68)
    for rank, r in enumerate(result['results'], 1):
        print(f"[{rank}] BM25={r['bm25']:<9} 覆盖率={r['coverage']:<7} {r['section']}")
        preview = r['text'].replace('\n', ' ')[:110]
        print(f"    {preview}…")
        if debug:
            print(f"    （片段 idx={r['index']}  长度={len(r['text'])} 字  docId={r['docId']}）")
    print('-' * 68)


def main(argv=None):
    parser = argparse.ArgumentParser(description='用 Python 问你的知识库')
    parser.add_argument('question', nargs='*', help='你的问题')
    parser.add_argument('--no-llm', action='store_true', help='只检索，不调用大模型')
    parser.add_argument('--topk', type=int, default=None, help=f"取前几条资料（默认 {RETRIEVAL['top_k']}）")
    parser.add_argument('--debug', action='store_true', help='打印更细的检索信息')
    parser.add_argument('--config', action='store_true', help='打印当前配置（排查"为什么没生效"）')
    parser.add_argument('--json', action='store_true', help='以 JSON 输出检索结果（方便脚本处理）')
    args = parser.parse_args(argv)

    if args.config:
        print(json.dumps(describe(), ensure_ascii=False, indent=2))
        return 0

    question = ' '.join(args.question).strip()
    if not question:
        print(__doc__)
        return 1

    index = load_index()
    if index is None:
        return 1

    if args.json:
        from retriever import search
        result = search(index, question, top_k=args.topk or RETRIEVAL['top_k'])
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    # ---- 只检索模式：不花钱、不联网，却是最该反复跑的部分 ----
    if args.no_llm or not chat_configured():
        if not args.no_llm:
            print('（未配置 LLM_API_KEY，自动进入"只检索"模式。要获得回答请在 .env 里填密钥。）')
        from retriever import search

        # 索引里有向量就顺手把问题也向量化，这样 --no-llm 能看到**混合检索**的中间态。
        # 只调向量接口、不调对话模型，成本可以忽略；失败也不阻断，降级为关键词模式。
        query_vector = None
        if index.has_vectors() and embed_configured():
            from llm import LLMError, embed_texts
            try:
                vecs, dim = embed_texts([question])
                if vecs and dim == index.vector_dim:
                    query_vector = vecs[0]
            except LLMError as exc:
                print(f'（查询向量化失败，本次按关键词模式检索：{exc}）')

        result = search(index, question, top_k=args.topk or RETRIEVAL['top_k'],
                        query_vector=query_vector)
        print('')
        print(SEP)
        print(f'问题：{question}')
        print(SEP)
        show_retrieval(result, debug=args.debug)
        return 0

    # ---- 完整流程：检索 + 流式生成 ----
    from answer import generate

    print('')
    print(SEP)
    print(f'问题：{question}')
    print(SEP)

    for event in generate(index, question, top_k=args.topk):
        if event['type'] == 'meta':
            print(f"[检索] 模式={event['mode']}  覆盖率={event['coverage']:.4f}"
                  f"（阈值 {event['threshold']}）闸门词 {event['stats']['gateTerms']} 个")
            if event['citations']:
                print(f"[资料] 命中 {len(event['citations'])} 条：")
                for c in event['citations']:
                    print(f"       [{c['index']}] {c['section']}")
            print('')
            print('-' * 68)

        elif event['type'] == 'delta':
            # 逐字打印，不加换行 —— 这样你能真实看到"流式"是什么感觉
            sys.stdout.write(event['text'])
            sys.stdout.flush()

        elif event['type'] == 'fallback':
            print('')
            print('-' * 68)
            print(f"[兜底] 原因：{event['reason']}")
            print('')
            print(event['message'])

        elif event['type'] == 'error':
            print('')
            print(f"[出错] {event['message']}")

        elif event['type'] == 'done':
            print('')
            print('-' * 68)
            print('[完成]' + ('已回答' if event.get('answered') else '已兜底（未调用模型或模型判定资料不足）'))

    return 0


if __name__ == '__main__':
    sys.exit(main())
