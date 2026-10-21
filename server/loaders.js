'use strict';

/**
 * 文档加载器：把各种格式的文件统一转成纯文本。
 *
 * PDF / DOCX 依赖为 optionalDependencies，缺失时不会导致服务启动失败，
 * 只会在上传该类文件时返回明确的提示，引导用户安装。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text', '.rst', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml']);
const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);
const PDF_EXT = new Set(['.pdf']);
const DOCX_EXT = new Set(['.docx']);

const SUPPORTED_EXT = new Set([...TEXT_EXT, ...HTML_EXT, ...PDF_EXT, ...DOCX_EXT]);

function extOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function isSupported(filename) {
  return SUPPORTED_EXT.has(extOf(filename));
}

/** 生成稳定的文档 ID：同一路径 + 同一内容 => 同一 ID，便于「更新覆盖」 */
function makeDocId(filename, content) {
  const hash = crypto.createHash('sha1');
  hash.update(path.basename(String(filename || 'untitled')).toLowerCase());
  hash.update('\u0000');
  hash.update(content ? String(content) : '');
  return hash.digest('hex').slice(0, 16);
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 尝试加载可选依赖，失败时给出可操作的提示 */
function requireOptional(pkg, hint) {
  try {
    return require(pkg);
  } catch (err) {
    const error = new Error(
      `缺少可选依赖 ${pkg}，无法解析该格式。请执行：npm install ${pkg}（${hint}）`
    );
    error.code = 'MISSING_OPTIONAL_DEP';
    error.cause = err;
    throw error;
  }
}

async function extractPdf(filePath) {
  const pdfParse = requireOptional('pdf-parse', '用于解析 PDF 文件');
  const buffer = fs.readFileSync(filePath);
  const result = await pdfParse(buffer);
  return String(result && result.text ? result.text : '');
}

async function extractDocx(filePath) {
  const mammoth = requireOptional('mammoth', '用于解析 Word .docx 文件');
  const result = await mammoth.extractRawText({ path: filePath });
  return String(result && result.value ? result.value : '');
}

/**
 * 从磁盘文件提取纯文本
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractFromFile(filePath) {
  const ext = extOf(filePath);

  if (PDF_EXT.has(ext)) return extractPdf(filePath);
  if (DOCX_EXT.has(ext)) return extractDocx(filePath);

  const raw = fs.readFileSync(filePath, 'utf8');

  if (HTML_EXT.has(ext)) return stripHtml(raw);
  if (ext === '.json') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** 从上传的内存缓冲区提取文本 */
async function extractFromBuffer(buffer, filename) {
  const ext = extOf(filename);

  if (PDF_EXT.has(ext)) {
    const pdfParse = requireOptional('pdf-parse', '用于解析 PDF 文件');
    const result = await pdfParse(buffer);
    return String(result && result.text ? result.text : '');
  }
  if (DOCX_EXT.has(ext)) {
    const mammoth = requireOptional('mammoth', '用于解析 Word .docx 文件');
    const result = await mammoth.extractRawText({ buffer });
    return String(result && result.value ? result.value : '');
  }

  const raw = buffer.toString('utf8');
  if (HTML_EXT.has(ext)) return stripHtml(raw);
  return raw;
}

/** 从 Markdown 正文中抽取第一个一级/二级标题作为文档标题 */
function inferTitle(text, fallback) {
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const m = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    const t = line.trim();
    if (t) return t.slice(0, 60);
  }
  return fallback;
}

module.exports = {
  extOf,
  isSupported,
  makeDocId,
  extractFromFile,
  extractFromBuffer,
  inferTitle,
  stripHtml,
  SUPPORTED_EXT,
  TEXT_EXT,
  PDF_EXT,
  DOCX_EXT,
  HTML_EXT
};
