'use strict';

/**
 * 文本切分器。
 *
 * 目标：让每个片段（chunk）既「语义完整」又「长度可控」。
 * 策略：先按 Markdown 标题切成小节（保留标题路径，用于溯源展示），
 *       小节内按段落贪心打包到目标长度；超长段落再按句子边界硬切并保留重叠。
 */

const { config } = require('./config');

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** 按句子边界切分长文本，尽量不把一句话拦腰截断 */
function splitSentences(text) {
  // 中文句末标点 + 英文句末标点 + 换行
  const parts = text.split(/(?<=[。！？；!?;])\s*|\n+/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * 对超长片段做硬切，带重叠
 */
function hardSplit(text, size, overlap) {
  const sentences = splitSentences(text);
  const pieces = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) pieces.push(buffer.trim());
    buffer = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > size) {
      // 单句就超长（例如无标点的表格行），按字符切
      flush();
      let cursor = 0;
      while (cursor < sentence.length) {
        pieces.push(sentence.slice(cursor, cursor + size));
        cursor += size - overlap > 0 ? size - overlap : size;
      }
      continue;
    }
    if ((buffer + sentence).length > size) {
      flush();
      // 从上一条尾巴取一点重叠，避免答案正好被切断
      if (pieces.length && overlap > 0) {
        const prev = pieces[pieces.length - 1];
        buffer = prev.slice(Math.max(0, prev.length - overlap)) + sentence;
      } else {
        buffer = sentence;
      }
    } else {
      buffer += sentence;
    }
  }
  flush();

  return pieces;
}

/**
 * 把一份文档切成片段
 * @param {object} input
 * @param {string} input.docId
 * @param {string} input.docTitle
 * @param {string} input.text
 * @param {number} [input.maxLen]
 * @param {number} [input.overlap]
 * @returns {Array<{docId:string,docTitle:string,section:string,ordinal:number,text:string,charCount:number}>}
 */
function chunkDocument(input) {
  const maxLen = input.maxLen || config.retrieval.chunkSize;
  const overlap = Math.min(input.overlap ?? config.retrieval.chunkOverlap, Math.floor(maxLen / 2));

  const lines = String(input.text || '').replace(/\r\n?/g, '\n').split('\n');

  /** @type {Array<{section:string, body:string}>} */
  const sections = [];
  const headingStack = [];
  let current = { section: input.docTitle || '正文', body: '' };
  let inFence = false;

  const pushCurrent = () => {
    if (current.body.trim()) sections.push(current);
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      current.body += line + '\n';
      continue;
    }

    // 代码块内的 # 不是标题
    const heading = inFence ? null : HEADING_RE.exec(line);
    if (heading) {
      pushCurrent();
      const level = heading[1].length;
      const title = heading[2].trim();
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = title;
      const path = headingStack.filter(Boolean).join(' › ');
      current = { section: path || title, body: '' };
      continue;
    }

    current.body += line + '\n';
  }
  pushCurrent();

  if (sections.length === 0) {
    sections.push({ section: input.docTitle || '正文', body: String(input.text || '') });
  }

  const chunks = [];
  let ordinal = 0;

  for (const section of sections) {
    // 段落级打包
    const paragraphs = section.body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    const blocks = [];
    let buffer = '';

    const flushBuffer = () => {
      if (buffer.trim()) blocks.push(buffer.trim());
      buffer = '';
    };

    for (const para of paragraphs) {
      if (para.length > maxLen) {
        flushBuffer();
        for (const piece of hardSplit(para, maxLen, overlap)) {
          blocks.push(piece.trim());
        }
        continue;
      }
      if ((buffer + '\n\n' + para).length > maxLen) {
        flushBuffer();
        buffer = para;
      } else {
        buffer = buffer ? buffer + '\n\n' + para : para;
      }
    }
    flushBuffer();

    for (const block of blocks) {
      if (!block.trim()) continue;
      chunks.push({
        docId: input.docId,
        docTitle: input.docTitle,
        section: section.section,
        ordinal: ordinal++,
        text: block,
        charCount: block.length
      });
    }
  }

  return chunks.filter((c) => c.text.trim().length > 0);
}

module.exports = { chunkDocument, splitSentences };
