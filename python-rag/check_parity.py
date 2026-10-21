"""
对账脚本 —— 把 Python 版和项目的 JS 版逐位比对。

这是整个 Python 工程里**最重要的一个文件**。原因很简单：
"读懂代码"和"移植正确"是两件事。你看着公式觉得抄对了，
但一个 in-place 修改、一个取整方式、一个 < 写成 <=，结果就全变了，
而且表面上它照样能跑、照样给出答案 —— 你不会发现它错了。

所以移植的正确性必须靠**对账**来证明，不能靠"看起来对"。

基准数据 reference/reference.json 是用项目的**真实代码**跑出来的：
    knowledge/ 4 份资料 -> 真实 chunker 切分 -> 真实 store 建统计量 -> 真实 retriever 检索
然后把结果固化下来。Python 版跑同一份语料，必须得到同样的数字。

用法：
    python check_parity.py            # 全部检查
    python check_parity.py -v         # 显示每一项的明细
"""

import hashlib
import json
import os
import sys

from bm25_index import KnowledgeIndex, SECTION_TF_MAX_TOKENS, strip_doc_title_prefix
from chunker import chunk_document
from config import CONFIG, RETRIEVAL
from retriever import (coverage_of, fuse_rrf, idf, search, search_bm25,
                       select_gate_terms)
from tokenizer import STOPWORDS, tokenize

HERE = os.path.dirname(os.path.abspath(__file__))
REF_PATH = os.path.join(HERE, 'reference', 'reference.json')
KB_DIR = CONFIG['kb_dir']

PASS = 0
FAIL = 0
FAILURES = []
VERBOSE = '-v' in sys.argv


def check(name, actual, expected, tol=None):
    """比对一项。tol 为 None 表示要求完全相等。"""
    global PASS, FAIL
    ok = False
    if tol is None:
        ok = actual == expected
    else:
        try:
            ok = abs(float(actual) - float(expected)) <= tol
        except (TypeError, ValueError):
            ok = False

    if ok:
        PASS += 1
        if VERBOSE:
            print(f'  [OK]   {name}')
    else:
        FAIL += 1
        FAILURES.append((name, actual, expected))
        print(f'  [FAIL] {name}')
        print(f'         期望: {expected}')
        print(f'         实际: {actual}')


def section(title):
    print('')
    print('=' * 68)
    print(title)
    print('=' * 68)


def load_reference():
    with open(REF_PATH, 'r', encoding='utf-8') as fh:
        return json.load(fh)


def build_corpus():
    """按与 JS 基准完全相同的方式读取 knowledge/，生成片段列表。"""
    chunks = []
    chunking = []
    for fname in sorted(os.listdir(KB_DIR)):
        if not fname.endswith('.md'):
            continue
        path = os.path.join(KB_DIR, fname)
        # ⚠️ newline='' 不能省。
        # Python 以文本模式打开文件时默认启用「通用换行」：会把 \r\n 统一改成 \n。
        # 而 Node 的 fs.readFileSync(p,'utf8') 是原样保留的。
        # 我们这份 03 号资料里就有 1327 处 \r\n —— 不关掉这个转换，
        # 读进来的字符数会从 29388 变成 28061，docId 也跟着变。
        # 搞笑的是：chunker 内部本来就会把 \r\n 归一成 \n，所以切出来的片段一模一样，
        # 只有"文件级"的数字对不上 —— 这类 bug 最容易被忽略。
        with open(path, 'r', encoding='utf-8', newline='') as fh:
            raw = fh.read()

        title = fname[:-3]                       # 去掉 .md
        # docId = sha1(原始文件名小写 + 空字符 + 内容) 前 16 位
        # 中间那个 '\x00' 是分隔符，没有它 "ab"+"c" 和 "a"+"bc" 会算出同一个 ID
        digest = hashlib.sha1()
        digest.update(fname.lower().encode('utf-8'))
        digest.update(b'\x00')
        digest.update(raw.encode('utf-8'))
        doc_id = digest.hexdigest()[:16]

        parts = chunk_document(doc_id, title, raw,
                               max_len=RETRIEVAL['chunk_size'],
                               overlap=RETRIEVAL['chunk_overlap'])
        for p in parts:
            chunks.append({
                'id': f"{doc_id}#{p['ordinal']}", 'docId': doc_id, 'docTitle': title,
                'source': title, 'section': p['section'], 'ordinal': p['ordinal'],
                'text': p['text'], 'charCount': p['charCount'],
            })

        checksum = hashlib.sha1('\u0001'.join(p['text'] for p in parts).encode('utf-8')).hexdigest()[:16]
        chunking.append({
            'file': fname, 'chars': len(raw), 'chunks': len(parts),
            'docId': doc_id,
            'lens': [p['charCount'] for p in parts],
            'sections': [p['section'] for p in parts],
            'checksum': checksum,
        })
    return chunks, chunking


def main():
    ref = load_reference()

    # ==================================================================
    section('① 分词器：token 必须逐个相同（顺序也相同）')
    for sample in ref['tokenSamples']:
        got = tokenize(sample['q'])
        expected = sample['tokens']
        check(f"tokenize({sample['q']!r})", got, expected)
        if got != expected:
            print(f'         长度 期望/实际: {len(expected)}/{len(got)}')

    # ==================================================================
    section('② 切分器：片段数 / 每片长度 / 内容校验和')
    chunks, chunking = build_corpus()
    ref_chunking = {c['file']: c for c in ref['chunking']}

    for mine in chunking:
        r = ref_chunking.get(mine['file'])
        if r is None:
            check(f"切分 {mine['file']}", '存在', '基准里没有这个文件')
            continue
        check(f"切分 {mine['file']} · 字符数", mine['chars'], r['chars'])
        check(f"切分 {mine['file']} · docId（内容指纹）", mine['docId'], r['docId'])
        check(f"切分 {mine['file']} · 片段数", mine['chunks'], r['chunks'])
        check(f"切分 {mine['file']} · 各片长度", mine['lens'], r['lens'])
        check(f"切分 {mine['file']} · 内容校验和", mine['checksum'], r['checksum'])
        check(f"切分 {mine['file']} · 标题路径", mine['sections'], r['sections'])

    # ==================================================================
    section('③ 索引统计量：avgdl / 词表规模')
    index = KnowledgeIndex().build(chunks)
    check('片段总数', len(index.chunks), ref['meta']['chunks'])
    check('avgdl（平均片段长度）', index.avgdl, ref['meta']['avgdl'], tol=1e-6)
    check('词表规模', len(index.df), ref['meta']['vocabulary'])

    # ==================================================================
    section('④ 检索：5 个查询的完整结果（模式/覆盖率/闸门词/top5）')
    for query, r in ref['searches'].items():
        got = search(index, query,
                     top_k=RETRIEVAL['top_k'],
                     candidates=RETRIEVAL['candidates'],
                     min_coverage=RETRIEVAL['min_coverage'],
                     rrf_k=RETRIEVAL['rrf_k'])
        check(f'{query} · mode', got['mode'], r['mode'])
        check(f'{query} · uncovered', got['uncovered'], r['uncovered'])
        check(f'{query} · coverage', got['coverage'], r['coverage'], tol=1e-6)
        check(f'{query} · 闸门词', got['gateTerms'], r['gateTerms'])
        check(f'{query} · 查询词数', got['stats']['queryTerms'], r['stats']['queryTerms'])

        got_top = [(x['index'], x['bm25'], x['score'], x['coverage']) for x in got['results']]
        exp_top = [(x['index'], x['bm25'], x['score'], x['coverage']) for x in r['top']]
        check(f'{query} · top 片段索引', [t[0] for t in got_top], [t[0] for t in exp_top])
        for i, (g, e) in enumerate(zip(got_top, exp_top)):
            check(f'{query} · 第{i + 1}名 bm25', g[1], e[1], tol=5e-5)
            check(f'{query} · 第{i + 1}名 score', g[2], e[2], tol=5e-5)
            check(f'{query} · 第{i + 1}名 coverage', g[3], e[3], tol=5e-5)

    # ==================================================================
    section('⑤ 标题权重扫描：0 / 0.25 / 0.5 / 1.0 下的排名与覆盖率')
    for sweep in ref['weightSweep']:
        w = sweep['weight']
        idx = KnowledgeIndex().build(chunks, title_weight=w)
        check(f'w={w} · avgdl', idx.avgdl, sweep['avgdl'], tol=1e-6)

        ranked = search_bm25(idx, tokenize('总监理工程师应履行哪些职责'), 10 ** 6)
        rank_of = {item['index']: pos + 1 for pos, item in enumerate(ranked)}
        gate = select_gate_terms(idx, list(dict.fromkeys(tokenize('总监理工程师应履行哪些职责'))))
        check(f'w={w} · 闸门词数', len(gate), sweep['gateTerms'])

        for label, items in (('3.2.1', sweep['of321']), ('3.2.3', sweep['of323'])):
            for item in items:
                i = item['index']
                check(f'w={w} · {label} idx={i} 排名', rank_of.get(i, 0), item['rank'])
                check(f'w={w} · {label} idx={i} 覆盖率',
                      coverage_of(idx, gate, i), item['coverage'], tol=1e-6)

    # ==================================================================
    section('⑥ RRF 融合：排名与归一化分数')
    for case in ref['fixtures']['rrf']:
        lists = [[{'index': i} for i in lst] for lst in case['lists']]
        got = fuse_rrf(lists, case['k'])
        check(f"RRF「{case['name']}」· 顺序",
              [x['index'] for x in got], [x['index'] for x in case['result']])
        for g, e in zip(got, case['result']):
            check(f"RRF「{case['name']}」· idx={e['index']} 分数", g['score'], e['score'], tol=1e-12)
            check(f"RRF「{case['name']}」· idx={e['index']} ranks", g['ranks'], e['ranks'])

    # ==================================================================
    section('⑦ 余弦相似度（含零向量的处理）')
    import math
    qv = ref['fixtures']['cosine']['query']
    for item in ref['fixtures']['cosine']['docs']:
        vec = item['vec']
        dot = sum(a * b for a, b in zip(vec, qv))
        na = math.sqrt(sum(a * a for a in vec))
        nb = math.sqrt(sum(b * b for b in qv))
        if na == 0 or nb == 0:
            got = None
        else:
            got = round(dot / (na * nb), 10)
        check(f'余弦 vec={vec}', got, item['cosine'])

    # ==================================================================
    section('⑧ idf 与停用词表：几个必须钉死的行为')
    # 停用词表是闸门的关键防线，一旦手抖删掉几个，"闸门静默失效"的 bug 就回来了
    check('停用词「什么」在表里', '什么' in STOPWORDS, True)
    check('停用词「哪些」在表里', '哪些' in STOPWORDS, True)
    check('idf(df=0, N=94) 为正', idf(0, 94) > 0, True)
    check('idf 随 df 增大而减小', idf(1, 94) > idf(50, 94), True)
    # 双字疑问词必须能溜进 token 列表（这是 tokenize 的既定行为），
    # 但要被 select_gate_terms 拦住 —— 两个环节缺一不可
    check('「什么」会出现在 token 里', '什么' in tokenize('锟鹏锴钺钉是什么'), True)
    check('「什么」不会成为闸门词',
          select_gate_terms(index, list(dict.fromkeys(tokenize('锟鹏锴钺钉是什么')))), [])

    # 标题前缀剥离：只剥文档名，不能误伤"首段就是标题"的情况
    check('剥离文档名前缀',
          strip_doc_title_prefix('规范 › 3.2.1 应履行', '规范'), '3.2.1 应履行')
    check('文档名不匹配时不剥离',
          strip_doc_title_prefix('甲方 › 乙方 › 丙方', '完全无关的名字'), '甲方 › 乙方 › 丙方')
    check('SECTION_TF_MAX_TOKENS 为 24', SECTION_TF_MAX_TOKENS, 24)

    # ==================================================================
    print('')
    print('=' * 68)
    if FAIL == 0:
        print(f'全部通过：{PASS} 项检查')
        print('')
        print('这意味着：Python 版与项目 JS 版在分词、切分、BM25 打分、')
        print('RRF 融合、覆盖率闸门这五个环节上，输出逐位一致。')
    else:
        print(f'通过 {PASS} 项，失败 {FAIL} 项')
        print('')
        for name, actual, expected in FAILURES[:20]:
            print(f'  · {name}')
            print(f'      期望 {expected!r}')
            print(f'      实际 {actual!r}')
        print('')
        print('提示：失败通常是这几类原因——')
        print('  1) 某处用了 in-place 修改而不是新建对象')
        print('  2) 取整/舍入方式不同（round 与 toFixed 在 .5 处行为不同）')
        print('  3) 正则里的 \\s / . 等元字符在两种语言里语义有细微差别')
        print('  4) 遍历顺序不同（Python dict 保序，JS Map 也保序，但 set 不一定）')
    print('=' * 68)
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
