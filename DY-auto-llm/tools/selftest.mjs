/**
 * 自检 1/2：扩展是否真的注入到抖音页面了
 *   用法：先跑 start-edge-debug.bat（带 --remote-debugging-port=9222），再 node tools/selftest.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const evalIn = (wsUrl, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('timeout')); }, 8000);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== 1) return;
    clearTimeout(timer);
    try { ws.close(); } catch (e) {}
    resolve(m.result && m.result.result ? m.result.result.value : null);
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
});

let list = [];
for (let i = 0; i < 20; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch (e) { list = []; }
  if (list.length) break;
  await sleep(1000);
}
if (!list.length) {
  console.error('连不上调试端口 ' + PORT + '。用 start-edge-debug.bat 启动。');
  process.exit(2);
}

const pages = list.filter((t) => t.type === 'page');
const sw = list.filter((t) => t.type === 'service_worker' && /^chrome-extension:\/\//.test(t.url));
console.log('页面:', pages.map((p) => p.url.slice(0, 70)).join(' | ') || '（无）');
console.log('扩展 SW:', sw.length ? sw[0].url : '❌ 未找到');

const douyin = pages.find((p) => /douyin\.com/.test(p.url));
if (!douyin) {
  console.error('没有打开抖音页面');
  process.exit(2);
}

for (let i = 0; i < 10; i++) {
  const raw = await evalIn(douyin.webSocketDebuggerUrl, `(() => {
    const p = document.getElementById('dy-ai-panel');
    return JSON.stringify({ href: location.href, panel: !!p, text: p ? p.innerText.replace(/\\n/g, ' | ') : '' });
  })()`);
  const d = JSON.parse(raw || '{}');
  if (d.panel) {
    console.log('\n✅ content script 已注入');
    console.log('面板:', d.text);
    process.exit(0);
  }
  await sleep(2000);
}
console.error('\n⚠️ 面板没出现：确认页面是 douyin.com，并且扩展已加载');
process.exit(1);
