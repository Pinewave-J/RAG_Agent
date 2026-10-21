'use strict';

/**
 * 统一配置层。
 * 所有可调参数集中在 .env，代码里不再散落魔法数字。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// 优先读 .env，但不强制（容器环境通常直接注入环境变量）
const ENV_PATH = path.join(ROOT, '.env');
require('dotenv').config({ path: ENV_PATH });

// 记录进程启动时 .env 的修改时间。
// 环境变量只在进程启动那一刻读取一次，之后改文件不会生效——
// "我明明填了密钥，页面还说没配置"几乎都是这个原因，因此单独探测它。
let envMtimeAtBoot = null;
try {
  envMtimeAtBoot = fs.statSync(ENV_PATH).mtimeMs;
} catch {
  envMtimeAtBoot = null; // 启动时不存在 .env
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, fallback) {
  const s = (value === undefined || value === null) ? '' : String(value).trim();
  return s === '' ? fallback : s;
}

function resolveDir(value, fallback) {
  const raw = str(value, fallback);
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

const config = {
  root: ROOT,

  server: {
    port: num(process.env.PORT, 8899),
    host: str(process.env.HOST, '0.0.0.0'),
    // 知识库写操作口令，留空表示不鉴权（仅建议内网本地使用）
    adminToken: str(process.env.ADMIN_TOKEN, '')
  },

  llm: {
    baseUrl: str(process.env.LLM_BASE_URL, 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: str(process.env.LLM_API_KEY, ''),
    model: str(process.env.LLM_MODEL, 'deepseek-chat'),
    temperature: num(process.env.LLM_TEMPERATURE, 0.2),
    // 输出预算。
    // 注意：deepseek-flash 等**推理模型**的思维链（reasoning_content）与正文
    // （content）**共享同一个 max_tokens**。实测思维链可占 3000~3400 字，
    // 故 1600 会被吃光（正文为空）、4096 只是临界值，8192 才留出充裕余量。
    // 开启 disableThinking 后思维链归零，此预算全部留给正文，可适当调小。
    maxTokens: num(process.env.LLM_MAX_TOKENS, 8192),
    // 是否关闭模型的"思考"（思维链）。'auto' | 'on' | 'off'
    //   auto —— 推理模型自动关闭，非推理模型不带该参数（默认）
    //   on   —— 强制保留思考
    //   off  —— 强制关闭（即使模型不支持该参数也照传）
    // 依据：RAG 场景下资料已由检索层筛好，模型只需"照着资料复述并组织"，
    // 实测关思考后正文完整度不变（428~431 字 vs 430 字）、首字延迟下降约 45%，
    // 且"资料不足时拒答"的表现不退化。详见 .env 中 LLM_DISABLE_THINKING 注释。
    disableThinking: str(process.env.LLM_DISABLE_THINKING, 'auto').toLowerCase(),
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 90000)
  },

  // 向量检索为可选能力：未配置 EMBED_BASE_URL 时自动降级为纯 BM25
  embed: {
    baseUrl: str(process.env.EMBED_BASE_URL, '').replace(/\/+$/, ''),
    apiKey: str(process.env.EMBED_API_KEY, ''),
    model: str(process.env.EMBED_MODEL, 'text-embedding-v3'),
    batchSize: num(process.env.EMBED_BATCH_SIZE, 10),
    get enabled() {
      return Boolean(this.baseUrl && this.apiKey);
    }
  },

  retrieval: {
    topK: num(process.env.RETRIEVAL_TOP_K, 5),
    candidates: num(process.env.RETRIEVAL_CANDIDATES, 20),
    minCoverage: num(process.env.RETRIEVAL_MIN_COVERAGE, 0.34),
    chunkSize: num(process.env.CHUNK_SIZE, 620),
    chunkOverlap: num(process.env.CHUNK_OVERLAP, 120),
    // RRF 融合常数，标准取值 60
    rrfK: num(process.env.RRF_K, 60)
  },

  paths: {
    kb: resolveDir(process.env.KB_DIR, 'knowledge'),
    data: resolveDir(process.env.DATA_DIR, 'data'),
    get uploads() { return path.join(this.data, 'uploads'); },
    get indexFile() { return path.join(this.data, 'kb-index.json'); },
    get vectorsFile() { return path.join(this.data, 'kb-vectors.bin'); }
  },

  limits: {
    maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 30) * 1024 * 1024
  }
};

/** 启动时确保必要目录存在 */
function ensureDirs() {
  for (const dir of [config.paths.kb, config.paths.data, config.paths.uploads]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 判断"是否需要主动关闭思考"，并给出理由（供日志与 /api/health 展示）。
 *
 * 为什么不无脑传 thinking:{type:'disabled'}：
 *   非推理模型收到未知字段虽通常会被忽略，但不保证所有 OpenAI 兼容端点都如此，
 *   个别网关会直接 400。故默认 auto 只在识别到推理模型时才注入该参数。
 *
 * 推理模型的识别：DeepSeek 的推理模型命名带 reasoning / reasoner / r1，
 * 或其模型列表中包含 flash / pro 这类"未标明但实为推理"的型号——后者无法
 * 靠名字判断，交由 .env 显式开关处理。
 */
function resolveThinking() {
  const mode = config.llm.disableThinking; // 'auto' | 'on' | 'off' | 其他
  const model = String(config.llm.model || '').toLowerCase();

  const looksReasoning = /(reasoner|reasoning|(^|[^a-z])r1([^0-9]|$))/.test(model);

  if (mode === 'off') return { enabled: true, why: 'LLM_DISABLE_THINKING=off，强制关闭思考' };
  if (mode === 'on') return { enabled: false, why: 'LLM_DISABLE_THINKING=on，强制保留思考' };

  if (mode === 'auto') {
    return looksReasoning
      ? { enabled: true, why: `auto：模型名「${config.llm.model}」判定为推理模型，自动关闭思考` }
      : {
          enabled: false,
          why:
            `auto：模型名「${config.llm.model}」未识别为推理模型，未注入 thinking 参数。` +
            '若该模型实际会输出思维链（如 deepseek-flash），请设 LLM_DISABLE_THINKING=off 强制关闭。'
        };
  }

  return { enabled: false, why: `LLM_DISABLE_THINKING 取值「${mode}」无法识别，按 auto 处理` };
}

/**
 * .env 是否在服务启动后被改动过。
 * 返回 true 意味着：文件里的配置与当前进程实际生效的配置很可能已经不一致。
 * 留 1 秒容差，规避文件系统时间戳精度造成的误报。
 */
function envStale() {  try {
    const mtime = fs.statSync(ENV_PATH).mtimeMs;
    if (envMtimeAtBoot === null) return true; // 启动时没有 .env，现在有了
    return mtime > envMtimeAtBoot + 1000;
  } catch {
    return false; // 文件被删或不可读，不作为"配置变更"处理
  }
}

/** 启动自检：返回人类可读的配置诊断，供 /api/health 与启动日志使用 */
function diagnose() {
  const issues = [];
  const notes = [];

  const stale = envStale();

  if (!config.llm.apiKey) {
    issues.push(
      stale
        ? '当前进程未加载到 LLM_API_KEY，且检测到 .env 在服务启动后被修改过。请重启服务（Ctrl+C 后重新 npm start），新配置才会生效。'
        : '未配置 LLM_API_KEY，问答接口无法调用大模型（知识库管理功能仍可用）。'
    );
  } else if (stale) {
    issues.push('检测到 .env 在服务启动后被修改，当前进程仍在使用旧配置。请重启服务（Ctrl+C 后重新 npm start）使改动生效。');
  }

  if (config.embed.enabled) {
    notes.push(`向量检索已开启：${config.embed.model}`);
  } else {
    notes.push('向量检索未开启（未配置 EMBED_BASE_URL/EMBED_API_KEY），已自动降级为本地 BM25 关键词检索。');
  }
  if (!config.server.adminToken) {
    notes.push('未设置 ADMIN_TOKEN，知识库管理接口当前无鉴权，请勿直接暴露到公网。');
  }

  // 思考开关状态：这是排查"回答为空 / 被截断"时最先该看的一项
  const thinking = resolveThinking();
  notes.push(thinking.enabled ? `思考（思维链）已关闭：${thinking.why}` : `思考（思维链）保留：${thinking.why}`);

  return {
    ok: issues.length === 0,
    issues,
    notes,
    llmConfigured: Boolean(config.llm.apiKey),
    vectorEnabled: config.embed.enabled,
    adminProtected: Boolean(config.server.adminToken),
    envStale: stale,
    envPath: ENV_PATH,
    thinking: { disabled: thinking.enabled, why: thinking.why, mode: config.llm.disableThinking }
  };
}

module.exports = { config, ensureDirs, diagnose, envStale, resolveThinking };
