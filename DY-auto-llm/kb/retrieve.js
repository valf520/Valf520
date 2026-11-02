/* kb/retrieve.js —— 中文小语料检索（tf-idf 余弦 + 路由优先 + 小节展开）
 *
 * 为什么不用向量库：语料 378KB / 277 块，装进扩展就能跑，零成本零网络。
 *
 * 相比第一版的三个改进：
 *   1) 路由优先：SKILL.md 里那张「问题 → 必读文件」的表被抽成 routes.json，
 *      命中关键词的文档，其所有块分数 ×1.8。这比纯词频准得多。
 *   2) 小节展开（small-to-big）：命中一块后，把同一小节的相邻块拼起来再给模型，
 *      避免「块边界把论证切断」。
 *   3) 表格降权：表格块词分布散、容易误命中（曾经一张表占了 900 字却没用），分数 ×0.6。
 *
 * 用法：
 *   DYKB.load(chunks, routes)
 *   DYKB.search(query, {limit, budget})
 */
(() => {
  const state = {
    chunks: [], vecs: [], secMap: new Map(),
    df: new Map(), N: 0, loaded: false, routes: [],
  };

  /** 高频虚词/代词单字，进检索只会拉低精度 */
  const STOP = new Set('的了是我你他她它们这那个吗呢啊吧么什怎会能要想去来上下好一二三得地着过把被给对从到而但所以为之其中大小多少很太还又再才只已经可没无里外前后都也和与就在有不说'.split(''));

  /**
   * 中文按「单字 + 双字」混切：
   *   单字保召回（"刚吵完架"里的 吵/架 能对上"冲突"那篇），双字保精度。
   *   虚词单字丢掉，双字权重给 2 倍。
   */
  function tokenize(s) {
    const t = String(s || '').toLowerCase();
    const out = [];
    const latin = t.match(/[a-z][a-z0-9]{1,}/g);
    if (latin) out.push(...latin);
    const cjk = t.replace(/[^\u4e00-\u9fff]+/g, ' ').trim();
    if (cjk) {
      for (const seg of cjk.split(/\s+/)) {
        if (!seg) continue;
        for (const ch of seg) if (!STOP.has(ch)) out.push(ch);
        for (let i = 0; i < seg.length - 1; i++) {
          const bg = seg.slice(i, i + 2);
          out.push(bg, bg);
        }
      }
    }
    return out;
  }

  /** 口语 -> 资料库里的书面词。客户不会说"投入失衡"，他只会说"她老不回我" */
  const ALIAS = [
    [/没回|不回|已读不回|不理我|冷处理|晾着/, ['冷淡', '投入', '回复']],
    [/没戏|凉了|黄了|没希望|放弃了|该不该继续/, ['退出', '投入失衡']],
    [/表白|告白|开口|怎么说|怎么聊|聊什么/, ['主动表达', '接话']],
    [/吵架|吵完架|冷战|闹矛盾|争执|翻旧账/, ['冲突', '修复']],
    [/分手|复合|挽回/, ['分手', '修复']],
    [/舔|备胎|卑微|讨好|舔狗/, ['投入失衡', '互惠']],
    [/吃醋|嫉妒|查手机/, ['信任', '边界']],
    [/相亲|约会|见面/, ['约会', '第一次见面']],
    [/拒绝|被拒|婉拒/, ['拒绝', '边界']],
    [/父母|家里|催婚/, ['双方家庭', '婚姻']],
    [/喜欢|心动|好感/, ['吸引', '关系启动']],
    [/情绪|难受|崩溃|焦虑|压力大/, ['情绪调节', '依恋']],
    [/聊天记录|截图|分析/, ['聊天', '证据']],
  ];

  function expand(query) {
    const q = String(query || '');
    const extra = [];
    for (const [re, words] of ALIAS) if (re.test(q)) extra.push(...words);
    return extra;
  }

  const idf = (df) => Math.log(1 + (state.N - df + 0.5) / (df + 0.5));

  /* 目录 / 索引 / 书单 / 参考文献：词覆盖全，但没有可用的内容 */
  const LOW_VALUE = /导读|目录|索引|书单|核心来源|参考文献|附录/;

  function load(chunks, routeList) {
    state.chunks = Array.isArray(chunks) ? chunks : [];
    state.routes = Array.isArray(routeList) ? routeList : [];
    state.N = state.chunks.length;
    state.df = new Map();
    state.vecs = [];
    state.secMap = new Map();

    /* 同一小节的块按 idx 排好，供 small-to-big 展开 */
    state.chunks.forEach((c, i) => {
      const key = c.file + '\u0000' + (c.sec || '');
      if (!state.secMap.has(key)) state.secMap.set(key, []);
      state.secMap.get(key).push({ i, idx: c.idx == null ? i : c.idx });
    });
    for (const arr of state.secMap.values()) arr.sort((a, b) => a.idx - b.idx);

    const tfs = state.chunks.map((c) => {
      const field = [c.doc || '', c.doc || '', c.sec || '', c.text || ''].join(' ');
      const tokens = tokenize(field);
      const tf = new Map();
      for (const tk of tokens) tf.set(tk, (tf.get(tk) || 0) + 1);
      for (const tk of tf.keys()) state.df.set(tk, (state.df.get(tk) || 0) + 1);
      return tf;
    });

    for (const tf of tfs) {
      const vec = new Map();
      let sq = 0;
      for (const [tk, n] of tf) {
        const w = (1 + Math.log(n)) * idf(state.df.get(tk) || 1);
        vec.set(tk, w);
        sq += w * w;
      }
      const norm = Math.sqrt(sq) || 1;
      for (const [tk, w] of vec) vec.set(tk, w / norm);
      state.vecs.push(vec);
    }

    state.loaded = true;
    return state.N;
  }

  /** 路由表里的关键词多半是"冲突修复""一句话回复"这种复合词，按整词匹配几乎撞不上，
      所以降级成「关键词里的任意双字出现在查询里」就算命中，并按命中数排序取前两条 */
  function keyBigrams(k) {
    const out = new Set();
    for (const t of tokenize(k)) {
      if (t.length === 2 && /[\u4e00-\u9fff]/.test(t)) out.add(t);
    }
    return out;
  }

  function routedFiles(query) {
    const q = String(query || '');
    const qTokens = new Set(tokenize(q));
    const hits = [];
    for (const r of state.routes) {
      let sc = 0;
      for (const k of r.k || []) {
        if (!k) continue;
        if (q.indexOf(k) >= 0) { sc += 5; continue; }
        let m = 0;
        for (const bg of keyBigrams(k)) if (qTokens.has(bg)) m++;
        if (m >= 1) sc += m;
      }
      if (sc >= 1) hits.push({ sc, files: r.f || [] });
    }
    hits.sort((a, b) => b.sc - a.sc);
    const out = new Set();
    for (const h of hits.slice(0, 2)) for (const f of h.files) out.add(f);
    return out;
  }

  /** 命中块 -> 它所在小节的完整文本（上限 cap 字） */
  function sectionText(chunk, cap) {
    const key = chunk.file + '\u0000' + (chunk.sec || '');
    const arr = state.secMap.get(key);
    if (!arr || arr.length <= 1) return chunk.text;
    let s = '';
    for (const { i } of arr) {
      const t = state.chunks[i].text;
      if (s.length + t.length + 1 > cap) break;
      s += (s ? '\n' : '') + t;
    }
    return s || chunk.text;
  }

  function search(query, opts = {}) {
    if (!state.loaded) return [];
    const limit = opts.limit || 2;
    const minScore = opts.minScore == null ? 0.055 : opts.minScore;
    const budget = opts.budget || 1800;
    const secCap = opts.sectionCap || 1200;
    const maxPerFile = opts.maxPerFile || 2;

    const qTokens = tokenize(query);
    if (!qTokens.length) return [];

    const qtf = new Map();
    for (const tk of qTokens) qtf.set(tk, (qtf.get(tk) || 0) + 1);
    for (const tk of tokenize(expand(query).join(' '))) qtf.set(tk, (qtf.get(tk) || 0) + 1);

    const qvec = new Map();
    let sq = 0;
    for (const [tk, n] of qtf) {
      const df = state.df.get(tk);
      if (!df) continue;
      const w = (1 + Math.log(n)) * idf(df);
      qvec.set(tk, w);
      sq += w * w;
    }
    if (!qvec.size) return [];
    const qnorm = Math.sqrt(sq) || 1;

    const routed = routedFiles(query);

    const scored = [];
    for (let i = 0; i < state.vecs.length; i++) {
      const vec = state.vecs[i];
      let dot = 0;
      for (const [tk, w] of qvec) {
        const dw = vec.get(tk);
        if (dw) dot += dw * w;
      }
      if (!dot) continue;
      let s = dot / qnorm;
      const c = state.chunks[i];
      if (routed.size && routed.has(c.file)) s *= 1.8;      // 路由优先
      if (c.kind === 'table') s *= 0.6;                      // 表格降权
      if (c.path === 'core') s *= 0.55;                       // 总纲/操作手册降权，它跟什么都能沾边
      /* 目录/索引/书单/参考文献这类块词很全但没内容，跟"什么都能匹配"是一回事 */
      if (LOW_VALUE.test((c.doc || '') + ' ' + (c.sec || ''))) s *= 0.5;
      scored.push([i, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);

    const out = [];
    const perFile = new Map();
    let used = 0;
    for (const [idx, score] of scored) {
      if (out.length >= limit || score < minScore) break;
      const c = state.chunks[idx];
      const n = perFile.get(c.file) || 0;
      if (n >= maxPerFile) continue;
      const text = sectionText(c, secCap);
      if (used + text.length > budget && out.length) continue;
      perFile.set(c.file, n + 1);
      used += text.length;
      out.push({
        file: c.file,
        doc: c.doc || c.title || '',
        sec: c.sec || '',
        path: c.path || '',
        kind: c.kind || 'text',
        text,
        expanded: text.length > c.text.length,
        score: Math.round(score * 1000) / 1000,
      });
    }
    return out;
  }

  /* 交易类问题（价格/发货/尺码/退款）走商家自己的知识库，不该翻沟通方法论 */
  const TRANSACTIONAL = /多少钱|价格|几块|包邮|发货|快递|物流|库存|现货|有没有货|尺码|码数|大小|颜色|下单|拍下|链接|优惠|优惠券|满减|退款|退货|换货|地址|付款|支付|定金|尾款|发票|质量|材质|面料|正品|保修|售后/;

  /* 关系/沟通类的领域词。没有这些词就不去翻资料库（1+1、你好、多少钱都不翻） */
  const DOMAIN = /感情|关系|恋爱|恋|喜欢|心动|追[求人]|表白|告白|相亲|分手|复合|挽回|吵架|吵[完过]|冷战|矛盾|冲突|情绪|难受|崩溃|焦虑|压力|聊天|聊[天过]|接话|回复|回[我他她]|没回|不回|冷淡|暧昧|约会|见面|拒绝|边界|信任|吃醋|嫉妒|对象|男朋友|女朋友|老公|老婆|前任|婚姻|结婚|离婚|尴尬|道歉|主动|投入|试探|渣|备胎|异地|父母|家里|催婚|沟通|表达|亲密|依恋|安全感|拉黑|删[了掉]|PUA|pua|操控|渣男|渣女|舔|卑微|讨好|异地恋|网恋|单身|撩|暧昧期|聊天记录|截图/;

  function isTransactional(text) {
    return TRANSACTIONAL.test(String(text || ''));
  }

  /** 该不该去查资料库 */
  function shouldRetrieve(text) {
    const t = String(text || '').trim();
    if (t.length < 4) return false;
    if (isTransactional(t)) return false;
    return DOMAIN.test(t);
  }

  globalThis.DYKB = { load, search, tokenize, shouldRetrieve, isTransactional, expand, routedFiles, state };
})();
