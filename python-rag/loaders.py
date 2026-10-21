"""
加载层 —— 项目 loaders.js + ingest-guard.js 的 Python 简化版。

职责：把各种格式的文件统一变成纯文本，并决定"这份东西到底该不该入库"。

顺序很重要：**先体检，再入库**。把垃圾资料收进来，比不收更糟 ——
它会切成几十个重复片段污染索引，让检索结果整体变差，
而且你很难查出原因（因为"索引里有 150 个片段"看起来是正常的）。
"""

import hashlib
import os
import re

# ---------------------------------------------------------------------------
# docId：给每份资料发一张"指纹身份证"
# ---------------------------------------------------------------------------

def make_doc_id(filename, content):
    """docId = sha1(原始文件名小写 + 空字符 + 内容) 的前 16 位。

    为什么要用内容算指纹，而不是用"上传时间"或"自增编号"？
      因为要让"重复上传同一份文件"变成**幂等**的：内容没变 -> ID 不变 ->
      覆盖旧的，不产生重复片段。内容改了 -> ID 变了 -> 视为新资料。

    ⚠️ 中间那个 '\\x00' 不能省：它是分隔符。
       没有它的话 "ab" + "c" 和 "a" + "bc" 会算出同一个 ID，
       两个完全不同的文件就会撞在一起。这是经典的"拼接歧义"陷阱。
    """
    h = hashlib.sha1()
    h.update(os.path.basename(str(filename or 'untitled')).lower().encode('utf-8'))
    h.update(b'\x00')
    h.update(str(content or '').encode('utf-8'))
    return h.hexdigest()[:16]


# ---------------------------------------------------------------------------
# 文本抽取
# ---------------------------------------------------------------------------

TEXT_EXTS = {'.md', '.markdown', '.txt', '.csv', '.json', '.log', '.yaml', '.yml'}
HTML_EXTS = {'.html', '.htm'}
PDF_EXTS = {'.pdf'}
DOCX_EXTS = {'.docx'}

TAG_RE = re.compile(r'<[^>]+>')
SCRIPT_RE = re.compile(r'<(script|style)[^>]*>.*?</\1>', re.IGNORECASE | re.DOTALL)
ENTITY = {'&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"}


def strip_html(raw):
    """把 HTML 剥成纯文本。

    HTML 里全是 <div> 这类标签，是给浏览器看的，不是给模型看的。
    不剥掉的话，标签会参与分词、抢占索引空间，还会把 BM25 的长度归一化搞乱。
    """
    s = SCRIPT_RE.sub(' ', raw)
    s = TAG_RE.sub(' ', s)
    for k, v in ENTITY.items():
        s = s.replace(k, v)
    return re.sub(r'\n{3,}', '\n\n', re.sub(r'[ \t]{2,}', ' ', s)).strip()


def _optional(pkg, hint):
    """可选依赖的友好报错 —— 照搬项目里 requireOptional 的思路。

    把非核心依赖做成"用到才导入"，好处有两个：
      一是启动更快；二是**报错更友好** ——
      用户看到的是"请执行 pip install pypdf"，而不是一句 ModuleNotFoundError。
    更重要的是：一个只用来读 PDF 的库没装，不应该让"读 .md 文件"这个功能也挂掉。
    """
    raise ImportError(
        f'缺少可选依赖 {pkg}，无法解析该格式。请执行：pip install {pkg}（{hint}）'
    )


def load_text(file_path):
    """把文件读成纯文本。返回 (文本, 类型)。

    支持的格式和项目一致，但 PDF / DOCX 是可选依赖：
      装了 pypdf / python-docx 就能读，没装就明确告诉你装什么。
    """
    ext = os.path.splitext(file_path)[1].lower()

    if ext in PDF_EXTS:
        try:
            from pypdf import PdfReader
        except ImportError:
            _optional('pypdf', '读取 PDF 需要')
        reader = PdfReader(file_path)
        return '\n\n'.join((page.extract_text() or '') for page in reader.pages), 'pdf'

    if ext in DOCX_EXTS:
        try:
            import docx  # python-docx
        except ImportError:
            _optional('python-docx', '读取 Word 需要')
        d = docx.Document(file_path)
        return '\n\n'.join(p.text for p in d.paragraphs), 'docx'

    # newline='' —— 见 check_parity.py 里的解释：不让 Python 改写 \r\n
    with open(file_path, 'r', encoding='utf-8', errors='replace', newline='') as fh:
        raw = fh.read()

    if ext in HTML_EXTS:
        return strip_html(raw), 'html'
    if ext == '.json':
        import json
        try:
            return json.dumps(json.loads(raw), ensure_ascii=False, indent=2), 'json'
        except ValueError:
            return raw, 'json'

    return raw, 'text'


# ---------------------------------------------------------------------------
# 扫描件守卫（简化版）
#
# 完整版在 server/ingest-guard.js，带 16 项正反用例测试（npm run test:guard）。
# 这里保留它的核心思想，够用且看得懂。
# ---------------------------------------------------------------------------

# 判定阈值集中放这里，方便做实验（对应项目里 ingest-guard.js 顶部的常量）
MIN_READABLE_RATIO = 0.15      # 可读字符（汉字/字母/数字）占比下限
MAX_LINE_REPEAT_RATIO = 0.5    # 单一重复行占比上限
MAX_PHRASE_REPEATS = 8         # 同一 8 字短语最多允许重复几次
MIN_INDEPENDENT_CHARS = 300    # 剔除重复块后，还需剩多少独立内容

READABLE_RE = re.compile(r'[\u4e00-\u9fffA-Za-z0-9]')


def inspect_extracted_text(text):
    """给解析出来的文本做体检，返回 (是否可疑, 原因, 细节)。

    要防的是什么：**扫描件**。一份纯图片的 PDF，解析器读不出正文，
    但也不会报错 —— 它会把每一页的页眉（公司名、页码）读出来。
    于是一份 60 页的扫描件，解析结果是"同一句页眉重复 63 次"。
    这种东西入库以后，会变成几十个几乎一样的片段，把索引彻底污染。

    三个信号：
      1. 可读性   —— 汉字/字母/数字占比过低，说明是乱码或缺 Unicode 映射
      2. 行级重复 —— 单一重复行占比过高，典型的"页眉各占一行"
      3. 短语重复 —— 同一 8 字短语反复出现，典型的"页眉被合成一整行"

    ★ 决定性判据是最后的「独立内容 < 300 字」：
      它让守卫能区分两种看起来一样、实则完全不同的情况 ——
        · 扫描件：63 行页眉，独立内容 **0 字**  -> 拦下
        · 正常资料：即使句式反复（每条都写"投标人应当…"），
                    独立内容仍有几千字          -> 放行
      没有这条判据，守卫会把正常资料也一起拒收。
      而"把正常资料全部拒收的守卫，比没有守卫更糟"。
    """
    if not text or not text.strip():
        return True, '空内容', {}

    sample = text[:200000]
    readable = len(READABLE_RE.findall(sample))
    ratio = readable / max(1, len(sample))
    detail = {'readableRatio': round(ratio, 4), 'chars': len(text)}

    if ratio < MIN_READABLE_RATIO:
        return True, f'可读字符占比仅 {ratio * 100:.1f}%（阈值 {MIN_READABLE_RATIO * 100:.0f}%），疑似乱码或字体无 Unicode 映射', detail

    lines = [ln.strip() for ln in sample.split('\n') if ln.strip()]
    if not lines:
        return True, '空内容', detail

    # 信号 2：行级重复
    counts = {}
    for ln in lines:
        counts[ln] = counts.get(ln, 0) + 1
    top_line, top_count = max(counts.items(), key=lambda kv: kv[1])
    line_ratio = top_count / len(lines)
    detail.update({
        'lines': len(lines),
        'topLineRepeat': top_count,
        'topLineRatio': round(line_ratio, 4),
        'topLine': top_line[:60],
    })

    # 信号 3：8 字短语重复（按起点聚类，而不是固定步长采样 ——
    # 固定步长会把"重复 63 次"数成"16 次"，这是项目实测踩过的坑）
    phrase_counts = {}
    step = 1
    for i in range(0, max(0, len(sample) - 8), step):
        phrase = sample[i:i + 8]
        if not READABLE_RE.search(phrase):
            continue
        phrase_counts[phrase] = phrase_counts.get(phrase, 0) + 1
    top_phrase, phrase_count = max(phrase_counts.items(), key=lambda kv: kv[1]) if phrase_counts else ('', 0)

    # 独立内容 = 总长度 - 重复块占用的长度
    independent = len(sample) - phrase_count * 8
    detail.update({
        'topPhraseRepeat': phrase_count,
        'topPhrase': top_phrase[:40],
        'independentChars': independent,
    })

    if phrase_count >= MAX_PHRASE_REPEATS and independent < MIN_INDEPENDENT_CHARS:
        return True, (f'同一 8 字短语重复 {phrase_count} 次，而独立内容仅 {independent} 字，'
                      f'疑似扫描件（页眉/水印）'), detail
    if line_ratio >= MAX_LINE_REPEAT_RATIO and independent < MIN_INDEPENDENT_CHARS:
        return True, (f'单一重复行占 {line_ratio * 100:.0f}%，独立内容仅 {independent} 字，'
                      f'疑似扫描件（页眉各占一行）'), detail

    return False, '', detail
