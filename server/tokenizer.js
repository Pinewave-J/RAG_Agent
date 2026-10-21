'use strict';

/**
 * 轻量中文分词器。
 *
 * 设计取舍：不引入 nodejieba 等需要本地编译的依赖，改用「CJK 单字 + 相邻双字（bigram）」
 * 的组合切分。中文里绝大多数双字词能被 bigram 覆盖，配合 BM25 的 idf 抑制单字噪声，
 * 实际召回效果足以支撑「知识库问答」场景，且零编译依赖、跨平台稳定。
 */

const STOPWORDS = new Set([
  // 虚词、助词、语气词
  '的', '了', '是', '在', '和', '与', '及', '或', '而', '并', '且', '也', '都', '就',
  '等', '之', '其', '被', '把', '让', '给', '从', '到', '由', '对', '为', '以', '于',
  '上', '下', '中', '内', '外', '前', '后', '个', '些', '有', '无', '不', '没', '很',
  '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '着', '过', '地', '得', '要', '会', '能',
  '可', '应', '该', '请', '我', '你', '他', '她', '它', '们', '这', '那', '哪',
  // 疑问句式高频词（保留会稀释检索信号）
  '什么', '怎么', '如何', '哪些', '哪个', '为什么', '是否', '多少', '请问', '一下',
  '一个', '一种', '一些', '以及', '同时', '因此', '所以', '但是', '然而', '如果',
  '那么', '这个', '那个', '我们', '你们', '他们', '可以', '需要', '进行', '关于',
  // 英文停用词
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'of', 'to', 'in', 'on', 'for',
  'and', 'or', 'not', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'how',
  'what', 'why', 'which', 'can', 'do', 'does'
]);

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const TOKEN_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+|[a-z0-9][a-z0-9._+#-]*/g;

/** 全角转半角 + 小写化 + 压缩空白 */
function normalize(text) {
  if (!text) return '';
  let s = String(text);
  // 全角 ASCII -> 半角
  s = s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  s = s.toLowerCase();
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim();
}

/** 是否为中日韩表意字符 */
function isCJK(ch) {
  return CJK_RE.test(ch);
}

/**
 * 切分为检索用 token 数组（保留重复，用于词频统计）。
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const norm = normalize(text);
  if (!norm) return [];

  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(norm)) !== null) {
    const seg = match[0];

    if (isCJK(seg[0])) {
      const chars = Array.from(seg);

      // 1) 单字（过滤虚词）
      for (const ch of chars) {
        if (!STOPWORDS.has(ch)) tokens.push(ch);
      }

      // 2) 相邻双字 bigram —— 中文双字词的主要来源
      for (let i = 0; i + 1 < chars.length; i++) {
        const bi = chars[i] + chars[i + 1];
        // 两个字都是虚词的组合没有信息量
        if (STOPWORDS.has(chars[i]) && STOPWORDS.has(chars[i + 1])) continue;
        tokens.push(bi);
      }
    } else {
      // 英文 / 数字 / 版本号，长度 1 会带来大量噪声，直接丢弃
      if (seg.length >= 2 && !STOPWORDS.has(seg)) tokens.push(seg);
    }
  }

  return tokens;
}

/**
 * 切分为去重后的词组（用于覆盖率计算与关键词展示）
 * @param {string} text
 * @param {boolean} keepStopwords 是否保留虚词
 * @returns {string[]}
 */
function uniqueTerms(text, keepStopwords = false) {
  const all = tokenize(text);
  const out = new Set();
  for (const t of all) {
    if (!keepStopwords && STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return Array.from(out);
}

/** 统计词频，返回 { tf: {token: count}, len } */
function termFrequency(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  return { tf, len: tokens.length };
}

module.exports = { normalize, tokenize, uniqueTerms, termFrequency, isCJK, STOPWORDS };
