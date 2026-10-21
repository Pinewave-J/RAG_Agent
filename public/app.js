/* ==========================================================================
   知识问答 Agent —— 前端逻辑
   无框架、无构建步骤：直接引用即可运行，便于部署与二次修改。
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  const escapeRegExp = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const formatNumber = (n) => {
    const num = Number(n) || 0;
    if (num >= 10000) return (num / 10000).toFixed(num >= 100000 ? 0 : 1) + ' 万';
    return String(num);
  };

  const formatTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const debounce = (fn, wait) => {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  /* ------------------------------------------------------------------ */
  /* Markdown 渲染                                                       */
  /* 说明：先转义、再做替换，绝不把模型输出当 HTML 执行，从源头杜绝 XSS。      */
  /* ------------------------------------------------------------------ */

  function renderInline(text) {
    let out = text;
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return out;
  }

  /**
   * 把 Markdown 渲染成安全的 HTML
   * @param {string} src
   * @param {{maxCite?:number}} [options] maxCite 之外的引用编号会被丢弃
   */
  function renderMarkdown(src, options = {}) {
    const maxCite = options.maxCite || 0;
    const codeBlocks = [];
    const inlineCodes = [];

    let text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');

    // 1) 抽出围栏代码块，避免其内容被后续规则误伤
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      codeBlocks.push({ lang: String(lang || '').trim(), code: code.replace(/\n+$/, '') });
      return `\n\n\u0000C${codeBlocks.length - 1}\u0000\n\n`;
    });

    // 2) 抽出行内代码
    text = text.replace(/`([^`\n]+)`/g, (m, code) => {
      inlineCodes.push(code);
      return `\u0000I${inlineCodes.length - 1}\u0000`;
    });

    // 3) 整体转义
    let html = escapeHtml(text);

    // 4) 引用编号 -> 可点击角标；越界编号直接剔除，避免"编造出处"
    html = html.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => {
      const idx = Number(n);
      if (idx < 1 || idx > maxCite) return '';
      return `<span class="cite" data-cite="${idx}" role="button" tabindex="0" title="查看来源 ${idx}">${idx}</span>`;
    });

    const lines = html.split('\n');
    const out = [];
    let i = 0;

    const isTableSeparator = (line) => /^\|?[\s:*-]*-[\s:*-]*\|[\s:|-]*$/.test(line.trim());
    const hasPipe = (line) => line.includes('|');

    const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();

      if (!line) { i++; continue; }

      // 代码块占位
      const codeMatch = /^\u0000C(\d+)\u0000$/.exec(line);
      if (codeMatch) {
        const block = codeBlocks[Number(codeMatch[1])];
        out.push(`<pre><code>${escapeHtml(block.code)}</code></pre>`);
        i++;
        continue;
      }

      // 标题
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = Math.min(heading[1].length + 1, 6); // h1 留给页面标题，这里从 h2 起
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      // 分割线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { out.push('<hr>'); i++; continue; }

      // 引用
      if (/^&gt;\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) {
          buf.push(lines[i].trim().replace(/^&gt;\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${renderInline(buf.join('<br>'))}</blockquote>`);
        continue;
      }

      // 表格
      if (hasPipe(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const header = splitRow(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && hasPipe(lines[i].trim()) && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const thead = `<thead><tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
        out.push(`<table>${thead}${tbody}</table>`);
        continue;
      }

      // 无序列表
      if (/^[-*+]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
          buf.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
          i++;
        }
        out.push(`<ul>${buf.map((t) => `<li>${renderInline(t)}</li>`).join('')}</ul>`);
        continue;
      }

      // 有序列表
      if (/^\d+[.)]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
          buf.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
          i++;
        }
        out.push(`<ol>${buf.map((t) => `<li>${renderInline(t)}</li>`).join('')}</ol>`);
        continue;
      }

      // 段落：连续的普通行合并为一段
      const buf = [];
      while (i < lines.length) {
        const cur = lines[i].trim();
        if (!cur) break;
        if (/^(#{1,6})\s+/.test(cur)) break;
        if (/^[-*+]\s+/.test(cur)) break;
        if (/^\d+[.)]\s+/.test(cur)) break;
        if (/^&gt;\s?/.test(cur)) break;
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(cur)) break;
        if (/^\u0000C\d+\u0000$/.test(cur)) break;
        if (hasPipe(cur) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
        buf.push(cur);
        i++;
      }
      if (buf.length) out.push(`<p>${renderInline(buf.join('<br>'))}</p>`);
    }

    // 还原行内代码
    let result = out.join('\n');
    result = result.replace(/\u0000I(\d+)\u0000/g, (m, n) => `<code>${escapeHtml(inlineCodes[Number(n)])}</code>`);
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 轻提示（右上角 Toast）                                              */
  /* ------------------------------------------------------------------ */

  const toastBox = $('#toasts');

  function toast(message, type = 'info', timeout = 3600) {
    // 注意：这里的变量不要叫 el —— 会遮蔽模块级的 el 元素引用表
    const node = document.createElement('div');
    node.className = `toast toast--${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
    const icon = type === 'ok' ? '✅' : type === 'err' ? '⚠️' : 'ℹ️';
    node.innerHTML = `<span class="toast__icon">${icon}</span><span>${escapeHtml(message)}</span>`;
    toastBox.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .2s, transform .2s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      setTimeout(() => node.remove(), 220);
    }, timeout);
  }

  /* ------------------------------------------------------------------ */
  /* 管理口令                                                            */
  /* ------------------------------------------------------------------ */

  const TOKEN_KEY = 'kbqa.adminToken';
  const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
  const setToken = (v) => (v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY));

  function apiFetch(url, options = {}) {
    const headers = Object.assign({}, options.headers);
    const token = getToken();
    if (token) headers['x-admin-token'] = token;
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(url, Object.assign({}, options, { headers }));
  }

  async function readError(res) {
    try {
      const data = await res.json();
      return data.error || data.message || `请求失败（HTTP ${res.status}）`;
    } catch {
      return `请求失败（HTTP ${res.status}）`;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 主题                                                               */
  /* ------------------------------------------------------------------ */

  const THEME_KEY = 'kbqa.theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }

  (function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
    if (stored === 'dark' || stored === 'light') { applyTheme(stored); return; }
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(prefersLight ? 'light' : 'dark');
  })();

  $('#btnTheme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  /* ------------------------------------------------------------------ */
  /* 状态与元素                                                          */
  /* ------------------------------------------------------------------ */

  const el = {
    chat: $('#chat'),
    messages: $('#messages'),
    welcome: $('#welcome'),
    input: $('#input'),
    btnSend: $('#btnSend'),
    composerBox: $('#composerBox'),
    chipMode: $('#chipMode'),
    chipDocs: $('#chipDocs'),
    envBanner: $('#envBanner'),
    envBannerClose: $('#envBannerClose'),
    drawer: $('#drawer'),
    scrim: $('#drawerScrim')
  };

  const MIN_RELEVANCE = 0.05;

  let streaming = false;
  let controller = null;
  let scrollLocked = false;
  // 提示条关闭后本次会话内不再打扰（刷新页面会重新提示）
  let bannerDismissed = false;

  // 配置变更提示条：关掉后本次会话不再提示，但顶栏徽标继续保留告警状态
  el.envBannerClose.addEventListener('click', () => {
    bannerDismissed = true;
    el.envBanner.hidden = true;
  });

  /* ------------------------------------------------------------------ */
  /* 滚动行为                                                            */
  /* ------------------------------------------------------------------ */

  function isNearBottom(threshold = 120) {
    return el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < threshold;
  }

  function scrollToBottom(force = false) {
    if (force || !scrollLocked) {
      el.chat.scrollTop = el.chat.scrollHeight;
    }
  }

  el.chat.addEventListener('scroll', () => {
    scrollLocked = !isNearBottom();
  }, { passive: true });

  /* ------------------------------------------------------------------ */
  /* 消息渲染                                                            */
  /* ------------------------------------------------------------------ */

  function hideWelcome() {
    if (el.welcome && el.welcome.parentNode) el.welcome.remove();
  }

  function appendUserMessage(text) {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--user';
    wrap.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    el.messages.appendChild(wrap);
    scrollToBottom(true);
  }

  function createAssistantMessage() {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--assistant';
    wrap.innerHTML = `
      <div class="avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
             stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5z"></path>
          <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5A1.5 1.5 0 0 0 20 15.5z"></path>
        </svg>
      </div>
      <div class="msg__body">
        <div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span class="thinking__text">正在检索知识库…</span></div>
      </div>`;
    el.messages.appendChild(wrap);
    scrollToBottom(true);

    return {
      wrap,
      body: $('.msg__body', wrap),
      thinking: $('.thinking', wrap),
      thinkingText: $('.thinking__text', wrap)
    };
  }

  /** 渲染来源卡片 */
  function renderSources(citations) {
    const usable = (citations || []).filter((c) => (c.coverage || 0) >= MIN_RELEVANCE);
    if (usable.length === 0) return null;

    const box = document.createElement('div');
    // 参考资料默认折叠：回答本身才是主角，来源按需展开，避免长列表淹没答案。
    box.className = 'sources is-collapsed';

    const items = usable.map((c) => {
      const pct = Math.max(6, Math.round((c.coverage || 0) * 100));
      return `
        <div class="source" id="src-${c.index}" data-cite="${c.index}">
          <div class="source__idx">${c.index}</div>
          <div class="source__main">
            <div class="source__title">${escapeHtml(c.title || '未命名资料')}</div>
            <div class="source__meta">
              <span>${escapeHtml(c.source || '')}</span>
              ${c.section ? `<span class="dot">·</span><span>${escapeHtml(c.section)}</span>` : ''}
            </div>
            <div class="source__snippet" data-role="snippet">${escapeHtml(c.snippet || '')}</div>
            <div class="source__more" data-role="more">展开全文 ▾</div>
            <div class="source__rel">
              <span>相关度</span>
              <span class="relbar"><span style="width:${pct}%"></span></span>
              <span>${pct}%</span>
            </div>
          </div>
        </div>`;
    }).join('');

    box.innerHTML = `
      <button class="sources__toggle" type="button" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
             stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 9l6 6 6-6"></path>
        </svg>
        <span>参考资料 ${usable.length} 条</span>
      </button>
      <div class="sources__list">${items}</div>`;

    $('.sources__toggle', box).addEventListener('click', () => {
      box.classList.toggle('is-collapsed');
      const collapsed = box.classList.contains('is-collapsed');
      $('.sources__toggle', box).setAttribute('aria-expanded', String(!collapsed));
    });

    box.addEventListener('click', (event) => {
      const more = event.target.closest('[data-role="more"]');
      if (more) {
        const snippet = more.parentNode.querySelector('[data-role="snippet"]');
        snippet.classList.toggle('is-open');
        more.textContent = snippet.classList.contains('is-open') ? '收起 ▴' : '展开全文 ▾';
      }
    });

    return box;
  }

  /** 让引用角标点击后滚动并高亮对应的来源卡片 */
  function bindCitationJump(container) {
    container.addEventListener('click', (event) => {
      const cite = event.target.closest('.cite');
      if (!cite) return;
      const idx = cite.getAttribute('data-cite');
      const card = document.getElementById(`src-${idx}`);
      if (!card) return;

      // 参考资料默认是折叠的，卡片此刻处于 display:none，
      // 不先展开就 scrollIntoView 等于什么都没发生。所以先确保它可见。
      const box = card.closest('.sources');
      if (box && box.classList.contains('is-collapsed')) {
        box.classList.remove('is-collapsed');
        const toggle = $('.sources__toggle', box);
        if (toggle) toggle.setAttribute('aria-expanded', 'true');
      }

      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('is-active');
      setTimeout(() => card.classList.remove('is-active'), 1800);
    });
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const cite = event.target.closest('.cite');
      if (!cite) return;
      event.preventDefault();
      cite.click();
    });
  }

  /* ------------------------------------------------------------------ */
  /* SSE 客户端                                                          */
  /* ------------------------------------------------------------------ */

  async function postChatStream({ question, history, signal, onEvent }) {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
      signal
    });

    if (!response.ok) {
      throw new Error(await readError(response));
    }
    if (!response.body) {
      throw new Error('当前浏览器不支持流式读取响应。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const dispatch = (rawEvent) => {
      let eventName = 'message';
      const dataLines = [];

      for (const line of rawEvent.split('\n')) {
        if (line.startsWith(':')) continue;           // 心跳
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;

      let payload = {};
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        return;
      }
      onEvent(eventName, payload);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatch(rawEvent);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) dispatch(buffer);
  }

  /* ------------------------------------------------------------------ */
  /* 对话主流程                                                          */
  /* ------------------------------------------------------------------ */

  const conversation = []; // {role:'user'|'assistant', content:string}

  function buildHistory() {
    return conversation
      .filter((m) => m.content && m.content.trim())
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
  }

  function setStreaming(value) {
    streaming = value;
    el.btnSend.classList.toggle('is-streaming', value);
    el.btnSend.setAttribute('aria-label', value ? '停止生成' : '发送');
    el.input.disabled = value;
  }

  async function ask(question) {
    const text = String(question || '').trim();
    if (!text || streaming) return;

    appendUserMessage(text);
    conversation.push({ role: 'user', content: text });

    el.input.value = '';
    autoGrow();
    setStreaming(true);

    const ui = createAssistantMessage();
    controller = new AbortController();

    let answerText = '';
    let citations = [];
    let settledForRender = false;
    let renderQueued = false;

    const paint = () => {
      renderQueued = false;
      if (!settledForRender) {
        // 首次输出时把"思考中"替换成正文容器
        ui.body.innerHTML = '<div class="answer is-streaming"></div>';
        settledForRender = true;
        bindCitationJump(ui.body);
      }
      const answerEl = $('.answer', ui.body);
      if (answerEl) {
        answerEl.innerHTML = renderMarkdown(answerText, { maxCite: citations.length });
      }
    };

    const schedule = () => {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(paint);
    };

    const setStage = (label) => {
      if (ui.thinkingText) ui.thinkingText.textContent = label;
    };

    let meta = null;
    let noticeEl = null;

    const showNotice = (kind, headline, bodyHtml) => {
      if (!settledForRender) {
        ui.body.innerHTML = '';
        settledForRender = true;
      }
      noticeEl = document.createElement('div');
      noticeEl.className = `notice notice--${kind}`;
      noticeEl.innerHTML = `<div class="notice__head">${kind === 'fallback' ? '🛡️' : '⚠️'}<span>${escapeHtml(headline)}</span></div><div>${bodyHtml}</div>`;
      ui.body.appendChild(noticeEl);
    };

    try {
      await postChatStream({
        question: text,
        history: buildHistory().slice(0, -1),
        signal: controller.signal,
        onEvent(name, payload) {
          if (name === 'meta') {
            meta = payload;
            citations = payload.citations || [];
            setStage(payload.mode === 'direct' ? '正在回答…'
              : `正在阅读 ${citations.length} 条资料…`);
          } else if (name === 'delta') {
            if (!settledForRender) setStage('正在作答…');
            answerText += payload.text || '';
            schedule();
          } else if (name === 'fallback') {
            showNotice('fallback', '知识库未覆盖此问题', renderMarkdown(payload.message || '', { maxCite: 0 }));
            answerText = '';
          } else if (name === 'error') {
            showNotice('error', '生成失败', renderMarkdown(payload.message || '未知错误'));
          } else if (name === 'done') {
            // 结束事件，收尾统一在下方处理
          }
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        if (settledForRender && answerText.trim()) {
          answerText += '\n\n> ⏹ 已由用户停止生成。';
          paint();
        } else {
          showNotice('fallback', '已停止生成', '<p>本次回答已被中断。</p>');
        }
      } else {
        showNotice('error', '请求失败', renderMarkdown(err.message || '网络异常'));
      }
    } finally {
      setStreaming(false);
      controller = null;

      const answerEl = $('.answer', ui.body);
      if (answerEl) answerEl.classList.remove('is-streaming');

      // 兜底/错误场景：给出本轮检索到的候选资料，便于判断是不是阈值调得太严
      const verbose = meta && (meta.verbose || meta);
      if (!answerText.trim() && noticeEl && verbose && verbose.citations && verbose.citations.length) {
        const src = renderSources(verbose.citations);
        if (src) {
          src.classList.add('is-collapsed');
          noticeEl.parentNode.insertBefore(src, noticeEl.nextSibling);
        }
      }

      if (answerText.trim()) {
        // 正文 + 来源
        const src = renderSources(citations);
        if (src) ui.body.appendChild(src);

        const foot = document.createElement('div');
        foot.className = 'msg__foot';
        const modeLabel = meta && meta.mode === 'hybrid' ? '混合检索'
          : meta && meta.mode === 'keyword' ? '关键词检索'
          : meta && meta.mode === 'direct' ? '直答'
          : '检索';

        foot.innerHTML = `
          <span class="tag tag--ok">✓ 依据知识库作答</span>
          <span class="tag">${modeLabel}</span>
          ${meta && meta.coverage != null ? `<span class="tag">覆盖率 ${(meta.coverage * 100).toFixed(0)}%</span>` : ''}
          ${meta && meta.retrievalMs != null ? `<span class="tag">检索 ${meta.retrievalMs} ms</span>` : ''}
          <button class="btn btn--ghost btn--sm" data-role="copy" type="button">复制</button>`;
        foot.querySelector('[data-role="copy"]').addEventListener('click', async (event) => {
          const btn = event.currentTarget;
          try {
            await navigator.clipboard.writeText(answerText);
            btn.textContent = '已复制';
          } catch {
            btn.textContent = '复制失败';
          }
          setTimeout(() => { btn.textContent = '复制'; }, 1600);
        });
        ui.body.appendChild(foot);

        conversation.push({ role: 'assistant', content: answerText });
      } else {
        conversation.push({ role: 'assistant', content: noticeEl ? noticeEl.textContent.slice(0, 500) : '（未作答）' });
      }

      // 触发一次来源加载检查（首次提问后可能才知道知识库是空的）
      refreshStats().catch(() => {});
      scrollToBottom();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 输入框                                                              */
  /* ------------------------------------------------------------------ */

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 190) + 'px';
  }

  el.input.addEventListener('input', autoGrow);

  el.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      ask(el.input.value);
    }
  });

  el.btnSend.addEventListener('click', () => {
    if (streaming) {
      if (controller) controller.abort();
      return;
    }
    ask(el.input.value);
  });

  $('#btnClear').addEventListener('click', () => {
    if (streaming && controller) controller.abort();
    conversation.length = 0;
    el.messages.innerHTML = '';
    location.reload();
  });

  $('#samples').addEventListener('click', (event) => {
    const btn = event.target.closest('.sample');
    if (!btn) return;
    ask(btn.getAttribute('data-q'));
  });

  /* ------------------------------------------------------------------ */
  /* 知识库管理抽屉                                                      */
  /* ------------------------------------------------------------------ */

  function openDrawer() {
    el.drawer.hidden = false;
    el.scrim.hidden = false;
    document.body.style.overflow = 'hidden';
    refreshStats().catch(() => {});
    renderDocs().catch(() => {});
    $('#adminToken').value = getToken();
  }

  function closeDrawer() {
    el.drawer.hidden = true;
    el.scrim.hidden = true;
    document.body.style.overflow = '';
  }

  $('#btnKb').addEventListener('click', openDrawer);
  $('#btnCloseDrawer').addEventListener('click', closeDrawer);
  el.scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.drawer.hidden) closeDrawer(); });

  /* ---------- 统计 ---------- */

  let lastStats = null;

  async function refreshStats() {
    const res = await apiFetch('/api/kb/stats');
    if (!res.ok) throw new Error(await readError(res));
    const data = await res.json();
    lastStats = data;

    const s = data.stats || {};
    $('#statDocs').textContent = formatNumber(s.documents || 0);
    $('#statChunks').textContent = formatNumber(s.chunks || 0);
    $('#statChars').textContent = formatNumber(s.characters || 0);
    $('#statMode').textContent = s.vectorEnabled ? '混合' : '关键词';
    $('#kbUpdatedAt').textContent = s.updatedAt ? `索引更新于 ${formatTime(s.updatedAt)}` : '尚未建立索引';

    // 顶栏状态
    el.chipDocs.textContent = `${s.documents || 0} 份资料 · ${s.chunks || 0} 片段`;

    // 配置文件改了但服务没重启 —— 优先级最高，因为它会让用户误以为改配置无效
    const stale = Boolean(data.capabilities && data.capabilities.envStale);
    el.envBanner.hidden = !stale || bannerDismissed;

    if (stale && !bannerDismissed) {
      el.chipMode.textContent = '配置待重启';
      el.chipMode.className = 'chip chip--warn';
    } else if (data.capabilities && data.capabilities.chat === false) {
      el.chipMode.textContent = '未配置模型密钥';
      el.chipMode.className = 'chip chip--warn';
    } else if (s.vectorEnabled) {
      el.chipMode.textContent = '混合检索';
      el.chipMode.className = 'chip chip--ok';
    } else {
      el.chipMode.textContent = '关键词检索';
      el.chipMode.className = 'chip chip--muted';
    }

    const formats = (data.limits && data.limits.formats) || [];
    if (formats.length) {
      $('#dropzoneSub').textContent =
        `支持 ${formats.join(' / ')}，单文件最大 ${data.limits.maxUploadMB} MB`;
    }

    const vectorNote = $('#vectorNote');
    if (s.vectorEnabled) {
      vectorNote.textContent = `向量检索已开启（${s.embedModel || '未知模型'}），检索为 BM25 + 向量混合模式。`;
    } else if (data.capabilities && data.capabilities.vector === false) {
      vectorNote.textContent = '未配置向量模型，当前为本地 BM25 关键词检索。配置 EMBED_BASE_URL 后可开启混合检索。';
    } else {
      vectorNote.textContent = '已配置向量模型但尚未生成向量，点击「生成向量」即可开启混合检索。';
    }

    return data;
  }

  /* ---------- 文档列表 ---------- */

  async function renderDocs() {
    const box = $('#docList');
    const res = await apiFetch('/api/kb/stats');
    if (!res.ok) {
      box.innerHTML = `<p class="empty">加载失败：${escapeHtml(await readError(res))}</p>`;
      return;
    }
    const data = await res.json();
    const docs = data.documents || [];

    if (docs.length === 0) {
      box.innerHTML = '<p class="empty">还没有任何资料，先导入一份试试。</p>';
      return;
    }

    box.innerHTML = docs.map((doc) => `
      <div class="doc">
        <div class="doc__main">
          <div class="doc__title" title="${escapeHtml(doc.title)}">${escapeHtml(doc.title)}</div>
          <div class="doc__meta">
            ${escapeHtml(doc.source || '')} · ${doc.chunkCount || 0} 个片段 · ${formatNumber(doc.charCount || 0)} 字
          </div>
        </div>
        <button class="doc__del" type="button" data-doc-id="${escapeHtml(doc.id)}" title="删除">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"></path>
          </svg>
        </button>
      </div>`).join('');
  }

  $('#docList').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-doc-id]');
    if (!btn) return;
    const docId = btn.getAttribute('data-doc-id');
    const title = $('.doc__title', btn.closest('.doc'))?.textContent || '该资料';
    if (!window.confirm(`确定要从知识库中删除《${title}》吗？\n删除后其内容将不再参与检索。`)) return;

    btn.disabled = true;
    try {
      const res = await apiFetch(`/api/kb/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await readError(res));
      toast(`已删除《${title}》`, 'ok');
      await Promise.all([refreshStats(), renderDocs()]);
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  /* ---------- 上传 ---------- */

  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  ['dragenter', 'dragover'].forEach((type) => {
    dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach((type) => {
    dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.remove('is-over'); });
  });
  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) uploadFiles(files);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFiles(fileInput.files);
    fileInput.value = '';
  });

  async function uploadFiles(fileList) {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const list = $('#uploadList');
    list.innerHTML = '';

    const rows = files.map((file) => {
      const row = document.createElement('div');
      row.className = 'upload-item';
      row.innerHTML = `<span class="upload-item__name">${escapeHtml(file.name)}</span><span class="upload-item__state">等待中…</span>`;
      list.appendChild(row);
      return row;
    });

    const form = new FormData();
    files.forEach((file) => form.append('files', file));

    try {
      const res = await apiFetch('/api/kb/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();

      let needsSuggestion = false;

      (data.results || []).forEach((result, i) => {
        const row = rows[i];
        if (!row) return;
        if (result.ok) {
          row.classList.add('upload-item--ok');
          $('.upload-item__state', row).textContent = `✓ ${result.chunks} 片段`;
        } else {
          row.classList.add('upload-item--err');
          $('.upload-item__state', row).textContent = `✗ ${result.reason || '失败'}`;
          row.title = result.reason || '';
          // 扫描件这类"文件本身有问题"的失败，需要把处置建议也摆出来，
          // 否则用户只看到"未提取到有效正文"，不知道该拿原文件怎么办。
          if (result.suggestion) {
            needsSuggestion = true;
            row.classList.add('upload-item--wrapped');
            const tip = document.createElement('div');
            tip.className = 'upload-item__tip';
            tip.textContent = `处理建议：${result.suggestion}`;
            row.appendChild(tip);
          }
        }
      });

      if (data.succeeded > 0) {
        toast(`成功导入 ${data.succeeded} 个文件${data.failed ? `，${data.failed} 个失败` : ''}`, data.failed ? 'info' : 'ok');
      } else if (needsSuggestion) {
        toast('导入被跳过：文件里没有可用的文字内容，请查看下方处理建议', 'err', 8000);
      } else {
        toast('导入失败，请检查文件格式', 'err');
      }

      await Promise.all([refreshStats(), renderDocs()]);
    } catch (err) {
      rows.forEach((row) => {
        row.classList.add('upload-item--err');
        $('.upload-item__state', row).textContent = `✗ ${err.message}`;
      });
      toast(err.message, 'err');
    }
  }

  /* ---------- 粘贴导入 ---------- */

  $('#btnPasteImport').addEventListener('click', async () => {
    const title = $('#pasteTitle').value.trim();
    const text = $('#pasteText').value.trim();

    if (!text) { toast('请先粘贴资料正文', 'err'); return; }

    const btn = $('#btnPasteImport');
    btn.disabled = true;
    btn.textContent = '导入中…';

    try {
      const res = await apiFetch('/api/kb/text', {
        method: 'POST',
        body: JSON.stringify({ title, text })
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      if (!data.ok) throw new Error((data.result && data.result.reason) || '导入失败');

      toast(`已导入《${data.result.title}》，共 ${data.result.chunks} 个片段`, 'ok');
      $('#pasteTitle').value = '';
      $('#pasteText').value = '';
      await Promise.all([refreshStats(), renderDocs()]);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '导入这段文本';
    }
  });

  /* ---------- 维护操作 ---------- */

  $('#btnRefresh').addEventListener('click', () => {
    Promise.all([refreshStats(), renderDocs()]).then(() => toast('已刷新', 'ok')).catch((e) => toast(e.message, 'err'));
  });

  $('#btnReindex').addEventListener('click', async () => {
    const btn = $('#btnReindex');
    btn.disabled = true;
    btn.textContent = '重建中…';
    try {
      const res = await apiFetch('/api/kb/reindex', { method: 'POST', body: JSON.stringify({ withVectors: true }) });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      const r = data.result || {};
      const skipped = r.skipped || [];
      const failedCount = (r.failures && r.failures.length) || 0;

      if (skipped.length) {
        // 扫描件是"静默跳过"的：必须显式告诉用户哪些文件没进去、为什么，
        // 否则用户会以为重建成功就等于资料都在。
        const names = skipped.map((s) => s.file).join('、');
        toast(
          `索引已重建：${r.documents} 份资料 / ${r.chunks} 个片段。` +
          `已跳过 ${skipped.length} 个无有效正文的文件：${names}` +
          `（多为扫描件，建议改用带文字层的版本后重新导入）`,
          'info',
          12000
        );
      } else {
        toast(`索引已重建：${r.documents} 份资料 / ${r.chunks} 个片段${failedCount ? `，${failedCount} 个文件失败` : ''}`, 'ok');
      }
      await Promise.all([refreshStats(), renderDocs()]);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '重建索引';
    }
  });

  $('#btnVectors').addEventListener('click', async () => {
    const btn = $('#btnVectors');
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const res = await apiFetch('/api/kb/vectors', { method: 'POST' });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      toast(`向量已生成：${data.result.embedded} 个片段，维度 ${data.result.dim}`, 'ok');
      await refreshStats();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '生成向量';
    }
  });

  /* ---------- 口令 ---------- */

  $('#btnSaveToken').addEventListener('click', async () => {
    const value = $('#adminToken').value.trim();
    setToken(value);
    try {
      const res = await fetch('/api/kb/auth-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value })
      });
      const data = await res.json();
      toast(data.message || (res.ok ? '已保存' : '口令不正确'), res.ok ? 'ok' : 'err');
    } catch (err) {
      toast(`校验失败：${err.message}`, 'err');
    }
  });

  /* ------------------------------------------------------------------ */
  /* 健康检查 + 初始化                                                    */
  /* ------------------------------------------------------------------ */

  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.config && data.config.issues && data.config.issues.length) {
        toast(data.config.issues[0], 'err', 8000);
      }
      if (data.kb && data.kb.documents === 0) {
        toast('知识库还是空的，先点右上角「知识库管理」导入一份资料吧。', 'info', 7000);
      }
    } catch {
      toast('无法连接服务端，请确认服务已启动。', 'err', 8000);
    }
  }

  function handleHashForMobileDrawer() {
    // 移动端把抽屉做成底部弹层，滚动锁定由 openDrawer 处理，此处仅兜底
    if (window.innerWidth <= 640) document.body.style.overscrollBehavior = 'none';
  }

  refreshStats().catch(() => {});
  checkHealth();
  handleHashForMobileDrawer();
  autoGrow();
  el.input.focus();

  window.addEventListener('resize', debounce(() => {
    if (window.innerWidth <= 640) document.body.style.overscrollBehavior = 'none';
    else document.body.style.overscrollBehavior = '';
  }, 200));

})();
