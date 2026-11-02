/* ============================================================
 * 抖音网页版 · 私信 AI 自动接待 v3.0.0
 *
 * 和原版（zhuhhz/DY-auto）的根本区别：
 *   原版：未读小红点 -> 点进会话 -> 发一句写死的话术
 *   本版：未读小红点 -> 点进会话 -> 读整段对话 -> 喂给大模型 -> 校验 -> 逐字输入 -> 发送
 *
 * 关键设计：
 *   1) 只回"对方最后一条"，自己最后一条时不回（天然防自问自答循环）
 *   2) 生成走 background（key 不进页面，也不受页面 CORS 限制）
 *   3) 模型输出必须过 6 道校验：空 / 越界承诺 / 联系方式 / 长度 / 换行 / 转人工标记
 *   4) 校验不过就发兜底话术，绝不把模型乱说的东西发出去
 *   5) 默认"草稿模式"：会进去读、会生成、会把草稿打到面板，但不发送
 * ============================================================ */
(() => {
  'use strict';

  const VERSION = '3.7.1';

  const CFG = {
    scanMs: [2500, 4000],
    minGapMs: [5000, 9000],
    thinkDelay: [8000, 30000],   // 生成完先停顿再发；期间对方再发消息就合并重答
    chatTtlMs: 20 * 60 * 1000,
    retryTtlMs: 90 * 1000,
    maxAttempts: 3,
    typeDelay: [40, 100],
    bucket: { capacity: 60, refillPerMin: 6 },      // 全局速度上限（批量处理未读时够用）
    perChatLimit: 6,                                // 单会话每小时最多回几条
    perChatWindowMs: 60 * 60 * 1000,
    itemCap: 90,
    ctxMsgs: 16,
    ctxCharBudget: 3000,
    kbCharBudget: 1500,
  };

  const SEL = {
    /* 会话列表：抖音 IM 是 conversation/ConversationList + ConversationItem 的 BEM 拼接。
       千万别用 [class*="message"] —— 那会匹配到右边的消息区，把消息当会话。 */
    list: [
      '[class*="conversationlist" i]',
      '[class*="ConversationList"]',
      '#island_b69f5',
      '[class*="chat-list"]',
    ],
    item: [
      '[class*="conversationitem" i]',
      '[class*="strangerbox" i]',
      '[class*="ConversationItem"]',
      'li',
      '[role="listitem"]',
    ],
    unreadClass: ['[class*="unread"]', '[aria-label*="未读"]', '[class*="badge"]', '[class*="reddot" i]'],
    editor: ['div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
    send: ['.e2e-send-msg-btn', 'span[class*="send"]', 'path[fill="#FE2C55"]'],
    exit: ['[class*="exit"]', '[aria-label*="退出"]', '[title*="退出"]'],
    /* 对话气泡容器：按可能性从高到低试，抖音改版时优先改这里。
       抖音 IM 的类名是 BEM 拼接（conversation + MessageList / ChatRoom ...），
       左边侧边栏是 componentsLeftPanel-boxList + conversationConversationListwr，由 isSidebar() 排掉。 */
    thread: [
      '[class*="messageMessageList"]',
      '[class*="MessageList"]',
      '[class*="messageList"]',
      '[class*="message-list"]',
      '[class*="conversationMessage"]',
      '[class*="conversationChat"]',
      '[class*="chatContent"]',
    ],
  };

  const BRAND = ['255, 44, 85', '254, 44, 85', '#fe2c55', '#ff2c55'];
  const ESCALATE = /\[\[\s*ESCALATE\s*\]\]|转人工/i;

  const S = {
    busy: false,
    enabled: false,
    dryRun: true,
    persona: '本店客服',
    kb: '',
    maxChars: 40,
    fallback: '稍等，我确认一下再回您',
    allowGeneral: true,      // 知识库没有的通用问题（1+1、闲聊）允许模型自己答
    vision: false,           // 图片交给 VLM 描述
    asr: false,              // 语音交给 ASR 转写
    kbRetrieve: true,        // 本地资料库检索
    kbHits: [],
    threadSel: '',           // 手动指定的消息区 CSS 选择器（抖音用纯 hash 类名时的兜底）
    allowIds: [],            // 白名单：只对这些会话生效，空 = 全部
    described: new Set(),    // 已识别过的图片 url
    memInfo: { msgs: 0, chats: 0, summary: 0, facts: 0, total: 0 },
    lastSendAt: 0,
    lastGen: null,
    stage: '',               // 当前卡在哪一步
    records: new Map(),      // chatId -> { key, at, ok, attempts }
    replies: new Map(),      // chatId -> { count, since }
    tokens: CFG.bucket.capacity,
    lastRefill: Date.now(),
    scanTimer: null,
  };

  /* 日志环形缓冲：面板上能直接看，卡住时不用开 DevTools */
  const logBuf = [];
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })())).join(' ');
    logBuf.push(new Date().toLocaleTimeString() + '  ' + line);
    if (logBuf.length > 60) logBuf.shift();
    console.log('[DY-AI]', ...a);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /* ---------------- 可见性 / 基础 ---------------- */

  function shown(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  }

  function isBrandRed(bg) {
    if (!bg) return false;
    const s = String(bg).toLowerCase();
    return BRAND.some((c) => s.includes(c));
  }

  /* ---------------- 会话列表 ---------------- */

  /**
   * 会话列表项。
   * 关键：抖音的类名是嵌套重复的（conversationConversationItemwrapper >
   * conversationConversationItemrowArea2 > ...），用 [class*=item] 会一个会话匹配出 4-8 个元素。
   * 所以先找列表容器、只取它的「直接子元素」；兜底时再用「去掉有同类祖先的元素」去重。
   */
  function listItems() {
    const out = [];
    const seen = new Set();
    const push = (el) => { if (el && !seen.has(el)) { seen.add(el); out.push(el); } };

    const itemSized = (el) => {
      if (!shown(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 160 && r.height >= 40 && r.height <= 140;   // 会话项大概 60-80px 高
    };

    /* 1) 容器 -> 直接子元素（最干净，20 个会话就是 20 项） */
    for (const sel of SEL.list) {
      let roots = [];
      try { roots = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      if (!roots.length) continue;
      for (const root of roots) {
        if (!shown(root)) continue;
        [...root.children].filter(itemSized).forEach(push);
      }
      if (out.length) break;
    }

    /* 2) 兜底：按 item 选择器找，然后把「祖先也匹配同一选择器」的深层元素丢掉 */
    if (!out.length) {
      for (const sel of SEL.item) {
        let nodes = [];
        try { nodes = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
        for (const el of nodes) {
          if (!itemSized(el)) continue;
          let nested = false;
          try {
            if (el.parentElement && el.parentElement.closest(sel)) nested = true;
          } catch (e) {}
          if (nested) continue;
          push(el);
        }
        if (out.length) break;
      }
    }

    /* 3) 同样的文本只留第一个（防止外层和整行重复） */
    const byText = new Map();
    const final = [];
    for (const el of out) {
      const t = norm(el.textContent || '').slice(0, 40);
      if (t && byText.has(t)) continue;
      if (t) byText.set(t, el);
      final.push(el);
    }
    return final;
  }

  function chatIdOf(item) {
    if (!item || !item.getAttribute) return null;
    const d = item.getAttribute('data-uid') || item.getAttribute('data-user-id');
    if (d) return String(d);
    try {
      const a = item.querySelector('a[href*="/user/"]');
      const m = a && (a.getAttribute('href') || '').match(/\/user\/(\d+)/);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }

  function hasUnread(item) {
    for (const sel of SEL.unreadClass) {
      try {
        const el = item.querySelector(sel);
        if (el && shown(el)) return true;
      } catch (e) {}
    }
    let nodes;
    try { nodes = item.querySelectorAll('span, div'); } catch (e) { return false; }
    const cap = Math.min(nodes.length, CFG.itemCap);
    for (let i = 0; i < cap; i++) {
      const el = nodes[i];
      if (!el || !el.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.width > 32 || r.height < 8 || r.height > 32) continue;   // 小红点也可能只有 8-10px
      if (Math.abs(r.width - r.height) > 4) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      if (!isBrandRed(st.backgroundColor)) continue;
      const t = norm(el.innerText || el.textContent);
      if (/^\d+$/.test(t) && parseInt(t, 10) > 0) return true;
      if (r.width <= 18 && r.height <= 18) return true;
      const path = el.querySelector && el.querySelector('path');
      if (path && /#f[ef]2c55/i.test(String(path.getAttribute('fill') || ''))) return true;
    }
    return false;
  }

  /* ---------------- 读对话（核心新增） ---------------- */

  /* 抖音 IM 的类名是 BEM 拼接：conversation + ConversationList + wr = conversationConversationListwr。
     左边侧边栏 / 会话列表必须排掉，那不是消息区。 */
  const SIDEBAR_RE = /LeftPanel|ConversationList|boxList|sidebar/i;

  function isSidebar(el) {
    if (!el) return false;
    if (SIDEBAR_RE.test(String(el.className || ''))) return true;
    try {
      /* 只按「会话列表」这一层排除；不要按 LeftPanel 祖先排除 —— 整个私信抽屉可能都叫 LeftPanel */
      if (el.closest && el.closest('[class*="ConversationList"]')) return true;
      if (el.closest && el.closest('[class*="boxList"]')) return true;
    } catch (e) {}
    return false;
  }

  /** 找对话气泡容器：手填选择器 -> 内置候选 -> 从输入框往上爬的结构兜底 */
  function threadRoot() {
    /* 1) 用户/我在弹窗里手填的选择器优先（读不到时靠它兜底） */
    if (S.threadSel) {
      try {
        const el = document.querySelector(S.threadSel);
        if (el && shown(el)) return el;
      } catch (e) { log('⚠️ 自定义选择器无效：', S.threadSel); }
    }

    /* 2) 内置候选 */
    for (const sel of SEL.thread) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      for (const el of els) {
        if (!shown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 150 || r.height < 100) continue;
        if (el.childElementCount < 1) continue;
        if (isSidebar(el)) continue;                      // 左栏（会话列表）不是消息区
        if (looksLikeList(threadRows(el))) continue;      // 每行带日期 = 会话列表
        return el;
      }
    }

    /* 3) 结构兜底：从输入框往上爬，找「在输入框上方 + 可滚动 + 子节点多」的兄弟块 */
    const ed = editorBox();
    if (!ed) return null;
    const edRect = ed.getBoundingClientRect();
    let p = ed.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      const parent = p.parentElement;
      if (!parent) break;
      let best = null;
      let bestScore = 0;
      for (const sib of parent.children) {
        if (sib === p) continue;
        if (!shown(sib)) continue;
        if (isSidebar(sib)) continue;
        const r = sib.getBoundingClientRect();
        if (r.width < 150 || r.height < 100) continue;
        let score = r.height;
        if (r.bottom <= edRect.top + 60) score += 400;                       // 在输入框上方 = 更像消息区
        if (sib.scrollHeight > sib.clientHeight + 20) score += 250;           // 可滚动
        score += Math.min(sib.childElementCount, 40) * 8;
        if (norm(sib.innerText || sib.textContent).length > 10) score += 120;  // 有文字
        if (score > bestScore) { bestScore = score; best = sib; }
      }
      if (best) {
        if (isSidebar(best)) { p = parent; continue; }
        if (looksLikeList(threadRows(best))) { p = parent; continue; }
        return best;
      }
      p = parent;
    }
    return null;
  }

  /**
   * 容器里的消息行。抖音有时候会套两层 wrapper：
   *   boxList > ConversationList-wr > item...
   * 判据：只有一个子元素、而且它的文本很长（>200 字）或它还有多个子元素，就往下钻。
   */
  function threadRows(root) {
    if (!root) return [];
    let rows = [...root.children];
    for (let depth = 0; depth < 3; depth++) {
      if (rows.length !== 1 || !rows[0] || !rows[0].children) break;
      const only = rows[0];
      const long = norm(only.textContent || '').length > 200;
      if (only.children.length >= 2 || long) { rows = [...only.children]; continue; }
      break;
    }
    return rows;
  }

  /** 取行内真正的文字叶子节点，用它判断左右对齐 */
  function textLeaf(row) {
    let best = null;
    let nodes = [];
    try { nodes = [...row.querySelectorAll('span, div, p')]; } catch (e) { return null; }
    for (const n of nodes) {
      if (n.childElementCount) continue;
      const t = norm(n.innerText || n.textContent);
      if (!t) continue;
      if (!best) { best = n; continue; }
      if (t.length > norm(best.innerText || best.textContent).length) best = n;
    }
    return best;
  }

  function dirOf(row, rootRect, leaf) {
    /* 0) 抖音把方向直接写在类名里：messageMessageBoxisFromMe / MessageBoxContentisFromMe
          这一层最可信（比几何稳，尤其是窄窗口） */
    const rowCls = String(row.className || '');
    if (/isFromMe|isfromme/i.test(rowCls)) return 'me';
    if (/isFromOther|isfromother|isFromFriend/i.test(rowCls)) return 'them';
    try {
      if (row.querySelector && row.querySelector('[class*="isFromMe"]')) return 'me';
      if (row.querySelector && row.querySelector('[class*="isFromOther"]')) return 'them';
    } catch (e) {}

    /* 1) 其它类名提示 */
    const cls = (rowCls + ' ' + String((leaf && leaf.className) || '')).toLowerCase();
    if (/self|mine|isme|right|owner/.test(cls)) return 'me';
    if (/other|left|friend|peer/.test(cls)) return 'them';
    /* 2) 几何：自己的气泡靠右 */
    const el = leaf && leaf.getBoundingClientRect ? leaf : row;
    const r = el.getBoundingClientRect();
    const mid = rootRect.left + rootRect.width / 2;
    if (r.left > mid - 20) return 'me';
    if (r.right < mid + 20) return 'them';
    return r.left > rootRect.left + rootRect.width * 0.35 ? 'me' : 'them';
  }

  /* 时间分隔行：09/26、2025/09/26、09:26、昨天 20:24 之类 */
  const TS_RE = /^(\d{4}[-\/])?\d{1,2}[-\/月]\d{1,2}日?$|^(昨天|前天|今天|星期[一二三四五六日天])?\s*\d{1,2}[:：]\d{2}$/;

  /** 把行首的日期剥掉，剥完是空的就说明这行只是时间分隔 */
  function stripDate(t) {
    return String(t || '').replace(/^(\d{4}[-\/])?\d{1,2}[-\/月]\d{1,2}日?\s*/, '').trim();
  }

  /* 抖音自己的系统提示，不是两个人说的话 —— 混进上下文会把模型带偏，
     尤其"你撤回了一条消息"会成为"对方最后说的"，Bot 就会去回复一条系统提示 */
  const SYS_RE = /^(已连续互聊|连续互聊|点亮.{0,4}聊天火花|.{0,12}撤回了一条消息|.{0,12}撤回了一条|对方正在输入|以下为新消息|查看更多消息|消息已发出|该消息已过期|你已添加|.{0,8}加入了群聊|.{0,8}退出了群聊|.{0,8}拍了拍|.{0,8}领取了|以上是历史消息|该内容已被删除)/;

  /** 判断这条消息是什么类型：文本 / 图片 / 表情 / 语音 / 视频 */
  function kindOf(row) {
    const cls = String(row.className || '').toLowerCase();
    if (/voice|audio|record/.test(cls)) return 'voice';
    if (/video/.test(cls)) return 'video';
    if (/emoji|sticker|emoticon/.test(cls)) return 'emoji';
    if (/image|imgbox|picture|photo|pic_/.test(cls)) return 'image';

    if (row.querySelector) {
      if (row.querySelector('audio')) return 'voice';
      if (row.querySelector('video')) return 'video';
      const img = contentImg(row);
      if (img) {
        const alt = String(img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('aria-label') || '');
        const r = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: 0, height: 0 };
        if (/^\[.+\]$/.test(alt)) return 'emoji';
        if (r.width && r.width <= 110 && r.height <= 110 && Math.abs(r.width - r.height) < 10) return 'emoji';
        return 'image';
      }
    }
    const t = norm(row.innerText || row.textContent);
    if (/^\s*\d{1,2}\s*["″']?\s*$/.test(t)) return 'voice';
    return 'text';
  }

  /**
   * 行里的「内容图」——头像不算。
   * 每个消息行都挂着头像 <img>（48~56px），不排掉的话纯日期行/空行会被当成表情消息。
   */
  function contentImg(row) {
    try {
      const imgs = [...row.querySelectorAll('img')];
      for (const im of imgs) {
        const r = im.getBoundingClientRect ? im.getBoundingClientRect() : { width: 0, height: 0 };
        if (r.width > 56 && r.height > 56) return im;
      }
    } catch (e) {}
    return null;
  }

  function firstImg(row) {
    try {
      const img = contentImg(row) || row.querySelector('img');
      if (!img) return null;
      const src = img.currentSrc || img.getAttribute('src') || (img.getAttribute('data-src') || '');
      return /^https?:\/\//.test(src) ? src : null;
    } catch (e) { return null; }
  }

  /** 头像地址：20~64px 的小方图。用来判断"对方"是不是好几个人（群聊） */
  function avatarSrc(row) {
    try {
      const imgs = [...row.querySelectorAll('img')];
      for (const im of imgs) {
        const r = im.getBoundingClientRect ? im.getBoundingClientRect() : { width: 0, height: 0 };
        if (r.width >= 20 && r.width <= 64 && r.height >= 20 && r.height <= 64) {
          const s = im.currentSrc || im.getAttribute('src') || '';
          if (s) return String(s).split('?')[0];
        }
      }
    } catch (e) {}
    return '';
  }

  /** 群聊判定：对方的消息来自两个以上不同的头像 */
  function isGroupThread(thread) {
    const set = new Set();
    let n = 0;
    for (const m of thread) {
      if (m.role !== 'them') continue;
      n++;
      if (m.av) set.add(m.av);
    }
    return n >= 2 && set.size >= 2;
  }

  /** 语音气泡里找音频地址：<audio> 的 src，或者 data-src 这类挂载属性 */
  function firstAudio(row) {
    try {
      const a = row.querySelector('audio');
      if (a) {
        const src = a.currentSrc || a.src || a.getAttribute('src') || '';
        if (src) return src;
      }
      for (const sel of ['[data-src*=".m4a"]', '[data-src*=".mp3"]', '[data-url]', '[data-src]']) {
        const n = row.querySelector(sel);
        const v = n && (n.getAttribute('data-src') || n.getAttribute('data-url'));
        if (v && /^(https?|blob):/.test(v)) return v;
      }
    } catch (e) {}
    return null;
  }

  /** 这堆行像不像「会话列表」而不是「消息记录」：列表每行都带日期 */
  function looksLikeList(rows) {
    if (!rows || rows.length < 3) return false;
    let hit = 0;
    let n = 0;
    for (const r of rows) {
      const t = norm(r && (r.textContent || ''));
      if (!t) continue;
      n++;
      if (/(\d{1,2}:\d{2})|(\d{1,2}\/\d{1,2})|(昨天|前天|星期[一二三四五六日])/.test(t)) hit++;
    }
    return n >= 3 && hit >= Math.max(3, Math.ceil(n * 0.5));
  }

  /**
   * 把当前会话读成 [{role,kind,text,src}]
   * 非文字消息统一降维成文本注解：[图片] / [表情] / [语音] —— 模型永远只吃文本
   */
  function readThread() {
    const root = threadRoot();
    if (!root) return [];
    const rows = threadRows(root);
    if (looksLikeList(rows)) {
      log('⚠️ 读到的是会话列表，不是消息记录 —— 先点开一个会话');
      return [];
    }
    const rootRect = root.getBoundingClientRect();
    const out = [];
    for (const row of rows) {
      if (!shown(row)) continue;
      const raw = norm(row.innerText || row.textContent);
      const dur = /^\d{1,2}\s*["″']?$/.test(raw);   // 语音气泡上的"6''"
      /* 纯时间分隔行（"09/26"）先干掉，别让它掉进媒体分支 */
      if (raw && TS_RE.test(raw) && raw.length <= 18) continue;
      /* 行首可能带日期（"09/25 没有啊"），剥掉再判断 */
      const t = stripDate(raw);

      /* 有文字就是文字消息 —— 哪怕行里有头像 img，也不能当表情 */
      if (t && !dur) {
        if (/^(对方正在输入|已读|未读)$/.test(t)) continue;
        if (SYS_RE.test(t)) continue;                     // 抖音的系统提示，不是人说的话
        const leaf = textLeaf(row);
        const lr = (leaf && leaf.getBoundingClientRect ? leaf : row).getBoundingClientRect();
        const clean = t.replace(/\s*(已读|未读|送达|发送中|发送失败)\s*$/, '').trim() || t;
        if (!clean || SYS_RE.test(clean)) continue;
        out.push({ role: dirOf(row, rootRect, leaf), kind: 'text', text: clean.slice(0, 300), av: avatarSrc(row), __y: lr.top });
        continue;
      }
      /* 没文字才当媒体处理 */
      const kind = kindOf(row);
      if (kind === 'voice') {
        out.push({ role: dirOf(row, rootRect, null), kind, text: '（对方发来一段语音）', src: firstAudio(row), __y: row.getBoundingClientRect().top });
      } else if (kind === 'emoji') {
        const alt = (() => {
          try {
            const img = row.querySelector('img');
            return String(img && (img.getAttribute('alt') || img.getAttribute('title') || '') || '');
          } catch (e) { return ''; }
        })();
        out.push({ role: dirOf(row, rootRect, null), kind, text: alt || '[表情]', __y: row.getBoundingClientRect().top });
      } else if (kind === 'image') {
        out.push({ role: dirOf(row, rootRect, null), kind, text: '（对方发来一张图片）', src: firstImg(row), __y: row.getBoundingClientRect().top });
      } else if (kind === 'video') {
        out.push({ role: dirOf(row, rootRect, null), kind, text: '（对方发来一段视频）', __y: row.getBoundingClientRect().top });
      }
    }

    /* 抖音的消息列表是 column-reverse（DOM 第一个是最新的、长在屏幕最下面）。
       用首尾两行的纵向位置判断：首行的 top 比末行大，说明 DOM 顺序是倒的，得翻回来。 */
    if (out.length > 1 && out[0].__y > out[out.length - 1].__y) out.reverse();
    for (const m of out) delete m.__y;
    return out;
  }

  function lastIncoming(thread) {
    for (let i = thread.length - 1; i >= 0; i--) {
      if (thread[i].role === 'them') return { msg: thread[i], index: i };
    }
    return null;
  }

  /* ---------------- 输入框 / 按钮 ---------------- */

  function editorBox() {
    for (const sel of SEL.editor) {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) {}
      if (el) return el;
    }
    return null;
  }

  function sendButton() {
    for (const sel of SEL.send) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      for (const n of nodes) {
        const t = n.tagName === 'path' && n.closest ? n.closest('div,span,button') : n;
        if (t && shown(t)) return t;
      }
    }
    return null;
  }

  /**
   * 回到会话列表（抽屉式 UI 里聊天页会盖住列表，必须点返回）
   * 顺序：返回箭头 -> aria/title 含返回 -> class 带 back -> 文字"退出会话"
   */
  function exitButton() {
    const SEL_BACK = [
      '[aria-label*="返回"]', '[title*="返回"]',
      '[class*="back" i]', '[class*="Back"]', '[class*="arrow" i]',
    ];
    for (const sel of SEL_BACK) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      for (const n of nodes) {
        if (!shown(n)) continue;
        const r = n.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.width > 80 || r.height > 80) continue;  // 返回键一般很小
        if (r.top > window.innerHeight * 0.35) continue;                            // 在顶部
        return n;
      }
    }
    for (const sel of SEL.exit) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      for (const n of nodes) {
        if (!shown(n)) continue;
        const t = norm(n.innerText);
        if (!t || /退出|离开/.test(t)) return n;
      }
    }
    return null;
  }

  function click(el) {
    if (!el || !shown(el)) return false;
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, buttons: 0, isPrimary: true, pointerType: 'mouse',
    };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', o)); } catch (e) { return false; }
    return true;
  }

  function caretToEnd(el) {
    try {
      if (typeof el.focus === 'function') el.focus();
      const sel = typeof getSelection === 'function' ? getSelection() : null;
      if (!sel || !document.createRange) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  const readEditor = (el) => norm(el && (el.innerText || el.textContent));

  /* 富文本编辑器会塞零宽字符 / 不换行空格，\s 匹配不到，肉眼一样但字符串不等 */
  const INVIS = /[\u00ad\u200b\u200c\u200d\u200e\u200f\u202a-\u202e\u2060\ufeff\u00a0]/g;
  const normCmp = (s) => String(s == null ? '' : s).replace(INVIS, '').replace(/\s+/g, ' ').trim();
  const stripPunct = (s) => normCmp(s).replace(/[，。！？、；：""''《》（）()\[\]【】,.!?;:"'\-—~～\s]/g, '');

  /**
   * 容错比较：去零宽 -> 去空白 -> 去标点。
   * 注意：**只在长度差 ≤2 时才允许“一方包含另一方”**。
   * 早期版本放开成"包含就算对"，结果"整段重复两遍"也被判通过，把重复消息发出去了。
   */
  function sameText(a, b) {
    const A = normCmp(a);
    const B = normCmp(b);
    if (A === B) return true;
    const PA = stripPunct(a);
    const PB = stripPunct(b);
    if (PA && PB && PA === PB) return true;
    if (PA && PB && Math.abs(PA.length - PB.length) <= 2 &&
        (PA.indexOf(PB) >= 0 || PB.indexOf(PA) >= 0)) return true;
    return false;
  }

  /** 输入框里的内容是不是"目标文本重复了两次以上"（富文本重复插入的典型症状） */
  function isDuplicated(text, target) {
    const T = stripPunct(target);
    const G = stripPunct(text);
    if (!T || !G) return false;
    if (G === T) return false;
    const first = G.indexOf(T);
    return first >= 0 && G.indexOf(T, first + 1) >= 0;
  }

  function clearEditor(el) {
    if (!el) return;
    try { el.focus(); } catch (e) {}
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (e) {}
    if (readEditor(el) !== '') {
      try { el.innerText = ''; el.textContent = ''; } catch (e) {}
    }
  }

  /**
   * 往输入框写文字。三种策略，按可靠性从高到低：
   *   1) 一次性 insertText —— execCommand 自己会触发原生 input，**不要再手动派发**，
   *      手动补一次会被富文本编辑器重复应用，写字变成写两遍。
   *   2) paste 事件
   *   3) 逐字 insertText（慢，且光标容易被编辑器重置，放最后）
   * 每次换策略前先清空，避免上一次的残留叠加。
   */
  async function putText(el, str) {
    const attempts = [];
    const check = (name) => {
      const got = readEditor(el);
      attempts.push({ name, got });
      return { ok: sameText(got, str) && !isDuplicated(got, str), got };
    };

    /* 1) 一次性插入 */
    clearEditor(el);
    caretToEnd(el);
    try { document.execCommand('insertText', false, str); } catch (e) {}
    let r = check('insertText-once');
    if (r.ok) return { ok: true, method: 'insertText-once', attempts };

    /* 2) 粘贴 */
    clearEditor(el);
    caretToEnd(el);
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', str);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    } catch (e) {}
    r = check('paste');
    if (r.ok) return { ok: true, method: 'paste', attempts };

    /* 3) 逐字（不带合成 input 事件） */
    clearEditor(el);
    caretToEnd(el);
    for (const ch of str) {
      try { document.execCommand('insertText', false, ch); } catch (e) { break; }
      await sleep(rand(CFG.typeDelay));
    }
    r = check('per-char');
    if (r.ok) return { ok: true, method: 'per-char', attempts };

    return { ok: false, method: 'none', attempts, got: r.got };
  }

  /** 兼容旧调用：只要成功/失败 */
  async function typeInto(el, str) {
    const r = await putText(el, str);
    return r.ok;
  }

  /** 找第一个不一样的字符位置，方便定位零宽/空格问题 */
  function firstDiff(a, b) {
    const A = String(a || '');
    const B = String(b || '');
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      if (A[i] !== B[i]) {
        const code = (x) => (x === undefined ? 'EOF' : 'U+' + x.codePointAt(0).toString(16).toUpperCase());
        return '位置 ' + i + '：输入框=' + code(A[i]) + ' 期望=' + code(B[i]);
      }
    }
    return '长度相同但不等（可能有不可见字符）';
  }

  /* ---------------- 大模型 ---------------- */

  /** 把 DB 里的历史（a）和页面上刚读到的（b）按尾部重叠合并 */
  function mergeContext(a, b, limit) {
    const key = (m) => m.role + '|' + m.text;
    const head = Array.isArray(a) ? a.slice() : [];
    let start = -1;
    for (let i = head.length - 1; i >= 0; i--) {
      let ok = true;
      for (let j = 0; j < b.length && i + j < head.length; j++) {
        if (key(head[i + j]) !== key(b[j])) { ok = false; break; }
      }
      if (ok) { start = i; break; }
    }
    const pre = start >= 0 ? head.slice(0, start) : head;
    return [...pre, ...b].slice(-limit);
  }

  function buildMessages(thread, mem, docs) {
    const hasKB = !!(S.kb && String(S.kb).trim());
    let sys = [
      '你是「' + S.persona + '」。你正在抖音的私信里跟对方聊天。',
      '',
      '【对话状态 · 重要】',
      '这是**正在进行中**的对话，不是新会话。',
      '- 不要重新打招呼、不要自我介绍、不要问"你什么情况""想找什么样的"。',
      '- 对方在讲自己的经历、抱怨、闲聊 —— 就接着他说的具体内容往下聊（他说什么你就聊什么）。',
      '- 你已经说过的话不要再重复一遍。',
      '- 你是在跟一个具体的人聊天，不是在发群发消息。',
    ].join('\n');

    if (hasKB) {
      sys += '\n\n' + [
        '【事实边界】',
        '1. 涉及本店/本人的具体信息（产品细节、价格、库存、发货、政策、资质），只能来自下面的【知识库】。知识库没写的，就说"我确认一下"，绝对不要猜。',
        '2. 和生意无关的通用问题（算术、常识、闲聊、平台规则），' +
          (S.allowGeneral ? '正常用自己的知识回答，简短。' : '不要回答，说不清楚就让对方稍等。'),
        '3. 除非对方明确问，否则不要推销、不要引导成交。',
      ].join('\n');
    } else {
      sys += '\n\n' + [
        '【边界】',
        '1. 你没有店铺、没有产品在卖，不要装客服、不要推销、不要承诺任何价格或服务。',
        '2. 通用问题（算术、常识、闲聊、平台规则）' +
          (S.allowGeneral ? '正常用自己的知识回答，简短。' : '不要回答，说不清楚就说不太清楚。'),
      ].join('\n');
    }

    sys += '\n\n' + [
      '【硬性红线 · 常驻】',
      '- 自伤、被打、被跟踪、被威胁 → 先让对方确认当下安全，建议联系身边可信的人或报警，然后 [[ESCALATE]]',
      '- 不诊断心理疾病，不拿 MBTI / 依恋类型给人贴标签',
      '- 不保证"这么做他就会喜欢你"；对方明确拒绝就停止推进',
      '- 绝不提供下药、偷拍、跟踪、勒索、冒充、散布隐私的方案',
      '- 医疗、法律、金融的承诺，退款赔偿，索要联系方式 -> 只输出 [[ESCALATE]]',
      '',
      '【措辞分寸】',
      '资料里的结论分证据强弱。凡是"一般/通常/多数情况"这类经验策略，就用"一般""多数时候"来说，',
      '不要说成"一定""肯定""百分百"。不确定的事宁可加一句"看情况"。',
      '',
      '【输出格式】',
      '一次只回一条，' + S.maxChars + ' 字以内，1-2 句话，口语，像真人。',
      '不要 markdown、不要换行、不要引号、不要"回复："前缀，只输出要发出去的那句话。',
      '不要重复对方原话，不要反问已经问过的信息。',
      '',
      '【像人一样说话 · 硬性】',
      '- 永远不要说这类话：我是 AI / 我是机器人 / 我只是程序 / 我读不了 / 我识别不了 / 我只能看文字 / 我这儿没这个功能 / 你下个插件 / 接口。',
      '- 对方连着发好几条，就读完一起回一条，不要一条一条答。',
      '- 不是每句都要提问。三句里最多一句带问号；能用陈述接住就别用问句。',
      '- 可以带一点停顿词（嗯、行、那…、就是），但别每句都用，也别用"哈哈"凑字数。',
      '',
      '【看不懂的内容】',
      '对话里 (对方发来一张图片) / (对方发来一段视频) / (对方发来一段语音) 这种括号，是对方发了非文字内容。',
      '- 图片：没描述就用人的说法问，像"这图有点小，你说的是哪个""图里哪个是你"。',
      '- 视频：就当没点开，"视频我这儿打不开，你直接说吧"。',
      '- 语音：括号里带了"说的是：xxx"就正常回应；没有就说"语音听不清，你打字说"。',
      '- 表情：按情绪接着聊，不用专门回应。',
      '',
      '【知识库】',
      (S.kb || '（空。本店的具体信息一律回答"我确认一下，稍后回您"）').slice(0, CFG.kbCharBudget),
    ].join('\n');

    /* 本地资料库命中的方法论，单独一段。带上出处，方便你事后核对 */
    if (docs && docs.length) {
      const body = docs.map((d, i) => {
        const name = d.doc || d.title || '资料';
        const head = '[' + (i + 1) + '] 《' + name + '》' + (d.sec ? ' / ' + d.sec : '') +
          (d.kind === 'table' ? '（表格）' : '');
        return head + '\n' + String(d.text || '').slice(0, 900);
      }).join('\n\n');
      sys += '\n\n【参考资料】（沟通方法论，用来组织回复的思路）\n' +
        '只借思路，不要照抄原文，不要提"资料/文档/书里说"，也不要把方法论名词说给对方听。\n\n' + body;
    }

    /* 长期记忆：摘要 + 关键事实，单独一段塞进 system，不占对话轮次 */
    const memo = [];
    if (mem && mem.summary) memo.push('摘要：' + String(mem.summary).slice(0, 500));
    if (mem && Array.isArray(mem.facts) && mem.facts.length) {
      memo.push('已知事实：\n' + mem.facts.slice(0, 5).map((f) => '- ' + String(f).slice(0, 120)).join('\n'));
    }
    if (mem && mem.count) memo.push('这是第 ' + mem.count + ' 条往来记录，别把它当第一次聊天。');

    const msgs = [{ role: 'system', content: sys }];
    if (memo.length) msgs.push({ role: 'system', content: '【长期记忆】\n' + memo.join('\n') });

    /* 只取最近 N 条，且卡总字数 */
    let budget = CFG.ctxCharBudget;
    const picked = [];
    for (let i = thread.length - 1; i >= 0 && picked.length < CFG.ctxMsgs; i--) {
      const m = thread[i];
      const t = String(m.text || '').slice(0, 300);
      if (t.length + 1 > budget) break;
      budget -= t.length + 1;
      picked.unshift(m);
    }
    for (const m of picked) {
      msgs.push({ role: m.role === 'me' ? 'assistant' : 'user', content: String(m.text || '').slice(0, 300) });
    }

    /* 保证最后一条是对方的 */
    const last = picked[picked.length - 1];
    if (!last || last.role !== 'them') {
      msgs.push({ role: 'user', content: '（请根据上面的对话，给出你要说的下一句）' });
    }
    return msgs;
  }

  /** 输出校验：这是"不能乱回答"的落地闸门 */
  function sanitize(raw) {
    let t = String(raw || '').trim();
    if (!t) return { ok: false, reason: 'EMPTY' };
    if (ESCALATE.test(t)) return { ok: false, reason: 'ESCALATE' };

    t = t.replace(/^[`"'“”‘’\s]+|[`"'“”‘’\s]+$/g, '');
    t = t.replace(/^(回复|答复|客服)[:：]\s*/, '');
    t = t.replace(/\*\*|__|`|#+>/g, '');
    t = t.replace(/\s*\n+\s*/g, '，');                 // 私信输入框是单行，换行转逗号
    t = norm(t);
    if (!t) return { ok: false, reason: 'EMPTY' };

    /* 联系方式 / 站外引流：知识库里没有就不许说 */
    const contact = /https?:\/\/|www\.|\bwx\b|微信|威信|vx|v信|扣扣|qq|电话|手机号|加我/i;
    if (contact.test(t) && !contact.test(S.kb)) return { ok: false, reason: 'CONTACT' };

    /* 承诺类词：知识库没提就打回 */
    const promise = /保证|百分百|100%|一定|绝对|包治|最便宜|全网最低|无效退款/;
    if (promise.test(t) && !promise.test(S.kb)) return { ok: false, reason: 'PROMISE' };

    /* 长度：maxChars 是硬上限。模型彻底跑飞（超过 4 倍）直接判废 */
    if (t.length > S.maxChars * 4) return { ok: false, reason: 'TOO_LONG' };
    if (t.length > S.maxChars) {
      const cut = t.slice(0, S.maxChars);
      const m = cut.match(/[，。！？~～；;、]/g);
      let out = cut;
      if (m) {
        const lastMark = cut.lastIndexOf(m[m.length - 1]);
        if (lastMark > S.maxChars * 0.55) out = cut.slice(0, lastMark);
      }
      t = out.replace(/[，、；;]$/, '') + '…';
    }

    return { ok: true, text: t };
  }

  async function generate(thread, chatId, mem, docs) {
    const last = lastIncoming(thread);
    if (!last) return { ok: false, reason: 'NO_INCOMING' };
    const messages = buildMessages(thread, mem, docs);
    const t0 = Date.now();
    let res = null;
    try {
      res = await withTimeout(
        chrome.runtime.sendMessage({ type: 'DY_LLM', payload: { messages, chatId } }),
        40000, '调模型'
      );
    } catch (e) {
      return { ok: false, reason: 'IPC', detail: String((e && e.message) || e), ms: Date.now() - t0 };
    }
    const ms = Date.now() - t0;
    if (!res || !res.ok) return { ok: false, reason: (res && res.error) || 'LLM_FAIL', ms };

    const clean = sanitize(res.text);
    return {
      ok: clean.ok,
      reason: clean.reason,
      text: clean.text,
      raw: res.text,
      ms,
      usage: res.usage,
      prompt: messages,          // 留一份给调试面板用
    };
  }

  /* ---------------- 记忆 / 多媒体 ---------------- */

  /** 任何 await 都不许无限期挂着：超时就抛，外面接住并显示到面板 */
  function withTimeout(p, ms, label) {
    return Promise.race([
      Promise.resolve(p),
      new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时 ' + ms + 'ms')), ms)),
    ]);
  }

  async function memoryGet(chatId) {
    try {
      const r = await withTimeout(
        chrome.runtime.sendMessage({ type: 'DY_MEMORY_GET', chatId, limit: 40 }),
        10000, '取记忆'
      );
      if (r && r.ok) return r;
      log('⚠️ 取记忆返回异常：', r && r.error);
    } catch (e) {
      log('⚠️ 取记忆失败：', (e && e.message) || e);
      showDraft('⚠️ 取记忆失败（' + ((e && e.message) || e) + '），先不带长期记忆继续');
    }
    return { ok: false, summary: '', facts: [], recent: [], count: 0, stats: { msgs: 0, chats: 0 } };
  }

  function dbAppend(chatId, msgs) {
    if (!msgs || !msgs.length) return;
    try {
      chrome.runtime.sendMessage({
        type: 'DY_DB_APPEND',
        chatId,
        msgs: msgs.map((m) => ({ role: m.role, kind: m.kind || 'text', text: m.text })),
      });
    } catch (e) {}
  }

  /** 图片 -> 一句描述（可选，需要配 VLM）。只处理最后两条，省 token */
  async function annotateImage(thread) {
    if (!S.vision) return thread;
    const out = thread.slice();
    for (let i = Math.max(0, out.length - 2); i < out.length; i++) {
      const m = out[i];
      if (m.role !== 'them' || m.kind !== 'image' || !m.src) continue;
      if (S.described.has(m.src)) continue;
      if (S.described.size > 300) S.described.clear();
      S.described.add(m.src);
      try {
        const r = await chrome.runtime.sendMessage({ type: 'DY_DESCRIBE_IMAGE', url: m.src });
        if (r && r.ok) {
          out[i] = { ...m, text: '（对方发来一张图片：' + r.text + '）' };
          log('🖼️ 图片识别：', r.text);
        } else {
          log('🖼️ 图片识别失败：', (r && r.error) || 'unknown');
        }
      } catch (e) {}
    }
    return out;
  }

  /** 语音气泡 -> 发给 background 的音频载荷（blob: 只能在页面里读，http(s) 交给后台带 Cookie 拿） */
  async function audioPayload(src) {
    if (!src) return null;
    if (src.startsWith('blob:')) {
      try {
        const r = await fetch(src);
        const b = await r.blob();
        if (!b.size || b.size > 20 * 1024 * 1024) return null;
        const buf = new Uint8Array(await b.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        }
        return { b64: btoa(bin), mime: b.type || 'audio/mp4' };
      } catch (e) {
        log('🎤 blob 读取失败：', e && e.message);
        return null;
      }
    }
    if (/^https?:/.test(src)) return { url: src };
    return null;
  }

  /** 语音 -> 文字（可选，需要配 ASR）。同样只处理最后两条 */
  async function annotateVoice(thread) {
    if (!S.asr) return thread;
    const out = thread.slice();
    for (let i = Math.max(0, out.length - 2); i < out.length; i++) {
      const m = out[i];
      if (m.role !== 'them' || m.kind !== 'voice' || m.asrTried) continue;
      m.asrTried = true;
      if (!m.src) { log('🎤 语音气泡里找不到音频地址（可能是自绘播放器）'); continue; }
      const payload = await audioPayload(m.src);
      if (!payload) continue;
      try {
        const r = await chrome.runtime.sendMessage({ type: 'DY_ASR', payload });
        if (r && r.ok) {
          out[i] = { ...m, text: '（对方发来一段语音，说的是：' + r.text + '）' };
          log('🎤 语音已转写：', r.text);
        } else {
          log('🎤 转写失败：', (r && r.error) || 'unknown');
        }
      } catch (e) {}
    }
    return out;
  }

  /** 拉本地资料库（狗头军师 corpus）——不是每次都拉，交易类问题直接跳过 */
  async function fetchDocs(thread) {
    if (!S.kbRetrieve) return [];
    const query = thread.filter((m) => m.role === 'them').slice(-2).map((m) => m.text).join(' ');
    if (!query || query.length < 4) return [];
    try {
      const r = await withTimeout(
        chrome.runtime.sendMessage({ type: 'DY_KB', query, limit: 2 }),
        8000, '查资料'
      );
      if (r && r.ok && r.chunks && r.chunks.length) {
        S.kbHits = r.chunks.map((c) => c.title + (c.sec && c.sec !== c.title ? ' / ' + c.sec : ''));
        log('📚 资料命中 ' + r.chunks.length + ' 条：', S.kbHits.join(' | '));
        return r.chunks;
      }
      S.kbHits = [];
      if (r && r.gated) log('📚 这轮不查资料库（交易类问题或没有领域词）');
    } catch (e) {
      log('⚠️ 查资料失败：', (e && e.message) || e);
    }
    return [];
  }

  /* ---------------- 频率 / 去重 ---------------- */

  function refill() {
    const now = Date.now();
    const mins = (now - S.lastRefill) / 60000;
    if (mins > 0) {
      S.tokens = Math.min(CFG.bucket.capacity, S.tokens + mins * CFG.bucket.refillPerMin);
      S.lastRefill = now;
    }
  }

  function rateOk() {
    refill();
    if (S.tokens < 1) return false;
    S.tokens -= 1;
    return true;
  }

  function chatQuotaOk(id) {
    const now = Date.now();
    const r = S.replies.get(String(id));
    if (!r || now - r.since > CFG.perChatWindowMs) {
      S.replies.set(String(id), { count: 0, since: now });
      return true;
    }
    return r.count < CFG.perChatLimit;
  }

  function bumpChat(id) {
    const now = Date.now();
    const r = S.replies.get(String(id));
    if (!r || now - r.since > CFG.perChatWindowMs) S.replies.set(String(id), { count: 1, since: now });
    else r.count++;
  }

  function recordOf(id) {
    const r = id ? S.records.get(String(id)) : null;
    if (!r) return null;
    const ttl = r.ok ? CFG.chatTtlMs : CFG.retryTtlMs;
    if (Date.now() - r.at > ttl) { S.records.delete(String(id)); return null; }
    return r;
  }

  /** 会话列表里这一项的可见文本。新消息进来时预览会变，拿它当"处理过"的指纹 */
  function fingerprint(item) {
    return norm(item && (item.innerText || item.textContent)).slice(0, 120);
  }

  function mark(id, fp, ok) {
    const prev = recordOf(id);
    S.records.set(String(id), {
      fp,
      at: Date.now(),
      ok,
      attempts: ok ? 0 : (((prev && prev.attempts) || 0) + 1),
    });
  }

  /* ---------------- 跨标签页互斥 ---------------- */

  async function withCrossTabLock(fn) {
    const locks = typeof navigator !== 'undefined' && navigator.locks;
    if (!locks || typeof locks.request !== 'function') return fn();
    let ran = false;
    let out = null;
    await locks.request('dy-ai-send', { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      ran = true;
      out = await fn();
    });
    if (!ran) log('⏸️ 另一个标签页正在处理，跳过');
    return out;
  }

  /* ---------------- 一次完整接待 ---------------- */

  async function handleChat(item, id, manual) {
    /* 白名单：上线时先只对测试号生效，确认没问题再放开 */
    if (S.allowIds.length && !S.allowIds.includes(String(id))) {
      log('⛔ 会话 ' + id + ' 不在白名单里，跳过');
      if (manual) {
        showDraft('⛔ 这个会话不在白名单里。\n\n弹窗「高级 → 只对这些用户生效」里填的是：' + S.allowIds.join(', ') +
          '\n当前会话 ID：' + id + '\n\n（想全放开就把那一栏清空保存）');
      }
      return true;
    }

    const fp = fingerprint(item);

    if (item) {
      click(item);
      await sleep(rand([350, 700]));
    } else {
      await sleep(manual ? rand([150, 300]) : rand([400, 800]));
    }

    /* 先读对话 —— 只有真要发送时才需要输入框 */
    const thread0 = readThread();
    if (!thread0.length) {
      if (manual) showDraft('❌ 读不到对话内容。\n\n先点开一个会话（能看到左右气泡），再点「试跑一次」。');
      log('⚠️ 读不到对话内容');
      mark(id, fp, false);
      return false;
    }
    log('🧾 对话 ' + thread0.length + ' 条，最后一条：', thread0[thread0.length - 1].role, '|', thread0[thread0.length - 1].text.slice(0, 30));

    /* 群聊不掺和：对方的消息来自好几个不同头像就是群 */
    if (isGroupThread(thread0)) {
      log('⏭️ 判定为群聊（多个发送者头像），跳过');
      showDraft('⏭️ 这是群聊，不回复。\n（群里多人发言，AI 插话容易出事）');
      mark(id, fp, true);
      const gx = exitButton(); if (gx) { click(gx); await sleep(rand([600, 1000])); }
      return true;
    }

    let ed = editorBox();
    if (!ed && item) {
      click(item);
      await sleep(rand([500, 900]));
      ed = editorBox();
    }
    const canSend = !!ed;
    if (!canSend) log('⚠️ 找不到输入框，只能生成不能发送');

    const last = lastIncoming(thread0);
    if (!last) {
      log('ℹ️ 没有对方的消息，不回');
      mark(id, fp, true);
      showDraft('ℹ️ 这个会话里还没有对方发的消息，没东西可回。');
      return true;
    }

    const lastIsMine = thread0[thread0.length - 1].role === 'me';

    /* 自动跑：最后一条是自己发的就不回（防自问自答） */
    if (lastIsMine && !manual) {
      log('ℹ️ 最后一条是自己发的，不回（防自问自答）');
      mark(id, fp, true);
      dbAppend(id, thread0);
      const ex0 = exitButton(); if (ex0) { click(ex0); await sleep(rand([600, 1000])); }
      return true;
    }

    /* 手动试跑：最后一条是自己发的，也照样给一份参考回复，别让人以为卡住了 */
    if (lastIsMine && manual) {
      S.manualNote = '⚠️ 最后一条是你自己发的。下面是假设对方刚说完「' + last.msg.text.slice(0, 18) + '」时你会怎么接，仅供参考。';
      log('ℹ️ 手动试跑：最后一条是自己发的，仍生成参考回复');
    } else {
      S.manualNote = '';
    }
    if (!chatQuotaOk(id)) {
      log('⏸️ 该会话本小时已回满 ' + CFG.perChatLimit + ' 条');
      mark(id, fp, true);
      showDraft('⏸️ 这个会话本小时已经回了 ' + CFG.perChatLimit + ' 条，先歇会儿（防止刷屏）。');
      return true;
    }

    /* 1) 先把对方真实说过的话落库（后面生成失败也不丢记忆） */
    dbAppend(id, thread0);

    /* 2) 取长期记忆 + 和页面读到的这条尾巴合并 */
    stage('取长期记忆…');
    const mem = await memoryGet(id);
    S.memInfo = {
      msgs: (mem.stats && mem.stats.msgs) || 0,
      chats: (mem.stats && mem.stats.chats) || 0,
      summary: (mem.summary || '').length,
      facts: (mem.facts || []).length,
      total: mem.count || 0,
    };
    if (mem.summary || (mem.facts && mem.facts.length)) {
      log('🧠 记忆命中：摘要 ' + (mem.summary || '').length + ' 字，事实 ' + ((mem.facts || []).length) + ' 条，历史 ' + (mem.count || 0) + ' 条');
    }

    /* 3) 可选：图片交给 VLM 描述，语音交给 ASR 转写 */
    let thread = await annotateImage(thread0);
    thread = await annotateVoice(thread);

    /* 4) 组装上下文：DB 历史 + 页面尾巴（重叠部分去重） */
    const merged = mergeContext(mem.recent || [], thread, CFG.ctxMsgs);
    S.ctxCount = merged.length;

    /* 5) 本地资料库检索（交易类问题自动跳过） */
    stage('检索资料库…');
    const docs = await fetchDocs(merged);

    stage('调模型生成中…（DeepSeek 通常 1-5 秒）');
    const gen = await generate(merged, id, mem, docs);
    S.lastGen = { id, at: Date.now(), ...gen };
    log('🤖 生成结果：', gen.ok ? gen.text : ('拦截[' + gen.reason + '] ' + (gen.raw || '')), '|', (gen.ms || 0) + 'ms');

    let reply = gen.ok ? gen.text : '';
    if (!gen.ok) {
      if (gen.reason === 'ESCALATE') {
        log('🙋 模型要求转人工，本轮不发');
        mark(id, fp, true);                       // 同一条消息不要反复问模型
        showDraft('（转人工）' + (gen.raw || ''), gen);
        return true;
      }
      if (!S.fallback) {
        showDraft('（生成失败：' + gen.reason + '）', gen);
        mark(id, fp, false);
        return false;
      }
      reply = S.fallback;
      log('↩️ 用兜底话术：', reply);
    }

    showDraft(reply, gen);

    /* 草稿模式对「手动试跑」同样生效 —— 手动只负责触发，不负责绕过安全闸 */
    if (S.dryRun) {
      log('📝 草稿模式，不发送。要真发请到弹窗里取消「草稿模式」');
      const d = document.getElementById('dy-ai-draft');
      if (d && !/草稿模式/.test(d.value)) d.value += '\n— 草稿模式，未发送';
      return true;
    }

    if (!canSend) {
      const d = document.getElementById('dy-ai-draft');
      if (d && !/没找到输入框/.test(d.value)) d.value += '\n— 没找到输入框，未发送';
      log('⚠️ 没有输入框，跳过发送');
      return true;
    }

    /* 人类的停顿：不立刻回。等的时候顺便看看对方有没有再发 —— 连发几条就一起答 */
    const pause = rand(CFG.thinkDelay);
    stage('停顿 ' + Math.round(pause / 1000) + ' 秒再发（期间对方再发就合并重答）…');
    log('⏳ 停顿 ' + Math.round(pause / 1000) + ' 秒后发送');
    const domBefore = thread0.length;
    await sleep(pause);

    try {
      const now = readThread();
      if (now.length > domBefore) {
        const added = now.length - domBefore;
        log('📥 停顿期间对方又发了 ' + added + ' 条，合并后重新生成');
        stage('对方又发了 ' + added + ' 条，合并重答…');
        const merged2 = mergeContext(mem.recent || [], now, CFG.ctxMsgs);
        const gen2 = await generate(merged2, id, mem, docs);
        if (gen2.ok && gen2.text) {
          reply = gen2.text;
          S.lastGen = { id, at: Date.now(), ...gen2 };
          ed = editorBox() || ed;
          showDraft(reply, gen2);
          log('🤖 重新生成：', reply);
        } else {
          log('⚠️ 重答失败，仍用原来的回复');
        }
      }
    } catch (e) {
      log('⚠️ 停顿期间复查失败：', (e && e.message) || e);
    }

    /* 输入 -> 校验 -> 发送 */
    log('🖊️ 写入输入框（' + reply.length + ' 字）');
    const put = await putText(ed, reply);
    let ok = put.ok;
    let target = ed;
    if (ok) {
      log('✅ 写入方式：' + put.method + '（尝试 ' + put.attempts.length + ' 次）');
    } else {
      for (const a of put.attempts) {
        log('   ' + a.name + ' -> ' + JSON.stringify(String(a.got || '').slice(0, 50)) +
          '（' + String(a.got || '').length + ' 字）' + (isDuplicated(a.got, reply) ? ' [重复了]' : ''));
      }
    }

    /* 文字可能被写进了另一个 contenteditable（编辑器被替换/聚焦到别处） */
    if (!ok) {
      const ae = document.activeElement;
      if (ae && ae !== ed && ae.isContentEditable && sameText(readEditor(ae), reply) && !isDuplicated(readEditor(ae), reply)) {
        ok = true;
        target = ae;
        log('ℹ️ 文字写进了另一个编辑框，已切换比对目标');
      }
    }
    if (!ok) {
      const got = readEditor(ed);
      log('❌ 输入框内容对不上。输入框=' + JSON.stringify(got.slice(0, 60)) + '（' + got.length + ' 字）');
      log('   期望=' + JSON.stringify(reply) + '（' + reply.length + ' 字）  差异：' + firstDiff(got, reply));
      showDraft('❌ 写进输入框的内容不对，已放弃发送（避免发错）。\n\n' +
        (isDuplicated(got, reply) ? '原因：文字被重复插入了两遍\n\n' : '') +
        '输入框读到：' + JSON.stringify(got.slice(0, 50)) + '\n' +
        '期望发送：' + JSON.stringify(reply) + '\n' +
        '差异：' + firstDiff(got, reply) + '\n\n（点「看日志」有完整内容）');
      mark(id, fp, false);
      return false;
    }
    ed = target;
    log('✅ 输入完成（' + readEditor(ed).length + ' 字），查找发送按钮…');

    const btn = sendButton();
    if (!btn) {
      log('❌ 找不到发送按钮');
      showDraft('❌ 找不到发送按钮。发送按钮的选择器要改（SEL.send），把这条发我：' +
        Array.from(document.querySelectorAll('[class*="send"], button')).slice(0, 8)
          .map((b) => b.className.toString().slice(0, 40)).join(' | '));
      mark(id, fp, false);
      return false;
    }
    log('🖱️ 点击发送按钮', String(btn.className || btn.tagName).slice(0, 40));
    click(btn);
    await sleep(rand([700, 1200]));

    if (sameText(readEditor(editorBox() || ed), reply)) {
      log('⚠️ 输入框没清空，再点一次');
      const again = sendButton();
      if (again) click(again);
      await sleep(rand([600, 1000]));
      if (sameText(readEditor(editorBox() || ed), reply)) {
        log('❌ 发送失败');
        showDraft('❌ 点了发送但输入框没清空，消息可能没发出去。\n检查：发送按钮选择器 SEL.send');
        mark(id, fp, false);
        return false;
      }
    }
    log('✅ 输入框已清空，发送成功');
    showDraft(reply + '\n✓ 已发送', gen);

    bumpChat(id);
    mark(id, fp, true);
    dbAppend(id, [{ role: 'me', kind: 'text', text: reply }]);   // 自己说的话也要进记忆
    log('📤 已发送 ->', id, '|', reply);

    /* 攒够 40 条就压一次摘要（后台跑，不等它） */
    try { chrome.runtime.sendMessage({ type: 'DY_MEMORY_SUMMARIZE', chatId: id }); } catch (e) {}

    await sleep(rand([400, 800]));
    const ex = exitButton();
    if (ex) { click(ex); await sleep(rand([700, 1200])); }
    return true;
  }

  /* ---------------- 调度 ---------------- */

  function picker() {
    const items = listItems();
    if (!items.length) return null;
    const cands = [];
    for (const it of items) {
      if (!hasUnread(it)) continue;
      const text = norm(it.textContent || '');
      /* 群聊在列表层先粗筛一道（会话内还有一道更准的：看头像是不是多个人） */
      if (/(群|Group|群聊)/.test(text)) { log('⏭️ 列表里判定为群聊，跳过：', text.slice(0, 20)); continue; }

      /* 没有 data-uid / 链接也要能跑：用列表项文本算个稳定 id */
      const id = chatIdOf(it) || listItemId(it);
      const rec = recordOf(id);
      if (rec && rec.ok && rec.fp === fingerprint(it)) continue;   // 同一条消息已处理过
      if (rec && !rec.ok && rec.attempts >= CFG.maxAttempts) continue;
      cands.push({ it, id, y: (it.getBoundingClientRect() || {}).top || 0 });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.y - b.y);
    return cands[0];
  }

  /** 列表项没有 id 时，用「昵称+预览」的 hash 当 id */
  function listItemId(item) {
    const t = norm(item && item.textContent || '').slice(0, 60);
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    return 'item-' + (h >>> 0).toString(36);
  }

  /** 拿不到真实 id 时的兜底：优先用会话标题（对方昵称），再退到首条消息 */
  function openChatFallbackId() {
    const hash = (s) => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    };

    /* 1) 会话头部：消息列表上方、文本很短的那个兄弟节点，大概率是对方昵称 */
    try {
      const root = threadRoot();
      const parent = root && root.parentElement;
      if (parent) {
        for (const sib of parent.children) {
          if (sib === root) break;
          const t = norm(sib.textContent || '');
          if (t && t.length >= 1 && t.length <= 20) return 'name-' + hash(t);
        }
      }
    } catch (e) {}

    /* 2) 退到第一条消息（窗口滑动时会变，但总比没有强） */
    let first = '';
    try {
      const t = readThread();
      first = (t[0] && t[0].text) || '';
    } catch (e) {}
    return 'open-' + hash(first);
  }

  /** 当前打开着的会话的 ID：URL -> 消息行里的 /user/ 链接 -> 会话头部链接 -> hash 兜底 */
  function currentChatId() {
    const m = String(location.href).match(/\/user\/(\d+)/);
    if (m) return m[1];
    const root = threadRoot();

    if (root) {
      /* 1) 消息气泡里有没有指向对方的链接 */
      try {
        const rows = threadRows(root);
        for (let i = rows.length - 1; i >= 0; i--) {
          const a = rows[i].querySelector && rows[i].querySelector('a[href*="/user/"]');
          const mm = a && (a.getAttribute('href') || '').match(/\/user\/(\d+)/);
          if (mm) return mm[1];
        }
      } catch (e) {}

      /* 2) 会话头部（同一个面板里、消息列表上方的兄弟节点） */
      try {
        const parent = root.parentElement;
        if (parent) {
          for (const sib of parent.children) {
            if (sib === root) break;
            const a = sib.querySelector && sib.querySelector('a[href*="/user/"]');
            const mm = a && (a.getAttribute('href') || '').match(/\/user\/(\d+)/);
            if (mm) return mm[1];
          }
        }
      } catch (e) {}
    }

    return openChatFallbackId();
  }

  /** 设置阶段并立刻显示到面板（卡住时一眼看出停在哪） */
  function stage(txt) {
    S.stage = txt;
    S.lastStageAt = Date.now();
    const d = document.getElementById('dy-ai-draft');
    if (d) {
      d.value = '⏳ ' + txt;
      d.style.height = '64px';
      d.style.background = '#fafafa';
    }
  }

  async function tick(manual) {
    if (S.busy) {
      if (manual) {
        showReport('⏳ 上一轮还没结束（卡在：' + (S.stage || '未知') + '）\n\n点「重置」清掉状态，再点试跑。\n\n最近日志：\n' + logBuf.slice(-12).join('\n'));
      }
      return;
    }
    S.busy = true;
    S.stage = '启动';
    S.lastStageAt = Date.now();
    const t0 = Date.now();

    /* 看门狗：45 秒没有任何阶段推进才报警（停顿最长 30s、调模型最长 40s，各自会刷新时间戳） */
    const wd = setInterval(() => {
      if (!S.busy) return;
      if (Date.now() - (S.lastStageAt || t0) < 45000) return;
      clearInterval(wd);
      showReport(
        '⚠️ 已经 ' + Math.round((Date.now() - t0) / 1000) + ' 秒没有进展\n\n' +
        '当前阶段：' + (S.stage || '未知') + '\n' +
        '（如果这一步是同步的，整页会一起卡住；如果只有这行没变，说明在等某个响应）\n\n' +
        '最近日志：\n' + logBuf.slice(-15).join('\n') +
        '\n\n点「重置」可以清掉卡住的状态。'
      );
    }, 25000);

    try {
      if (!S.enabled && !manual) return;
      if (document.visibilityState === 'hidden') return;
      if (!manual && Date.now() - S.lastSendAt < rand(CFG.minGapMs)) return;

      /* 手动试跑：只认「当前打开的这个会话」，绝不替你点开别人的会话 */
      if (manual) {
        stage('读取对话…');
        let readable = 0;
        try { readable = readThread().length; } catch (e) { log('读取对话异常：', (e && e.message) || e); }
        if (!readable) {
          showDraft('❌ 没读到当前会话的消息。\n\n请先用鼠标点开左边一个会话（能看到左右气泡），再点「试跑一次」。\n（我不会自己点开别人的会话——那会把人家消息变成已读）');
          log('ℹ️ 试跑：当前没有可读的会话');
          return;
        }
        stage('定位会话 ID…');
        const openId = currentChatId();
        log('🎯 试跑当前会话', openId, '（' + readable + ' 条消息）');
        stage('等跨标签页锁…');
        await withCrossTabLock(async () => {
          S.lastSendAt = Date.now();
          await handleChat(null, openId, true);
          updatePanel();
        });
        return;
      }

      const hit = picker();
      if (!hit) {
        if (manual) showDraft('ℹ️ 没有未读会话，也没有打开任何聊天。\n先点开左边一个会话，再点「试跑一次」。');
        log('ℹ️ 当前没有未读会话');
        return;
      }
      if (!rateOk()) { log('⏸️ 达到频率上限'); return; }

      log('🎯 命中未读会话', hit.id);
      await withCrossTabLock(async () => {
        S.lastSendAt = Date.now();
        await handleChat(hit.it, hit.id, manual);   // 成功/失败/转人工都在里面记账
        updatePanel();
      });
    } catch (e) {
      log('❌ tick 异常：', (e && e.message) || e);
      if (manual) showDraft('❌ 试跑出错：\n' + ((e && e.message) || e) + '\n' + String((e && e.stack) || '').slice(0, 500));
    } finally {
      clearInterval(wd);
      S.busy = false;
      S.stage = '';
    }
  }

  function schedule() {
    if (S.scanTimer) clearTimeout(S.scanTimer);
    S.scanTimer = setTimeout(() => { tick(false).finally(schedule); }, rand(CFG.scanMs));
  }

  /* ---------------- 面板 ---------------- */

  function el(tag, css, text) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensurePanel() {
    if (document.getElementById('dy-ai-panel')) return;
    const wrap = el('div',
      'position:fixed;right:16px;bottom:16px;width:300px;z-index:2147483647;background:#fff;' +
      'border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:14px;box-shadow:0 8px 24px rgba(0,0,0,.12);' +
      'font:13px/1.45 -apple-system,Segoe UI,sans-serif;color:#1a1a1a');
    wrap.id = 'dy-ai-panel';

    const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(0,0,0,.06)');
    head.append(el('strong', null, 'AI 私信接待 v' + VERSION));
    const mini = el('button', 'width:22px;height:22px;border:0;border-radius:4px;background:rgba(0,0,0,.05);cursor:pointer', '−');
    head.append(mini);

    const body = el('div');
    body.id = 'dy-ai-body';

    const status = el('div', 'font-size:12px;color:#666;margin-bottom:10px');
    status.id = 'dy-ai-status';

    const row = el('div', 'display:flex;gap:8px;margin-bottom:10px');
    const toggle = el('button', 'flex:1;padding:8px;border:0;border-radius:8px;background:#4CAF50;color:#fff;font-weight:600;cursor:pointer', '启用');
    toggle.id = 'dy-ai-toggle';
    const once = el('button', 'flex:1;padding:8px;border:0;border-radius:8px;background:#FE2C55;color:#fff;font-weight:600;cursor:pointer', '试跑一次');
    row.append(toggle, once);

    const draft = el('textarea',
      'width:100%;box-sizing:border-box;height:64px;padding:8px;border:1px solid #e5e5e5;border-radius:8px;' +
      'font:12px/1.5 inherit;resize:vertical;background:#fafafa');
    draft.id = 'dy-ai-draft';
    draft.readOnly = true;
    draft.placeholder = '模型生成的内容会显示在这里';

    const probe = el('button', 'width:100%;margin-top:8px;padding:6px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;color:#666;cursor:pointer;font-size:11px', '探测当前会话（结果显示在上面的框里）');

    const promptBtn = el('button', 'width:100%;margin-top:6px;padding:6px;border:1px solid #dcdcf0;border-radius:6px;background:#fafaff;color:#4a4a8a;cursor:pointer;font-size:11px', '看这次送给模型的内容');

    const memLine = el('div', 'margin-top:8px;font-size:11px;color:#999');
    memLine.id = 'dy-ai-mem';
    memLine.textContent = '记忆 0 会话 / 0 条';

    const memBtn = el('button', 'width:100%;margin-top:6px;padding:6px;border:1px solid #f0d0d6;border-radius:6px;background:#fff7f8;color:#c2185b;cursor:pointer;font-size:11px', '清空当前会话的记忆');

    const logBtn = el('button', 'width:100%;margin-top:6px;padding:6px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;color:#666;cursor:pointer;font-size:11px', '看日志（最近 60 行）');
    const scanBtn = el('button', 'width:100%;margin-top:6px;padding:6px;border:1px solid #dcdcf0;border-radius:6px;background:#fafaff;color:#4a4a8a;cursor:pointer;font-size:11px', '扫描未读（看它看到了什么）');
    const resetBtn = el('button', 'width:100%;margin-top:6px;padding:6px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;color:#666;cursor:pointer;font-size:11px', '重置卡住状态');

    body.append(status, row, draft, probe, promptBtn, scanBtn, logBtn, resetBtn, memLine, memBtn);
    wrap.append(head, body);
    document.body.appendChild(wrap);

    mini.addEventListener('click', () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      mini.textContent = hidden ? '−' : '+';
    });

    toggle.addEventListener('click', () => {
      S.enabled = !S.enabled;
      save({ ENABLED: S.enabled });
      updatePanel();
      if (S.enabled) { log('▶️ 已启用'); tick(false); }
    });

    once.addEventListener('click', () => { tick(true); });

    probe.addEventListener('click', () => {
      try {
        probeThread();
      } catch (e) {
        showReport('❌ 探测时出错，把这段发我：\n\n' + ((e && e.message) || e) + '\n\n' + String((e && e.stack) || '').slice(0, 600));
      }
    });

    promptBtn.addEventListener('click', () => {
      const p = S.lastGen && S.lastGen.prompt;
      if (!p || !p.length) { showReport('还没有生成过。先点「试跑一次」，再点这里。'); return; }
      const txt = p.map((m) => '[' + m.role + ']\n' + m.content).join('\n\n————————\n\n');
      showReport('这次送给模型的内容（共 ' + p.length + ' 段）：\n\n' + txt);
    });

    scanBtn.addEventListener('click', () => {
      const items = listItems();
      const L = ['会话列表项：' + items.length + '    （没有数字说明选择器没匹配到）'];
      items.slice(0, 15).forEach((it, i) => {
        const t = norm(it.textContent || '').slice(0, 26);
        const flag = hasUnread(it) ? '✅未读' : '⬜已读';
        const grp = /(群|Group)/.test(t) ? ' [群]' : '';
        L.push('#' + i + '  ' + flag + grp + '  ' + (chatIdOf(it) || listItemId(it)) +
          '  [' + String(it.className || '').slice(0, 28) + ']  ' + t);
      });
      if (!items.length) L.push('\n⚠️ 一个会话项都没找到。请先点开抖音的「消息」面板（左边那个列表）。');
      L.push('\n挑选规则：有未读 + 不是群 + 没处理过 → 从最上面开始。');
      showReport(L.join('\n'));
    });

    logBtn.addEventListener('click', () => {
      showReport('=== 最近日志（' + logBuf.length + ' 行）===\n\n' + (logBuf.join('\n') || '（空）') +
        '\n\n当前阶段：' + (S.stage || '空闲') + '   busy=' + S.busy);
    });

    resetBtn.addEventListener('click', () => {
      S.busy = false;
      S.stage = '';
      showDraft('已重置。可以再点「试跑一次」。\n\n（如果刚才是真卡住，重置后再卡，就把「看日志」的内容发我）');
    });

    memBtn.addEventListener('click', async () => {
      const url = location.href.match(/\/user\/(\d+)/);
      const id = (url && url[1]) || (S.lastGen && S.lastGen.id);
      if (!id) { log('⚠️ 当前不在会话里，无法确定要清哪个'); return; }
      try {
        const r = await chrome.runtime.sendMessage({ type: 'DY_DB_CLEAR', chatId: id });
        log('🧹 已清空会话 ' + id + ' 的记忆，剩余 ' + ((r && r.msgs) || 0) + ' 条');
        S.records.delete(String(id));
        S.memInfo = { msgs: (r && r.msgs) || 0, chats: (r && r.chats) || 0, summary: 0, facts: 0, total: 0 };
        updatePanel();
      } catch (e) { log('❌ 清空失败', (e && e.message) || e); }
    });

    updatePanel();
  }

  function showDraft(text, gen) {
    const d = document.getElementById('dy-ai-draft');
    if (d) {
      const meta = [];
      if (gen && gen.ms) meta.push(gen.ms + 'ms');
      if (gen && gen.usage) meta.push(gen.usage);
      if (S.ctxCount) meta.push('上下文 ' + S.ctxCount + ' 条');
      if (S.kbHits && S.kbHits.length) meta.push('资料 ' + S.kbHits.length + ' 条');
      const note = S.manualNote ? S.manualNote + '\n\n' : '';
      S.manualNote = '';
      d.value = note + text + (meta.length ? '\n— ' + meta.join(' · ') : '');
      d.style.height = '64px';
      d.style.background = '#fafafa';
    }
  }

  function updatePanel() {
    const st = document.getElementById('dy-ai-status');
    const tg = document.getElementById('dy-ai-toggle');
    const mem = document.getElementById('dy-ai-mem');
    if (st) {
      const okCount = [...S.records.values()].filter((r) => r.ok).length;
      st.textContent = (S.enabled ? '运行中' : '已关闭') +
        (S.dryRun ? ' · 草稿模式' : ' · 真发送') +
        ' · 已回 ' + okCount;
    }
    if (tg && tg.style) {
      tg.textContent = S.enabled ? '停用' : '启用';
      tg.style.background = S.enabled ? '#888' : '#4CAF50';
    }
    if (mem) {
      const m = S.memInfo || {};
      mem.textContent = '记忆 ' + (m.chats || 0) + ' 会话 / ' + (m.msgs || 0) + ' 条' +
        (m.summary ? ' · 摘要 ' + m.summary + ' 字' : '') +
        (m.facts ? ' · 事实 ' + m.facts + ' 条' : '');
    }
  }

  /* ---------------- 诊断 ---------------- */

  /**
   * 探测入口：先立刻给可见反馈，真正的扫描放下一帧，出错也把错误打到面板上。
   * 之前的坑：排除左栏后 threadRoot 返回 null，于是走全页扫描，扫描几秒没反馈 = 按钮"没反应"。
   */
  function probeThread() {
    showReport('⏳ 探测中…\n\n（如果 3 秒后这行还在，说明页面 DOM 太大卡住了，把这一屏发我）');
    setTimeout(() => {
      try {
        probeThreadInner();
      } catch (e) {
        showReport('❌ 探测出错：\n\n' + ((e && e.message) || e) + '\n\n' + String((e && e.stack) || '').slice(0, 800));
      }
    }, 30);
  }

  function probeThreadInner() {
    const root = threadRoot();
    if (!root) {
      showReport('❌ 自动找不到对话容器\n\n' + domCandidates());
      return;
    }
    const rr = root.getBoundingClientRect();
    const rows = threadRows(root);
    const L = [];
    L.push('=== 对话容器 ===');
    L.push('tag=' + root.tagName + '  class=' + String(root.className).slice(0, 60) + (isSidebar(root) ? '  ← 这是左栏，选错了' : ''));
    L.push('尺寸=' + Math.round(rr.width) + 'x' + Math.round(rr.height) + '  子节点=' + rows.length + ' 行');
    L.push('');
    L.push(classDump(12));
    L.push('');
    L.push('=== 最后 12 行（dir 是方向判断）===');
    rows.slice(-12).forEach((row, i) => {
      const leaf = textLeaf(row);
      const lr = leaf ? leaf.getBoundingClientRect() : row.getBoundingClientRect();
      L.push(
        '#' + (rows.length - Math.min(12, rows.length) + i) +
        ' class=' + String(row.className).slice(0, 30) +
        ' left=' + Math.round(lr.left) +
        ' right=' + Math.round(lr.right) +
        ' dir=' + dirOf(row, rr, leaf) +
        ' | ' + norm(row.innerText).slice(0, 30)
      );
    });
    L.push('');
    L.push('=== 解析结果（这就是喂给模型的东西）===');
    const parsed = readThread();
    L.push(JSON.stringify(parsed, null, 1));
    L.push('');
    L.push(parsed.length ? '✅ 读到 ' + parsed.length + ' 条消息' : '⚠️ 一条都没读到，选择器要调');
    showReport(L.join('\n'));
  }

  /** 有上限的 DOM 扫描：最多 1200 个 div、最多 400ms，避免把主线程卡死 */
  function scanDivs(maxN, budgetMs) {
    const out = [];
    let list = [];
    try { list = document.querySelectorAll('div'); } catch (e) { return out; }
    const n = Math.min(list.length, maxN || 1200);
    const deadline = Date.now() + (budgetMs || 400);
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0 && Date.now() > deadline) break;
      const el = list[i];
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 40 || r.height < 20) continue;
      out.push({ el, r, cls: String(el.className || '') });
    }
    return out;
  }

  /** 找不到容器时，把页面上像"消息列表"的东西全列出来，方便一次把选择器改对 */
  function domCandidates() {
    const L = [];
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); };
    const cls = (el) => String((el && el.className) || '').slice(0, 50) || '(无class)';

    const scanned = scanDivs(1200, 400);
    const divs = scanned.map((s) => s.el);

    const scrollers = scanned
      .filter((s) => s.el.scrollHeight > s.el.clientHeight + 40 && s.el.childElementCount >= 2)
      .sort((a, b) => b.el.clientHeight - a.el.clientHeight)
      .slice(0, 6)
      .map((s) => s.el);
    L.push('=== 滚动容器（按可见高度，top6）===');
    if (!scrollers.length) L.push('（一个都没有）');
    scrollers.forEach((el, i) => {
      L.push('[' + (i + 1) + '] ' + rectOf(el) + '  子=' + el.childElementCount +
        '  滚动高=' + el.scrollHeight + '  .' + cls(el) +
        (looksLikeList(threadRows(el)) ? '   ← 这是会话列表' : ''));
    });
    if (scrollers.some((el) => looksLikeList(threadRows(el)))) {
      L.push('');
      L.push('⚠️ 探测到的是会话列表。请先点开其中一个会话（能看到聊天气泡），再点一次探测。');
    }

    const KW = /message|chat|conversation|msg|dialog|bubble|letter/i;
    const hits = divs.filter((el) => KW.test(String(el.className || '')) && shown(el)).slice(0, 8);
    L.push('');
    L.push('=== class 里带 message/chat/bubble 的 ===');
    if (!hits.length) L.push('（没有，说明用的是纯 hash 类名）');
    hits.forEach((el) => {
      L.push('- ' + rectOf(el) + '  子=' + el.childElementCount +
        '  audio=' + el.querySelectorAll('audio').length +
        '  img=' + el.querySelectorAll('img').length + '  .' + cls(el));
    });

    L.push('');
    L.push(classDump(12, scanned));
    L.push('');
    L.push('=== 输入框往上 6 层 ===');
    const ed = editorBox();
    if (!ed) {
      L.push('（连输入框都没找到，可能还没进会话）');
    } else {
      let p = ed;
      for (let i = 0; i < 6 && p; i++) {
        L.push(' '.repeat(i * 2) + '↑ ' + p.tagName.toLowerCase() +
          (p.id ? '#' + p.id : '') + '  ' + rectOf(p) + '  子=' + p.childElementCount + '  .' + cls(p));
        p = p.parentElement;
      }
    }

    L.push('');
    L.push('先点开左边一个会话（进到有消息的对话里），再点一次探测。');
    L.push('还是读不出来就把这段发我，我按上面的 class 直接写选择器。');
    return L.join('\n');
  }

  /** 把页面上 class 带 conversation/message/chat 的元素列出来，用来一眼看出消息区的类名 */
  function classDump(limit, scannedIn) {
    const KW = /conversation|message|chat|bubble|msg/i;
    const scanned = scannedIn || scanDivs(1200, 300);
    const seen = [];
    for (const s of scanned) {
      if (!KW.test(s.cls)) continue;
      seen.push({
        c: s.cls,
        w: Math.round(s.r.width),
        h: Math.round(s.r.height),
        n: s.el.childElementCount,
        area: s.r.width * s.r.height,
      });
    }
    seen.sort((a, b) => b.area - a.area);
    const L = ['=== class 含 conversation/message/chat 的元素（按面积 top ' + limit + '）==='];
    if (!seen.length) L.push('（一个都没有）');
    for (const s of seen.slice(0, limit)) {
      L.push(s.w + 'x' + s.h + '  子=' + s.n + '  .' + s.c.slice(0, 60));
    }
    return L.join('\n');
  }

  /** 探测结果打到面板上（不用去 DevTools 切执行上下文），并尝试复制到剪贴板 */
  function showReport(text) {    const d = document.getElementById('dy-ai-draft');
    if (d) {
      d.value = text;
      d.style.height = '240px';
      d.style.background = '#fff';
      try { d.scrollTop = 0; } catch (e) {}
    }
    log(text);
    try {
      navigator.clipboard.writeText(text).then(
        () => { const m = document.getElementById('dy-ai-mem'); if (m) m.textContent = '📋 探测结果已复制，直接粘给海鸥'; },
        () => { const m = document.getElementById('dy-ai-mem'); if (m) m.textContent = '📋 复制失败：手动选中草稿框文字 Ctrl+C'; }
      );
    } catch (e) {}
  }

  globalThis.__dyAI = {
    cfg: CFG,
    probeThread,
    readThread,
    listItems,
    picker,
    tick,
    state: S,
    /* 调试用：看模型到底收到了什么 */
    lastPrompt: () => (S.lastGen && S.lastGen.prompt) || null,
    memory: (chatId) => memoryGet(chatId),
    stats: () => chrome.runtime.sendMessage({ type: 'DY_DB_STATS' }),
    exportDb: () => chrome.runtime.sendMessage({ type: 'DY_DB_EXPORT' }),
    clearDb: (chatId) => chrome.runtime.sendMessage({ type: 'DY_DB_CLEAR', chatId }),
  };

  /* ---------------- 启动 ---------------- */

  function save(obj, cb) {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) log('❌ 存储失败：', chrome.runtime.lastError.message);
        if (cb) cb();
      });
    } catch (e) { log('❌ 存储异常：', (e && e.message) || e); }
  }

  function boot() {
    try {
      chrome.storage.local.get(
        {
          ENABLED: false, DRY_RUN: true, PERSONA: '本店客服', KB: '', MAX_CHARS: 40,
          FALLBACK: '稍等，我确认一下再回您', ALLOW_GENERAL: true, VISION_ON: false,
          ASR_ON: false, KB_RETRIEVE: true, THREAD_SEL: '', ALLOW_IDS: '',
        },
        (res) => {
          S.enabled = res.ENABLED === true;
          S.dryRun = res.DRY_RUN !== false;
          S.persona = res.PERSONA || S.persona;
          S.kb = res.KB || '';
          S.maxChars = Number(res.MAX_CHARS) || 40;
          S.fallback = res.FALLBACK == null ? S.fallback : String(res.FALLBACK);
          S.allowGeneral = res.ALLOW_GENERAL !== false;
          S.vision = res.VISION_ON === true;
          S.asr = res.ASR_ON === true;
          S.kbRetrieve = res.KB_RETRIEVE !== false;
          S.threadSel = String(res.THREAD_SEL || '').trim();
          S.allowIds = String(res.ALLOW_IDS || '').split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean);
          log('配置载入：enabled=' + S.enabled + ' dryRun=' + S.dryRun +
              ' kb=' + S.kb.length + '字 allowGeneral=' + S.allowGeneral +
              ' vision=' + S.vision + ' asr=' + S.asr + ' 资料库=' + S.kbRetrieve +
              (S.allowIds.length ? ' 白名单=' + S.allowIds.join('/') : ''));
          refreshMemStats();
          updatePanel();
          schedule();
        }
      );
    } catch (e) {
      log('❌ 读配置失败，保持关闭', (e && e.message) || e);
      schedule();
    }
    ensurePanel();

    try {
      chrome.runtime.onMessage.addListener((msg, _s, reply) => {
        if (!msg) return false;
        if (msg.type === 'DY_RELOAD') { boot(); reply && reply({ ok: true }); return true; }
        if (msg.type === 'DY_RUN_ONCE') { tick(true).finally(() => reply && reply({ ok: true })); return true; }
        if (msg.type === 'DY_PROBE') { probeThread(); reply && reply({ ok: true }); return true; }
        return false;
      });
    } catch (e) {}

    log('注入完成 v' + VERSION + (S.dryRun ? '（草稿模式）' : ''));
  }

  async function refreshMemStats() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'DY_DB_STATS' });
      if (r && r.ok) {
        S.memInfo = { ...S.memInfo, msgs: r.msgs || 0, chats: r.chats || 0 };
        updatePanel();
      }
    } catch (e) {}
  }

  boot();
})();
