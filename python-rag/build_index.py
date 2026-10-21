"""
建索引入口 —— 相当于项目里的 scripts/reindex.js + server/indexer.js。

跑法：
    python build_index.py                 # 扫描 knowledge/ 建索引（纯关键词模式）
    python build_index.py --embed         # 顺带把向量也算出来（需要配 EMBED_*，会联网）
    python build_index.py --kb ./mydocs   # 换一个资料目录
    python build_index.py --title-weight 0   # 做实验：把标题权重设成 0，复现"答错人"故障

这个脚本做四件事，正好对应 RAG 的前三个阶段：
    扫描文件 -> 抽取文本（加载）-> 体检把关 -> 切分 -> 建统计量（索引）
"""

import argparse
import array
import os
import sys
import time

from bm25_index import SECTION_TF_WEIGHT, KnowledgeIndex
from chunker import chunk_document
from config import CONFIG, EMBED, RETRIEVAL, embed_configured
from loaders import inspect_extracted_text, load_text, make_doc_id

INDEX_PATH = os.path.join(CONFIG['data_dir'], 'py-index.json')
VECTORS_PATH = os.path.join(CONFIG['data_dir'], 'py-vectors.bin')

SKIP_EXTS = {'.py', '.pyc', '.js', '.exe', '.dll', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.bin'}


def collect_files(kb_dir):
    """收集资料目录下的文件（不递归，和项目行为一致：只扫一层）。"""
    if not os.path.isdir(kb_dir):
        return []
    out = []
    for name in sorted(os.listdir(kb_dir)):
        if name.startswith('.') or name.startswith('~'):
            continue
        path = os.path.join(kb_dir, name)
        if not os.path.isfile(path):
            continue
        if os.path.splitext(name)[1].lower() in SKIP_EXTS:
            continue
        out.append(path)
    return out


def build(kb_dir, title_weight=SECTION_TF_WEIGHT, verbose=True):
    """扫描 -> 加载 -> 体检 -> 切分 -> 建索引。返回 (index, 报告)。"""
    files = collect_files(kb_dir)
    if not files:
        print(f'! 资料目录里没有可用文件：{kb_dir}')
        return None, []

    chunks = []
    report = []

    for path in files:
        name = os.path.basename(path)
        try:
            text, kind = load_text(path)
        except Exception as exc:                      # noqa: BLE001
            report.append({'file': name, 'status': 'skipped', 'reason': f'解析失败：{exc}'})
            if verbose:
                print(f'  [跳过] {name} —— 解析失败：{exc}')
            continue

        # ---- 先体检，再入库 ----
        suspicious, reason, detail = inspect_extracted_text(text)
        if suspicious:
            report.append({'file': name, 'status': 'skipped', 'reason': reason, 'detail': detail})
            if verbose:
                print(f'  [拒绝] {name} —— {reason}')
                print('         处理办法：改用带文字层的版本，或先做 OCR 转成 .md/.txt 再导入')
            continue

        doc_id = make_doc_id(name, text)
        title = os.path.splitext(name)[0]
        parts = chunk_document(doc_id, title, text,
                               max_len=RETRIEVAL['chunk_size'],
                               overlap=RETRIEVAL['chunk_overlap'])

        for p in parts:
            chunks.append({
                'id': f"{doc_id}#{p['ordinal']}",
                'docId': doc_id,
                'docTitle': title,
                'source': name,
                'section': p['section'],
                'ordinal': p['ordinal'],
                'text': p['text'],
                'charCount': p['charCount'],
            })

        report.append({
            'file': name, 'status': 'ok', 'type': kind,
            'chars': len(text), 'chunks': len(parts), 'docId': doc_id,
        })
        if verbose:
            print(f'  [入库] {name} —— {len(text)} 字 -> {len(parts)} 个片段')

    index = KnowledgeIndex().build(chunks, title_weight=title_weight)
    return index, report


def build_vectors(index, verbose=True):
    """把每个片段转成向量（可选步骤，对应项目里的 indexer.buildVectors）。

    为什么默认不跑（要显式 --embed）：
      · 它要联网、要花钱、**而且慢** —— 94 个片段按批 10 条发出去，10 次请求；
      · 更重要的是：**BM25 那条通道本来就不需要它**。
        这一层被设计成"可选能力"，不配就自动降级，所以默认路径必须能在零配置下跑通。

    失败不抛出：向量化失败只意味着"检索退化为关键词模式"，
    不应该让整个建索引流程失败 —— 这和项目里 buildVectors 的处理方式一致。
    """
    from llm import LLMError, embed_texts      # 延迟导入：不跑 --embed 就不碰网络模块

    if not embed_configured():
        print('')
        print('! 未配置 EMBED_BASE_URL / EMBED_API_KEY，已跳过向量化')
        print('  （检索仍为纯关键词模式，功能完整可用，只是少了语义通道）')
        return False

    texts = [c['text'] for c in index.chunks]
    print('')
    print(f'正在向量化 {len(texts)} 个片段（模型 {EMBED["model"]}，批大小 {EMBED["batch_size"]}）...')

    try:
        vectors, dim = embed_texts(texts)
    except LLMError as exc:
        print(f'! 向量化失败：{exc}')
        print('  已跳过。索引照常保存，检索退化为关键词模式。')
        return False

    if not vectors or not dim or len(vectors) != len(index.chunks):
        print(f'! 向量数量异常（期望 {len(index.chunks)}，实际 {len(vectors)}），已跳过')
        return False

    # 按片段顺序平铺成一维 float32 —— 和 Node 版 kb-vectors.bin 的格式**逐字节一致**，
    # 所以两个文件其实可以互换读。
    index.vectors = array.array('f')
    for vec in vectors:
        index.vectors.extend(float(x) for x in vec)
    index.vector_dim = dim
    index.embed_model = EMBED['model']

    if len(index.vectors) != len(index.chunks) * dim:
        print('! 向量维度不一致，已跳过')
        index.vectors, index.vector_dim = None, 0
        return False

    if verbose:
        print(f'向量化完成：{len(vectors)} 条 × {dim} 维'
              f'（落盘 {len(index.vectors) * 4 / 1024:.0f} KB，'
              f'若写成 JSON 文本会大好几倍）')
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description='建立 Python 版 RAG 索引')
    parser.add_argument('--kb', default=CONFIG['kb_dir'], help='资料目录（默认取 .env 的 KB_DIR）')
    parser.add_argument('--title-weight', type=float, default=SECTION_TF_WEIGHT,
                        help=f'标题词频权重，默认 {SECTION_TF_WEIGHT}。填 0 可以复现"答错人"故障')
    parser.add_argument('--no-save', action='store_true', help='只跑一遍看统计，不落盘')
    parser.add_argument('--embed', action='store_true',
                        help='顺带生成向量（需要 EMBED_BASE_URL / EMBED_API_KEY，会联网且缓慢）')
    args = parser.parse_args(argv)

    print('')
    print('=' * 68)
    print('建立索引')
    print('=' * 68)
    print(f'资料目录：{args.kb}')
    print(f'标题权重：{args.title_weight}')
    print('')

    started = time.time()
    index, report = build(args.kb, title_weight=args.title_weight)
    if index is None:
        return 1

    elapsed = time.time() - started

    print('')
    print('-' * 68)
    stats = index.stats()
    print(f"片段总数    {stats['chunks']}")
    print(f"词表规模    {stats['vocabulary']}")
    print(f"正文总字数  {stats['characters']}")
    print(f"平均片段长  {stats['avgdl']} token（这才是 BM25 公式里用的长度，不是字符数）")
    print(f"耗时        {elapsed * 1000:.0f} ms")

    skipped = [r for r in report if r['status'] == 'skipped']
    if skipped:
        print('')
        print(f'被拒绝的资料（{len(skipped)} 份）—— 它们是扫描件或乱码，入库只会污染索引：')
        for r in skipped:
            print(f"  · {r['file']}：{r['reason']}")

    if not args.no_save:
        if args.embed:
            build_vectors(index)
        index.save(INDEX_PATH, VECTORS_PATH)
        print('')
        print(f'索引已写入：{INDEX_PATH}')
        if index.has_vectors():
            print(f'向量已写入：{VECTORS_PATH}（维度 {index.vector_dim}）')
        print('现在可以问了：python ask.py "监理投标文件由哪几部分组成"')
    print('-' * 68)
    return 0


if __name__ == '__main__':
    sys.exit(main())
