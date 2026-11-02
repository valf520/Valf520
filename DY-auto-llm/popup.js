const $ = (id) => document.getElementById(id);
const out = (t) => { $('out').textContent = t; };

const DEF = {
  API_BASE: 'https://api.deepseek.com', MODEL: 'deepseek-chat',
  PERSONA: '本店客服', KB: '', MAX_CHARS: 40, FALLBACK: '稍等，我确认一下再回您',
  DRY_RUN: true, ALLOW_GENERAL: true,
  VISION_ON: false, VISION_BASE: '', VISION_MODEL: '', VISION_KEY: '',
  ASR_ON: false, ASR_BASE: '', ASR_MODEL: '', ASR_KEY: '',
  KB_RETRIEVE: true, THREAD_SEL: '', ALLOW_IDS: '',
};

chrome.storage.local.get({ ...DEF, API_KEY: '' }, (r) => {
  $('key').value = r.API_KEY || '';
  $('base').value = r.API_BASE || DEF.API_BASE;
  $('model').value = r.MODEL || DEF.MODEL;
  $('persona').value = r.PERSONA || DEF.PERSONA;
  $('kb').value = r.KB || '';
  $('max').value = r.MAX_CHARS || 40;
  $('fallback').value = r.FALLBACK == null ? DEF.FALLBACK : r.FALLBACK;
  $('dry').checked = r.DRY_RUN !== false;
  $('general').checked = r.ALLOW_GENERAL !== false;
  $('vision').checked = r.VISION_ON === true;
  $('vbase').value = r.VISION_BASE || '';
  $('vmodel').value = r.VISION_MODEL || '';
  $('vkey').value = r.VISION_KEY || '';
  $('asr').checked = r.ASR_ON === true;
  $('abase').value = r.ASR_BASE || '';
  $('amodel').value = r.ASR_MODEL || '';
  $('akey').value = r.ASR_KEY || '';
  $('kbret').checked = r.KB_RETRIEVE !== false;
  $('tsel').value = r.THREAD_SEL || '';
  $('allowIds').value = r.ALLOW_IDS || '';
});

function collect() {
  return {
    API_KEY: $('key').value.trim(),
    API_BASE: $('base').value.trim() || DEF.API_BASE,
    MODEL: $('model').value.trim() || DEF.MODEL,
    PERSONA: $('persona').value.trim() || DEF.PERSONA,
    KB: $('kb').value,
    MAX_CHARS: Number($('max').value) || 40,
    FALLBACK: $('fallback').value,
    DRY_RUN: $('dry').checked,
    ALLOW_GENERAL: $('general').checked,
    VISION_ON: $('vision').checked,
    VISION_BASE: $('vbase').value.trim(),
    VISION_MODEL: $('vmodel').value.trim(),
    VISION_KEY: $('vkey').value.trim(),
    ASR_ON: $('asr').checked,
    ASR_BASE: $('abase').value.trim(),
    ASR_MODEL: $('amodel').value.trim(),
    ASR_KEY: $('akey').value.trim(),
    KB_RETRIEVE: $('kbret').checked,
    THREAD_SEL: $('tsel').value.trim(),
    ALLOW_IDS: $('allowIds').value.trim(),
  };
}

async function kbStats() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'DY_KB_STATS' });
    $('kbBar').textContent = r && r.n
      ? (`已载入 ${r.n} 块 · ${r.source || ''} · ${r.builtAt || ''}${r.enabled ? '' : '（已关闭）'}`)
      : ('资料库未载入：' + ((r && r.error) || 'kb/kb.json 缺失'));
  } catch (e) { $('kbBar').textContent = '读取失败：' + (e.message || e); }
}
kbStats();

$('kbTest').addEventListener('click', async () => {
  const q = $('kbq').value.trim();
  if (!q) return;
  $('kbOut').textContent = '检索中…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'DY_KB', query: q, limit: 3 });
    if (!r || !r.ok) { $('kbOut').textContent = '失败：' + ((r && r.error) || 'unknown'); return; }
    if (r.gated) { $('kbOut').textContent = '闸门拦住了：交易类问题或没有领域词，不会去查资料。'; return; }
    if (!r.chunks.length) { $('kbOut').textContent = '没有命中。'; return; }
    $('kbOut').textContent = r.chunks.map((c, i) =>
      `[${i + 1}] ${c.score} ${c.title} / ${c.sec || '-'}\n${String(c.text).slice(0, 120)}…`).join('\n\n');
  } catch (e) { $('kbOut').textContent = '失败：' + (e.message || e); }
});

async function memStats() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'DY_DB_STATS' });
    $('memBar').textContent = r && r.ok ? (`已存 ${r.chats} 个会话 / ${r.msgs} 条消息`) : '读取失败';
  } catch (e) { $('memBar').textContent = '读取失败：' + (e.message || e); }
}
memStats();

$('memRefresh').addEventListener('click', memStats);

$('memExport').addEventListener('click', async () => {
  const d = await chrome.runtime.sendMessage({ type: 'DY_DB_EXPORT' });
  if (!d || !d.ok) { out('导出失败'); return; }
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dy-memory-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  out('已导出 ' + d.msgs.length + ' 条消息，可直接灌进 SQLite 做 SQL 分析。');
});

$('memClear').addEventListener('click', async () => {
  if (!confirm('清空全部对话记忆？不可恢复。')) return;
  const r = await chrome.runtime.sendMessage({ type: 'DY_DB_CLEAR' });
  memStats();
  out('已清空，剩余 ' + ((r && r.msgs) || 0) + ' 条。');
});

$('save').addEventListener('click', () => {
  chrome.storage.local.set(collect(), () => out('已保存。刷新抖音页面生效。'));
});

$('test').addEventListener('click', async () => {
  const cfg = collect();
  await chrome.storage.local.set(cfg);
  out('请求中…');
  const t0 = Date.now();
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'DY_TEST_LLM',
      payload: { kb: cfg.KB, persona: cfg.PERSONA, maxChars: cfg.MAX_CHARS, message: '在吗？这个多少钱' },
    });
    const ms = Date.now() - t0;
    if (res && res.ok) out('✅ ' + ms + 'ms · ' + (res.usage || '') + '\n\n' + res.text);
    else out('❌ ' + (res && res.error));
  } catch (e) { out('❌ ' + (e.message || e)); }
});

$('run').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/douyin\.com/.test(tab.url || '')) { out('当前标签页不是抖音网页版。'); return; }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'DY_RELOAD' });
    await chrome.tabs.sendMessage(tab.id, { type: 'DY_RUN_ONCE' });
    out('已触发。看页面控制台 [DY-AI] 日志和右下角面板的草稿框。');
  } catch (e) {
    out('注入未就绪：' + (e.message || e) + '\n刷新抖音页面重试。');
  }
});
