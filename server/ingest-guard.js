'use strict';

/**
 * 扫描件 / 低质量提取侦测。
 *
 * 背景：
 *   pdf-parse 只能提取 PDF 的文字层。遇到「纯图片扫描件」时不会报错，
 *   而是把每页的页眉、页脚、水印当成正文返回——典型症状是同一句短语
 *   在全文里重复几十次，而有效正文一个字都没有。
 *   这样的内容一旦入库，会被切成若干条几乎相同的片段，在检索里频繁
 *   抢占排名却提供不了任何答案，属于纯噪声。
 *
 * 本模块在文本入库前做一次体检，命中即返回可操作的建议。
 */

/** 判定为「扫描件」时，重复率与有效信息量的阈值 */
const REPEAT_RATIO_THRESHOLD = 0.5; // 单一重复行占非空行比例
const MIN_LINES_FOR_REPEAT = 6; // 行数太少不做重复率判定，避免误伤表格/书摘
const MIN_UNIQUE_CHARS = 200; // 低于此字符数且重复率高 => 判定为扫描件
const MIN_ALNUM_RATIO = 0.15; // 有效字符（字母/数字/CJK）占比下限，防止乱码

/**
 * 跨行短语重复阈值。
 *
 * 为什么需要这个信号：
 *   行级重复率有两个已知的躲法——
 *     1) 文字层把 63 个页眉合并成同一行（无换行符），行级重复率恒为 1/1，看起来"不重复"；
 *     2) 每行长度各不相同（例如页眉里带页码），行文本不完全相同，行级去重抓不到。
 *   但这两者的共同点是：**同一个短语在全文里反复出现几十次**。
 *   因此额外对「8 字滑窗短语」统计最高出现次数，超过阈值即认定是模板噪声。
 */
const PHRASE_WINDOW = 8;
const MAX_PHRASE_REPEATS = 8;

/**
 * 判为扫描件时，重复块之外允许保留的独立内容上限（字）。
 * 正常资料即便句式反复，独立表述也远超这个量级；
 * 扫描件的"页眉重复"则几乎归零。
 */
const MIN_INDEPENDENT_CHARS = 300;

/** 统计一行里的「有效字符」数量（去空白） */
function contentLength(line) {
  return line.replace(/\s+/g, '').length;
}

/**
 * 在连续字符流里统计「同一位置起点的 8 字短语」最多重复了多少次，
 * 并把这个短语向前后各扩展，还原出完整的重复块。
 *
 * 实现要点：
 *   1. 先把每个起点上的短语分组（Map 只保存各短语的起点列表）——
 *      固定步长采样会把长重复串截断成 N/s 次，导致漏判；
 *   2. 统计时不改原串（原地删除会导致后续起点找不到相同的 key），
 *      而是用「同一段连续重复文字里的位置只算一次」的规则聚类；
 *   3. 最后向两侧扩展，得到真正的重复块长度：
 *      形如「页眉第1页」「页眉第2页」的变体，重复块是「页眉第N页」整段，
 *      只按 8 字窗口算会严重低估它在全文中的占比。
 *
 * @param {string} compact 去掉所有空白字符后的文本
 * @returns {{count:number, phrase:string, blockChars:number, share:number}}
 */
function maxPhraseRepeats(compact) {
  const len = compact.length;
  if (len < PHRASE_WINDOW * 2) return { count: 0, phrase: '', blockChars: 0, share: 0 };

  /** @type {Map<string, number[]>} 短语 -> 起点位置列表 */
  const positions = new Map();
  for (let i = 0; i + PHRASE_WINDOW <= len; i++) {
    const phrase = compact.slice(i, i + PHRASE_WINDOW);
    const list = positions.get(phrase);
    if (list) list.push(i);
    else positions.set(phrase, [i]);
  }

  let bestCount = 0;
  let bestPhrase = '';
  let bestStarts = [];

  for (const [phrase, list] of positions.entries()) {
    if (list.length < 2 || list.length <= bestCount) continue;

    // 起点聚类：同一段连续文字内的每个位置都会各命中一次，
    // 但它们其实是"同一处"，合并后才是真实的重现次数。
    const starts = [list[0]];
    for (let k = 1; k < list.length; k++) {
      if (list[k] - list[k - 1] > PHRASE_WINDOW) starts.push(list[k]);
    }

    if (starts.length > bestCount) {
      bestCount = starts.length;
      bestPhrase = phrase;
      bestStarts = starts;
    }
  }

  if (bestCount < 2) return { count: bestCount, phrase: bestPhrase, blockChars: 0, share: 0 };

  // 还原重复块的真实长度：相邻两次出现的间隔就是"模板"的长度。
  //   纯页眉重复  => 间隔 12（正好是"住房城乡建设部信息公开浏览专用"）
  //   页眉带页码  => 间隔 14（"……专用第1页"），比 8 字窗口长
  // 用间隔而不是固定 8 字，才能正确衡量重复块的大小。
  const gaps = [];
  for (let k = 1; k < bestStarts.length; k++) gaps.push(bestStarts[k] - bestStarts[k - 1]);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  const blockChars = Math.max(PHRASE_WINDOW, medianGap);

  // 重复块累计占全文的比例。
  // 注意这里衡量的是"重复文字"的总量，而不是全文——正常资料里也会出现
  // 重复的句式（如每条都写"投标人应当…"），但重复块之外还有大量独立内容，
  // 所以必须与"独立内容极少"联合判定，见 inspectExtractedText。
  const share = Math.min(1, (bestCount * blockChars) / len);

  return { count: bestCount, phrase: bestPhrase, blockChars, share };
}

/**
 * 分析提取出来的文本，判断是否像"只抓到页眉页脚的扫描件"。
 *
 * @param {string} text 从文件中提取到的原始文本
 * @returns {{scanned:boolean, reason:string, suggestion:string, detail:object}}
 */
function inspectExtractedText(text) {
  const raw = String(text || '');
  const lines = raw
    .split(/\r\n?|\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const detail = {
    totalChars: raw.length,
    nonEmptyLines: lines.length,
    uniqueLines: new Set(lines).size,
    topLineCount: 0,
    topLineRatio: 0,
    uniqueChars: 0,
    contentChars: 0,
    topPhrase: '',
    topPhraseCount: 0
  };

  if (lines.length === 0) {
    return {
      scanned: true,
      reason: '没有提取到任何文字',
      suggestion: '该文件可能是纯图片扫描件。请提供带文字层的版本，或先做 OCR 再把识别结果导入。',
      detail
    };
  }

  // 1) 重复行占比：扫描件的页眉/水印会反复出现
  const counter = new Map();
  for (const line of lines) counter.set(line, (counter.get(line) || 0) + 1);
  let topLine = '';
  let topCount = 0;
  for (const [line, count] of counter.entries()) {
    if (count > topCount) {
      topCount = count;
      topLine = line;
    }
  }
  detail.topLineCount = topCount;
  detail.topLineRatio = Number((topCount / lines.length).toFixed(3));
  detail.topLine = topLine.slice(0, 60);

  // 2) 有效字符量：去掉重复行之后，还剩多少独立内容
  const uniqueLines = Array.from(counter.keys());
  let contentChars = 0;
  for (const line of uniqueLines) contentChars += contentLength(line);
  detail.contentChars = contentChars;
  detail.uniqueChars = new Set(uniqueLines.join('')).size;

  // 3) 可读性：字母/数字/CJK 占比过低说明是乱码或二进制噪声
  const alnumMatches = raw.match(/[\p{L}\p{N}]/gu);
  const alnumRatio = raw.length > 0 ? (alnumMatches ? alnumMatches.length : 0) / raw.length : 0;
  detail.alnumRatio = Number(alnumRatio.toFixed(3));

  // 4) 跨行短语重复：识别"页眉被合并成一行"或"每行长度不同"这两种躲法
  const compact = raw.replace(/\s+/g, '');
  const phrase = maxPhraseRepeats(compact);
  detail.topPhrase = phrase.phrase;
  detail.topPhraseCount = phrase.count;
  detail.topPhraseBlockChars = phrase.blockChars;
  detail.phraseShare = Number(phrase.share.toFixed(3));

  // 「独立内容」= 全文长度 - 重复块累计长度。
  // 这是区分"扫描件页眉噪声"与"正常资料"的决定性指标：
  //   扫描件：63 行页眉，独立内容 ≈ 0；
  //   正常资料：即使句式反复（每条都写"投标人应当…"），
  //             重复块之外仍有成百上千字的独立表述。
  const independentChars = Math.max(0, compact.length - phrase.count * phrase.blockChars);
  detail.independentChars = independentChars;

  // 判定一：同一短语反复出现，且重复块之外几乎没有独立内容
  // （扫描件的决定性特征：全文就是同一句页眉被重复了 N 遍）
  if (
    phrase.count >= MAX_PHRASE_REPEATS &&
    phrase.share >= 0.5 &&
    independentChars < MIN_INDEPENDENT_CHARS
  ) {
    return {
      scanned: true,
      reason:
        `提取到的内容里，「${phrase.phrase}」这类短语重复了 ${phrase.count} 次，` +
        `占全文的 ${(phrase.share * 100).toFixed(0)}%，` +
        `重复部分之外只剩 ${independentChars} 字独立内容`,
      suggestion:
        '这是一份纯图片扫描件，解析器只能读到页眉/水印，正文一个字都没提取到。' +
        '请改用带文字层的版本（官方电子版），或先对原文件做 OCR，再把识别出的文字导入。',
      detail
    };
  }

  // 判定二：行级高度重复 + 有效内容极少 => 典型的"每页页眉各占一行"
  if (
    lines.length >= MIN_LINES_FOR_REPEAT &&
    detail.topLineRatio >= REPEAT_RATIO_THRESHOLD &&
    contentChars < MIN_UNIQUE_CHARS
  ) {
    return {
      scanned: true,
      reason: `提取到的内容几乎全是重复行「${detail.topLine.slice(0, 30)}」（${lines.length} 行里出现 ${topCount} 次，有效正文仅 ${contentChars} 字）`,
      suggestion:
        '这是一份纯图片扫描件，解析器只能读到页眉/水印，正文一个字都没提取到。' +
        '请改用带文字层的版本（官方电子版），或先对原文件做 OCR，再把识别出的文字导入。',
      detail
    };
  }

  // 判定三：字符数不少但可读字符占比极低 => 编码/字体映射问题
  if (raw.length >= 200 && alnumRatio < MIN_ALNUM_RATIO) {
    return {
      scanned: true,
      reason: `提取到的内容可读字符占比仅 ${(alnumRatio * 100).toFixed(0)}%，疑似乱码或字体缺少 Unicode 映射`,
      suggestion: '请检查原文件是否内嵌了正确的字体，或改用其他格式（如 Markdown / Word）重新导出后再导入。',
      detail
    };
  }

  return { scanned: false, reason: '', suggestion: '', detail };
}

module.exports = {
  inspectExtractedText,
  maxPhraseRepeats,
  REPEAT_RATIO_THRESHOLD,
  MIN_LINES_FOR_REPEAT,
  MIN_UNIQUE_CHARS,
  MIN_ALNUM_RATIO,
  PHRASE_WINDOW,
  MAX_PHRASE_REPEATS
};
