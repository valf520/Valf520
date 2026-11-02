/**
 * 自检 2/2：service worker 里的资料库 / IndexedDB / 检索闸门是否正常
 *   用法：node tools/selftest-sw.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9222);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const sw = list.find((t) => t.type === 'service_worker' && /background\.js$/.test(t.url));
if (!sw) {
  console.error('找不到 background service worker（扩展没加载？Service Worker 可能已休眠，打开一次扩展弹窗再试）');
  process.exit(2);
}

const expr = `(async () => {
  const out = { manifest: chrome.runtime.getManifest().version, DYKB: typeof DYKB, indexedDB: typeof indexedDB };
  try {
    const r = await fetch(chrome.runtime.getURL('kb/kb.json'));
    const j = await r.json();
    out.kbChunks = j.chunks.length;
    out.kbBuilt = j.builtAt;
    if (typeof DYKB !== 'undefined') {
      DYKB.load(j.chunks);
      out.probe = DYKB.search('她三天没回我消息', { limit: 2 }).map(h => h.title + ' / ' + h.sec + ' (' + h.score + ')');
      out.gate_relationship = DYKB.shouldRetrieve('她三天没回我消息');
      out.gate_price = DYKB.shouldRetrieve('这个裙子多少钱');
    }
  } catch (e) { out.error = String(e && e.message || e); }
  return JSON.stringify(out, null, 2);
})()`;

const res = await new Promise((resolve, reject) => {
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  const timer = setTimeout(() => reject(new Error('timeout')), 10000);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== 1) return;
    clearTimeout(timer);
    try { ws.close(); } catch (e) {}
    if (m.result && m.result.exceptionDetails) return reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
    resolve(m.result.result.value);
  };
  ws.onerror = () => reject(new Error('ws error'));
});

console.log(res);
process.exit(0);
