"""
配置层 —— 项目 config.js 的 Python 简化版。

原则和 JS 版一致：**所有可调参数集中在一个地方**，代码里不散落魔法数字。
参数从 .env 读，找不到就用默认值（默认值就是能跑通的那一套）。

为什么不 pip install python-dotenv？
  因为读 .env 只需要 15 行代码，而"自己写一遍"能让你看清：
  所谓环境变量，就是进程启动时从文件里读进来的一堆字符串而已。
  顺带还能理解项目里那条最容易踩的坑 ——
  **环境变量只在进程启动时读一次**，改完 .env 必须重启才生效。
"""

import os
import re

# python-rag/ 目录
HERE = os.path.dirname(os.path.abspath(__file__))
# 项目根目录（知识问答agent/）
PROJECT_ROOT = os.path.dirname(HERE)


def _find_env_file():
    """按优先级找 .env：先看 python-rag/.env，再看项目根目录的 .env。

    这样设计是为了省事：项目根目录那份 .env 里已经有你的 DeepSeek 密钥了，
    用它就不用重复填一遍。但如果你想给 Python 版单独配，放一份在 python-rag/ 即可。
    """
    for candidate in (os.path.join(HERE, '.env'), os.path.join(PROJECT_ROOT, '.env')):
        if os.path.exists(candidate):
            return candidate
    return None


ENV_FILE = _find_env_file()


def load_env():
    """把 .env 读成一个字典。

    只支持 `键=值` 这种最简形式（够用了），并处理三件小事：
      · 跳过注释行（# 开头）和空行
      · 去掉值两边的引号（有些编辑器会自动加）
      · 不覆盖已经存在的【真实环境变量】—— 优先级：命令行 > .env
        这条很重要：它让你可以临时用 `LLM_MODEL=xxx python ask.py` 覆盖配置，
        而不必去改文件。
    """
    env = {}
    if not ENV_FILE:
        return env
    with open(ENV_FILE, 'r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                env[key] = value
    return env


_ENV = load_env()


def env(key, default=''):
    """取配置：真实环境变量优先，其次 .env，最后默认值。"""
    if key in os.environ and os.environ[key] != '':
        return os.environ[key]
    return _ENV.get(key, default)


def env_num(key, default):
    try:
        return float(env(key, str(default)))
    except (TypeError, ValueError):
        return float(default)


def env_int(key, default):
    return int(env_num(key, default))


# ---------------------------------------------------------------------------
# 全部配置项。左边是 Python 里的名字，右边对应 .env 里的变量名。
# 默认值和 Node 版完全一致，这样两边跑出来的数字可以直接对账。
# ---------------------------------------------------------------------------
def resolve_dir(value, default):
    """把配置里的目录变成绝对路径：相对路径按项目根目录解析。"""
    raw = value if value else default
    return raw if os.path.isabs(raw) else os.path.join(PROJECT_ROOT, raw)


CONFIG = {
    'kb_dir': resolve_dir(env('KB_DIR', ''), 'knowledge'),

    # 索引放在 python-rag/data/ 下，**不碰 Node 版用的 data/**，
    # 免得两边互相覆盖。
    'data_dir': os.path.join(HERE, 'data'),

    'llm': {
        'base_url': env('LLM_BASE_URL', 'https://api.deepseek.com/v1').rstrip('/'),
        'api_key': env('LLM_API_KEY', ''),
        'model': env('LLM_MODEL', 'deepseek-chat'),
        'temperature': env_num('LLM_TEMPERATURE', 0.2),
        # 输出预算。⚠️ 推理模型（deepseek-flash 这类）的思维链和正文**共享**这个额度，
        # 实测思维链占 3000~3400 字，所以给小了会出现"回答是空的"。
        'max_tokens': env_int('LLM_MAX_TOKENS', 8192),
        # 'auto' | 'on' | 'off' —— 是否关闭模型的"思考"
        'disable_thinking': env('LLM_DISABLE_THINKING', 'auto').lower(),
        'timeout': env_num('LLM_TIMEOUT_MS', 90000) / 1000.0,
    },

    # 向量检索为可选能力：没配 EMBED_BASE_URL 时自动降级为纯 BM25
    'embed': {
        'base_url': env('EMBED_BASE_URL', '').rstrip('/'),
        'api_key': env('EMBED_API_KEY', ''),
        'model': env('EMBED_MODEL', 'text-embedding-v3'),
        'batch_size': env_int('EMBED_BATCH_SIZE', 10),
    },

    'retrieval': {
        'top_k': env_int('RETRIEVAL_TOP_K', 5),
        'candidates': env_int('RETRIEVAL_CANDIDATES', 20),
        'min_coverage': env_num('RETRIEVAL_MIN_COVERAGE', 0.34),
        'chunk_size': env_int('CHUNK_SIZE', 620),
        'chunk_overlap': env_int('CHUNK_OVERLAP', 120),
        'rrf_k': env_int('RRF_K', 60),
    },
}

RETRIEVAL = CONFIG['retrieval']
LLM = CONFIG['llm']
EMBED = CONFIG['embed']


def embed_configured():
    return bool(EMBED['base_url'] and EMBED['api_key'])


def chat_configured():
    return bool(LLM['api_key'])


def resolve_thinking():
    """判断"要不要主动关掉模型的思考"，并给出理由。

    为什么不无脑传 thinking={'type':'disabled'}：
      非推理模型收到未知字段通常会被忽略，但不保证所有 OpenAI 兼容网关都如此，
      个别网关会直接返回 400。所以默认 auto 只在识别到推理模型时才注入这个参数。

    为什么 auto 不够用：
      DeepSeek 的推理模型命名带 reasoning / reasoner / r1，靠名字能认出来。
      但 deepseek-flash 这类"不标明却实为推理"的型号认不出来 ——
      只能用 .env 显式写 LLM_DISABLE_THINKING=off。
    """
    mode = LLM['disable_thinking']
    model = str(LLM['model']).lower()
    looks_reasoning = bool(re.search(r'(reasoner|reasoning|(^|[^a-z])r1([^0-9]|$))', model))

    if mode == 'off':
        return True, 'LLM_DISABLE_THINKING=off，强制关闭思考'
    if mode == 'on':
        return False, 'LLM_DISABLE_THINKING=on，强制保留思考'
    if mode == 'auto':
        if looks_reasoning:
            return True, f'auto：模型名「{LLM["model"]}」判定为推理模型，自动关闭思考'
        return False, (f'auto：模型名「{LLM["model"]}」未识别为推理模型，未注入 thinking 参数。'
                       '若该模型实际会输出思维链（如 deepseek-flash），请设 LLM_DISABLE_THINKING=off。')
    return False, f'LLM_DISABLE_THINKING 取值「{mode}」无法识别，按 auto 处理'


def describe():
    """打印当前配置摘要，方便排查"为什么没生效"。"""
    thinking, why = resolve_thinking()
    return {
        'env_file': ENV_FILE,
        'kb_dir': CONFIG['kb_dir'],
        'data_dir': CONFIG['data_dir'],
        'model': LLM['model'],
        'chat_configured': chat_configured(),
        'embed_configured': embed_configured(),
        'thinking_disabled': thinking,
        'thinking_why': why,
        **{f'retrieval.{k}': v for k, v in RETRIEVAL.items()},
    }


if __name__ == '__main__':
    import json
    print(json.dumps(describe(), ensure_ascii=False, indent=2))
